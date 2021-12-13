const fs = require('fs');
const process = require('process');
const { Buffer } = require('buffer');
const { v4: uuidv4 } = require('uuid');
const evernode = require('evernode-js-client');
const { SqliteDatabase, DataTypes } = require('./lib/sqlite-handler');
const logger = require('./lib/logger');
const { BootstrapClient } = require('./bootstrap-client');

// Environment variables.
const RIPPLED_URL = process.env.RIPPLED_URL || "wss://hooks-testnet.xrpl-labs.com";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const IS_DEV_MODE = process.env.DEV === "1";
const FILE_LOG_ENABLED = process.env.MB_FILE_LOG === "1";

const CONFIG_PATH = DATA_DIR + '/auditor.cfg';
const LOG_PATH = DATA_DIR + '/log/auditor.log';
const DB_PATH = DATA_DIR + '/auditor.sqlite';
const AUDITOR_CONTRACT_PATH = DATA_DIR + (IS_DEV_MODE ? '/dist/default-contract' : '/auditor-contract');
const AUDITOR_CLIENT_PATH = DATA_DIR + (IS_DEV_MODE ? '/dist/default-client' : '/auditor-client');
const DB_TABLE_NAME = 'audit_req';

const AuditStatus = {
    CREATED: 'Created',
    ASSIGNED: 'Assigned',
    CASHED: 'Cashed',
    REDEEMED: 'Redeemed',
    AUDITSUCCESS: 'AuditSuccess',
    AUDITFAILED: 'AuditFailed',
    EXPIRED: 'Expired',
    FAILED: 'Failed'
}

class Auditor {
    #db = null;
    #configPath = null;
    #contractPath = null;
    #auditTable = DB_TABLE_NAME;
    #lastValidatedLedgerIdx = null;
    #curMomentStartIdx = null;

    #ongoingAudit = null;

    constructor(configPath, dbPath, contractPath, clientPath) {
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

        this.#db = new SqliteDatabase(dbPath);
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

        this.userClient = new evernode.UserClient(this.cfg.xrpl.address, this.cfg.xrpl.secret, { xrplApi: this.xrplApi });
        this.evernodeHookConf = this.auditorClient.hookConfig;

        this.#db.open();
        // Create audit table if not exist.
        await this.createAuditTableIfNotExists();
        await this.initMomentInfo();
        this.#db.close();

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
                drafts: {},
                isDraft: true
            };

            try {
                this.logMessage(momentStartIdx, 'Requesting for an audit.');
                await this.createAuditRecord(momentStartIdx);
                await this.auditorClient.requestAudit();
            }
            catch (e) {
                this.#ongoingAudit = null;
                reject(e);
            }

            // Off events of previous moment, before listen to new moment.
            this.auditorClient.off(evernode.AuditorEvents.AuditAssignment);
            this.auditorClient.on(evernode.AuditorEvents.AuditAssignment, async (assignmentInfo) => {
                let hostInfo = {
                    currency: assignmentInfo.currency,
                    address: assignmentInfo.issuer,
                    amount: assignmentInfo.value
                }

                await new Promise(async (resolveEvent, rejectEvent) => {
                    try {
                        this.logMessage(momentStartIdx, `Assigned a host for audit, token - ${hostInfo.currency}`);
                        await this.updateAuditAssigned(momentStartIdx, hostInfo.currency);

                        this.#ongoingAudit.isDraft = false;
                        this.#ongoingAudit.drafts[`${momentStartIdx}${hostInfo.currency}`] = {
                            resolve: resolveEvent,
                            reject: rejectEvent
                        };

                        this.logMessage(momentStartIdx, `Cashing the hosting token, token - ${hostInfo.currency}`);
                        await this.auditorClient.cashAuditAssignment(assignmentInfo);

                        // Check whether moment is expired while waiting for cashing the audit.
                        if (!this.#checkMomentValidity(momentStartIdx))
                            throw { status: AuditStatus.EXPIRED, error: 'Moment expired while waiting for cashing the audit.' };

                        this.logMessage(momentStartIdx, `Cashed the hosting token, token - ${hostInfo.currency}`);
                        await this.updateAuditStatus(momentStartIdx, hostInfo.currency, AuditStatus.CASHED);

                        // Generating Hot pocket key pair for this audit round.
                        const bootstrapClient = new BootstrapClient();
                        const hpKeys = await bootstrapClient.generateKeys();

                        this.logMessage(momentStartIdx, `Redeeming from the host, token - ${hostInfo.currency}`);
                        const startLedger = this.xrplApi.ledgerIndex;
                        const instanceInfo = await this.sendRedeemRequest(hostInfo, hpKeys);
                        // Time took in ledgers for instance redeem.
                        const ledgerTimeTook = this.xrplApi.ledgerIndex - startLedger;

                        // Check whether moment is expired while waiting for the redeem.
                        if (!this.#checkMomentValidity(momentStartIdx))
                            throw { status: AuditStatus.EXPIRED, error: 'Moment expired while waiting for the redeem response, token - ${hostInfo.currency}' };

                        await this.updateAuditStatus(momentStartIdx, hostInfo.currency, AuditStatus.REDEEMED);

                        this.logMessage(momentStartIdx, `Auditing the host, token - ${hostInfo.currency}`);
                        const auditRes = await this.auditInstance(instanceInfo, ledgerTimeTook, momentStartIdx, bootstrapClient);

                        // Check whether moment is expired while waiting for the audit completion.
                        if (!this.#checkMomentValidity(momentStartIdx))
                            throw { status: AuditStatus.EXPIRED, error: 'Moment expired while waiting for the audit, token - ${hostInfo.currency}' };

                        if (auditRes) {
                            this.logMessage(momentStartIdx, `Audit success, token - ${hostInfo.currency}`);
                            await this.updateAuditStatus(momentStartIdx, hostInfo.currency, AuditStatus.AUDITSUCCESS);
                            await this.auditorClient.auditSuccess(hostInfo.address)
                        }
                        else {
                            this.logMessage(momentStartIdx, `Audit failed, token - ${hostInfo.currency}`);
                            await this.updateAuditStatus(momentStartIdx, hostInfo.currency, AuditStatus.AUDITFAILED);
                            await this.auditorClient.auditFail(hostInfo.address);
                        }

                        delete this.#ongoingAudit.drafts[`${momentStartIdx}${hostInfo.currency}`];
                        resolveEvent();
                    }
                    catch (e) {
                        rejectEvent(e);
                    }
                }).catch(async e => {
                    this.logMessage(momentStartIdx, 'Audit error - ', e);
                    delete this.#ongoingAudit.drafts[`${momentStartIdx}${hostInfo.currency}`];
                    if (e.status && e.status === AuditStatus.EXPIRED)
                        await this.updateAuditStatus(momentStartIdx, hostInfo.currency, AuditStatus.EXPIRED);
                    else
                        await this.updateAuditStatus(momentStartIdx, hostInfo.currency, AuditStatus.FAILED);
                });
            });
        });
    }

    async auditCycle(momentStartIdx) {
        this.#db.open();

        // Before this moment cycle, we expire the old draft audits.
        if (this.#ongoingAudit && this.#ongoingAudit.momentStartIdx < momentStartIdx) {
            for (const key of Object.keys(this.#ongoingAudit.drafts))
                this.#ongoingAudit.drafts[key].reject({ status: AuditStatus.EXPIRED, error: 'Audit has been expired.' });

            if (this.#ongoingAudit.isDraft)
                this.#ongoingAudit.reject({ status: AuditStatus.EXPIRED, error: 'Audit has been expired.' });
            else
                this.#ongoingAudit.resolve();
            this.#ongoingAudit = null;
        }

        try {
            await this.#handleAudit(momentStartIdx);
        }
        catch (e) {
            this.logMessage(momentStartIdx, 'Audit error - ', e);
            if (e.status && e.status === AuditStatus.EXPIRED)
                await this.updateAuditStatus(momentStartIdx, null, AuditStatus.EXPIRED);
            else
                await this.updateAuditStatus(momentStartIdx, null, AuditStatus.FAILED);
        }

        this.#db.close();
    }

    #checkMomentValidity(momentStartIdx) {
        return (momentStartIdx == this.#curMomentStartIdx);
    }

    async auditInstance(instanceInfo, ledgerTimeTook, momentStartIdx, client) {
        // Redeem audit threshold is take as half the moment size.
        const redeemThreshold = this.evernodeHookConf.momentSize / 2;
        if (ledgerTimeTook >= redeemThreshold) {
            console.error(`Redeem took too long. (Took: ${ledgerTimeTook} Threshold: ${redeemThreshold}) Audit failed`);
            return false;
        }
        // Checking connection with bootstrap contract succeeds.
        const connectSuccess = await client.connect(instanceInfo);

        if (!this.#checkMomentValidity(momentStartIdx))
            throw { status: AuditStatus.EXPIRED, error: 'Moment expired while waiting for the host connection.' };

        if (!connectSuccess) {
            console.error('Bootstrap contract connection failed.');
            return false;
        }

        // Checking whether the bootstrap contract is alive.
        const isBootstrapRunning = await client.checkStatus();

        if (!this.#checkMomentValidity(momentStartIdx))
            throw { status: AuditStatus.EXPIRED, error: 'Moment expired while waiting for the bootstrap contract status.' };

        if (!isBootstrapRunning) {
            console.error('Bootstrap contract status is not live.');
            return false;
        }

        // Checking the file upload to bootstrap contract succeeded.
        const uploadSuccess = await client.uploadContract(this.#contractPath);

        if (!this.#checkMomentValidity(momentStartIdx))
            throw { status: AuditStatus.EXPIRED, error: 'Moment expired while uploading the contract bundle.' };

        if (!uploadSuccess) {
            console.error('Contract upload failed.');
            return false;
        }

        // Run custom auditor contract related logic.
        const auditLogicSuccess = await this.audit(instanceInfo.ip, instanceInfo.user_port);
        if (!auditLogicSuccess) {
            console.error('Custom audit process informed fail status.');
            return false;
        }
        return true;
    }

    async sendRedeemRequest(hostInfo, keys) {
        const response = await this.userClient.redeem(hostInfo.currency, hostInfo.address, hostInfo.amount, this.getInstanceRequirements(keys), { timeout: 30000 });
        return response.instance;
    }

    async initMomentInfo() {
        this.#lastValidatedLedgerIdx = this.xrplApi.ledgerIndex;
        const relativeN = Math.floor((this.#lastValidatedLedgerIdx - this.evernodeHookConf.momentBaseIdx) / this.evernodeHookConf.momentSize);
        this.#curMomentStartIdx = this.evernodeHookConf.momentBaseIdx + (relativeN * this.evernodeHookConf.momentSize);
        if (!this.draftAudits)
            this.draftAudits = [];

        const draftAudits = await this.getDraftAuditRecords();
        if (draftAudits && draftAudits.length) {
            // If there's any pending audits handle them. This will be implemented later.
            // If there's expired audits, Update their db status.
            const expiredDrafts = draftAudits.filter(a => a.moment_start_idx <= this.#curMomentStartIdx);
            if (expiredDrafts && expiredDrafts.length) {
                this.logMessage(expiredDrafts.map(a => a.moment_start_idx).join(', '), 'Audit has been expired.');
                await this.updateAuditStatusByIds(AuditStatus.EXPIRED, expiredDrafts.map(a => a.id));
            }
        }
    }

    async createAuditTableIfNotExists() {
        // Create table if not exists.
        await this.#db.createTableIfNotExists(this.#auditTable, [
            { name: 'id', type: DataTypes.INTEGER, primary: true, notNull: true },
            { name: 'timestamp', type: DataTypes.INTEGER, notNull: true },
            { name: 'moment_start_idx', type: DataTypes.INTEGER, notNull: true },
            { name: 'hosting_token', type: DataTypes.TEXT, notNull: false },
            { name: 'status', type: DataTypes.TEXT, notNull: true }
        ]);
    }

    async getDraftAuditRecords() {
        return (await this.#db.getValuesIn(this.#auditTable, { status: [AuditStatus.CREATED, AuditStatus.ASSIGNED, AuditStatus.CASHED, AuditStatus.REDEEMED] }));
    }

    async getAuditRecords(momentStartIdx) {
        return (await this.#db.getValues(this.#auditTable, { moment_start_idx: momentStartIdx }));
    }

    async createAuditRecord(momentStartIdx) {
        await this.#db.insertValue(this.#auditTable, {
            timestamp: Date.now(),
            moment_start_idx: momentStartIdx,
            status: AuditStatus.CREATED
        });
    }

    async updateAuditAssigned(momentStartIdx, hostingToken) {
        const auditRecords = await this.getAuditRecords(momentStartIdx);
        const createdRecord = auditRecords.find(a => a.status === AuditStatus.CREATED);
        if (createdRecord) {
            await this.#db.updateValue(this.#auditTable, {
                hosting_token: hostingToken,
                status: AuditStatus.ASSIGNED
            }, { moment_start_idx: createdRecord.moment_start_idx, hosting_token: createdRecord.hosting_token, status: createdRecord.status });
        }
        else {
            await this.#db.insertValue(this.#auditTable, {
                timestamp: auditRecords[0].timestamp,
                moment_start_idx: auditRecords[0].moment_start_idx,
                hosting_token: hostingToken,
                status: AuditStatus.ASSIGNED
            });
        }
    }

    async updateAuditStatus(momentStartIdx, hostingToken, status) {
        await this.#db.updateValue(this.#auditTable, {
            status: status
        }, { moment_start_idx: momentStartIdx, hosting_token: hostingToken });
    }

    async updateAuditStatusByIds(status, ids) {
        await this.#db.updateValuesIn(this.#auditTable, { status: status }, { id: ids });
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

    const auditor = new Auditor(CONFIG_PATH, DB_PATH, AUDITOR_CONTRACT_PATH, AUDITOR_CLIENT_PATH);
    await auditor.init(RIPPLED_URL);
}

main().catch(console.error);