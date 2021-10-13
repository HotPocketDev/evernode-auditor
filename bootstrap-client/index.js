const fs = require('fs');
const bson = require('bson');
var path = require("path");
const HotPocket = require('hotpocket-js-client');
const child_process = require("child_process");

/**
 * Responsible for communciating with the bootstrap contract.
 */
class BootstrapClient {
    constructor(instanceInfo, contractPath) {
        this.hpc = null;
        this.instanceInfo = instanceInfo;
        this.contractPath = contractPath;
    }

    async connect() {
        const workingDir = path.join(__dirname, 'datadir/');

        /**
         * We persist the public key since we are hardcoding the public key in the messaging board.
        */
        if (!fs.existsSync(workingDir))
            fs.mkdirSync(workingDir);

        const keyfile = workingDir + "sashimono-client.key";
        const savedPrivateKey = fs.existsSync(keyfile) ? fs.readFileSync(keyfile, 'utf8') : null;
        console.log("Saved private key: " + savedPrivateKey);
        const keys = await HotPocket.generateKeys(savedPrivateKey);
        fs.writeFileSync(keyfile, Buffer.from(keys.privateKey).toString("hex"));


        const pkhex = Buffer.from(keys.publicKey).toString('hex');
        console.log('My public key is: ' + pkhex);
        let server = `wss://${this.instanceInfo.ip}:${this.instanceInfo.user_port}`
        this.hpc = await HotPocket.createClient([server], keys, { protocol: HotPocket.protocols.bson });

        // Establish HotPocket connection.
        if (!await this.hpc.connect()) {
            console.log('Connection failed.');
            return false;
        }
        console.log('HotPocket Connected.');

        // This will get fired if HP server disconnects unexpectedly.
        this.hpc.on(HotPocket.events.disconnect, () => {
            console.log('Disconnected');
            this.hpc = null;
        })
        return true;
    }

    async checkStatus() {
        return new Promise(async (resolve, reject) => {
            const input = await this.hpc.submitContractInput(bson.serialize({
                type: "status"
            }));

            const submission = await input.submissionStatus;
            if (submission.status != "accepted") {
                console.log("Status failed. reason: " + submission.reason);
                resolve(false);
            }

            this.hpc.on(HotPocket.events.contractOutput, (r) => {
                r.outputs.forEach(output => {
                    // If bson.deserialize error occured it'll be caught by this try catch.
                    try {
                        const result = bson.deserialize(output);
                        if (result.type == "statusResult") {
                            if (result.status == "ok") {
                                console.log(`(ledger:${r.ledgerSeqNo})>> ${result.message}`);
                                resolve(true);
                            }
                            else {
                                console.log(`(ledger:${r.ledgerSeqNo})>> Status failed. reason: ${result.status}`);
                                resolve(false);
                            }
                        }
                    }
                    catch (e) {
                        console.error(e);
                        reject(false);
                    }
                });
            })
        });
    }

    async uploadContract() {
        return new Promise(async (resolve, reject) => {
            const zipPath = path.join(__dirname, 'bundle.zip');
            try {
                // Generate zip bundle.
                const configPath = path.join(this.contractPath, '/contract.config');
                if (fs.existsSync(configPath)) {
                    const file = fs.readFileSync(configPath, 'utf8');
                    const json = JSON.parse(file);
                    json.unl = [this.instanceInfo.pubkey];
                    fs.writeFileSync(configPath, JSON.stringify(json, null, 4));
                }
                child_process.execSync(`zip -r ${zipPath} *`, {
                    cwd: this.contractPath
                });

            } catch (error) {
                console.log(error);
                reject(false);
            }
            const fileName = path.basename(zipPath);
            if (fs.existsSync(zipPath)) {
                const fileContent = fs.readFileSync(zipPath);
                const sizeKB = Math.round(fileContent.length / 1024);
                console.log("Uploading file " + fileName + " (" + sizeKB + " KB)");

                const input = await this.hpc.submitContractInput(bson.serialize({
                    type: "upload",
                    content: fileContent
                }));

                const submission = await input.submissionStatus;
                if (submission.status != "accepted") {
                    console.log("Upload failed. reason: " + submission.reason);
                    resolve(false);
                }

                this.hpc.on(HotPocket.events.contractOutput, (r) => {
                    r.outputs.forEach(output => {
                        // If bson.deserialize error occured it'll be caught by this try catch.
                        try {
                            const result = bson.deserialize(output);
                            if (result.type == "uploadResult") {
                                if (result.status == "ok") {
                                    console.log(`(ledger:${r.ledgerSeqNo})>> ${result.message}`);
                                    resolve(true);
                                }
                                else {
                                    console.log(`(ledger:${r.ledgerSeqNo})>> Zip upload failed. reason: ${result.status}`);
                                    resolve(false);
                                }
                            }
                        }
                        catch (e) {
                            console.error(e);
                            reject(false);
                        }
                    });
                })
            }
            else {
                console.log("Zip bundle not found");
                resolve(false);
            }
        });
    }

    disconnect() {
        this.hpc = null;
    }
}

module.exports = { BootstrapClient };