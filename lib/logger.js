const fs = require('fs');
const path = require('path');
const util = require('util');

const formatText = (text, logType = 'dbg') => {
    const date = new Date().toISOString().
        replace(/T/, ' ').       // Replace T with a space.
        replace(/\..+/, '').     // Delete the dot and everything after.
        replace(/-/, '');     // Delete the dashes.

    return `${date} [${logType}] ${text}\n`;
}

exports.init = (logPath) => {
    const dirname = path.dirname(logPath);
    if (!fs.existsSync(dirname))
        fs.mkdirSync(dirname, { recursive: true });

    // Formating logs and printing.
    const ws = fs.createWriteStream(logPath, { flags: 'a' });
    console.log = function () {
        const text = formatText(util.format.apply(this, arguments));
        ws.write(text);
        process.stdout.write(text);
    };
    console.error = function () {
        const text = formatText(util.format.apply(this, arguments), 'err');
        ws.write(text);
        process.stderr.write(text);
    };
}