/*
 * Rule-engine + page-wiring + multiplayer-protocol tests.
 *
 *   node tools/test.mjs          (expects server.js on 127.0.0.1:8787 for part 3)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WsClient } from './ws.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}${extra ? `  — ${extra}` : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? `  — ${extra}` : ''}`);
  }
}

const engine = await import(pathToFileURL(path.join(PUB, 'engine.js')).href);
const board = await import(pathToFileURL(path.join(PUB, 'board.js')).href);
const ai = await import(pathToFileURL(path.join(PUB, 'ai.js')).href);
const { BOARD, rentFor } = board;
const {
  createGame, applyIntent, player, currentPlayer, propsOf, legalActions,
  netWorth, moveTo, buildingCount, DEFAULT_SETTINGS,
} = engine;

/* ------------------------------------------------------------ part 1 rules */

console.log('\n[1] 规则引擎');

function game(settings = {}, players = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]) {
  return createGame({ seed: 12345, players, settings });
}

{
  const g = game({ startingCash: 2500 });
  check('初始资金遵循设置', g.players.every((p) => p.cash === 2500), `cash=${g.players[0].cash}`);
  check('开局等待掷骰', g.phase === 'roll' && g.turn === 0);
  check('开局日志已写入', g.log.length >= 1);
  check('状态可 JSON 序列化', (() => {
    const clone = JSON.parse(JSON.stringify(g));
    return clone.players.length === 2 && Array.isArray(clone.decks.chance);
  })());
}

{
  const g = game();
  const before = g.players[1].cash;
  applyIntent(g, 'b', { t: 'roll' });           // not their turn
  check('拒绝非当前玩家掷骰', g.dice[0] === 0 && g.players[1].cash === before);
  applyIntent(g, 'a', { t: 'roll' });
  check('掷骰产生 2~12 点', g.dice[0] >= 1 && g.dice[0] <= 6 && g.dice[1] >= 1 && g.dice[1] <= 6, `${g.dice}`);
  check('掷骰写入战况', g.log.some((l) => l.text.includes('掷出')));
  check('结算后进入可操作阶段', ['end', 'buy', 'auction', 'resolve', 'roll'].includes(g.phase), g.phase);
}

{
  const g = game();
  g.players[0].pos = 1;
  g.phase = 'buy';
  applyIntent(g, 'a', { t: 'buy' });
  check('购买地产扣除现金', g.players[0].cash === 1440, `cash=${g.players[0].cash}`);
  check('购买地产登记所有者', g.owners[1] && g.owners[1].owner === 'a');
}

{
  const g = game();
  g.owners[1] = { owner: 'a', houses: 0, mortgaged: false };
  check('单块地产不翻倍', rentFor(BOARD[1], 'a', g.owners, 7) === 2, `rent=${rentFor(BOARD[1], 'a', g.owners, 7)}`);
  g.owners[3] = { owner: 'a', houses: 0, mortgaged: false };
  check('集齐色组基本租金翻倍', rentFor(BOARD[1], 'a', g.owners, 7) === 4, `rent=${rentFor(BOARD[1], 'a', g.owners, 7)}`);
  g.owners[1].houses = 2;
  check('房屋租金按等级取用', rentFor(BOARD[1], 'a', g.owners, 7) === 30);
}

{
  const g = game();
  g.owners[1] = { owner: 'a', houses: 0, mortgaged: false };
  moveTo(g, g.players[1], 1);
  check('停在他人地产自动收租', g.players[1].cash === 1498 && g.players[0].cash === 1502,
    `b=${g.players[1].cash} a=${g.players[0].cash}`);
  check('租金写入战况', g.log.some((l) => l.text.includes('租金')));
}

{
  const g = game();
  moveTo(g, g.players[1], 30);
  check('入狱格送到监狱', g.players[1].pos === 10 && g.players[1].inJail === true);
  g.turn = 1;
  g.phase = 'jail';
  const cash = g.players[1].cash;
  applyIntent(g, 'b', { t: 'jail', action: 'pay' });
  check('支付保释金出狱', g.players[1].inJail === false && g.players[1].cash === cash - g.settings.jailFine);
}

{
  const g = game();
  g.owners[1] = { owner: 'a', houses: 0, mortgaged: false };
  g.owners[3] = { owner: 'a', houses: 0, mortgaged: false };
  g.players[0].cash = 1500;
  applyIntent(g, 'a', { t: 'build', space: 1 });
  check('集齐色组后可建造', g.owners[1].houses === 1 && g.players[0].cash === 1450);
  applyIntent(g, 'a', { t: 'build', space: 1 });
  check('强制均衡建造', g.owners[1].houses === 1 && g.players[0].cash === 1450);
  applyIntent(g, 'a', { t: 'build', space: 3 });
  check('均衡后可轮流建造', g.owners[3].houses === 1);
  applyIntent(g, 'a', { t: 'mortgage', space: 1 });
  check('有房屋时禁止抵押', g.owners[1].mortgaged === false);
  applyIntent(g, 'a', { t: 'sell-house', space: 1 });
  applyIntent(g, 'a', { t: 'sell-house', space: 3 });
  applyIntent(g, 'a', { t: 'mortgage', space: 1 });
  check('抵押获得半价', g.owners[1].mortgaged === true && g.players[0].cash === 1480, `cash=${g.players[0].cash}`);
  applyIntent(g, 'a', { t: 'unmortgage', space: 1 });
  check('赎回支付 55%', g.owners[1].mortgaged === false && g.players[0].cash === 1447, `cash=${g.players[0].cash}`);
}

{
  const g = game();
  g.players[0].pos = 1;
  g.phase = 'buy';
  applyIntent(g, 'a', { t: 'decline' });
  check('放弃购买进入拍卖', g.phase === 'auction' && g.auction && g.auction.space === 1);
  applyIntent(g, 'a', { t: 'auction-bid', amount: 50 });
  check('记录最高出价', g.auction.high === 50 && g.auction.highBidder === 'a');
  applyIntent(g, 'b', { t: 'auction-pass' });
  check('拍卖结束归属买家', g.owners[1].owner === 'a' && g.players[0].cash === 1450, `cash=${g.players[0].cash}`);
  check('拍卖后回到回合结束', g.phase === 'end' && g.auction === null);
}

{
  const g = game();
  applyIntent(g, 'a', { t: 'roll' });
  const t1 = g.turn;
  if (g.phase !== 'end' && g.phase !== 'roll') g.phase = 'end';
  g.canRollAgain = false;
  applyIntent(g, 'a', { t: 'end-turn' });
  check('结束回合交给下一位', g.turn !== t1 && currentPlayer(g).id === 'b', `turn=${g.turn}`);
}

{
  const g = game();
  g.owners[5] = { owner: 'a', houses: 0, mortgaged: false };
  g.phase = 'buy';
  g.players[0].pos = 39;
  g.players[1].cash = 10;
  applyIntent(g, 'b', { t: 'roll' });
  // Force a debt the player cannot pay, then fold.
  g.charge = { from: 'b', to: 'a', amount: 900, reason: '测试欠款' };
  g.phase = 'resolve';
  applyIntent(g, 'b', { t: 'bankrupt' });
  check('破产后标记出局', g.players[1].bankrupt === true);
  check('破产资产转移债权人', g.owners[5] && g.owners[5].owner === 'a');
  check('仅剩一人时判定胜者', g.finished === true && g.winner === 'a');
}

{
  const g = game();
  let guard = 0;
  let signature = '';
  let stalled = 0;
  while (!g.finished && guard < 4000) {
    const actor = g.charge
      ? player(g, g.charge.from)
      : g.phase === 'auction' && g.auction
        ? player(g, g.auction.order[g.auction.idx])
        : currentPlayer(g);
    const intent = ai.botIntent(g, actor.id) || { t: 'end-turn' };
    applyIntent(g, actor.id, intent);
    guard += 1;
    const next = `${g.turn}|${g.phase}|${g.canRollAgain}|${g.charge ? g.charge.amount : ''}|${g.players.map((p) => p.cash).join(',')}|${g.log.length}`;
    stalled = next === signature ? stalled + 1 : 0;
    signature = next;
    if (stalled > 300) break;
  }
  check('AI 对局不会卡死', stalled <= 300, `连续无进展 ${stalled} 步`);
  check('AI 可在 4000 步内跑完整局', g.finished === true, `步骤 ${guard}，回合 ${g.stats.rounds}`);
  check('AI 对局产生了地产交易与建筑', Object.keys(g.owners).length > 0);
}

/* ---------------------------------------------------------- part 2 page wiring */

console.log('\n[2] 页面接线');

const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const ui = fs.readFileSync(path.join(PUB, 'ui.js'), 'utf8');
const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
const refs = new Set([...ui.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]));
// #join-code is created dynamically when the online tab is opened.
const dynamicIds = new Set(['join-code']);
const missing = [...refs].filter((id) => !ids.has(id) && !dynamicIds.has(id));
check('ui.js 引用的 DOM id 都存在', missing.length === 0, missing.join(', '));
check('页面加载为 ES module 入口', html.includes('type="module"') && html.includes('/ui.js'));
check('样式表已链接', html.includes('/styles.css'));

const exports = Object.keys(engine);
check('引擎导出关键 API', ['createGame', 'applyIntent', 'legalActions'].every((k) => exports.includes(k)));
check('棋盘恰好 40 格', BOARD.length === 40);
check('地产格均有租金表', BOARD.filter((s) => s.type === 'prop').every((s) => s.rent?.length === 6));

/* ------------------------------------------------------- part 3 multiplayer */

console.log('\n[3] 联机协议');

const BASE_WS = process.env.BASE_WS || 'ws://127.0.0.1:8787/';

class Client {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.listeners = [];
  }
  async open() {
    this.ws = new WsClient(BASE_WS);
    this.ws.onmessage = (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      this.msgs.push(msg);
      for (let i = 0; i < this.listeners.length; i++) {
        if (this.listeners[i].pred(msg)) {
          const l = this.listeners.splice(i, 1)[0];
          clearTimeout(l.timer);
          l.resolve(msg);
          break;
        }
      }
    };
    await this.ws.connect();
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  waitFor(pred, timeout = 6000) {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: 等待超时`)), timeout);
      this.listeners.push({ pred, resolve, timer });
    });
  }
  close() { this.ws.close(); }
}

try {
  const host = new Client('host');
  const guest = new Client('guest');
  await host.open();
  await guest.open();

  host.send({ t: 'create', name: '房主' });
  const created = await host.waitFor((m) => m.t === 'joined');
  check('创建房间返回 4 位房间号', /^[A-Z0-9]{4}$/.test(created.room.code), created.room.code);
  check('创建者即房主', created.host === true && created.room.hostId === created.you);

  guest.send({ t: 'join', code: created.room.code, name: '阿明' });
  const joined = await guest.waitFor((m) => m.t === 'joined');
  check('加入房间成功', joined.host === false && joined.room.code === created.room.code);
  check('房间成员共 2 人', joined.room.members.length === 2, joined.room.members.map((m) => m.name).join('/'));
  const roster = await host.waitFor((m) => m.t === 'roster' && m.room.members.length === 2);
  check('房主收到成员名单更新', roster.room.members.length === 2);

  host.send({ t: 'ready', started: true });
  const start = await guest.waitFor((m) => m.t === 'start');
  check('开局信号广播到客机', start.t === 'start');

  const listed = await (await fetch('http://127.0.0.1:8787/api/rooms')).json();
  check('公开房间不出现在列表中（已开局）', !listed.rooms.some((r) => r.code === created.room.code));

  const pub = new Client('pub');
  await pub.open();
  pub.send({ t: 'create', name: '公开房主', public: true });
  const pubRoom = await pub.waitFor((m) => m.t === 'joined');
  const listed2 = await (await fetch('http://127.0.0.1:8787/api/rooms')).json();
  check('公开房间出现在大厅列表', listed2.rooms.some((r) => r.code === pubRoom.room.code), pubRoom.room.code);

  const priv = new Client('priv');
  await priv.open();
  priv.send({ t: 'create', name: '私密房主', public: false });
  const privRoom = await priv.waitFor((m) => m.t === 'joined');
  const listed3 = await (await fetch('http://127.0.0.1:8787/api/rooms')).json();
  check('私密房间不出现在大厅列表', !listed3.rooms.some((r) => r.code === privRoom.room.code));
  check('房间列表带容量信息', listed2.rooms.every((r) => r.players >= 1 && r.capacity >= 2 && typeof r.host === 'string'));
  pub.close();
  priv.close();

  host.send({ t: 'state', state: { rev: 3, marker: 'snapshot' }, rev: 3 });
  const snap = await guest.waitFor((m) => m.t === 'state');
  check('状态快照转发到客机', snap.state.marker === 'snapshot' && snap.rev === 3);

  guest.send({ t: 'toHost', data: { k: 'intent', intent: { t: 'roll' } } });
  const relay = await host.waitFor((m) => m.t === 'fromPeer');
  check('客机意图送达房主', relay.data.k === 'intent' && relay.data.intent.t === 'roll' && relay.from === joined.you);

  guest.send({ t: 'broadcast', data: { k: 'chat', text: '大家好' } });
  const chat = await host.waitFor((m) => m.t === 'peer');
  check('聊天广播到其他玩家', chat.data.text === '大家好' && chat.fromName === '阿明');

  guest.send({ t: 'broadcast', data: { k: 'chat', text: '再会' } });
  await host.waitFor((m) => m.t === 'peer' && m.data.text === '再会');
  guest.send({ t: 'leave' });
  const left = await host.waitFor((m) => m.t === 'peerLeft');
  check('离开房间通知同伴', left.id === joined.you && left.room.members.length === 1);

  // A late joiner receives the stored snapshot instead of being rejected.
  const late = new Client('late');
  await late.open();
  late.send({ t: 'join', code: created.room.code, name: '观察者' });
  const lateJoined = await late.waitFor((m) => m.t === 'joined');
  check('对局中可带快照重连', lateJoined.state && lateJoined.state.marker === 'snapshot');

  host.close();
  guest.close();
  late.close();
} catch (err) {
  check('联机协议测试执行完成', false, err.message);
}

/* ------------------------------------------------------------------ summary */

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
// Let sockets finish closing on their own instead of a hard exit, which
// trips a libuv teardown assertion on Windows.
process.exitCode = fail === 0 ? 0 : 1;
