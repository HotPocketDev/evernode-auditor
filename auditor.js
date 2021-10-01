const fs = require('fs');
const logger = require('./lib/logger');
const { RippleAPIWarpper, Events } = require('./lib/ripple-handler');
const { SqliteDatabase, DataTypes } = require('./lib/sqlite-handler');

const CONFIG_PATH = 'auditor.cfg';
const DB_PATH = 'auditor.sqlite';
const LOG_PATH = 'auditor.log';
const DB_TABLE_NAME = 'audit_req';
const MOMENT_BASE_INDEX = 0;
const LEDGERS_PER_MOMENT = 72;


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
    constructor(configPath, dbPath, rippleServer) {
        this.configPath = configPath;
        this.auditTable = DB_TABLE_NAME;

        if (!fs.existsSync(this.configPath))
            throw `${this.configPath} does not exist.`;

        this.ripplAPI = new RippleAPIWarpper(rippleServer);
        this.db = new SqliteDatabase(dbPath);
    }

    async init() {
        this.readConfig();
        if (!this.cfg.xrpl.address || !this.cfg.xrpl.secret || !this.cfg.xrpl.hookAddress)
            throw "Required cfg fields cannot be empty.";

        try { await this.ripplAPI.connect(); }
        catch (e) { throw e; }

        this.db.open();
        // Create audit table if not exist.
        await this.createAuditTableIfNotExists();
        await this.initMomentInfo();
        this.db.close();

        // Keep listening to ripple ledger creations and keep track of moments.
        this.ripplAPI.events.on(Events.LEDGER, async (e) => {
            this.lastValidatedLedgerIdx = e.ledgerVersion;
            // If this is the start of a new moment.
            if ((this.lastValidatedLedgerIdx - MOMENT_BASE_INDEX) % LEDGERS_PER_MOMENT === 0) {
                this.curMomentStartIdx = this.lastValidatedLedgerIdx;
                // Start the audit cycle for the moment.
                try { await this.auditCycle(this.curMomentStartIdx); }
                catch (e) {
                    console.log(`Audit request failed: ${e}`);
                }
            }
        });
    }

    async auditCycle(momentStartIdx) {
        this.db.open();

        // Before this moment cycle, we expire the old draft audits.
        for (const moment of this.draftAudits) {
            console.log(`Audit for the moment ${moment} has been expired.`)
            this.expireTheAudit(moment);
        }

        console.log(`Requesting for an audit at ${momentStartIdx}`);
        await this.createAuditRecord(momentStartIdx);
        this.setAsDraft(momentStartIdx);

        this.db.close();

        return new Promise((resolve, reject) => {
            this.sendAuditRequest().then(async (hostInfo) => {
                this.db.open();

                // If the moment is expired when the response received, we just expire the audit.
                if (momentStartIdx < this.curMomentStartIdx) {
                    this.expireTheAudit(momentStartIdx);
                    reject(`Audit for the moment ${momentStartIdx} has been expired.`);
                    return;
                }

                await this.updateAuditCashed(momentStartIdx, hostInfo.hostingToken);

                console.log(`Auditing the host with token ${hostInfo.hostingToken}`);
                const success = await this.audit(hostInfo);

                // If the moment is expired when the audit response received, we just expire the audit.
                if (momentStartIdx < this.curMomentStartIdx) {
                    this.expireTheAudit(momentStartIdx);
                    reject(`Audit for the moment ${momentStartIdx} has been expired.`);
                    return;
                }

                if (success) {
                    console.log(`Host with token ${hostInfo.hostingToken} has passed the audit.`);
                    await this.updateAuditStatus(momentStartIdx, AuditStatus.AUDITSUCCESS);
                    await this.sendAuditSuccess(hostInfo);
                }
                else {
                    console.log(`Host with token ${hostInfo.hostingToken} has failed the audit.`);
                    await this.updateAuditStatus(momentStartIdx, AuditStatus.AUDITFAILED);
                }

                this.db.close();
                resolve();
            }).catch(async (e) => {
                this.db.open();
                await this.updateAuditStatus(momentStartIdx, AuditStatus.FAILED);
                this.db.close();
                reject(e);
            }).finally(() => {
                this.removeFromDraft(momentStartIdx);
            });
        });
    }

    setAsDraft(momentStartIdx) {
        this.draftAudits.push(momentStartIdx);
    }

    removeFromDraft(momentStartIdx) {
        const i = this.draftAudits.indexOf(momentStartIdx);
        if (i > -1)
            this.draftAudits.splice(i, 1);
    }

    async audit(hostInfo) {
        const instanceInfo = await this.sendRedeemRequest(hostInfo);
        this.updateAuditStatus(this.curMomentStartIdx, AuditStatus.REDEEMED);

        return new Promise(resolve => {
            setTimeout(() => {
                resolve(true);
            }, 10000);
        })
    }

    async sendAuditRequest() {
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve({
                    hostingToken: 'HTK',
                    issues: '-----------------------'
                });
            }, 100);
        })
    }

    async sendAuditSuccess() {
    }

    async sendRedeemRequest(hostInfo) {
    }

    async expireTheAudit(momentStartIdx) {
        await this.updateAuditStatus(momentStartIdx, AuditStatus.EXPIRED);
        this.removeFromDraft(momentStartIdx);
    }

    async initMomentInfo() {
        this.lastValidatedLedgerIdx = await this.ripplAPI.getLedgerVersion();
        const relativeN = (this.lastValidatedLedgerIdx - MOMENT_BASE_INDEX) / LEDGERS_PER_MOMENT;
        this.curMomentStartIdx = MOMENT_BASE_INDEX + (relativeN * LEDGERS_PER_MOMENT);

        if (!this.draftAudits)
            this.draftAudits = [];
        const draftAudits = await this.getDraftAuditRecords();
        if (draftAudits && draftAudits.length) {
            for (const draftAudit of draftAudits) {
                if (draftAudit.moment_start_idx < this.curMomentStartIdx)
                    this.setAsDraft(draftAudit.moment_start_idx);
                else {
                    // Need to handle already created audit requests here.
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
        return (await this.db.getValues(this.auditTable, { status: AuditStatus.CREATED }));
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

    readConfig() {
        this.cfg = JSON.parse(fs.readFileSync(this.configPath).toString());
    }

    persistConfig() {
        fs.writeFileSync(this.configPath, JSON.stringify(this.cfg, null, 2));
    }
}

async function main() {
    const args = process.argv;

    // This is used for logging purposes.
    // Logs are formatted with the timestamp and a log file will be created inside log directory.
    if (args.includes('--enable-logging'))
        logger.init(LOG_PATH);

    if (args.length < 3)
        throw "Arguments mismatch.\n Usage: node auditor <ripple server url>";

    console.log('Starting the auditor' + (args[3] == '--dev' ? ' (in dev mode)' : ''));

    // Read Ripple Server Url.
    const rippleServer = args[2];
    const auditor = new Auditor(CONFIG_PATH, DB_PATH, rippleServer);
    await auditor.init();
}

main().catch(console.error);