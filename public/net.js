// Thin WebSocket client. Reconnects automatically and re-joins the room so a
// short network blip does not drop a player out of the match.

export class Net extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.connected = false;
    this.room = null;
    this.you = null;
    this.host = false;
    this.name = '';
    this.pendingJoin = null;
    this.retry = 0;
    this.timer = null;
    this.queue = [];
    this.latency = 0;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    clearTimeout(this.timer);
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.emit('open');
      if (this.pendingJoin) {
        this.send(this.pendingJoin);
      }
      for (const msg of this.queue.splice(0)) this.send(msg);
      this.ping();
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        this.latency = Math.max(0, Date.now() - msg.at);
        this.emit('latency', this.latency);
        return;
      }
      if (msg.t === 'joined') {
        this.you = msg.you;
        this.room = msg.room;
        this.host = msg.host;
        this.emit('joined', msg);
        return;
      }
      if (msg.t === 'roster') {
        this.room = msg.room;
        this.host = msg.room.hostId === this.you;
        this.emit('roster', msg.room);
        return;
      }
      if (msg.t === 'newHost') {
        this.room = msg.room;
        this.host = msg.hostId === this.you;
        this.emit('newHost', msg);
        return;
      }
      if (msg.t === 'state') {
        this.emit('state', msg);
        return;
      }
      this.emit(msg.t, msg);
    };

    ws.onclose = () => {
      this.connected = false;
      this.emit('close');
      // Only guests auto-rejoin: a host would otherwise create a brand new
      // room while the old one is handed to the next member.
      if (this.pendingJoin && this.pendingJoin.t === 'join') this.scheduleReconnect();
    };

    ws.onerror = () => {
      this.emit('neterror');
    };
  }

  scheduleReconnect() {
    this.retry = Math.min(this.retry + 1, 6);
    const delay = Math.min(500 * 2 ** this.retry, 8000);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  ping() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.connected) this.send({ t: 'ping', at: Date.now() });
    }, 15000);
  }

  send(msg) {
    if (!this.ws) return false;
    if (this.ws.readyState !== 1) {
      if (msg.t === 'state' || msg.t === 'toHost' || msg.t === 'broadcast' || msg.t === 'ready' || msg.t === 'rename') {
        this.queue.push(msg);
        if (this.queue.length > 20) this.queue.shift();
      }
      return false;
    }
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  create(name, isPublic = true) {
    this.name = name;
    this.pendingJoin = { t: 'create', name, public: isPublic };
    this.connect();
  }

  join(code, name) {
    this.name = name;
    this.pendingJoin = { t: 'join', code, name };
    this.connect();
  }

  leave() {
    this.send({ t: 'leave' });
    this.pendingJoin = null;
    this.room = null;
    this.you = null;
    this.host = false;
    this.queue.length = 0;
    if (this.ws) this.ws.close();
  }
}
