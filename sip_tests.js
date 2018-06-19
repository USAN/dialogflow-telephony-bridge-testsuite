'use strict';

const winston = require('winston');
const mocha = require('mocha');
const net = require('net');
const expect = require('chai').expect;
const assert = require('chai').assert;
const Promise = require('promise');
const TestClient = require('./sip_test_client');


let host = process.env.HOST;
winston.info(`host: ${host}`);
let astAddress = host.split(':')[0];
let astSipPort = host.split(':')[1] || 5060;

let username = process.env.USER;
let password = process.env.PASSWORD;

describe("sip tests", function() {
    var client;
    var call;
    before(function() {
        client = new TestClient(7060, 10000, 11000);
    });
    it("responds", function(done) {
        client.verifyPeer(astAddress, astSipPort, (err, msg) => {
            expect(msg).to.have.property('status');
            expect(msg.status).to.not.equal(408);
            done();
        });
    });
    it("answers", function() {
        return new Promise((resolve, reject) => {
            call = client.startCall("dialogflow", "test", astAddress, astSipPort, null, process.env.USER, process.env.PASSWORD);
            call.on('answer', (resp) => {
                expect(resp.status).to.equal(200);
                resolve(resp);
            });
            call.on('fail', (resp) => {
                reject(`Got ${resp.status} on INVITE`);
            });
        });
    }).timeout(30000);
    it("receives audio", function() {
        return new Promise((resolve, reject) => {
            call.once('audio', () => { resolve(); });
        });
    }).timeout(5000);
    it("hangs up", function() {
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                call.hangup(16);
                call.on('hangup', (resp) => {
                    resolve();
                });
            }, 500);
        });
    });
    after(function() {
        winston.info("Stopping SIP client");
        client.stop();
    });
});

// describe("sip tcp tests", function() {
//     var client;
//     var call;
//     before(function() {
//         client = new TestClient(7060, 10000, 11000, "TCP");
//     });
//     it("responds", function(done) {
//         client.verifyPeer(astAddress, astSipPort, (err, msg) => {
//             expect(msg).to.have.property('status');
//             expect(msg.status).to.not.equal(408);
//             done();
//         });
//     });
//     it("answers", function() {
//         return new Promise((resolve, reject) => {
//             call = client.startCall("test", "test", astAddress, astSipPort);
//             call.on('answer', (resp) => {
//                 expect(resp.status).to.equal(200);
//                 resolve(resp);
//             });
//             call.on('fail', (resp) => {
//                 reject(`Got ${resp.status} on INVITE`);
//             });
//         });
//     }).timeout(30000);
//     it("receives audio", function() {
//         return new Promise((resolve, reject) => {
//             call.once('audio', () => { resolve(); });
//         });
//     }).timeout(5000);
//     it("hangs up", function() {
//         return new Promise((resolve, reject) => {
//             setTimeout(() => {
//                 call.hangup(16);
//                 call.on('hangup', (resp) => {
//                     resolve();
//                 });
//             }, 500);
//         });
//     });
//     after(function() {
//         winston.info("Stopping SIP client");
//         client.stop();
//     });
// });
