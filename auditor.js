const fs = require('fs');
const process = require('process');
const { Buffer } = require('buffer');
const { v4: uuidv4 } = require('uuid');
const evernode = require('evernode-js-client');
const logger = require('./lib/logger');
const { BootstrapClient } = require('./bootstrap-client');

// Environment variables.
const RIPPLED_URL = process.env.RIPPLED_URL || "wss://hooks-testnet.xrpl-labs.com";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const IS_DEV_MODE = process.env.DEV === "1";
const FILE_LOG_ENABLED = process.env.MB_FILE_LOG === "1";

const CONFIG_PATH = DATA_DIR + '/auditor.cfg';
const LOG_PATH = DATA_DIR + '/log/auditor.log';
const AUDITOR_CONTRACT_PATH = DATA_DIR + (IS_DEV_MODE ? '/dist/default-contract' : '/auditor-contract');
const AUDITOR_CLIENT_PATH = DATA_DIR + (IS_DEV_MODE ? '/dist/default-client' : '/auditor-client');

const REDEEM_WAIT_TIMEOUT = 60000 // 1 Minute.

class Auditor {
    #configPath = null;
    #contractPath = null;
    #lastValidatedLedgerIdx = null;
    #curMomentStartIdx = null;

    #ongoingAudit = null;

    constructor(configPath, contractPath, clientPath) {
        this.#configPath = configPath;
        this.#contractPath = contractPath;

        if (!fs.existsSync(this.#configPath))
            throw `${this.#configPath} does not exist.`;

        if (!fs.existsSync(clientPath))
            throw `${clientPath} does not exist.`

        if (!fs.existsSync(this.#contractPath))
            throw `${this.#contractPath} does not exist.`

        const { audit } = require(clientPath);
        this.audit = audit;
    }

    async init(rippledServer) {
        this.readConfig();
        if (!this.cfg.xrpl.address || !this.cfg.xrpl.secret || !this.cfg.xrpl.hookAddress || !this.cfg.instance.image)
            throw "Required cfg fields cannot be empty.";

        evernode.Defaults.set({
            hookAddress: this.cfg.xrpl.hookAddress,
            rippledServer: rippledServer
        })

        this.auditorClient = new evernode.AuditorClient(this.cfg.xrpl.address, this.cfg.xrpl.secret);
        this.xrplApi = this.auditorClient.xrplApi;

        await this.auditorClient.connect();
        this.evernodeHookConf = this.auditorClient.hookConfig;

        this.userClient = new evernode.UserClient(this.cfg.xrpl.address, this.cfg.xrpl.secret, { xrplApi: this.xrplApi });

        await this.userClient.connect();
        await this.userClient.prepareAccount();

        // Create audit table if not exist.
        await this.initMomentInfo();

        // Keep listening to xrpl ledger creations and keep track of moments.
        this.xrplApi.on(evernode.XrplApiEvents.LEDGER, async (e) => {
            this.#lastValidatedLedgerIdx = e.ledger_index;
            // If this is the start of a new moment.
            if ((this.#lastValidatedLedgerIdx - this.evernodeHookConf.momentBaseIdx) % this.evernodeHookConf.momentSize === 0) {
                this.#curMomentStartIdx = this.#lastValidatedLedgerIdx;
                // Start the audit cycle for the moment.
                // Keep constant variable of momentStartIdx for this execution since #curMomentStartIdx is changing.
                const momentStartIdx = this.#curMomentStartIdx;
                try { await this.auditCycle(momentStartIdx); }
                catch (e) {
                    this.logMessage(momentStartIdx, e);
                }
            }
        });
    }

    #handleAudit(momentStartIdx) {
        return new Promise(async (resolve, reject) => {
            this.#ongoingAudit = {
                momentStartIdx: momentStartIdx,
                resolve: resolve,
                reject: reject,
                assignmentCount: -1
            };

            try {
                this.logMessage(momentStartIdx, 'Requesting for an audit.');
                await this.auditorClient.requestAudit();
            }
            catch (e) {
                this.#ongoingAudit = null;
                reject(e);
                return;
            }

            this.auditorClient.on(evernode.AuditorEvents.AuditAssignment, async (assignmentInfo) => {
                // Keep updating ongoing audits when audit assignment received.
                if (this.#ongoingAudit.assignmentCount == -1)
                    this.#ongoingAudit.assignmentCount = 1;
                else
                    this.#ongoingAudit.assignmentCount++;

                let hostInfo = {
                    currency: assignmentInfo.currency,
                    address: assignmentInfo.issuer,
                    amount: assignmentInfo.value
                }

                try {
                    this.logMessage(momentStartIdx, `Assigned a host to audit, token - ${hostInfo.currency}`);


                    this.logMessage(momentStartIdx, `Cashing the hosting token, token - ${hostInfo.currency}`);
                    const cashRes = await this.auditorClient.cashAuditAssignment(assignmentInfo);

                    // Check whether moment is expired while cashing the hosting token.
                    if (!this.#checkMomentValidity(momentStartIdx))
                        throw 'Moment expired while cashing the hosting token.';

                    // Generating Hot pocket key pair for this audit round.
                    const bootstrapClient = new BootstrapClient();
                    const hpKeys = await bootstrapClient.generateKeys();

                    this.logMessage(momentStartIdx, `Redeeming from the host, token - ${hostInfo.currency}`);
                    const startLedger = this.xrplApi.ledgerIndex;
                    let ledgerTimeTook = 0;

                    const instanceInfo = await this.sendRedeemRequest(hostInfo, hpKeys).finally(async () => {
                        // Time took in ledgers for redeem to response.
                        ledgerTimeTook = this.xrplApi.ledgerIndex - startLedger;

                        // If the trustline was created by the audit assignment. Remove the trustline after the redeem.
                        if (cashRes.trustCreated) {
                            this.logMessage(momentStartIdx, `Removing trustline for ${hostInfo.currency}/${hostInfo.address}`);
                            await this.auditorClient.removeAuditTrustline(hostInfo.address, hostInfo.currency);
                        }
                    });

                    // Check whether moment is expired while waiting for the redeem.
                    if (!this.#checkMomentValidity(momentStartIdx))
                        throw 'Moment expired while waiting for the redeem response.';

                    this.logMessage(momentStartIdx, `Auditing the host, token - ${hostInfo.currency}`);
                    const auditRes = await this.auditInstance(instanceInfo, ledgerTimeTook, momentStartIdx, bootstrapClient);

                    // Check whether moment is expired while waiting for the audit completion.
                    if (!this.#checkMomentValidity(momentStartIdx))
                        throw 'Moment expired while waiting for the audit.';

                    if (auditRes) {
                        this.logMessage(momentStartIdx, `Audit success, token - ${hostInfo.currency}`);
                        await this.auditorClient.auditSuccess(hostInfo.address)
                    }
                    else {
                        this.logMessage(momentStartIdx, `Audit failed, token - ${hostInfo.currency}`);
                        await this.auditorClient.auditFail(hostInfo.address);
                    }
                }
                catch (e) {
                    this.logMessage(momentStartIdx, 'Audit error,', e.reason ? `${e.reason},` : e, `token - ${hostInfo.currency}`);
                }

                // Decrease ongoing audit assignment count when an audit completed.
                this.#ongoingAudit.assignmentCount--;
            });
        });
    }

    async auditCycle(momentStartIdx) {
        // Before this moment cycle, we expire the previous audit if any.
        if (this.#ongoingAudit && this.#ongoingAudit.momentStartIdx < momentStartIdx) {
            // Off events of previous moment's listener before the new audit cycle.
            this.auditorClient.off(evernode.AuditorEvents.AuditAssignment);

            // assignmentCount > 0 means, There's a pending audit for an audit assignment.
            // assignmentCount == -1 means, There's no audit assignment for the audit request.
            // assignmentCount == 0 means, All assigned audits has been completed.
            // In boath cases audit has to be expired.
            if (this.#ongoingAudit.assignmentCount !== 0)
                this.#ongoingAudit.reject('Audit has been expired.');
            else
                this.#ongoingAudit.resolve();
            this.#ongoingAudit = null;
        }

        this.logMessage(momentStartIdx, 'Audit cycle started.');

        try {
            await this.#handleAudit(momentStartIdx);
        }
        catch (e) {
            this.logMessage(momentStartIdx, 'Audit error - ', e.reason ? `${e.reason},` : e);
        }

        this.logMessage(momentStartIdx, 'Audit cycle ended.');
    }

    #checkMomentValidity(momentStartIdx) {
        return (momentStartIdx == this.#curMomentStartIdx);
    }

    async auditInstance(instanceInfo, ledgerTimeTook, momentStartIdx, client) {
        // Redeem audit threshold is take as half the moment size.
        const redeemThreshold = this.evernodeHookConf.momentSize / 2;
        if (ledgerTimeTook >= redeemThreshold) {
            this.logMessage(momentStartIdx, `Redeem took too long. (Took: ${ledgerTimeTook} Threshold: ${redeemThreshold}) Audit failed`);
            return false;
        }
        // Checking connection with bootstrap contract succeeds.
        const connectSuccess = await client.connect(instanceInfo);

        if (!this.#checkMomentValidity(momentStartIdx))
            throw 'Moment expired while waiting for the host connection.';

        if (!connectSuccess) {
            this.logMessage(momentStartIdx, 'Bootstrap contract connection failed.');
            return false;
        }

        // Checking whether the bootstrap contract is alive.
        const isBootstrapRunning = await client.checkStatus();

        if (!this.#checkMomentValidity(momentStartIdx))
            throw 'Moment expired while waiting for the bootstrap contract status.';

        if (!isBootstrapRunning) {
            console.error('Bootstrap contract status is not live.');
            return false;
        }

        // Checking the file upload to bootstrap contract succeeded.
        const uploadSuccess = await client.uploadContract(this.#contractPath);

        if (!this.#checkMomentValidity(momentStartIdx))
            throw 'Moment expired while uploading the contract bundle.';

        if (!uploadSuccess) {
            this.logMessage(momentStartIdx, 'Contract upload failed.');
            return false;
        }

        // Run custom auditor contract related logic.
        const auditLogicSuccess = await this.audit(instanceInfo.ip, instanceInfo.user_port);
        if (!auditLogicSuccess) {
            this.logMessage(momentStartIdx, 'Custom audit process informed fail status.');
            return false;
        }
        return true;
    }

    async sendRedeemRequest(hostInfo, keys) {
        const response = await this.userClient.redeem(hostInfo.currency, hostInfo.address, hostInfo.amount, this.getInstanceRequirements(keys), { timeout: REDEEM_WAIT_TIMEOUT });
        return response.instance;
    }

    async initMomentInfo() {
        this.#lastValidatedLedgerIdx = this.xrplApi.ledgerIndex;
        const relativeN = Math.floor((this.#lastValidatedLedgerIdx - this.evernodeHookConf.momentBaseIdx) / this.evernodeHookConf.momentSize);
        this.#curMomentStartIdx = this.evernodeHookConf.momentBaseIdx + (relativeN * this.evernodeHookConf.momentSize);
    }

    getInstanceRequirements(keys) {
        return {
            owner_pubkey: Buffer.from(keys.publicKey).toString('hex'),
            contract_id: uuidv4(),
            image: this.cfg.instance.image,
            config: {}
        }
    }

    readConfig() {
        this.cfg = JSON.parse(fs.readFileSync(this.#configPath).toString());
    }

    persistConfig() {
        fs.writeFileSync(this.#configPath, JSON.stringify(this.cfg, null, 2));
    }

    logMessage(momentStartIdx, ...msgArgs) {
        console.log(`Moment start idx ${momentStartIdx}:`, ...msgArgs);
    }
}

async function main() {

    // Logs are formatted with the timestamp and a log file will be created inside log directory.
    logger.init(LOG_PATH, FILE_LOG_ENABLED);

    console.log('Starting the Evernode auditor.' + (IS_DEV_MODE ? ' (in dev mode)' : ''));
    console.log('Data dir: ' + DATA_DIR);
    console.log('Rippled server: ' + RIPPLED_URL);

    const auditor = new Auditor(CONFIG_PATH, AUDITOR_CONTRACT_PATH, AUDITOR_CLIENT_PATH);
    await auditor.init(RIPPLED_URL);
}

main().catch(console.error);