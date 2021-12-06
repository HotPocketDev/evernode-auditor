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
    CASHED: 'Cashed',
    REDEEMED: 'Redeemed',
    AUDITSUCCESS: 'AuditSuccess',
    AUDITFAILED: 'AuditFailed',
    EXPIRED: 'Expired',
    FAILED: 'Failed'
}

class Auditor {
    constructor(configPath, dbPath, contractPath, clientPath) {
        this.configPath = configPath;
        this.contractPath = contractPath;
        this.auditTable = DB_TABLE_NAME;

        if (!fs.existsSync(this.configPath))
            throw `${this.configPath} does not exist.`;

        if (!fs.existsSync(clientPath))
            throw `${clientPath} does not exist.`

        if (!fs.existsSync(this.contractPath))
            throw `${this.contractPath} does not exist.`

        const { audit } = require(clientPath);
        this.audit = audit;

        this.db = new SqliteDatabase(dbPath);
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

        this.db.open();
        // Create audit table if not exist.
        await this.createAuditTableIfNotExists();
        await this.initMomentInfo();
        this.db.close();

        // Keep listening to xrpl ledger creations and keep track of moments.
        this.xrplApi.on(evernode.XrplApiEvents.LEDGER, async (e) => {
            this.lastValidatedLedgerIdx = e.ledger_index;
            // If this is the start of a new moment.
            if ((this.lastValidatedLedgerIdx - this.evernodeHookConf.momentBaseIdx) % this.evernodeHookConf.momentSize === 0) {
                this.curMomentStartIdx = this.lastValidatedLedgerIdx;
                // Start the audit cycle for the moment.
                // Keep constant variable of momentStartIdx for this execution since curMomentStartIdx is changing.
                const momentStartIdx = this.curMomentStartIdx;
                try { await this.auditCycle(momentStartIdx); }
                catch (e) {
                    this.logMessage(momentStartIdx, e);
                }
            }
        });
    }

    async auditCycle(momentStartIdx) {
        this.db.open();

        // Before this moment cycle, we expire the old draft audits.
        this.expireDraftAudits();

        this.logMessage(momentStartIdx, 'Requesting for an audit.');
        await this.createAuditRecord(momentStartIdx);
        this.setAsDraft(momentStartIdx);

        try {
            const hostInfo = await this.sendAuditRequest();

            // Check whether moment is expired while waiting for the response.
            if (!this.checkMomentValidity(momentStartIdx))
                throw 'Moment expired while waiting for the audit response.';

            await this.updateAuditCashed(momentStartIdx, hostInfo.currency);

            // Generating Hot pocket key pair for this audit round.
            const bootstrapClient = new BootstrapClient();
            const hpKeys = await bootstrapClient.generateKeys();

            this.logMessage(momentStartIdx, `Redeeming from the host, token - ${hostInfo.currency}`);
            const startLedger = this.xrplApi.ledgerIndex;
            const instanceInfo = await this.sendRedeemRequest(hostInfo, hpKeys);
            // Time took in ledgers for instance redeem.
            const ledgerTimeTook = this.xrplApi.ledgerIndex - startLedger;

            // Check whether moment is expired while waiting for the redeem.
            if (!this.checkMomentValidity(momentStartIdx))
                throw 'Moment expired while waiting for the redeem response.';

            await this.updateAuditStatus(momentStartIdx, AuditStatus.REDEEMED);

            this.logMessage(momentStartIdx, `Auditing the host, token - ${hostInfo.currency}`);
            const auditRes = await this.auditInstance(instanceInfo, ledgerTimeTook, momentStartIdx, bootstrapClient);

            // Check whether moment is expired while waiting for the audit completion.
            if (!this.checkMomentValidity(momentStartIdx))
                throw 'Moment expired while waiting for the audit checks.';

            if (auditRes) {
                this.logMessage(momentStartIdx, `Audit success, token - ${hostInfo.currency}`);
                await this.updateAuditStatus(momentStartIdx, AuditStatus.AUDITSUCCESS);
                await this.sendAuditSuccess();
            }
            else {
                this.logMessage(momentStartIdx, `Audit failed, token - ${hostInfo.currency}`);
                await this.updateAuditStatus(momentStartIdx, AuditStatus.AUDITFAILED);
            }
        }
        catch (e) {
            this.logMessage(momentStartIdx, 'Audit error - ', e);
            await this.updateAuditStatus(momentStartIdx, AuditStatus.FAILED);
        }

        this.removeFromDraft(momentStartIdx);
        this.db.close();
    }

    setAsDraft(...momentStartIdxes) {
        this.draftAudits = this.draftAudits.concat(momentStartIdxes);
    }

    removeFromDraft(...momentStartIdxes) {
        this.draftAudits = this.draftAudits.filter(m => !momentStartIdxes.includes(m));
    }

    clearDraft() {
        this.draftAudits = [];
    }

    checkMomentValidity(momentStartIdx) {
        return (momentStartIdx == this.curMomentStartIdx);
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

        if (!this.checkMomentValidity(momentStartIdx))
            throw 'Moment expired while waiting for the host connection.';

        if (!connectSuccess) {
            console.error('Bootstrap contract connection failed.');
            return false;
        }

        // Checking whether the bootstrap contract is alive.
        const isBootstrapRunning = await client.checkStatus();

        if (!this.checkMomentValidity(momentStartIdx))
            throw 'Moment expired while waiting for the bootstrap contract status.';

        if (!isBootstrapRunning) {
            console.error('Bootstrap contract status is not live.');
            return false;
        }

        // Checking the file upload to bootstrap contract succeeded.
        const uploadSuccess = await client.uploadContract(this.contractPath);

        if (!this.checkMomentValidity(momentStartIdx))
            throw 'Moment expired while uploading the contract bundle.';

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

    async sendAuditRequest() {
        return (await this.auditorClient.requestAudit());
    }

    async sendAuditSuccess() {
        return (await this.auditorClient.auditSuccess());
    }

    async sendRedeemRequest(hostInfo, keys) {
        const response = await this.userClient.redeem(hostInfo.currency, hostInfo.address, hostInfo.amount, this.getInstanceRequirements(keys));
        return response.instance;
    }

    async expireDraftAudits() {
        if (this.draftAudits && this.draftAudits.length) {
            this.logMessage(this.draftAudits.join(', '), 'Audit has been expired.');
            await this.updateAuditStatuses(AuditStatus.EXPIRED, ...this.draftAudits);
            this.clearDraft();
        }
    }

    async initMomentInfo() {
        this.lastValidatedLedgerIdx = this.xrplApi.ledgerIndex;
        const relativeN = (this.lastValidatedLedgerIdx - this.evernodeHookConf.momentBaseIdx) / this.evernodeHookConf.momentSize;
        this.curMomentStartIdx = this.evernodeHookConf.momentBaseIdx + (relativeN * this.evernodeHookConf.momentSize);
        if (!this.draftAudits)
            this.draftAudits = [];

        const draftAudits = await this.getDraftAuditRecords();
        if (draftAudits && draftAudits.length) {
            // If there's expired audits, add them to tha draft list for expiration.
            // So, their db status will be updated in the next audit cycle.
            this.setAsDraft(...draftAudits.filter(a => a.moment_start_idx < this.curMomentStartIdx).map(a => a.moment_start_idx));

            // If there's any pending audits handle them. This will be implemented later.
            for (const draftAudit of draftAudits.filter(a => a.moment_start_idx == this.curMomentStartIdx)) {
                switch (draftAudit.status) {
                    case (AuditStatus.CREATED):
                        // Send audit request.
                        break;
                    case (AuditStatus.CASHED):
                        // Send redeem request.
                        break;
                    case (AuditStatus.REDEEMED):
                        // Audit the instance.
                        break;
                    default:
                        this.logMessage(draftAudit.moment_start_idx, 'Invalid audit status for the db record');
                        break;
                }
            }
        }
    }

    async createAuditTableIfNotExists() {
        // Create table if not exists.
        await this.db.createTableIfNotExists(this.auditTable, [
            { name: 'timestamp', type: DataTypes.INTEGER, notNull: true },
            { name: 'moment_start_idx', type: DataTypes.INTEGER, notNull: true },
            { name: 'hosting_token', type: DataTypes.TEXT, notNull: false },
            { name: 'status', type: DataTypes.TEXT, notNull: true }
        ]);
    }

    async getDraftAuditRecords() {
        return (await this.db.getValuesIn(this.auditTable, { status: [AuditStatus.CREATED, AuditStatus.CASHED, AuditStatus.REDEEMED] }));
    }

    async createAuditRecord(momentStartIdx) {
        await this.db.insertValue(this.auditTable, {
            timestamp: Date.now(),
            moment_start_idx: momentStartIdx,
            status: AuditStatus.CREATED
        });
    }

    async updateAuditCashed(momentStartIdx, hostingToken) {
        await this.db.updateValue(this.auditTable, {
            hosting_token: hostingToken,
            status: AuditStatus.CASHED
        }, { moment_start_idx: momentStartIdx });
    }

    async updateAuditStatus(momentStartIdx, status) {
        await this.db.updateValue(this.auditTable, { status: status }, { moment_start_idx: momentStartIdx });
    }

    async updateAuditStatuses(status, ...momentStartIdxes) {
        await this.db.updateValuesIn(this.auditTable, { status: status }, { moment_start_idx: momentStartIdxes });
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
        this.cfg = JSON.parse(fs.readFileSync(this.configPath).toString());
    }

    persistConfig() {
        fs.writeFileSync(this.configPath, JSON.stringify(this.cfg, null, 2));
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