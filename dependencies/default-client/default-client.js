const fs = require('fs');
const readline = require('readline');
const bson = require('bson');
var path = require("path");
const HotPocket = require('./lib/hp-client-lib');

async function main() {
    const workingDir = "datadir/";

    /**
     * We persist the public key since we are hardcoding the public key in the messaging board.
    */
    if (!fs.existsSync(workingDir))
        fs.mkdirSync(workingDir);

    const keyfile = workingDir + "sashimono-client.key";
    const savedPrivateKey = fs.existsSync(keyfile) ? fs.readFileSync(keyfile, 'utf8') : null;
    const keys = await HotPocket.generateKeys(savedPrivateKey);
    fs.writeFileSync(keyfile, Buffer.from(keys.privateKey).toString("hex"));


    const pkhex = Buffer.from(keys.publicKey).toString('hex');
    console.log('My public key is: ' + pkhex);

    let server = 'wss://localhost:8080'
    if (process.argv.length == 3) server = 'wss://localhost:' + process.argv[2]
    if (process.argv.length == 4) server = 'wss://' + process.argv[2] + ':' + process.argv[3]
    const hpc = await HotPocket.createClient([server], keys, { protocol: HotPocket.protocols.bson });

    // Establish HotPocket connection.
    if (!await hpc.connect()) {
        console.log('Connection failed.');
        return;
    }
    console.log('HotPocket Connected.');

    // start listening for stdin
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    // On ctrl + c we should close HP connection gracefully.
    rl.on('SIGINT', () => {
        console.log('SIGINT received...');
        rl.close();
        hpc.close();
    });

    // This will get fired if HP server disconnects unexpectedly.
    hpc.on(HotPocket.events.disconnect, () => {
        console.log('Disconnected');
        rl.close();
    })

    // This will get fired when contract sends an output.
    hpc.on(HotPocket.events.contractOutput, (r) => {

        r.outputs.forEach(output => {
            // If bson.deserialize error occured it'll be caught by this try catch.
            try {
                const result = bson.deserialize(output);
                if (result.type == "uploadResult") {
                    if (result.status == "ok")
                        console.log(`(ledger:${r.ledgerSeqNo})>> ${result.message}`);
                    else
                        console.log(`(ledger:${r.ledgerSeqNo})>> Zip upload failed. reason: ${result.status}`);
                }
                else if (result.type == "statusResult") {
                    if (result.status == "ok")
                        console.log(`(ledger:${r.ledgerSeqNo})>> ${result.message}`);
                    else
                        console.log(`(ledger:${r.ledgerSeqNo})>> Status failed. reason: ${result.status}`);
                }
                else {
                    console.log("Unknown contract output.");
                }
            }
            catch (e) {
                console.log(e)
            }
        });
    })

    console.log("Ready to accept inputs.");

    const input_pump = () => {
        rl.question('', async (inp) => {
            if (inp.startsWith("status")) {
                const input = await hpc.submitContractInput(bson.serialize({
                    type: "status"
                }));

                const submission = await input.submissionStatus;
                if (submission.status != "accepted")
                    console.log("Status failed. reason: " + submission.reason);
            }
            else if (inp.startsWith("upload ")) {

                const filePath = inp.substr(7);
                const fileName = path.basename(filePath);
                if (fs.existsSync(filePath)) {
                    const fileContent = fs.readFileSync(filePath);
                    const sizeKB = Math.round(fileContent.length / 1024);
                    console.log("Uploading file " + fileName + " (" + sizeKB + " KB)");

                    const input = await hpc.submitContractInput(bson.serialize({
                        type: "upload",
                        content: fileContent
                    }));

                    const submission = await input.submissionStatus;
                    if (submission.status != "accepted")
                        console.log("Upload failed. reason: " + submission.reason);
                }
                else
                    console.log("File not found");
            }
            else {
                console.log("Invalid command. [status] or [upload <local path>] expected.")
            }

            input_pump();
        })
    }
    input_pump();
}

main();