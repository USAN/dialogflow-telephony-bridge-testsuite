const winston = require('winston');
const Mocha = require('mocha');
const fs = require('fs');
const spawn = require('child_process').spawn;
const rtpfactory = require('./rtp');
const parseArgs = require('minimist');

var argv = parseArgs(process.argv.slice(2));

process.env.HOST = argv.host || process.env.HOST || "127.0.0.1:5060";
process.env.SVC = argv.svc || process.env.SVC;
process.env.USER = argv.user || process.env.USER || "dialogflow";
process.env.PASSWORD = argv.password || process.env.PASSWORD;

let run = runTests();

run.on('end', () => {
    process.exitCode = run.failures;
});

function runTests() {
    winston.info("Launching Mocha");
    var mocha = new Mocha();

    fs.readdirSync(".")
        .filter(file => { return file.match(/tests?\.js$/); })
        .forEach(file => { mocha.addFile(file); });

    mocha.exit = false; /* don't force an exit, wait for things to quiesce */

    return mocha.run();
}