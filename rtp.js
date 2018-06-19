"use strict";

const winston = require('winston');
const Promise = require('promise');
const dgram = require('dgram');
const EventEmitter = require('events');
const binary = require('jbinary');

const rtpType = {
    'jBinary.all': 'packet',
    'jBinary.littleEndian': false,
    /*
    0                   1                   2                   3
    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    |V=2|P|X|  CC   |M|     PT      |       sequence number         |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    |                           timestamp                           |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    |           synchronization source (SSRC) identifier            |
    +=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+
    |            contributing source (CSRC) identifiers             |
    |                             ....                              |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    */
    packet: {
        version: ['bitfield', 2],
        padded: ['bitfield', 1],
        extension: ['bitfield', 1],
        contributingSourceCount: ['bitfield', 4],
        marker: ['bitfield', 1],
        payloadType: ['bitfield', 7],
        sequenceNumber: 'uint16',
        timestamp: 'uint32',
        ssrc: 'uint32',
        csrc: ['array', 'uint32', 'contributingSourceCount'],
        payload: ['array', 'uint8']
    }
};
const telephonyEventType = {
    'jBinary.all': 'telephonyEvent',
    'jBinary.littleEndian': false,
    /*
     0                   1                   2                   3
     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
    |     event     |E|R| volume    |          duration             |
    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+   
    */
    telephonyEvent: {
        event: 'uint8',
        end: ['bitfield', 1],
        rbit: ['bitfield', 1],
        volume: ['bitfield', 6],
        duration: 'uint16'
    }
};

class RtpStream extends EventEmitter {
    constructor(factory, socket, localAddr) {
        super();
        var now = new Date().getTime();
        this.factory = factory;
        this.socket = socket;
        this.ourSsrc = Math.floor(Math.random() * 0xffffffff);
        this.needsMarker = true;
        this.ourSeq = Math.floor(Math.random() * 0xffff);
        this.ourTimestamp = Math.floor(Math.random() * 0xffffffff);
        this.ourAddr = localAddr;
        this.ourPort = socket.address().port;
        this.socket.on('message', (msg) => { this.onMessage(msg); });
        this.digitQueue = new Array();
        this.current = {
            dtmf: null,
            audio: 0x7f,
            length: null,
            startTimestamp: this.ourTimestamp
        };
        this.packetTimer = null;
        this.ourSdp = {
            m: [{
                media: "audio",
                port: socket.address().port,
                portnum: 1,
                proto: "RTP/AVP",
                fmt: [0, 101],
                a: [
                    "rtpmap:0 PCMU/8000",
                    "rtpmap:101 telephone-event/8000",
                    "fmtp:101 0-16",
                    "silenceSupp:off - - - -",
                    "ptime:20",
                    "sendrecv"
                ]
            }],
            v: "0",
            o: {
                username: "tester",
                id: now.toString(),
                version: now.toString(),
                nettype: "IN",
                addrtype: "IP4",
                address: localAddr
            },
            s: "sipjs",
            c: {
                nettype: "IN",
                addrtype: "IP4",
                address: localAddr
            },
            t: "0 0"
        };
    }

    _pushAudio(digit, audio, ms) {
        let obj = {
            dtmf: digit,
            audio: audio,
            length: ms * 8 /* samples */
        };
        this.digitQueue.push(obj);
    }

    pushAudio(fill, ms) {
        this._pushAudio(null, fill || 0x7f, ms);
    }

    pushDigit(digit, ms) {
        this._pushAudio(digit, null, ms || 100);
    }

    onMessage(msg) {
        var buff = new binary(msg, rtpType);
        var packet = buff.readAll();
        if (packet.marker || (packet.sequenceNumber % 1000 === 0)) {
            winston.info(`RTP packet: ${packet.sequenceNumber}/${packet.marker}/${packet.ssrc}`);
        }
        if (packet.payloadType === 101) {
            var dtmfbuff = new binary(packet.payload, telephonyEventType);
            var dtmf = dtmfbuff.readAll();
            packet.payload = dtmf;
            //winston.info(JSON.stringify(packet));
            this.emit('dtmf', dtmf);
        } else {
            this.emit('audio', packet.payloadType, packet.payload);
        }
    }

    start(theirSdp) {
        this.theirSdp = theirSdp;
        this.theirAddr = theirSdp.c.address;
        this.theirPort = theirSdp.m[0].port;
        if (!this.packetTimer) {
            this.packetTimer = setInterval(() => { this.sendRtpPacket(); }, 20);
        }
    }

    stop() {
        if (this.packetTimer) {
            clearInterval(this.packetTimer);
            this.packetTimer = null;
        }
        this.socket.close();
    }

    setAudioFill(byte) {
        this._pushAudio(null, byte, null);
    }

    _sendDtmfEnd(oldCurrent) {
        var packet = new Object();
        var dtmf = new Object();
        var rtpFmt = new binary(12 + 4, rtpType); /* creates backing buffer */
        var dtmfFmt = new binary(4, telephonyEventType);
        packet.version = 2;
        packet.padded = 0;
        packet.extension = 0;
        packet.contributingSourceCount = 0;
        packet.marker = 0;
        this.needsMarker = false;
        packet.payloadType = 101;
        packet.csrc = new Array();
        packet.ssrc = this.ourSsrc;
        packet.timestamp = oldCurrent.startTimestamp;
        switch (oldCurrent.dtmf) {
            case '*':
                dtmf.event = 10;
                break;
            case '#':
                dtmf.event = 11;
                break;
            case 'A':
                dtmf.event = 12;
                break;
            case 'B':
                dtmf.event = 13;
                break;
            case 'C':
                dtmf.event = 14;
                break;
            case 'D':
                dtmf.event = 15;
                break;
            default:
                dtmf.event = parseInt(oldCurrent.dtmf);
                break;
        }
        dtmf.end = 1;
        dtmf.rbit = 0;
        dtmf.volume = 7;
        dtmf.duration = (this.ourTimestamp < oldCurrent.startTimestamp) ?
            this.ourTimestamp + 0xffffffff - oldCurrent.startTimestamp :
            this.ourTimestamp - oldCurrent.startTimestamp;
        dtmfFmt.write('telephonyEvent', dtmf, 0);
        packet.payload = dtmfFmt.read('blob', 0);

        var i;
        for (i = 0; i < 3; i++) {
            packet.sequenceNumber = this.ourSeq++;
            rtpFmt.write('packet', packet, 0);
            var buffer = rtpFmt.read('blob', 0);
            this.socket.send(buffer, 0, buffer.length, this.theirPort, this.theirAddr);
            if (this.ourSeq > 0xffff) {
                this.ourSeq = 0;
            }
        }
    }

    _sendDtmf() {
        var packet = new Object();
        var dtmf = new Object();
        var rtpFmt = new binary(12 + 4, rtpType); /* creates backing buffer */
        var dtmfFmt = new binary(4, telephonyEventType);
        packet.version = 2;
        packet.padded = 0;
        packet.extension = 0;
        packet.contributingSourceCount = 0;
        packet.marker = 0;
        this.needsMarker = false;
        packet.payloadType = 101;
        packet.csrc = new Array();
        packet.ssrc = this.ourSsrc;
        packet.timestamp = this.current.startTimestamp;
        switch (this.current.dtmf) {
            case '*':
                dtmf.event = 10;
                break;
            case '#':
                dtmf.event = 11;
                break;
            case 'A':
                dtmf.event = 12;
                break;
            case 'B':
                dtmf.event = 13;
                break;
            case 'C':
                dtmf.event = 14;
                break;
            case 'D':
                dtmf.event = 15;
                break;
            default:
                dtmf.event = parseInt(this.current.dtmf);
                break;
        }
        dtmf.end = 0;
        dtmf.rbit = 0;
        dtmf.volume = 7;
        dtmf.duration = (this.ourTimestamp < this.current.startTimestamp) ?
            this.ourTimestamp + 0xffffffff - this.current.startTimestamp :
            this.ourTimestamp - this.current.startTimestamp;
        dtmfFmt.write('telephonyEvent', dtmf, 0);
        packet.payload = dtmfFmt.read('blob', 0);

        packet.sequenceNumber = this.ourSeq++;
        rtpFmt.write('packet', packet, 0);
        var buffer = rtpFmt.read('blob', 0);
        this.socket.send(buffer, 0, buffer.length, this.theirPort, this.theirAddr);
    }

    _sendAudio() {
        var packet = new Object();
        var fmt = new binary(12 + 160, rtpType); /* creates backing buffer */
        packet.version = 2;
        packet.padded = 0;
        packet.extension = 0;
        packet.contributingSourceCount = 0;
        packet.marker = this.needsMarker ? 1 : 0;
        this.needsMarker = false;
        packet.payloadType = 0; /* mulaw */
        packet.csrc = new Array();
        packet.ssrc = this.ourSsrc;
        packet.sequenceNumber = this.ourSeq++;
        packet.timestamp = this.ourTimestamp;
        if (Array.isArray(this.current.audio)) {
            if (this.current.audio.length >= 160) {
                packet.payload = this.current.audio;
            } else {
                packet.payload = Array.from(this.current.audio);
                while (packet.payload < 160) {
                    packet.payload.push(0x7f);
                }
            }
        } else {
            packet.payload = new Array(160);
            packet.payload.fill(this.current.audio);
        }
        fmt.write('packet', packet, 0); //packet.read('blob', 0);
        var buffer = fmt.read('blob', 0);
        this.socket.send(buffer, 0, buffer.length, this.theirPort, this.theirAddr);
    }

    sendRtpPacket() {
        let haveQueued = (this.digitQueue.length > 0);
        let currentDone = (this.current.length && (this.current.length + this.current.startTimestamp <= this.ourTimestamp));
        let oldCurrent = {
            audio: this.current.audio,
            dtmf: this.current.dtmf,
            length: this.current.length,
            startTimestamp: this.current.startTimestamp
        }
        if (haveQueued && (!this.current.length || currentDone)) {
            let head = this.digitQueue.shift();
            this.current.audio = head.audio;
            this.current.dtmf = head.dtmf;
            this.current.length = head.length;
            this.current.startTimestamp = this.ourTimestamp;
            this.needsMarker = true;
        } else if (currentDone) {
            this.current.audio = 0x7f;
            this.current.dtmf = null;
            this.current.length = null;
            this.current.startTimestamp = this.ourTimestamp;
            this.needsMarker = true;
        }
        if (oldCurrent.startTimestamp !== this.current.startTimestamp) {
            if (oldCurrent.audio && !(this.current.audio && this.current.length)) {
                winston.info("audio stopped");
                this.emit('audioStopped', oldCurrent.audio, (oldCurrent.length || 0) / 8);
            } else {
                this.emit('dtmfStopped', oldCurrent.dtmf, (oldCurrent.length || 0) / 8);
            }
            if (this.current.audio) {
                this.emit('audioStarted', this.current.audio, (this.current.length || 0) / 8);
            } else {
                this.emit('dtmfStarted', this.current.dtmf, (this.current.length || 0) / 8);
            }
        }
        if (oldCurrent.startTimestamp !== this.current.startTimestamp && oldCurrent.dtmf) {
            /* send dtmf ends */
            this._sendDtmfEnd(oldCurrent);
        }
        if (this.current.audio) {
            this._sendAudio();
        } else {
            this._sendDtmf();
        }
        this.ourTimestamp += 160;
        if (this.ourTimestamp > 0xffffffff) {
            this.ourTimestamp -= 0xffffffff;
        }
        if (this.ourSeq > 0xffff) {
            this.ourSeq = 0;
            this.needsMarker = true;
        }
        if (this.started) {
            var now = new Date().getTime();
            var wait = (this.lastPacket || now) + 20 - now;
            this.lastPacket = now;
            setTimeout(() => { this.sendRtpPacket(); }, wait > 0 ? wait : 0);
        }
    }
}

class RtpStreamFactory {
    constructor(startPort, endPort) {
        this.portPool = [];
        startPort = Math.ceil(startPort / 2) * 2; /* round up to next even */
        while (startPort <= endPort) {
            this.portPool.push(startPort);
            startPort += 2;
        }
        this.maxPorts = this.portPool.length;
    }

    _tryBind(socket, attempt, resolve, reject) {
        if (this.portPool.length === 0) {
            reject();
            return;
        }
        var port = this.portPool.shift();
        socket.once('error', (err) => {
            this.portPool.push(port);
            winston.info(`RTP bind on ${port} failed: ${err}`);
            if (attempt + 1 >= this.maxPorts) {
                winston.error("Failed to bind RTP port");
                reject();
            } else {
                this._tryBind(socket, attempt + 1, resolve, reject);
            }
        });
        socket.once('listening', () => {
            resolve(socket);
        });
        winston.info(`Attempting to start RTP on ${port}`);
        socket.bind(port);
    }

    createStream(localAddr) {
        var socket = dgram.createSocket('udp4');
        var factory = this;
        return new Promise((resolve, reject) => {
            var attempt = 0;
            this._tryBind(socket, attempt, resolve, reject);
        }).then(function(socket) {
                return new RtpStream(factory, socket, localAddr);
            },
            () => {
                socket.close();
                return null;
            });
    }
}

module.exports = RtpStreamFactory;