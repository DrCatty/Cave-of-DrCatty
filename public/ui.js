// Board / lobby / interaction layer. Owns no rules: every mutation goes
// through applyIntent() so the host stays authoritative for all peers.

import { BOARD, GROUPS, GROUP_MEMBERS, gridPos, rentFor } from './board.js';
import {
  COLORS, TOKENS, DEFAULT_SETTINGS, createGame, applyIntent, currentPlayer, player,
  propsOf, ownsGroup, legalActions, netWorth, buildingCount,
} from './engine.js';
import { Net } from './net.js';
import { botIntent, botName } from './ai.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

const net = new Net();

const ui = {
  mode: 'menu',          // menu | offline | host | guest
  game: null,
  selected: null,        // board index shown in the detail sheet
  lobby: { tab: 'solo', botCount: 3, name: localStorage.getItem('mono.name') || '' },
  settings: { ...DEFAULT_SETTINGS },
  seenLog: 0,
  chat: [],
  chatTab: 'log',
  muted: localStorage.getItem('mono.muted') === '1',
  busy: false,
  lastRoll: 0,
  toast: null,
};

/* ------------------------------------------------------------------- audio */

let audioCtx = null;
function beep(freq = 440, dur = 0.07, gain = 0.04) {
  if (ui.muted) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const amp = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    amp.gain.value = gain;
    osc.connect(amp).connect(audioCtx.destination);
    osc.start();
    amp.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    osc.stop(audioCtx.currentTime + dur);
  } catch {
    /* audio is a nicety only */
  }
}

function toast(text) {
  ui.toast = text;
  renderToast();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    ui.toast = null;
    renderToast();
  }, 2600);
}

function renderToast() {
  const host = $('#toast');
  host.replaceChildren();
  host.hidden = !ui.toast;
  if (ui.toast) host.append(ui.toast);
}

/* -------------------------------------------------------------- networking */

function isAuthority() {
  return ui.mode === 'offline' || ui.mode === 'host';
}

function me() {
  if (ui.mode === 'offline') return ui.game ? currentPlayer(ui.game) : null;
  return ui.game ? player(ui.game, net.you) : null;
}

function canControl(playerId) {
  if (ui.mode === 'offline') return true;
  return playerId === net.you;
}

function publish() {
  if (!ui.game) return;
  ui.game.rev += 1;
  if (ui.mode === 'host') net.send({ t: 'state', state: ui.game, rev: ui.game.rev });
}

function act(intent, actorId) {
  const game = ui.game;
  if (!game) return;
  const actor = actorId || (me() && me().id);
  if (!actor) return;
  if (isAuthority()) {
    applyIntent(game, actor, intent);
    publish();
    afterChange();
  } else {
    net.send({ t: 'toHost', data: { k: 'intent', intent, actor } });
    ui.busy = true;
    renderPanel();
  }
}

function afterChange() {
  const events = ui.game.log.slice(ui.seenLog);
  if (events.length) {
    const last = events[events.length - 1];
    if (/买下|拍得/.test(last.text)) beep(660, 0.09);
    else if (/支付|罚款|租金/.test(last.text)) beep(240, 0.09);
    else if (/入狱|破产/.test(last.text)) beep(160, 0.16);
    else if (/收获|获得|奖金|起点/.test(last.text)) beep(880, 0.07);
  }
  const diceChanged = ui.game.dice[0] !== ui.lastRoll;
  if (diceChanged) {
    ui.lastRoll = ui.game.dice[0];
    beep(520, 0.05, 0.03);
    setTimeout(() => beep(400, 0.05, 0.03), 70);
  }
  renderAll();
  scheduleBots();
}

net.addEventListener('joined', (ev) => {
  const { room, host, state } = ev.detail;
  ui.chat.push({ system: true, text: `已进入房间 ${room.code}` });
  if (host) ui.mode = 'host';
  else if (!ui.game) ui.mode = 'guest';
  if (state) ui.game = state;
  renderAll();
  if (!host && !state) net.send({ t: 'toHost', data: { k: 'hello' } });
});

net.addEventListener('roster', () => {
  if (!ui.game) renderLobby();
});

net.addEventListener('newHost', (ev) => {
  if (ev.detail.hostId === net.you) {
    ui.mode = 'host';
    if (ev.detail.state) ui.game = ev.detail.state;
    toast('你已成为房主，继续主持对局。');
  } else if (!ui.game) {
    ui.mode = 'guest';
  }
  renderAll();
});

net.addEventListener('state', (ev) => {
  ui.game = ev.detail.state;
  ui.mode = 'guest';
  ui.busy = false;
  afterChange();
});

net.addEventListener('start', () => {
  if (!ui.game) toast('房主已开始对局。');
});

net.addEventListener('fromPeer', (ev) => {
  const { from, fromName, data } = ev.detail;
  if (!data || !ui.game) return;
  if (data.k === 'intent') {
    if (!player(ui.game, from)) return;
    applyIntent(ui.game, from, data.intent);
    publish();
    afterChange();
  } else if (data.k === 'hello') {
    net.send({ t: 'state', state: ui.game, rev: ui.game.rev });
  } else if (data.k === 'chat') {
    ui.chat.push({ name: fromName, text: String(data.text).slice(0, 200) });
    renderLog();
  }
});

net.addEventListener('peer', (ev) => {
  const { fromName, data } = ev.detail;
  if (data && data.k === 'chat') {
    ui.chat.push({ name: fromName, text: String(data.text).slice(0, 200) });
    renderLog();
  }
});

net.addEventListener('peerLeft', (ev) => {
  ui.chat.push({ system: true, text: `${ev.detail.name || '一位玩家'} 离开了房间` });
  renderLog();
});

net.addEventListener('error', (ev) => {
  toast(ev.detail.message);
  renderLobby();
});

net.addEventListener('kicked', () => {
  toast('你已被房主移出房间。');
  ui.mode = 'menu';
  ui.game = null;
  renderAll();
});

net.addEventListener('close', () => {
  if (ui.mode === 'guest' || ui.mode === 'host') toast('连接中断，正在重连…');
});

/* -------------------------------------------------------------------- bots */

let botTimer = null;

function pendingActor(game) {
  if (!game || game.finished) return null;
  if (game.charge) return player(game, game.charge.from);
  if (game.phase === 'auction' && game.auction) {
    return player(game, game.auction.order[game.auction.idx]);
  }
  return currentPlayer(game);
}

function scheduleBots() {
  clearTimeout(botTimer);
  const game = ui.game;
  if (!game || !isAuthority()) return;
  const actor = pendingActor(game);
  if (!actor || !actor.isBot) return;
  const delay = Math.max(220, game.settings.speed || 900);
  botTimer = setTimeout(() => {
    const intent = botIntent(game, actor.id);
    if (intent) {
      applyIntent(game, actor.id, intent);
      publish();
    } else if (game.phase === 'auction' && game.auction) {
      applyIntent(game, actor.id, { t: 'auction-pass' });
      publish();
    } else if (game.phase === 'buy') {
      applyIntent(game, actor.id, { t: 'decline' });
      publish();
    } else if (game.phase === 'end') {
      applyIntent(game, actor.id, { t: 'end-turn' });
      publish();
    }
    afterChange();
  }, delay);
}

/* ------------------------------------------------------------------ render */

function renderAll() {
  $('#topbar').hidden = !ui.game;
  $('#lobby').hidden = !!ui.game;
  $('#stage').hidden = !ui.game;
  if (!ui.game) {
    renderLobby();
    return;
  }
  renderTop();
  renderBoard();
  renderPlayers();
  renderPanel();
  renderLog();
  renderDetail();
}

function renderTop() {
  const game = ui.game;
  const cp = pendingActor(game);
  $('#turn-label').textContent = game.finished
    ? '对局结束'
    : cp
      ? `${cp.token} ${cp.name} 的行动`
      : '等待中';
  const dot = $('#turn-dot');
  dot.style.background = cp ? cp.color : '#94a3b8';
  $('#room-chip').textContent = ui.mode === 'offline'
    ? (game.players.some((p) => p.isBot) ? '单机对战' : '本地热座')
    : `房间 ${net.room ? net.room.code : '----'}${net.host ? ' · 房主' : ''}`;
  $('#net-chip').textContent = ui.mode === 'offline'
    ? '本地'
    : net.connected ? `${net.latency} ms` : '重连中';
  $('#net-chip').classList.toggle('off', ui.mode !== 'offline' && !net.connected);
}

function edgeOf(space) {
  return space.edge;
}

function renderBoard() {
  const game = ui.game;
  const board = $('#board');
  board.replaceChildren();

  for (const space of BOARD) {
    const { row, col } = gridPos(space.i);
    const entry = game.owners[space.i];
    const owner = entry ? player(game, entry.owner) : null;
    const cls = ['cell', `edge-${edgeOf(space)}`, `type-${space.type}`];
    if (owner) cls.push('owned');
    if (entry && entry.mortgaged) cls.push('mortgaged');
    if (ui.selected === space.i) cls.push('selected');

    const cell = el('div', {
      class: cls.join(' '),
      style: { gridRow: row, gridColumn: col },
      onclick: () => {
        ui.selected = ui.selected === space.i ? null : space.i;
        renderBoard();
        renderDetail();
      },
    });

    if (space.group) {
      cell.append(el('div', {
        class: 'band',
        style: { background: GROUPS[space.group].color },
      }));
    }
    if (owner) {
      cell.append(el('div', { class: 'ownbar', style: { background: owner.color } }));
    }

    const body = el('div', { class: 'cell-body' });
    if (space.type === 'go') body.append(el('div', { class: 'corner-title', text: 'GO' }), el('div', { class: 'corner-sub', text: '领取 $200' }));
    else if (space.type === 'jail') body.append(el('div', { class: 'corner-title', text: '监狱' }), el('div', { class: 'corner-sub', text: '免费探监' }));
    else if (space.type === 'parking') body.append(el('div', { class: 'corner-title', text: '免费停车' }), el('div', { class: 'corner-sub', text: game.settings.freeParkingPot ? `奖池 ${money(game.pot)}` : '休息一回合' }));
    else if (space.type === 'goto-jail') body.append(el('div', { class: 'corner-title', text: '入狱' }), el('div', { class: 'corner-sub', text: '直接进监狱' }));
    else {
      body.append(el('div', { class: 'name', text: space.short }));
      if (space.price) body.append(el('div', { class: 'price', text: money(space.price) }));
      if (space.type === 'chance' || space.type === 'chest') {
        body.append(el('div', { class: 'icon', text: space.type === 'chance' ? '?' : '🎁' }));
      }
      if (space.type === 'tax') body.append(el('div', { class: 'icon', text: '💸' }));
    }

    if (entry && entry.houses > 0 && space.type === 'prop') {
      body.append(el('div', { class: 'houses', text: entry.houses === 5 ? '🏨' : '🏠'.repeat(entry.houses) }));
    }
    cell.append(body);
    board.append(cell);
  }

  board.append(renderCenter());

  // Token layer: absolute positions make movement animate via CSS transitions.
  const layer = el('div', { class: 'token-layer' });
  const groups = new Map();
  for (const p of game.players) {
    const key = p.bankrupt ? `b${p.id}` : String(p.pos);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const [key, list] of groups) {
    const pos = key.startsWith('b') ? null : Number(key);
    list.forEach((p, i) => {
      const { row, col } = gridPos(pos == null ? 10 : pos);
      const spread = list.length > 1 ? (i - (list.length - 1) / 2) * 2.1 : 0;
      const left = ((col - 0.5) / 11) * 100 + spread;
      const top = ((row - 0.5) / 11) * 100 + (pos == null ? 1.6 : 0);
      const tok = el('div', {
        class: `tok${p.bankrupt ? ' out' : ''}${currentPlayer(game)?.id === p.id && !game.finished ? ' active' : ''}`,
        style: { left: `${left}%`, top: `${top}%`, background: p.color },
        title: `${p.name} · ${money(p.cash)}`,
        text: p.token,
      });
      layer.append(tok);
    });
  }
  board.append(layer);
}

function renderCenter() {
  const game = ui.game;
  const [d1, d2] = game.dice;
  const center = el('div', { class: 'center' });

  const head = el('div', { class: 'center-head' });
  head.append(el('div', { class: 'brand', text: '大富翁' }));
  head.append(el('div', { class: 'brand-sub', text: ui.mode === 'offline' ? 'OFFLINE' : `ROOM ${net.room ? net.room.code : ''}` }));
  center.append(head);

  const diceRow = el('div', { class: 'dice-row' });
  diceRow.append(dieFace(d1));
  diceRow.append(dieFace(d2));
  if (d1) diceRow.append(el('div', { class: 'dice-total', text: `${d1 + d2}` }));
  center.append(diceRow);

  const pot = el('div', { class: 'center-meta' });
  if (game.settings.freeParkingPot) pot.append(el('span', { class: 'meta', text: `免费停车奖池 ${money(game.pot)}` }));
  pot.append(el('span', { class: 'meta', text: `回合 ${game.stats.rounds + 1}` }));
  pot.append(el('span', { class: 'meta', text: `交易 ${game.stats.trades}` }));
  center.append(pot);

  // Last few log lines make the middle of the board readable at a glance.
  const feed = el('div', { class: 'center-feed' });
  for (const line of game.log.slice(-3)) {
    feed.append(el('div', { class: `feed-line k-${line.kind}`, text: line.text }));
  }
  center.append(feed);

  if (game.finished) {
    const w = player(game, game.winner);
    center.append(el('div', { class: 'winner', text: w ? `${w.token} ${w.name} 获胜！` : '对局结束' }));
    center.append(el('button', { class: 'btn primary', text: '再来一局', onclick: restart }));
  }
  return center;
}

function dieFace(v) {
  const face = el('div', { class: `die${v ? '' : ' blank'}` });
  for (let i = 1; i <= 9; i++) face.append(el('i', { class: `pip${v && PIPS[v].includes(i) ? ' on' : ''}` }));
  return face;
}

const PIPS = {
  1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9],
};

/* ---------------------------------------------------------------- players */

function renderPlayers() {
  const game = ui.game;
  const wrap = $('#players');
  wrap.replaceChildren();
  const ranked = [...game.players].sort((a, b) => (a.bankrupt === b.bankrupt ? netWorth(game, b.id) - netWorth(game, a.id) : a.bankrupt ? 1 : -1));

  for (const p of ranked) {
    const isTurn = !game.finished && currentPlayer(game).id === p.id;
    const mine = canControl(p.id);
    const card = el('div', { class: `pcard${isTurn ? ' turn' : ''}${p.bankrupt ? ' out' : ''}${mine ? ' mine' : ''}` });
    card.style.setProperty('--pc', p.color);

    const head = el('div', { class: 'pcard-head' });
    head.append(el('span', { class: 'ptoken', text: p.token }));
    head.append(el('span', { class: 'pname', text: p.name + (p.isBot ? ' · AI' : '') }));
    if (isTurn) head.append(el('span', { class: 'ptag', text: '行动中' }));
    if (p.inJail) head.append(el('span', { class: 'ptag warn', text: `狱中 ${p.jailTurns}/3` }));
    head.append(el('span', { class: 'pcash', text: money(p.cash) }));
    card.append(head);

    const meta = el('div', { class: 'pcard-meta' });
    meta.append(el('span', { text: `净资产 ${money(netWorth(game, p.id))}` }));
    if (p.cards) meta.append(el('span', { text: `出狱卡 ×${p.cards}` }));
    meta.append(el('span', { text: `位置 ${BOARD[p.pos].short}` }));
    card.append(meta);

    const chips = el('div', { class: 'chips' });
    const owned = propsOf(game, p.id);
    if (!owned.length) chips.append(el('span', { class: 'empty', text: '暂无地产' }));
    for (const i of owned) {
      const space = BOARD[i];
      const entry = game.owners[i];
      chips.append(el('button', {
        class: `chip${entry.mortgaged ? ' mort' : ''}`,
        style: { '--cc': GROUPS[space.group]?.color || '#64748b' },
        text: space.short + (entry.houses === 5 ? ' 🏨' : entry.houses ? ` ${'●'.repeat(entry.houses)}` : ''),
        onclick: () => {
          ui.selected = i;
          renderBoard();
          renderDetail();
        },
      }));
    }
    card.append(chips);
    wrap.append(card);
  }
}

/* ------------------------------------------------------------------ panel */

function renderPanel() {
  const game = ui.game;
  const wrap = $('#panel');
  wrap.replaceChildren();
  const actor = me();
  if (!actor) {
    wrap.append(el('div', { class: 'hint', text: '你是旁观者，可以观战和聊天。' }));
    return;
  }
  const acts = legalActions(game, actor.id);
  const isTurn = acts.current === actor.id;
  const row = el('div', { class: 'actions' });

  if (game.finished) {
    wrap.append(el('div', { class: 'hint', text: '本局已结束。' }));
  } else if (game.charge && game.charge.from === actor.id) {
    const c = game.charge;
    wrap.append(el('div', { class: 'alert', text: `你需要支付 ${money(c.amount)}${c.to ? ` 给 ${player(game, c.to).name}` : ' 给银行'}。可抵押或变卖地产筹款。` }));
    row.append(el('button', { class: 'btn primary', text: `支付 ${money(c.amount)}`, disabled: actor.cash < c.amount, onclick: () => act({ t: 'settle-charge' }) }));
    row.append(el('button', { class: 'btn danger', text: '宣布破产', onclick: () => confirmBox('宣布破产？全部资产将移交债权人。', () => act({ t: 'bankrupt' })) }));
  } else if (isTurn && game.phase === 'jail') {
    wrap.append(el('div', { class: 'hint', text: `你在监狱中（第 ${actor.jailTurns} 次）。` }));
    row.append(el('button', { class: 'btn', text: `支付保释金 ${money(game.settings.jailFine)}`, disabled: actor.cash < game.settings.jailFine, onclick: () => act({ t: 'jail', action: 'pay' }) }));
    if (actor.cards > 0) row.append(el('button', { class: 'btn', text: `使用出狱卡 ×${actor.cards}`, onclick: () => act({ t: 'jail', action: 'card' }) }));
    row.append(el('button', { class: 'btn primary', text: '掷骰求双数', onclick: () => act({ t: 'jail', action: 'roll' }) }));
  } else if (isTurn && game.phase === 'roll') {
    wrap.append(el('div', { class: 'hint', text: game.canRollAgain ? '双数，可以再掷一次。' : '轮到你了，掷骰开始行动。' }));
    row.append(el('button', { class: 'btn primary big', text: '掷骰子', onclick: () => act({ t: 'roll' }) }));
  } else if (isTurn && game.phase === 'buy') {
    const space = BOARD[actor.pos];
    wrap.append(el('div', { class: 'hint', text: `${space.name} 无人拥有，价格 ${money(space.price)}。` }));
    row.append(el('button', { class: 'btn primary', text: `购买 ${money(space.price)}`, disabled: actor.cash < space.price, onclick: () => act({ t: 'buy' }) }));
    row.append(el('button', { class: 'btn', text: game.settings.auctionOnDecline ? '进入拍卖' : '放弃购买', onclick: () => act({ t: 'decline' }) }));
  } else if (game.phase === 'auction' && game.auction) {
    const a = game.auction;
    const space = BOARD[a.space];
    const bidder = player(game, a.order[a.idx]);
    wrap.append(el('div', { class: 'alert', text: `《${space.name}》拍卖中，当前最高 ${a.high ? `${money(a.high)}（${player(game, a.highBidder).name}）` : '无人出价'}。` }));
    wrap.append(el('div', { class: 'hint', text: `等待 ${bidder.name} 出价。` }));
    if (acts.canBid) {
      const input = el('input', { class: 'input', type: 'number', min: acts.minBid, max: acts.maxBid, value: Math.min(acts.maxBid, acts.minBid) });
      const quick = el('div', { class: 'actions' });
      for (const step of [10, 20, 50]) {
        quick.append(el('button', { class: 'btn tiny', text: `+${step}`, onclick: () => { input.value = Math.min(acts.maxBid, Number(input.value) + step); } }));
      }
      row.append(input);
      row.append(el('button', { class: 'btn primary', text: '出价', onclick: () => act({ t: 'auction-bid', amount: Number(input.value) }) }));
      row.append(el('button', { class: 'btn', text: '放弃', onclick: () => act({ t: 'auction-pass' }) }));
      wrap.append(quick);
    }
  } else if (isTurn && game.phase === 'resolve') {
    wrap.append(el('div', { class: 'hint', text: '请先处理欠款。' }));
  } else if (isTurn) {
    wrap.append(el('div', { class: 'hint', text: '可以建造房屋、抵押地产或与其他玩家交易，然后结束回合。' }));
    row.append(el('button', { class: 'btn primary big', text: '结束回合', onclick: () => act({ t: 'end-turn' }) }));
  } else {
    wrap.append(el('div', { class: 'hint', text: '等待其他玩家行动。你也可以交易、抵押或建造自己的地产。' }));
  }

  wrap.append(row);

  const tools = el('div', { class: 'actions tools' });
  tools.append(el('button', { class: 'btn ghost', text: '发起交易', onclick: openTrade }));
  tools.append(el('button', { class: 'btn ghost', text: '我的地产', onclick: () => { ui.selected = propsOf(game, actor.id)[0] ?? null; renderBoard(); renderDetail(); } }));
  wrap.append(tools);
  if (ui.busy) wrap.append(el('div', { class: 'hint waiting', text: '等待房主确认…' }));
}

/* -------------------------------------------------------------------- log */

function renderLog() {
  const wrap = $('#log');
  wrap.replaceChildren();
  $$('.tab', $('#log-tabs')).forEach((t) => t.classList.toggle('on', t.dataset.tab === ui.chatTab));

  if (ui.chatTab === 'chat') {
    for (const m of ui.chat.slice(-120)) {
      wrap.append(el('div', { class: `logline${m.system ? ' k-system' : ''}` }, m.system
        ? [m.text]
        : [el('b', { text: `${m.name}: ` }), m.text]));
    }
  } else {
    for (const line of ui.game.log.slice(-120)) {
      wrap.append(el('div', { class: `logline k-${line.kind}`, text: line.text }));
    }
  }
  wrap.scrollTop = wrap.scrollHeight;
}

/* ----------------------------------------------------------------- detail */

function groupStatus(game, space) {
  if (!space.group) return null;
  const members = GROUP_MEMBERS[space.group];
  const owners = members.map((i) => game.owners[i]);
  const same = owners[0] && owners.every((o) => o && o.owner === owners[0].owner);
  return same ? player(game, owners[0].owner) : null;
}

function renderDetail() {
  const sheet = $('#detail');
  const game = ui.game;
  if (ui.selected == null || !game) {
    sheet.hidden = true;
    return;
  }
  const space = BOARD[ui.selected];
  const entry = game.owners[space.i];
  const owner = entry ? player(game, entry.owner) : null;
  sheet.hidden = false;
  sheet.replaceChildren();

  const head = el('div', { class: 'sheet-head' });
  if (space.group) head.append(el('span', { class: 'swatch', style: { background: GROUPS[space.group].color } }));
  head.append(el('h3', { text: space.name }));
  head.append(el('button', { class: 'icon-btn', text: '✕', onclick: () => { ui.selected = null; renderBoard(); renderDetail(); } }));
  sheet.append(head);

  const info = el('div', { class: 'sheet-info' });
  if (space.price) info.append(el('div', { text: `价格 ${money(space.price)}` }));
  if (space.house) info.append(el('div', { text: `每栋房屋 ${money(space.house)}` }));
  if (space.amount) info.append(el('div', { text: `缴纳 ${money(space.amount)}` }));
  info.append(el('div', { text: owner ? `所有者：${owner.name}${entry.mortgaged ? '（已抵押）' : ''}` : '所有者：银行' }));
  const monopolyOwner = groupStatus(game, space);
  if (monopolyOwner) info.append(el('div', { class: 'ok', text: `${GROUPS[space.group].name} 已由 ${monopolyOwner.name} 垄断` }));
  sheet.append(info);

  if (space.rent) {
    const table = el('table', { class: 'rent' });
    const rows = [['基本租金', space.rent[0], owner && !entry.houses && groupStatus(game, space) ? space.rent[0] * 2 : null],
      ['1 栋房屋', space.rent[1]], ['2 栋房屋', space.rent[2]], ['3 栋房屋', space.rent[3]],
      ['4 栋房屋', space.rent[4]], ['旅馆', space.rent[5]]];
    for (const [label, value, alt] of rows) {
      const tr = el('tr');
      tr.append(el('td', { text: label }), el('td', { text: alt ? `${money(alt)}（垄断翻倍）` : money(value) }));
      table.append(tr);
    }
    sheet.append(table);
  }

  if (entry && owner && canControl(owner.id) && space.type === 'prop') {
    const row = el('div', { class: 'actions' });
    row.append(el('button', { class: 'btn', text: `建造房屋 ${money(space.house)}`, disabled: entry.houses >= 5, onclick: () => { act({ t: 'build', space: space.i }, owner.id); } }));
    row.append(el('button', { class: 'btn', text: `拆除房屋 +${money(Math.floor(space.house / 2))}`, disabled: entry.houses === 0, onclick: () => { act({ t: 'sell-house', space: space.i }, owner.id); } }));
    row.append(entry.mortgaged
      ? el('button', { class: 'btn', text: `赎回 ${money(Math.ceil(space.price * 0.55))}`, onclick: () => act({ t: 'unmortgage', space: space.i }, owner.id) })
      : el('button', { class: 'btn', text: `抵押 +${money(Math.floor(space.price / 2))}`, onclick: () => act({ t: 'mortgage', space: space.i }, owner.id) }));
    sheet.append(row);
  } else if (entry && owner && !canControl(owner.id) && space.type !== 'prop') {
    const row = el('div', { class: 'actions' });
    row.append(entry.mortgaged
      ? el('button', { class: 'btn', text: '赎回', onclick: () => act({ t: 'unmortgage', space: space.i }, owner.id) })
      : el('button', { class: 'btn', text: '抵押', onclick: () => act({ t: 'mortgage', space: space.i }, owner.id) }));
    sheet.append(row);
  }
}

/* ------------------------------------------------------------------ trade */

function openTrade() {
  const game = ui.game;
  const actor = me();
  if (!game || !actor) return;
  const others = game.players.filter((p) => !p.bankrupt && p.id !== actor.id);
  if (!others.length) return toast('没有可交易的对象。');
  const dialog = $('#modal');
  dialog.hidden = false;
  dialog.replaceChildren();
  const target = others[0].id;
  const state = { to: target, mine: new Set(), theirs: new Set(), give: 0, get: 0 };

  const box = el('div', { class: 'modal-box wide' });
  box.append(el('h3', { text: '发起交易' }));
  const selectWrap = el('div', { class: 'field' });
  const select = el('select', { class: 'input' }, others.map((p) => el('option', { value: p.id, text: `${p.token} ${p.name}` })));
  select.addEventListener('change', () => { state.to = select.value; state.theirs.clear(); paint(); });
  selectWrap.append(el('label', { text: '交易对象' }), select);
  box.append(selectWrap);

  const body = el('div', { class: 'trade-grid' });
  box.append(body);

  const actions = el('div', { class: 'actions' });
  actions.append(el('button', { class: 'btn primary', text: '发送提案', onclick: () => {
    act({ t: 'trade-offer', to: state.to, give: { props: [...state.mine], cash: Number(state.give) || 0 }, get: { props: [...state.theirs], cash: Number(state.get) || 0 } }, actor.id);
    closeModal();
  } }));
  actions.append(el('button', { class: 'btn', text: '取消', onclick: closeModal }));
  box.append(actions);
  dialog.append(box);

  function paint() {
    body.replaceChildren();
    const other = player(game, state.to);
    body.append(tradeColumn('你付出', actor, state.mine, state.give, (v) => { state.give = v; }));
    body.append(tradeColumn(`你获得（${other.name}）`, other, state.theirs, state.get, (v) => { state.get = v; }));
  }
  function tradeColumn(title, who, set, cashVal, onCash) {
    const col = el('div', { class: 'trade-col' });
    col.append(el('h4', { text: title }));
    const list = el('div', { class: 'trade-list' });
    const owned = propsOf(game, who.id);
    if (!owned.length) list.append(el('div', { class: 'empty', text: '没有地产' }));
    for (const i of owned) {
      const space = BOARD[i];
      const row = el('label', { class: 'trade-row' });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = set.has(i);
      cb.addEventListener('change', () => { cb.checked ? set.add(i) : set.delete(i); });
      row.append(cb, el('span', { class: 'swatch small', style: { background: GROUPS[space.group]?.color || '#64748b' } }), el('span', { text: `${space.short} · ${money(space.price)}` }));
      list.append(row);
    }
    col.append(list);
    const cashRow = el('div', { class: 'field' });
    const input = el('input', { class: 'input', type: 'number', min: 0, max: who.cash, value: cashVal });
    input.addEventListener('input', () => onCash(Number(input.value) || 0));
    cashRow.append(el('label', { text: `现金（上限 ${money(who.cash)}）` }), input);
    col.append(cashRow);
    return col;
  }
  paint();
}

function closeModal() {
  const dialog = $('#modal');
  dialog.hidden = true;
  dialog.replaceChildren();
  renderAll();
}

let confirmAction = null;
function confirmBox(text, onYes) {
  const dialog = $('#modal');
  dialog.hidden = false;
  dialog.replaceChildren();
  confirmAction = onYes;
  const box = el('div', { class: 'modal-box' });
  box.append(el('h3', { text: '确认操作' }));
  box.append(el('p', { text }));
  const row = el('div', { class: 'actions' });
  row.append(el('button', { class: 'btn danger', text: '确定', onclick: () => { dialog.hidden = true; dialog.replaceChildren(); confirmAction && confirmAction(); } }));
  row.append(el('button', { class: 'btn', text: '取消', onclick: closeModal }));
  box.append(row);
  dialog.append(box);
}

function showIncomingTrade() {
  const game = ui.game;
  const t = game.trade;
  if (!t) return;
  const isTarget = canControl(t.to) || ui.mode === 'offline';
  if (!isTarget || ui.modalShown === t.at) return;
  ui.modalShown = t.at;
  const dialog = $('#modal');
  dialog.hidden = false;
  dialog.replaceChildren();
  const box = el('div', { class: 'modal-box wide' });
  const from = player(game, t.from);
  const to = player(game, t.to);
  box.append(el('h3', { text: `${from.name} 的交易提案` }));
  const grid = el('div', { class: 'trade-grid' });
  grid.append(bundleBox(`${from.name} 付出`, from, t.give));
  grid.append(bundleBox(`${to.name} 付出`, to, t.get));
  box.append(grid);
  const row = el('div', { class: 'actions' });
  row.append(el('button', { class: 'btn primary', text: '接受', onclick: () => { act({ t: 'trade-accept' }, t.to); closeModal(); } }));
  row.append(el('button', { class: 'btn danger', text: '拒绝', onclick: () => { act({ t: 'trade-decline' }, t.to); closeModal(); } }));
  box.append(row);
  dialog.append(box);
}

function bundleBox(title, who, bundle) {
  const box = el('div', { class: 'trade-col' });
  box.append(el('h4', { text: title }));
  const list = el('div', { class: 'trade-list' });
  for (const i of bundle.props) {
    box.append(el('div', { class: 'trade-static', text: BOARD[i].short }));
  }
  if (!bundle.props.length) list.append(el('div', { class: 'empty', text: '无地产' }));
  if (bundle.cash) list.append(el('div', { class: 'trade-static', text: `现金 ${money(bundle.cash)}` }));
  if (bundle.cards) list.append(el('div', { class: 'trade-static', text: `出狱卡 ×${bundle.cards}` }));
  box.append(list);
  return box;
}

/* ------------------------------------------------------------------ lobby */

function renderLobby() {
  const lobby = $('#lobby');
  if (!lobby) return;
  lobby.replaceChildren();
  const inRoom = ui.mode === 'host' || ui.mode === 'guest';

  const shell = el('div', { class: 'lobby-shell' });
  const left = el('div', { class: 'lobby-main' });

  left.append(el('div', { class: 'logo' }, [
    el('span', { class: 'logo-mark', text: '🎩' }),
    el('div', {}, [el('h1', { text: '大富翁' }), el('p', { text: '经典规则 · 联机对局 · AI 对手' })]),
  ]));

  if (!inRoom) {
    const tabs = el('div', { class: 'seg' });
    for (const [key, label] of [['solo', '单机对战'], ['hotseat', '本地热座'], ['online', '联机房间']]) {
      tabs.append(el('button', { class: `seg-btn${ui.lobby.tab === key ? ' on' : ''}`, text: label, onclick: () => { ui.lobby.tab = key; renderLobby(); } }));
    }
    left.append(tabs);

    const form = el('div', { class: 'lobby-form' });
    form.append(nameField());
    if (ui.lobby.tab === 'solo') {
      form.append(stepper('AI 对手数量', ui.lobby.botCount, 1, 7, (v) => { ui.lobby.botCount = v; }));
    } else if (ui.lobby.tab === 'hotseat') {
      form.append(stepper('本地玩家数量', ui.lobby.humanCount || 3, 2, 8, (v) => { ui.lobby.humanCount = v; }));
    } else {
      const row = el('div', { class: 'field' });
      row.append(el('label', { text: '房间号' }));
      const input = el('input', { class: 'input', placeholder: '4 位房间号', maxlength: 4, value: ui.lobby.code || '' });
      input.id = 'join-code';
      input.addEventListener('input', () => { ui.lobby.code = input.value.toUpperCase(); });
      row.append(input);
      form.append(row);
      const row2 = el('div', { class: 'actions' });
      row2.append(el('button', { class: 'btn primary', text: '创建房间', onclick: createRoom }));
      row2.append(el('button', { class: 'btn', text: '加入房间', onclick: joinRoom }));
      form.append(row2);

      const pubRow = el('label', { class: 'toggle' });
      const pubInput = el('input', { type: 'checkbox' });
      pubInput.checked = ui.lobby.publicRoom !== false;
      pubInput.addEventListener('change', () => { ui.lobby.publicRoom = pubInput.checked; });
      pubRow.append(pubInput, el('div', {}, [
        el('b', { text: '公开房间' }),
        el('small', { text: '创建后显示在大厅的公开房间列表，陌生人可直接加入。' }),
      ]));
      form.append(pubRow);
      form.append(publicRoomList());
    }
    if (ui.lobby.tab !== 'online') {
      form.append(el('div', { class: 'actions' }, [
        el('button', { class: 'btn primary big', text: '开始游戏', onclick: startOffline }),
      ]));
    }
    left.append(form);
  } else {
    const card = el('div', { class: 'room-card' });
    card.append(el('div', { class: 'room-code' }, [
      el('span', { text: '房间号' }),
      el('b', { text: net.room ? net.room.code : '----' }),
      el('button', { class: 'btn tiny', text: '复制', onclick: () => { navigator.clipboard?.writeText(net.room.code); toast('房间号已复制'); } }),
    ]));
    const list = el('div', { class: 'room-list' });
    const members = net.room ? net.room.members : [];
    for (const m of members) {
      list.append(el('div', { class: `room-row${m.id === net.you ? ' me' : ''}` }, [
        el('span', { class: 'dot', style: { background: COLORS[members.indexOf(m) % COLORS.length] } }),
        el('span', { text: m.name + (m.id === net.you ? '（你）' : '') }),
        m.id === net.room.hostId ? el('span', { class: 'ptag', text: '房主' }) : null,
      ]));
    }
    card.append(list);
    if (net.host) {
      card.append(stepper('AI 对手数量', ui.lobby.botCount, 0, 7, (v) => { ui.lobby.botCount = v; }));
      card.append(el('div', { class: 'actions' }, [
        el('button', { class: 'btn primary big', text: '开始联机对局', onclick: startOnline }),
      ]));
    } else {
      card.append(el('div', { class: 'hint', text: '等待房主开始对局…' }));
    }
    card.append(el('div', { class: 'actions' }, [
      el('button', { class: 'btn ghost', text: '离开房间', onclick: () => { net.leave(); ui.mode = 'menu'; renderLobby(); } }),
    ]));
    left.append(card);
  }

  const side = el('div', { class: 'lobby-side' });
  side.append(el('h3', { text: '规则设置' }));
  side.append(select('初始资金', ui.settings.startingCash, [[1000, '$1,000'], [1500, '$1,500'], [2500, '$2,500']], (v) => { ui.settings.startingCash = v; }));
  side.append(select('经过起点', ui.settings.goSalary, [[200, '$200'], [300, '$300']], (v) => { ui.settings.goSalary = v; }));
  side.append(toggle('流拍后拍卖', 'auctionOnDecline', '无人购买时进入竞拍，符合官方规则。'));
  side.append(toggle('免费停车奖池', 'freeParkingPot', '罚款累积到免费停车，停在该格全部取走。'));
  side.append(toggle('停在起点双倍', 'doubleGoSalary', '正好停在起点领取双倍薪水。'));
  side.append(select('出狱保释金', ui.settings.jailFine, [[50, '$50'], [100, '$100'], [200, '$200']], (v) => { ui.settings.jailFine = v; }));
  side.append(select('行动速度', ui.settings.speed, [[500, '快'], [900, '标准'], [1600, '慢']], (v) => { ui.settings.speed = v; }));
  side.append(el('button', { class: 'btn ghost wide', text: '查看规则说明', onclick: showRules }));
  left.append(side);

  shell.append(left);
  lobby.append(shell);
}

function nameField() {
  const row = el('div', { class: 'field' });
  row.append(el('label', { text: '你的昵称' }));
  const input = el('input', { class: 'input', maxlength: 12, value: ui.lobby.name, placeholder: '输入昵称' });
  input.addEventListener('input', () => { ui.lobby.name = input.value; localStorage.setItem('mono.name', input.value); });
  row.append(input);
  return row;
}

function publicRoomList() {
  const wrap = el('div', { class: 'pub-rooms' });
  const head = el('div', { class: 'pub-head' });
  head.append(el('b', { text: '公开房间' }));
  head.append(el('button', { class: 'btn tiny', text: '刷新', onclick: () => loadPublicRooms(wrap) }));
  wrap.append(head);
  const list = el('div', { class: 'pub-list', text: '加载中…' });
  wrap.append(list);
  loadPublicRooms(wrap);
  return wrap;
}

async function loadPublicRooms(wrap) {
  const list = wrap.querySelector('.pub-list');
  if (!list) return;
  try {
    const res = await fetch('/api/rooms', { cache: 'no-store' });
    const data = await res.json();
    list.replaceChildren();
    if (!data.rooms || data.rooms.length === 0) {
      list.append(el('div', { class: 'empty', text: '暂无公开房间，创建一个吧。' }));
      return;
    }
    for (const room of data.rooms) {
      const row = el('div', { class: 'pub-row' });
      row.append(el('b', { text: room.code }));
      row.append(el('span', { text: `${room.host} · ${room.players}/${room.capacity} 人` }));
      row.append(el('button', {
        class: 'btn tiny',
        text: '加入',
        onclick: () => {
          ui.lobby.code = room.code;
          const input = $('#join-code');
          if (input) input.value = room.code;
          joinRoom();
        },
      }));
      list.append(row);
    }
  } catch {
    list.textContent = '无法获取房间列表。';
  }
}

function stepper(label, value, min, max, onChange) {
  const row = el('div', { class: 'field' });
  row.append(el('label', { text: label }));
  const wrap = el('div', { class: 'stepper' });
  const out = el('span', { class: 'stepper-val', text: String(value) });
  let v = value;
  wrap.append(el('button', { class: 'btn tiny', text: '−', onclick: () => { v = Math.max(min, v - 1); out.textContent = v; onChange(v); } }));
  wrap.append(out);
  wrap.append(el('button', { class: 'btn tiny', text: '+', onclick: () => { v = Math.min(max, v + 1); out.textContent = v; onChange(v); } }));
  row.append(wrap);
  return row;
}

function select(label, value, options, onChange) {
  const row = el('div', { class: 'field' });
  row.append(el('label', { text: label }));
  const sel = el('select', { class: 'input' }, options.map(([v, t]) => el('option', { value: v, text: t, selected: v === value })));
  sel.addEventListener('change', () => onChange(Number(sel.value)));
  row.append(sel);
  return row;
}

function toggle(label, key, hint) {
  const row = el('label', { class: 'toggle' });
  const input = el('input', { type: 'checkbox' });
  input.checked = !!ui.settings[key];
  input.addEventListener('change', () => { ui.settings[key] = input.checked; });
  row.append(input, el('div', {}, [el('b', { text: label }), el('small', { text: hint })]));
  return row;
}

/* ------------------------------------------------------------- game starts */

function startOffline() {
  const name = (ui.lobby.name || '玩家').slice(0, 12);
  const players = [];
  if (ui.lobby.tab === 'hotseat') {
    const n = ui.lobby.humanCount || 3;
    for (let i = 0; i < n; i++) players.push({ id: `h${i + 1}`, name: i === 0 ? name : `玩家 ${i + 1}` });
  } else {
    players.push({ id: 'h1', name });
    for (let i = 0; i < ui.lobby.botCount; i++) players.push({ id: `bot${i + 1}`, name: botName(i), isBot: true });
  }
  ui.mode = 'offline';
  ui.game = createGame({ players, settings: ui.settings });
  ui.seenLog = 0;
  ui.chat = [];
  afterChange();
}

function createRoom() {
  ui.mode = 'host';
  net.create((ui.lobby.name || '房主').slice(0, 12), ui.lobby.publicRoom !== false);
}

function joinRoom() {
  const code = ($('#join-code') && $('#join-code').value || ui.lobby.code || '').toUpperCase().trim();
  if (code.length !== 4) return toast('请输入 4 位房间号。');
  ui.mode = 'guest';
  net.join(code, (ui.lobby.name || '玩家').slice(0, 12));
}

function startOnline() {
  const members = net.room.members;
  const players = members.map((m, i) => ({ id: m.id, name: m.name }));
  for (let i = 0; i < ui.lobby.botCount; i++) players.push({ id: `bot${i + 1}`, name: botName(i), isBot: true });
  if (players.length < 2) return toast('至少需要 2 位玩家。');
  ui.game = createGame({ players, settings: ui.settings, roomCode: net.room.code });
  ui.seenLog = 0;
  net.send({ t: 'ready', started: true });
  publish();
  toast(`对局开始，房间号 ${net.room.code}`);
  afterChange();
}

function restart() {
  if (ui.mode === 'offline') {
    ui.game = null;
    ui.mode = 'menu';
    renderAll();
    return;
  }
  if (ui.mode === 'host') {
    ui.game = createGame({ players: ui.game.players.map((p) => ({ ...p, cash: ui.settings.startingCash, pos: 0, inJail: false, jailTurns: 0, cards: 0, bankrupt: false })), settings: ui.settings });
    ui.seenLog = 0;
    publish();
    afterChange();
  }
}

function showRules() {
  const dialog = $('#modal');
  dialog.hidden = false;
  dialog.replaceChildren();
  const box = el('div', { class: 'modal-box wide' });
  box.append(el('h3', { text: '规则说明' }));
  box.append(el('ul', { class: 'rules' }, [
    el('li', { text: '起始资金 $1,500，经过起点领取 $200。' }),
    el('li', { text: '掷出双数可以再掷一次，连续三次双数直接入狱。' }),
    el('li', { text: '无人购买的地产可以买下；放弃时按官方规则进入拍卖，价高者得。' }),
    el('li', { text: '集齐同色组且未建造房屋时，基本租金翻倍。' }),
    el('li', { text: '集齐同色组后可建造房屋，必须均衡建造；4 栋房屋后可升级旅馆。' }),
    el('li', { text: '铁路租金随持有数量提升（$25 / $50 / $100 / $200），公用事业按点数的 4 倍或 10 倍计费。' }),
    el('li', { text: '监狱中可支付保释金、使用出狱卡或掷双数；第三次掷骰失败必须缴纳保释金。' }),
    el('li', { text: '现金不足时可抵押地产（获得半价）或拆除房屋，赎回需支付 55%。' }),
    el('li', { text: '无法清偿债务时宣布破产，资产转移给债权人；最后留下的玩家获胜。' }),
    el('li', { text: '交易可自由组合地产、现金与出狱卡，色组内有房屋时不可拆分转让。' }),
  ]));
  box.append(el('div', { class: 'actions' }, [el('button', { class: 'btn primary', text: '知道了', onclick: closeModal })]));
  dialog.append(box);
}

/* ------------------------------------------------------------------- wire */

function wire() {
  $('#btn-help').addEventListener('click', showRules);
  $('#btn-mute').addEventListener('click', () => {
    ui.muted = !ui.muted;
    localStorage.setItem('mono.muted', ui.muted ? '1' : '0');
    $('#btn-mute').textContent = ui.muted ? '🔇' : '🔊';
  });
  $('#btn-mute').textContent = ui.muted ? '🔇' : '🔊';
  $('#btn-leave').addEventListener('click', () => {
    confirmBox('退出当前对局？', () => {
      if (ui.mode !== 'offline') net.leave();
      ui.game = null;
      ui.mode = 'menu';
      ui.selected = null;
      renderAll();
    });
  });
  $('#log-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    ui.chatTab = tab.dataset.tab;
    renderLog();
  });
  const form = $('#chat-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim().slice(0, 200);
    if (!text) return;
    input.value = '';
    const name = ui.mode === 'offline' ? '本地' : (net.name || '我');
    ui.chat.push({ name, text });
    if (ui.mode === 'guest') net.send({ t: 'broadcast', data: { k: 'chat', text } });
    else if (ui.mode === 'host') net.send({ t: 'state', state: ui.game, rev: ui.game.rev }) && net.send({ t: 'broadcast', data: { k: 'chat', text } });
    ui.chatTab = 'chat';
    renderLog();
  });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#detail').addEventListener('click', (e) => { if (e.target.id === 'detail') { ui.selected = null; renderBoard(); renderDetail(); } });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); ui.selected = null; renderBoard(); renderDetail(); }
    if (e.key === ' ' && ui.game && !ui.game.finished) {
      const a = me();
      if (a && legalActions(ui.game, a.id).canRoll) { e.preventDefault(); act({ t: 'roll' }); }
    }
  });
  // Keep incoming trade prompts visible without re-rendering mid-typing.
  setInterval(() => { if (ui.game && ui.game.trade) showIncomingTrade(); }, 700);
  // Refresh the public room directory while sitting in the lobby.
  setInterval(() => {
    if (ui.game) return;
    const wrap = document.querySelector('.pub-rooms');
    if (wrap) loadPublicRooms(wrap);
  }, 8000);
}

wire();

// ?demo=N jumps straight into a local match against N bots.
const demoBots = Number(new URLSearchParams(location.search).get('demo'));
if (Number.isFinite(demoBots) && demoBots > 0) {
  ui.lobby.tab = 'solo';
  ui.lobby.botCount = Math.min(7, Math.max(1, Math.round(demoBots)));
  ui.lobby.name = ui.lobby.name || '你';
  startOffline();
} else {
  renderAll();
}
