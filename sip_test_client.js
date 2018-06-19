"use strict";

const sip = require('./sip/sip');
const winston = require('winston');
const EventEmitter = require('events');
const uuid = require('node-uuid');
const url = require('url');
const os = require('os');
const ip = require('ip');
const RtpStreamFactory = require('./rtp');
const sdp = require('./sip/sdp');
const md5 = require('md5');

function randomString(len) {
    var str = "";
    for (var i = 0; i < len; i++) {
        var byte = Math.floor(Math.random() * 256);
        str += byte.toString(16);
    }
    return str;
}

function localAddrForAddr(toAddr) {
    var nics = os.networkInterfaces();
    var dflt = null;
    for (var nic in nics) {
        for (var i = 0; i < nics[nic].length; i++) {
            var addr = nics[nic][i];
            var subnet = ip.subnet(addr.address, addr.netmask);
            if (subnet.contains(toAddr) && ip.isV4Format(addr.address)) {
                return addr.address;
            } else if (dflt == null && !addr.internal && ip.isV4Format(addr.address)) {
                /* grab the first non-internal */
                dflt = addr.address;
            }
        }
    }
    return dflt;
}

class Call extends EventEmitter {
    constructor(client, rtpfactory, callId, fromUser, toUser, toAddr, toPort, protocol, username, password) {
        super();
        this.client = client;
        this.callId = callId;
        this.localAddr = localAddrForAddr(toAddr);
        this.fromUser = fromUser;
        this.fromtag = randomString(16);
        this.totag = null;
        this.to = `sip:${toUser}@${toAddr}:${toPort}`;
        this.protocol = protocol;
        this.msgSeq = 101;
        this.currentDigit = null;
        this.username = username;
        this.password = password;
        this.authAttempted = false;
        rtpfactory.createStream(this.localAddr).then((rtp) => {
            this.rtp = rtp;
            this._startCall();
            this.rtp.on('audio', (type, data) => { this.emit('audio', type, data); });
            this.rtp.on('dtmf', (data) => { this._handleDtmf(data); });
        });
    }

    _handleDtmf(dtmf) {
        const dtmfData = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#', 'A', 'B', 'C', 'D'];
        if (dtmf.event >= 0 && dtmf.event < dtmfData.length) {
            let digit = dtmfData[dtmf.event];
            if (!this.currentDigit || this.currentDigit !== digit) {
                this.emit('dtmfStart', digit);
                this.currentDigit = digit;
            } else if (this.currentDigit && dtmf.end) {
                this.emit('dtmfEnd', digit, dtmf.duration);
                this.currentDigit = null;
            }
        }
    }

    _inviteHandler(call, invite, resp) {
        winston.info(`Got ${resp.status} to INVITE`);
        //winston.info(resp);
        if (call && !call.totag && resp.headers.to.params && resp.headers.to.params.tag) {
            call.totag = resp.headers.to.params.tag;
        }
        if (resp.status >= 100 && resp.status < 200) {
            winston.info(`Got provisional ${resp.status} to INVITE`);
            if (resp.headers['content-length'] > 0 && resp.headers['content-type'] === 'application/sdp') {
                this.rtp.start(sdp.parse(resp.content));
            }
            if (resp.status === 180) {
                call.emit('ring', resp);
            }
        } else if (resp.status < 300) {
            winston.info(`Got success (${resp.status}) for INVITE`);
            if (resp.headers['content-length'] > 0 && resp.headers['content-type'] === 'application/sdp') {
                call.rtp.start(sdp.parse(resp.content));
            }
            call.emit('answer', resp);
        } else if (resp.status === 401 && !call.authAttempted) {
            /* WWW-Authenticate: Digest  realm="asterisk",nonce="1530927568/c3cfd85db9af63f28f83a7567e99fd4e",opaque="6ee2c5c76c46739c",algorithm=md5,qop="auth" */
            let auth = resp.headers['www-authenticate'][0];
            let cnonce = md5(Math.random().toString()).toString(16);
            let nc = call.msgSeq.toString(16);
            let ha1 = md5(`${call.username}:${auth.realm}:${call.password}`);
            let ha2 = md5(`${invite.method}:sip:${call.fromUser}@${auth.realm}`);
            let response = md5(`${ha1}:${auth.nonce}:${nc}:${cnonce}:${auth.qop}:${ha2}`);
            call.authAttempted = true;
            let newinvite = {
                method: 'INVITE',
                uri: call.to + ";transport=" + (call.protocol || "UDP"),
                version: '2.0',
                headers: {
                    'max-forwards': call.client.maxForwards.toString(),
                    from: {
                        uri: `sip:${call.fromUser}@${auth.realm}`,
                        params: { tag: call.fromtag }
                    },
                    to: {
                        uri: call.to,
                    },
                    'call-id': call.callId,
                    cseq: { seq: call.msgSeq++, method: 'INVITE' },
                    contact: [{
                        uri: `sip:${call.fromUser}@${this.localAddr}:${this.client.listenPort}`,
                    }],
                    'authorization': [{
                        scheme: auth.scheme,
                        realm: auth.realm,
                        nonce: auth.nonce,
                        opaque: auth.opaque,
                        algorithm: auth.algorithm,
                        qop: auth.qop,
                        username: call.username,
                        uri: `sip:${call.fromUser}@${auth.realm}`,
                        nc: nc,
                        cnonce: cnonce,
                        response: response
                    }],
                    'content-type': 'application/sdp'
                },
                content: sdp.stringify(call.rtp.ourSdp)
            };

            sip.send(newinvite, function(resp) { call._inviteHandler(call, newinvite, resp); });
        } else {
            winston.info(`Got failure (${resp.status}) for INVITE`);
            call.emit('fail', resp);
        }
    }

    _startCall() {
        var invite = {
            method: 'INVITE',
            uri: this.to + ";transport=" + (this.protocol || "UDP"),
            version: '2.0',
            headers: {
                'max-forwards': this.client.maxForwards.toString(),
                from: {
                    uri: `sip:${this.fromUser}@${this.localAddr}:${this.client.listenPort}`,
                    params: { tag: this.fromtag }
                },
                to: {
                    uri: this.to,
                },
                'call-id': this.callId,
                cseq: { seq: this.msgSeq++, method: 'INVITE' },
                contact: [{
                    uri: `sip:${this.fromUser}@${this.localAddr}:${this.client.listenPort}`,
                }],
                'content-type': 'application/sdp'
            },
            content: sdp.stringify(this.rtp.ourSdp)
        };
        //winston.info(invite);
        var call = this;
        sip.send(invite, function(resp) { call._inviteHandler(call, invite, resp); });
    }

    setAudioFill(byte) {
        this.rtp.setAudioFill(byte);
    }

    playAudio(buffer, callback) {
        /* chunk the file into 20ms blocks (160 bytes) and send those */
        let start = 0;
        let end = 160;
        let data = [...buffer];
        while (start < data.length) {
            let block = data.slice(start, end);
            this.rtp.pushAudio(block, 20);
            start = end;
            end = start + 160;
        }
        winston.info("written data");
        this.rtp.once('audioStopped', callback);
    }

    hangup(causeCode) {
        var bye = {
            method: 'BYE',
            uri: this.to,
            version: '2.0',
            headers: {
                'max-forwards': this.client.maxForwards.toString(),
                from: {
                    uri: `sip:${this.fromUser}@${this.localAddr}:${this.client.listenPort}`,
                    params: { tag: this.fromtag }
                },
                to: {
                    uri: this.to,
                    params: { tag: (this.totag || "") }
                },
                'call-id': this.callId,
                cseq: { seq: this.msgSeq++, method: 'BYE' },
                contact: [{
                    uri: `sip:${this.fromUser}@${this.localAddr}:${this.client.listenPort}`,
                }],
            }
        };
        winston.info(`Hanging up ${this.callId}`);
        var call = this;
        sip.send(bye, function(resp) {
            winston.info(`Got ${resp.status} for BYE`);
            call.emit('hangup', resp);
        });
        this.rtp.stop();
    }
}

class SipTestClient extends EventEmitter {
    constructor(listenPort, rtpstart, rtpend, defaultTransport) {
        super();
        this.listenPort = listenPort;
        this.maxForwards = 70;
        this.calls = new Object();
        this.rtpFactory = new RtpStreamFactory(rtpstart, rtpend);
        this.defaultTransport = defaultTransport || "UDP";
        sip.start({ port: this.listenPort }, this.onSipRequest);
        winston.info(`SIP Listening on ${listenPort}`);
    }

    onSipRequest(req, rem) {
        winston.info(`Got ${req.method} request from ${rem.address}:${rem.port}`);
        if (req.method === "OPTIONS") {
            var resp = sip.makeResponse(req, 200, "OK");
            sip.send(resp);
        } else {
            this.emit('request', req, rem);
        }
    }

    verifyPeer(address, port, cb) {
        winston.info(`Verifying peer at ${address}:${port}`);
        var fromaddr = localAddrForAddr(address);
        var req = {
            method: 'OPTIONS',
            uri: `sip:${address}:${port};transport=${this.defaultTransport}`,
            version: '2.0',
            headers: {
                'max-forwards': this.maxForwards.toString(),
                from: {
                    uri: `sip:verify@${fromaddr}:${this.listenPort}`,
                    params: { tag: `${randomString(8)}` }
                },
                to: {
                    uri: `sip:${address}:${port}`
                },
                'call-id': `${randomString(8)}@localhost`,
                cseq: { seq: 101, method: 'OPTIONS' },
                contact: [{
                    uri: `sip:test@${fromaddr}:${this.listenPort}`
                }],
                'content-length': 0
            }
        };
        //winston.info(req);
        //winston.info(`"${sip.stringify(req)}"`);
        sip.send(req, function(msg) {
            winston.info(`Got ${msg.status} to OPTIONS`);
            if (msg.status !== 408) {
                cb(null, msg);
            } else {
                cb("Timeout", msg);
            }
        });
    }

    startCall(fromUser, toUser, toAddr, toPort, transport, username, password) {
        var call = new Call(this, this.rtpFactory, randomString(16), fromUser, toUser, toAddr, toPort, transport || this.defaultTransport, username, password);
        this.calls[call.callId] = call;
        return call;
    }

    stop() {
        sip.stop();
    }
}

module.exports = SipTestClient;