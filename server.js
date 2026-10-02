/*
 * Zero-dependency game server for "大富翁 Online".
 *
 * Serves the static client from ./public and provides a small WebSocket
 * transport used to create/join rooms. The game rules themselves live in the
 * browser: the room host is authoritative and broadcasts state snapshots to
 * the other members, this process only relays messages between sockets.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT || 8787);
// 0.0.0.0 lets friends on the same LAN join; set HOST=127.0.0.1 to stay local-only.
const HOST = process.env.HOST || '0.0.0.0';
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 800);
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE || 8);
const PUBLIC_DIR = path.join(__dirname, 'public');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'self'",
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------------------------------------------ static */

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      sockets: sockets.size,
      uptime: Math.round(process.uptime()),
    }));
    return;
  }

  // Public room directory, consumed by the lobby.
  if (url.pathname === '/api/rooms') {
    const list = [...rooms.values()]
      .filter((room) => room.public && !room.started && room.members.size < MAX_ROOM_SIZE)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 60)
      .map((room) => {
        const host = room.members.get(room.hostId);
        return {
          code: room.code,
          host: host ? host.name : '房主',
          players: room.members.size,
          capacity: MAX_ROOM_SIZE,
          createdAt: room.createdAt,
        };
      });
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ rooms: list, capacity: MAX_ROOM_SIZE }));
    return;
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
      return;
    }
    sendFile(res, target);
  });
});

/* --------------------------------------------------------------- websocket */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

class Socket {
  constructor(raw, req) {
    this.raw = raw;
    this.id = crypto.randomBytes(9).toString('base64url');
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.alive = true;
    this.remote = req.socket.remoteAddress;
    this.session = null;

    raw.on('data', (chunk) => this.onData(chunk));
    raw.on('close', () => this.onClose());
    raw.on('error', () => this.onClose());
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.readFrame();
      if (!frame) break;
      this.handleFrame(frame);
    }
  }

  readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > 8n * 1024n * 1024n) {
        this.close(1009, 'message too big');
        return null;
      }
      len = Number(big);
      offset += 8;
    }

    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;

    let payload = Buffer.from(buf.subarray(offset, offset + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  handleFrame(frame) {
    const { opcode, payload, fin } = frame;
    if (opcode === 0x8) {
      this.close(1000, 'bye');
      return;
    }
    if (opcode === 0x9) {
      this.raw.write(encodeFrame(payload, 0xa));
      return;
    }
    if (opcode === 0xa) {
      this.alive = true;
      return;
    }
    if (opcode === 0x0) {
      this.fragments.push(payload);
      if (fin) this.flushFragments();
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) {
        if (opcode === 0x1) this.onText(payload.toString('utf8'));
      } else {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
      }
    }
  }

  flushFragments() {
    const full = Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOpcode === 0x1) this.onText(full.toString('utf8'));
    this.fragmentOpcode = 0;
  }

  onText(text) {
    const now = Date.now();
    if (!this.windowStart || now - this.windowStart > 10000) {
      this.windowStart = now;
      this.hits = 0;
    }
    this.hits += 1;
    if (this.hits > 300) {
      this.send({ t: 'error', message: '操作过于频繁，请稍后再试。' });
      this.close(1008, 'rate limit');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    handleMessage(this, msg);
  }

  send(obj) {
    if (this.raw.destroyed) return;
    try {
      this.raw.write(encodeFrame(JSON.stringify(obj)));
    } catch {
      this.onClose();
    }
  }

  close(code = 1000, reason = '') {
    if (this.raw.destroyed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    try {
      this.raw.write(encodeFrame(body, 0x8));
    } catch {
      /* ignore */
    }
    this.raw.destroy();
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    const room = this.session && rooms.get(this.session.room);
    if (room) leaveRoom(this, room);
  }
}

server.on('upgrade', (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );
  socket.setNoDelay(true);
  const ws = new Socket(socket, req);
  sockets.add(ws);
});

/* ------------------------------------------------------------------- rooms */

const sockets = new Set();
const rooms = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  for (;;) {
    let code = '';
    const bytes = crypto.randomBytes(4);
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
}

function roomSummary(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    members: [...room.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      connected: !m.ws.raw.destroyed,
    })),
  };
}

function broadcast(room, obj, exceptId = null) {
  for (const member of room.members.values()) {
    if (member.id === exceptId) continue;
    member.ws.send(obj);
  }
}

function cleanName(name, fallback) {
  const value = String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (value || fallback).slice(0, 12);
}

function handleMessage(ws, msg) {
  switch (msg.t) {
    case 'create': {
      if (rooms.size >= MAX_ROOMS) {
        ws.send({ t: 'error', message: '服务器房间数已达上限，请稍后再试。' });
        return;
      }
      leaveCurrent(ws);
      const code = newCode();
      const room = {
        code,
        hostId: ws.id,
        started: false,
        public: msg.public !== false,
        members: new Map(),
        createdAt: Date.now(),
      };
      rooms.set(code, room);
      const name = cleanName(msg.name, '房主');
      room.members.set(ws.id, { id: ws.id, name, ws });
      ws.session = { room: code, name };
      ws.send({ t: 'joined', you: ws.id, room: roomSummary(room), host: true, name, state: room.state || null });
      break;
    }

    case 'join': {
      const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      const room = rooms.get(code);
      if (!room) {
        ws.send({ t: 'error', message: '房间不存在，请检查房间号。' });
        return;
      }
      if (room.started && !room.state) {
        ws.send({ t: 'error', message: '该对局已经开始，无法加入。' });
        return;
      }
      if (room.members.size >= MAX_ROOM_SIZE) {
        ws.send({ t: 'error', message: `房间已满（最多 ${MAX_ROOM_SIZE} 人）。` });
        return;
      }
      leaveCurrent(ws);
      const name = cleanName(msg.name, '玩家');
      room.members.set(ws.id, { id: ws.id, name, ws });
      ws.session = { room: code, name };
      ws.send({ t: 'joined', you: ws.id, room: roomSummary(room), host: false, name, state: room.state || null });
      broadcast(room, { t: 'roster', room: roomSummary(room) }, ws.id);
      break;
    }

    case 'rename': {
      const room = currentRoom(ws);
      if (!room) return;
      const member = room.members.get(ws.id);
      member.name = cleanName(msg.name, member.name);
      ws.session.name = member.name;
      broadcast(room, { t: 'roster', room: roomSummary(room) });
      break;
    }

    case 'ready': {
      const room = currentRoom(ws);
      if (!room || room.hostId !== ws.id) return;
      room.started = !!msg.started;
      broadcast(room, { t: 'roster', room: roomSummary(room) });
      if (room.started) broadcast(room, { t: 'start', by: ws.id });
      break;
    }

    // Host -> everyone: authoritative state snapshot.
    case 'state': {
      const room = currentRoom(ws);
      if (!room || room.hostId !== ws.id) return;
      room.state = msg.state;
      for (const member of room.members.values()) {
        if (member.id === ws.id) continue;
        member.ws.send({ t: 'state', state: msg.state, rev: msg.rev });
      }
      break;
    }

    // Guest -> host: an intent, or any direct message (chat / hand-shake).
    case 'toHost': {
      const room = currentRoom(ws);
      if (!room) return;
      const host = room.members.get(room.hostId);
      if (!host) {
        ws.send({ t: 'error', message: '房主已离开房间。' });
        return;
      }
      host.ws.send({ t: 'fromPeer', from: ws.id, fromName: room.members.get(ws.id).name, data: msg.data });
      break;
    }

    case 'broadcast': {
      const room = currentRoom(ws);
      if (!room) return;
      broadcast(room, {
        t: 'peer',
        from: ws.id,
        fromName: room.members.get(ws.id).name,
        data: msg.data,
      });
      break;
    }

    case 'kick': {
      const room = currentRoom(ws);
      if (!room || room.hostId !== ws.id) return;
      const target = room.members.get(msg.id);
      if (!target || target.id === ws.id) return;
      target.ws.send({ t: 'kicked' });
      target.ws.close(1000, 'kicked');
      break;
    }

    case 'leave':
      leaveCurrent(ws);
      ws.send({ t: 'left' });
      break;

    case 'ping':
      ws.send({ t: 'pong', at: msg.at });
      break;

    default:
      break;
  }
}

function currentRoom(ws) {
  if (!ws.session) return null;
  return rooms.get(ws.session.room) || null;
}

function leaveCurrent(ws) {
  const room = currentRoom(ws);
  if (room) leaveRoom(ws, room);
  ws.session = null;
}

function leaveRoom(ws, room) {
  const member = room.members.get(ws.id);
  room.members.delete(ws.id);
  ws.session = null;
  broadcast(room, { t: 'peerLeft', id: ws.id, name: member ? member.name : '', room: roomSummary(room) });

  if (room.members.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === ws.id) {
    // Promote the longest-standing remaining member and hand over authority.
    room.hostId = [...room.members.keys()][0];
    broadcast(room, { t: 'newHost', hostId: room.hostId, room: roomSummary(room), state: room.state || null });
  } else {
    broadcast(room, { t: 'roster', room: roomSummary(room) });
  }
}

/* ---------------------------------------------------------------- heartbeat */

setInterval(() => {
  for (const ws of sockets) {
    if (ws.raw.destroyed) {
      sockets.delete(ws);
      ws.onClose();
      continue;
    }
    try {
      ws.raw.write(encodeFrame(Buffer.alloc(0), 0x9));
    } catch {
      ws.onClose();
    }
  }
}, 25000).unref();

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.members.size === 0 || now - room.createdAt > 1000 * 60 * 60 * 6) {
      for (const m of room.members.values()) m.ws.send({ t: 'error', message: '房间已过期。' });
      rooms.delete(room.code);
    }
  }
}, 1000 * 60 * 10).unref();

server.listen(PORT, HOST, () => {
  const urls = [`http://localhost:${PORT}`];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list || []) {
      if (nic.family === 'IPv4' && !nic.internal) urls.push(`http://${nic.address}:${PORT}`);
    }
  }
  console.log('大富翁 Online 已启动，用浏览器打开：');
  for (const url of [...new Set(urls)]) console.log(`  ${url}`);
  console.log(HOST === '0.0.0.0'
    ? '  局域网内的朋友可用上面的 IP 地址加入同一房间。'
    : '  当前仅本机可访问（设置 HOST=0.0.0.0 可开放局域网）。');
});
