'use strict';

const winston = require('winston');
const mocha = require('mocha');
const net = require('net');
const expect = require('chai').expect;
const assert = require('chai').assert;
const Promise = require('promise');
const TestClient = require('./sip_test_client');
const fs = require('fs');

let host = process.env.HOST;
let svc = process.env.SVC;
winston.info(`host: ${host}`);
let astAddress = host.split(':')[0];
let astSipPort = host.split(':')[1] || 5060;

let username = process.env.USER;
let password = process.env.PASSWORD;

let coffee_please_audio = fs.readFileSync("coffee_please.ul");

describe("dfe tests", function() {
    var client;
    var call;
    before(function() {
        client = new TestClient(8060, 12000, 13000);
    });
    after(function() {
        winston.info("Stopping SIP client");
        client.stop();
    });
    it("answers", function() {
        return new Promise((resolve, reject) => {
            call = client.startCall("dialogflow", svc, astAddress, astSipPort, null, username, password);
            call.on('answer', (resp) => {
                expect(resp.status).to.equal(200);
                resolve(resp);
            });
            call.on('fail', (resp) => {
                reject(`Got ${resp.status} on INVITE`);
            });
        });
    }).timeout(30000);
    it("listens", function() {
        return new Promise((resolve, reject) => {
            call.playAudio(coffee_please_audio, resolve);
        });
    }).timeout(60000);
    it("hangs up", function() {
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                call.hangup(16);
                call.on('hangup', (resp) => {
                    resolve();
                });
            }, 5000);
        });
    }).timeout(20000);
    
});