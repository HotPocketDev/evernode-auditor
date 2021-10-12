const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { EvernodeClient } = require('evernode-js-client');
const { SqliteDatabase, DataTypes } = require('./lib/sqlite-handler');

// Environment variables.
const RIPPLED_URL = process.env.RIPPLED_URL || "wss://hooks-testnet.xrpl-labs.com";
const DATA_DIR = process.env.DATA_DIR || ".";
const IS_DEV_MODE = process.env.DEV === "1";

const CONFIG_PATH = DATA_DIR + '/auditor.cfg';
const DB_PATH = DATA_DIR + '/auditor.sqlite';
const AUDITOR_CONTRACT_PATH = DATA_DIR + (IS_DEV_MODE ? '/dependencies/default-contract/default-contract.js' : '/auditor-contract');
const AUDITOR_CLIENT_PATH = DATA_DIR + (IS_DEV_MODE ? '/dependencies/default-client/default-client.js' : '/auditor-client');
const AUDITOR_CONTRACT_CFG = DATA_DIR + (IS_DEV_MODE ? '/dependencies/contract-template.config' : '/contract-template.config');
const DB_TABLE_NAME = 'audit_req';
const MOMENT_BASE_INDEX = 0;
const LEDGERS_PER_MOMENT = 72;

// Instance requirement constants.
const OWNER_PUBKEY = 'ed5cb83404120ac759609819591ef839b7d222c84f1f08b3012f490586159d2b50';
const INSTANCE_IMAGE = 'hp.latest-ubt.20.04';

const Events = {
    LEDGER: 'ledger'
}

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
    constructor(configPath, dbPath, contractPath, contractCfg, clientPath) {
        this.configPath = configPath;
        this.contractPath = contractPath;
        this.contractCfg = contractCfg;
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

    async init(rippleServer) {
        this.readConfig();
        if (!this.cfg.xrpl.address || !this.cfg.xrpl.secret || !this.cfg.xrpl.hookAddress)
            throw "Required cfg fields cannot be empty.";

        this.evernodeClient = new EvernodeClient(this.cfg.xrpl.address, this.cfg.xrpl.secret, { hookAddress: this.cfg.xrpl.hookAddress, rippledServer: rippleServer });
        this.rippleAPI = this.evernodeClient.rippleAPI;

        try { await this.evernodeClient.connect(); }
        catch (e) { throw e; }

        this.db.open();
        // Create audit table if not exist.
        await this.createAuditTableIfNotExists();
        await this.initMomentInfo();
        this.db.close();

        // Keep listening to ripple ledger creations and keep track of moments.
        this.rippleAPI.events.on(Events.LEDGER, async (e) => {
            this.lastValidatedLedgerIdx = e.ledgerVersion;
            // If this is the start of a new moment.
            if ((this.lastValidatedLedgerIdx - MOMENT_BASE_INDEX) % LEDGERS_PER_MOMENT === 0) {
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
                return;

            await this.updateAuditCashed(momentStartIdx, hostInfo.currency);

            this.logMessage(momentStartIdx, `Redeeming from the host, token - ${hostInfo.currency}`);
            const instanceInfo = await this.sendRedeemRequest(hostInfo);

            // Check whether moment is expired while waiting for the redeem.
            if (!this.checkMomentValidity(momentStartIdx))
                return;

            await this.updateAuditStatus(momentStartIdx, AuditStatus.REDEEMED);

            this.logMessage(momentStartIdx, `Auditing the host, token - ${hostInfo.currency}`);
            const auditRes = await this.auditInstance(momentStartIdx, instanceInfo);

            // Check whether moment is expired while waiting for the audit completion.
            if (!this.checkMomentValidity(momentStartIdx))
                return;

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
            this.logMessage(momentStartIdx, 'Audit error ', e);
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

    async auditInstance(momentStartIdx, instanceInfo) {
        try {
            await this.uploadAuditorContract(instanceInfo);
            console.log(instanceInfo);
            return (await this.audit(instanceInfo.ip, instanceInfo.user_port));
        }
        catch (e) {
            this.logMessage(momentStartIdx, e);
            return false;
        }
    }

    async uploadAuditorContract(instanceInfo) {
        // this.contractPath;
        // this.contractCfg;
        // Update the config file with instance data and binary details.
        // Create the zip contract bundle with contract and updated config.
        // Then upload to the instance.
        // Mocking the contract upload process, This will be implemented later.
        return new Promise(resolve => {
            setTimeout(() => {
                resolve();
            }, 1000);
        });
    }

    async sendAuditRequest() {
        return (await this.evernodeClient.requestAudit());
    }

    async sendAuditSuccess() {
        return (await this.evernodeClient.auditSuccess());
    }

    async sendRedeemRequest(hostInfo) {
        return (await this.evernodeClient.redeem(hostInfo.currency, hostInfo.address, hostInfo.amount, this.getInstanceRequirements()));
    }

    async expireDraftAudits() {
        if (this.draftAudits && this.draftAudits.length) {
            this.logMessage(this.draftAudits.join(', '), 'Audit has been expired.');
            await this.updateAuditStatuses(AuditStatus.EXPIRED, ...this.draftAudits);
            this.clearDraft();
        }
    }

    async initMomentInfo() {
        this.lastValidatedLedgerIdx = this.rippleAPI.ledgerVersion;
        const relativeN = (this.lastValidatedLedgerIdx - MOMENT_BASE_INDEX) / LEDGERS_PER_MOMENT;
        this.curMomentStartIdx = MOMENT_BASE_INDEX + (relativeN * LEDGERS_PER_MOMENT);
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

    getInstanceRequirements() {
        return {
            owner_pubkey: OWNER_PUBKEY,
            contract_id: uuidv4(),
            image: INSTANCE_IMAGE,
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
    console.log('Starting the Evernode auditor.' + (IS_DEV_MODE ? ' (in dev mode)' : ''));
    console.log('Data dir: ' + DATA_DIR);
    console.log('Rippled server: ' + RIPPLED_URL);

    // Read Ripple Server Url.
    const auditor = new Auditor(CONFIG_PATH, DB_PATH, AUDITOR_CONTRACT_PATH, AUDITOR_CONTRACT_CFG, AUDITOR_CLIENT_PATH);
    await auditor.init(RIPPLED_URL);
}

main().catch(console.error);