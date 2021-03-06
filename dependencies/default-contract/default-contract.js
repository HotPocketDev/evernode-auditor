const fs = require('fs');
const HotPocket = require("hotpocket-nodejs-contract");

const exectsFile = "exects.txt";

// HP smart contract is defined as a function which takes HP ExecutionContext as an argument.
// HP considers execution as complete, when this function completes and all the NPL message callbacks are complete.
const auditContract = async (ctx) => {

    // We just save execution timestamp as an example state file change.
    if (!ctx.readonly) {
        fs.appendFileSync(exectsFile, "ts:" + ctx.timestamp + "\n");

        const stats = fs.statSync(exectsFile);
        if (stats.size > 100 * 1024 * 1024) // If more than 100 MB, empty the file.
            fs.truncateSync(exectsFile);
    }

    // Collection of per-user promises to wait for. Each promise completes when inputs for that user is processed.
    const userHandlers = [];

    for (const user of ctx.users.list()) {

        // This user's hex pubkey can be accessed from 'user.pubKey'

        // For each user we add a promise to list of promises.
        userHandlers.push(new Promise(async (resolve) => {

            // The contract need to ensure that all outputs for a particular user is emitted
            // in deterministic order. Hence, we are processing all inputs for each user sequentially.
            for (const input of user.inputs) {

                const buf = await ctx.users.read(input);
                const msg = JSON.parse(buf);

                // Contract logic is to reapeat a string and concat.
                // Input pattern should be {some text}(*){number of times}.
                // If input does not match the patter return error.
                // Input id is forwarded so client side can identify the outputs respective to the input.
                let output;
                if (!(/^([a-zA-Z0-9\s]{5,}\(\*\)[0-9]*)$/.test(msg.input))) {
                    output = {
                        id: msg.id,
                        output: "INVALID_INPUT",
                        ts: fs.readFileSync("exects.txt").toString()
                    };
                }
                else {
                    const args = msg.input.split("(*)");
                    const text = args[0];
                    const n = parseInt(args[1]);
                    output = "";
                    for (let i = 0; i < n; i++)
                        output += text;
                    output = {
                        id: msg.id,
                        output: output,
                        ts: fs.readFileSync("exects.txt").toString()
                    };
                }

                await user.send(output);

            }

            // The promise gets completed when all inputs for this user are processed.
            resolve();
        }));
    }

    // Wait until all user promises are complete.
    await Promise.all(userHandlers);
}

const hpc = new HotPocket.Contract();
hpc.init(auditContract);