const { v4: uuidv4 } = require('uuid');
const HotPocket = require('hotpocket-js-client');

class AuditorClient {
    constructor(auditTimeout, tests) {
        this.auditTimeout = auditTimeout;
        this.tests = tests;

        this.resolvers = {
            rr: {},
            ci: {}
        };
        this.promises = [];
    }

    returnAuditResult = () => {
        // Just create a resultset for loggin purpose.
        const auditOutput = {
            readRequests: [],
            contractInputs: []
        }
        for (let [i, key] of Object.keys(this.resolvers['rr']).entries()) {
            const rr = this.resolvers['rr'][key];
            auditOutput.readRequests.push({
                input: rr.input,
                success: rr.success,
                time: rr.outTime ? `${rr.outTime - rr.inTime}ms` : null
            });
        }
        for (let [i, key] of Object.keys(this.resolvers['ci']).entries()) {
            const ci = this.resolvers['ci'][key]
            auditOutput.contractInputs.push({
                input: ci.input,
                success: ci.success,
                time: ci.outTime ? `${ci.outTime - ci.inTime}ms` : null
            });
        }

        // If all the results are success, return true.
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
        // Send contract inputs and read requests.
        // Prepare promises and resolvers.
        let submitRes;
        let key;
        const id = uuidv4();
        const input = JSON.stringify({
            id: id,
            input: test.input
        });
        const inTime = new Date().getTime();
        if (isReadRequest) {
            key = 'rr';
            submitRes = await this.hpc.sendContractReadRequest(input);
        }
        else {
            key = 'ci';
            submitRes = await this.hpc.submitContractInput(input);
        }

        this.promises.push(new Promise((resolve, reject) => {
            let completed = false;
            // Resolvers are stores against the input id.
            this.resolvers[key][id] = {
                resolve: (e) => {
                    resolve(e);
                    completed = true;
                },
                reject: (e) => {
                    reject(e);
                    completed = true;
                },
                inTime: inTime,
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
                this.resolvers[key][id].reject(submission.reason);
        }
    }

    handleOutput = (output, isReadRequest = false) => {
        // Validate received outputs and handle the resolvers.
        const obj = JSON.parse(output);
        const id = obj.id;
        const resolver = this.resolvers[isReadRequest ? 'rr' : 'ci'][id];
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
        // Full audit process.
        try {
            // Generate or fetch existing keys.
            const keys = await HotPocket.generateKeys();

            const pkhex = Buffer.from(keys.publicKey).toString('hex');
            console.log('My public key is: ' + pkhex);

            this.hpc = await HotPocket.createClient([`wss://${ip}:${userPort}`], keys, { protocol: HotPocket.protocols.bson });

            // Establish HotPocket connection.
            // If failed audit process is failed.
            if (!await this.hpc.connect()) {
                console.log('Returning false.....');
                console.log('Connection failed.');
                return false;
            }
            console.log('HotPocket Connected.');

            // This will get fired if HP server disconnects unexpectedly.
            this.hpc.on(HotPocket.events.disconnect, () => {
                console.log('Disconnected');
            })

            // This will get fired when contract sends an output.
            this.hpc.on(HotPocket.events.contractOutput, (r) => {
                r.outputs.forEach(output => {
                    this.handleOutput(output);
                });
            });

            // This will get fired when contract sends an read request result.
            this.hpc.on(HotPocket.events.contractReadResponse, (output) => {
                this.handleOutput(output, true);
            });

            // Send test inputs and read requests.
            for (let test of this.tests) {
                await this.handleInput(test);
                await this.handleInput(test, true);
            }

            // Wait for the result.
            await Promise.all(this.promises);
            // Log output and return.
            return this.returnAuditResult();
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
    // Test inputs and expected output.
    const testcases = [
        {
            input: 'This is invalid input [||]',
            output: 'INVALID_INPUT'
        },
        {
            input: 'This is valid input(*)45',
            output: 'This is valid input'.repeat(45)
        },
        {
            input: '1234567891011121314151617181920(*)100',
            output: '1234567891011121314151617181920'.repeat(100)
        },
        {
            input: 'This is valid input 1234567891011121314151617181920(*)500',
            output: 'This is valid input 1234567891011121314151617181920'.repeat(500)
        }
    ];
    const auditorClient = new AuditorClient(5000, testcases);
    return (await auditorClient.audit(ip, userPort));
}