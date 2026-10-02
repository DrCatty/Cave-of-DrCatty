// Minimal RFC6455 client. Node's bundled WebSocket negotiates permessage-deflate,
// which the Chrome DevTools endpoint does not tolerate, so the test harness
// speaks the protocol directly.
import net from 'node:net';
import crypto from 'node:crypto';

export class WsClient {
  constructor(url) {
    const parsed = new URL(url);
    this.host = parsed.hostname;
    this.port = Number(parsed.port || 80);
    this.path = parsed.pathname + parsed.search;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOp = 0;
    this.onmessage = () => {};
    this.onclose = () => {};
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect(this.port, this.host);
      this.socket = socket;
      let handshake = Buffer.alloc(0);
      let upgraded = false;

      socket.on('connect', () => {
        socket.write(
          `GET ${this.path} HTTP/1.1\r\n` +
            `Host: ${this.host}:${this.port}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n\r\n'
        );
      });

      socket.on('data', (chunk) => {
        if (!upgraded) {
          handshake = Buffer.concat([handshake, chunk]);
          const end = handshake.indexOf('\r\n\r\n');
          if (end === -1) return;
          const head = handshake.subarray(0, end).toString('latin1');
          if (!/^HTTP\/1\.1 101/.test(head)) {
            reject(new Error(`handshake failed: ${head.split('\r\n')[0]}`));
            socket.destroy();
            return;
          }
          upgraded = true;
          const rest = handshake.subarray(end + 4);
          handshake = Buffer.alloc(0);
          resolve();
          if (rest.length) this.push(rest);
          return;
        }
        this.push(chunk);
      });

      socket.on('error', (err) => {
        if (!upgraded) reject(err);
        this.finish();
      });
      socket.on('close', () => this.finish());
    });
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.readFrame();
      if (!frame) break;
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        this.fragments.push(frame.payload);
        if (frame.fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.onmessage(text);
        }
      } else if (frame.opcode === 0x8) {
        this.close(1000);
      } else if (frame.opcode === 0x9) {
        this.socket.write(encode(frame.payload, 0xa));
      }
    }
  }

  readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    if (buf.length < offset + len) return null;
    const payload = buf.subarray(offset, offset + len);
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  send(text) {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(encode(Buffer.from(text, 'utf8')));
  }

  close() {
    if (!this.socket || this.socket.destroyed) return;
    try { this.socket.write(encode(Buffer.alloc(0), 0x8)); } catch { /* ignore */ }
    try {
      this.socket.end();      // graceful FIN, avoids libuv teardown asserts on Windows
      this.socket.unref();
    } catch { /* ignore */ }
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.onclose();
  }
}

function encode(body, opcode = 0x1) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}
