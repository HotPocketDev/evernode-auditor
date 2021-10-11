const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const HotPocket = require('hotpocket-js-client');

class AuditorClient {
    constructor(workingDir, keyFile, auditTimeout, tests) {
        this.auditTimeout = auditTimeout;
        this.workingDir = workingDir;
        this.keyFilePath = `${this.workingDir}/${keyFile}`;
        this.tests = tests;

        this.resolvers = {
            rr: {},
            ci: {}
        };
        this.promises = [];

        if (!fs.existsSync(this.workingDir))
            fs.mkdirSync(this.workingDir);
    }

    returnAuditResult = () => {
        const auditOutput = {
            readRequests: [],
            contractInputs: []
        }
        for (let [i, key] of Object.keys(resolvers['rr']).entries()) {
            const rr = resolvers['rr'][key];
            auditOutput.readRequests.push({
                input: rr.input,
                success: rr.success,
                time: rr.outTime ? `${rr.outTime - rr.inTime}ms` : null
            });
        }
        for (let [i, key] of Object.keys(resolvers['ci']).entries()) {
            const ci = resolvers['ci'][key]
            auditOutput.contractInputs.push({
                input: ci.input,
                success: ci.success,
                time: ci.outTime ? `${ci.outTime - ci.inTime}ms` : null
            });
        }

        if (!auditOutput.readRequests.find(o => !o.success) && !auditOutput.contractInputs.find(o => !o.success)) {
            console.log('Returning true.....');
            console.log('Audit success');
            console.log(auditOutput);
            return true;
        }
        else {
            console.log('Returning false.....');
            console.log('Audit failed');
            console.log(auditOutput);
            return false;
        }
    }

    handleInput = async (test, isReadRequest = false) => {
        let submitRes;
        const id = uuidv4();
        const input = JSON.stringify({
            id: id,
            input: test.input
        });
        if (isReadRequest) {
            key = 'rr';
            submitRes = await this.hpc.sendContractReadRequest(input);
        }
        else {
            key = 'ci';
            submitRes = await this.hpc.submitContractInput(input);
        }

        promises.push(new Promise((resolve, reject) => {
            let completed = false;
            resolvers[key][id] = {
                resolve: (e) => {
                    resolve(e);
                    completed = true;
                },
                reject: (e) => {
                    reject(e);
                    completed = true;
                },
                inTime: new Date().getTime(),
                input: test.input,
                output: test.output,
                success: false
            }
            setTimeout(() => {
                if (!completed)
                    reject('Input timeout reached.');
            }, this.auditTimeout);
        }));

        if (!isReadRequest) {
            const submission = await submitRes.submissionStatus;
            if (submission.status != "accepted")
                resolvers[key][id].reject(submission.reason);
        }
    }

    handleOutput = (output, isReadRequest = false) => {
        const obj = JSON.parse(output);
        const id = obj.id;
        const resolver = resolvers[isReadRequest ? 'rr' : 'ci'][id];
        if (!resolver) {
            console.log('Output for unawaited input');
            return;
        }

        const receivedOutput = obj.output;
        const actualOutput = resolver.output;
        const ts = obj.ts;
        resolver.outTime = new Date().getTime();
        if (ts && (receivedOutput === actualOutput)) {
            resolver.resolve(true);
            resolver.success = true;
        }
        else
            resolver.resolve(false);
    }

    audit = async (ip, userPort) => {
        const savedPrivateKey = fs.existsSync(this.keyFilePath) ? fs.readFileSync(this.keyFilePath, 'utf8') : null;
        const keys = await HotPocket.generateKeys(savedPrivateKey);
        fs.writeFileSync(this.keyFilePath, Buffer.from(keys.privateKey).toString("hex"));

        const pkhex = Buffer.from(keys.publicKey).toString('hex');
        console.log('My public key is: ' + pkhex);

        this.hpc = await HotPocket.createClient([`wss://${ip}:${userPort}`], keys, { protocol: HotPocket.protocols.bson });

        // Establish HotPocket connection.
        if (!await hpc.connect()) {
            console.log('Returning false.....');
            console.log('Connection failed.');
            return false;
        }
        console.log('HotPocket Connected.');

        // This will get fired if HP server disconnects unexpectedly.
        hpc.on(HotPocket.events.disconnect, () => {
            console.log('Disconnected');
            rl.close();
        })

        // This will get fired when contract sends an output.
        hpc.on(HotPocket.events.contractOutput, (r) => {
            r.outputs.forEach(output => {
                handleOutput(output);
            });
        });

        hpc.on(HotPocket.events.contractReadResponse, (output) => {
            handleOutput(output, true);
        });

        try {
            for (let test of this.tests) {
                await handleInput(hpc, test);
                await handleInput(hpc, test, true);
            }

            await Promise.all(promises);
            return returnAuditResult();
        }
        catch (e) {
            console.log('Returning false.....');
            console.log(e);
            return false;
        }
    }
}

// Logic inside this audit function might deffer according to the audit.
exports.audit = async (ip, userPort) => {
    const testcases = [
        {
            input: 'gfdddfgfdf789sfkhjhhda][',
            output: 'INVALID_INPUT'
        },
        {
            input: 'sdfsdfsd(*)45',
            output: 'sdfsdfsd'.repeat(45)
        },
        {
            input: '564646546(*)100',
            output: '564646546'.repeat(100)
        },
        {
            input: 'sdfsdsgd654645fsd(*)500',
            output: 'sdfsdsgd654645fsd'.repeat(500)
        }
    ];
    const auditorClient = new AuditorClient("data", "client.key", 5000, testcases);
    return (await auditorClient.audit(ip, userPort));
}