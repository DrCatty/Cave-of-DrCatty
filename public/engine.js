// Authoritative Monopoly rule engine. Pure data in, pure data out: the whole
// state is JSON-serialisable so it can be snapshotted to peers over the wire.

import { BOARD, GROUP_MEMBERS, RAILS, UTILITIES, rentFor, isBuildable } from './board.js';

export const COLORS = [
  '#e11d48', '#2563eb', '#16a34a', '#f59e0b',
  '#7c3aed', '#0891b2', '#db2777', '#65a30d',
];

export const TOKENS = ['🎩', '🚗', '🐕', '🚢', '👞', '🧵', '🪣', '🏍️'];

export const DEFAULT_SETTINGS = {
  startingCash: 1500,
  goSalary: 200,
  jailFine: 50,
  auctionOnDecline: true,
  freeParkingPot: false,
  doubleGoSalary: false,
  vacationCash: 0,
  speed: 900,
};

/* ----------------------------------------------------------------- random */

function rng(state) {
  state.rngState |= 0;
  state.rngState = (state.rngState + 0x6d2b79f5) | 0;
  let t = state.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function die(state) {
  return 1 + Math.floor(rng(state) * 6);
}

function shuffle(state, arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng(state) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ------------------------------------------------------------- game setup */

export function createGame(opts = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(opts.settings || {}) };
  const state = {
    rev: 0,
    rngState: opts.seed != null ? opts.seed | 0 : (Math.random() * 2 ** 31) | 0,
    createdAt: Date.now(),
    settings,
    roomCode: opts.roomCode || null,
    players: [],
    turn: 0,
    phase: 'roll',
    dice: [0, 0],
    doubles: 0,
    canRollAgain: false,
    owners: {},
    pot: 0,
    log: [],
    logId: 0,
    decks: { chance: [], chest: [] },
    deckPos: { chance: 0, chest: 0 },
    auction: null,
    trade: null,
    charge: null,
    lastEvent: null,
    finished: false,
    winner: null,
    stats: { rounds: 0, rolls: 0, trades: 0 },
  };

  (opts.players || []).slice(0, 8).forEach((p, idx) => {
    state.players.push(makePlayer(p, idx, settings.startingCash));
  });

  state.decks.chance = shuffle(state, CHANCE.map((_, i) => i));
  state.decks.chest = shuffle(state, CHEST.map((_, i) => i));
  pushLog(state, `对局开始，每位玩家持有 $${settings.startingCash}。`, 'system');
  return state;
}

export function makePlayer(src, idx, startingCash = DEFAULT_SETTINGS.startingCash) {
  return {
    id: src.id || `p${idx + 1}`,
    name: src.name || `玩家 ${idx + 1}`,
    color: src.color || COLORS[idx % COLORS.length],
    token: src.token || TOKENS[idx % TOKENS.length],
    isBot: !!src.isBot,
    pos: 0,
    cash: src.cash != null ? src.cash : startingCash,
    inJail: false,
    jailTurns: 0,
    cards: 0,
    bankrupt: false,
    netWorthPeak: 0,
  };
}

/* ------------------------------------------------------------- utilities */

export function player(state, id) {
  return state.players.find((p) => p.id === id) || null;
}

export function currentPlayer(state) {
  return state.players[state.turn] || null;
}

export function ownerOf(state, idx) {
  return state.owners[idx] || null;
}

export function propsOf(state, id) {
  return Object.keys(state.owners)
    .map(Number)
    .filter((i) => state.owners[i].owner === id)
    .sort((a, b) => a - b);
}

export function ownsGroup(state, id, group) {
  const members = GROUP_MEMBERS[group] || [];
  return members.length > 0 && members.every((i) => state.owners[i] && state.owners[i].owner === id);
}

export function housePrice(space) {
  return space.house || 0;
}

export function netWorth(state, id) {
  const p = player(state, id);
  if (!p) return 0;
  let total = p.cash;
  for (const i of propsOf(state, id)) {
    const space = BOARD[i];
    const entry = state.owners[i];
    if (!entry.mortgaged) total += space.price;
    total += (space.house || 0) * entry.houses * (entry.houses === 5 ? 1 : 1);
  }
  return total;
}

export function liquidCash(state, id) {
  return player(state, id).cash;
}

function pushLog(state, text, kind = 'info', actor = null) {
  state.logId += 1;
  state.log.push({ id: state.logId, at: Date.now(), text, kind, actor });
  if (state.log.length > 240) state.log.splice(0, state.log.length - 240);
  state.lastEvent = { id: state.logId, text, kind, actor };
}

export function logLine(state, text, kind, actor) {
  pushLog(state, text, kind, actor);
}

function cash(state, p, amount) {
  p.cash += amount;
  if (p.cash < 0) p.cash = 0;
}

/** Take money to the bank (or a creditor). Sets a pending charge when short. */
function charge(state, p, amount, creditorId = null, reason = '') {
  if (amount <= 0) return true;
  if (p.cash >= amount) {
    p.cash -= amount;
    if (creditorId) {
      const c = player(state, creditorId);
      if (c) c.cash += amount;
    } else {
      state.pot += state.settings.freeParkingPot ? amount : 0;
    }
    if (reason) pushLog(state, `${p.name} 支付 ${reason} $${amount}${creditorId ? ` 给 ${player(state, creditorId).name}` : ' 给银行'}。`, 'money', p.id);
    return true;
  }
  state.charge = { from: p.id, to: creditorId, amount, reason };
  state.phase = 'resolve';
  pushLog(state, `${p.name} 需要支付 $${amount}${creditorId ? ` 给 ${player(state, creditorId).name}` : ''}，现金不足，请变卖或抵押资产。`, 'warn', p.id);
  return false;
}

function receive(state, p, amount, reason) {
  p.cash += amount;
  if (reason) pushLog(state, `${p.name} 获得 ${reason} $${amount}。`, 'money', p.id);
}

function advanceTurn(state) {
  state.charge = null;
  state.canRollAgain = false;
  state.doubles = 0;
  let guard = 0;
  do {
    state.turn = (state.turn + 1) % state.players.length;
    if (state.turn === 0) state.stats.rounds += 1;
    guard += 1;
  } while (state.players[state.turn].bankrupt && guard < 64);

  const p = currentPlayer(state);
  state.phase = p.inJail ? 'jail' : 'roll';
  if (p.bankrupt) return endGameCheck(state);
  pushLog(state, `轮到 ${p.name} 行动。`, 'turn', p.id);
  return null;
}

function endGameCheck(state) {
  const alive = state.players.filter((p) => !p.bankrupt);
  if (alive.length <= 1) {
    state.finished = true;
    state.phase = 'over';
    state.winner = alive[0] ? alive[0].id : null;
    pushLog(state, alive[0] ? `${alive[0].name} 赢得了本局！` : '对局结束。', 'system');
  }
}

/* -------------------------------------------------------------- movement */

function moveTo(state, p, target, { collectGo = true, reason = '', cardRent = null } = {}) {
  const from = p.pos;
  let steps = (target - from + 40) % 40;
  if (steps === 0) steps = 0;
  const passedGo = from + steps >= 40;
  p.pos = target;
  if (passedGo && collectGo) {
    let salary = state.settings.goSalary;
    if (state.settings.doubleGoSalary && target === 0) salary *= 2;
    receive(state, p, salary, reason ? `${reason}，经过起点` : '经过起点');
  }
  resolveLanding(state, p, { cardRent, reason });
}

function moveSteps(state, p, steps, opts = {}) {
  const target = (p.pos + steps + 40 * 4) % 40;
  const wrapped = p.pos + steps >= 40;
  p.pos = target;
  if (wrapped && steps > 0 && opts.collectGo !== false) {
    receive(state, p, state.settings.goSalary, '经过起点');
  }
  resolveLanding(state, p, opts);
}

function sendToJail(state, p, reason) {
  p.pos = 10;
  p.inJail = true;
  p.jailTurns = 0;
  state.canRollAgain = false;
  state.doubles = 0;
  pushLog(state, `${p.name} ${reason}，被送进监狱。`, 'warn', p.id);
  state.phase = 'end';
}

function resolveLanding(state, p, opts = {}) {
  const space = BOARD[p.pos];
  switch (space.type) {
    case 'go':
      receive(state, p, state.settings.goSalary, '停在起点');
      state.phase = 'end';
      break;
    case 'prop':
    case 'rail':
    case 'utility':
      landOnProperty(state, p, space, opts);
      break;
    case 'chance':
      drawCard(state, p, 'chance');
      break;
    case 'chest':
      drawCard(state, p, 'chest');
      break;
    case 'tax':
      if (!charge(state, p, space.amount, null, space.name)) return;
      state.phase = 'end';
      break;
    case 'goto-jail':
      sendToJail(state, p, '踩到「入狱」格');
      break;
    case 'parking':
      if (state.settings.freeParkingPot && state.pot > 0) {
        receive(state, p, state.pot, '免费停车奖金');
        state.pot = 0;
      } else {
        pushLog(state, `${p.name} 在免费停车场休息。`, 'info', p.id);
      }
      state.phase = 'end';
      break;
    case 'jail':
      pushLog(state, `${p.name} 只是来探监。`, 'info', p.id);
      state.phase = 'end';
      break;
    default:
      state.phase = 'end';
  }
  afterLanding(state, p);
}

function landOnProperty(state, p, space, opts) {
  const entry = state.owners[space.i];
  if (!entry) {
    if (p.cash >= space.price) {
      state.phase = 'buy';
      pushLog(state, `${p.name} 抵达 ${space.name}（$${space.price}），等待决定购买或拍卖。`, 'action', p.id);
    } else {
      pushLog(state, `${p.name} 现金不足，无法购买 ${space.name}。`, 'info', p.id);
      state.phase = 'end';
    }
    return;
  }
  if (entry.owner === p.id) {
    pushLog(state, `${p.name} 回到自己的 ${space.name}。`, 'info', p.id);
    state.phase = 'end';
    return;
  }
  const owner = player(state, entry.owner);
  if (entry.mortgaged) {
    pushLog(state, `${space.name} 已抵押，本回合不收租。`, 'info', p.id);
    state.phase = 'end';
    return;
  }
  const total = opts.cardRent != null ? opts.cardRent : rentFor(space, owner.id, state.owners, (state.dice[0] + state.dice[1]) || 7);
  pushLog(state, `${p.name} 停在 ${owner.name} 的 ${space.name}，需支付租金 $${total}。`, 'rent', p.id);
  if (charge(state, p, total, owner.id, `租金（${space.name}）`)) state.phase = 'end';
}

function afterLanding(state, p) {
  if (state.finished || state.charge) return;
  if (state.canRollAgain && !p.inJail && !p.bankrupt) {
    state.phase = 'roll';
    pushLog(state, `${p.name} 掷出双数，可以再掷一次。`, 'system', p.id);
  } else if (state.phase !== 'buy') {
    state.phase = 'end';
  }
}

/* ------------------------------------------------------------------ cards */

const CHANCE = [
  { text: '前往起点，领取 $200。', run: (g, p) => moveTo(g, p, 0, { collectGo: true, reason: '机会卡' }) },
  { text: '前往伊利诺伊大道，若经过起点可领取 $200。', run: (g, p) => moveTo(g, p, 24, { collectGo: true, reason: '机会卡' }) },
  { text: '前往圣查尔斯广场，若经过起点可领取 $200。', run: (g, p) => moveTo(g, p, 11, { collectGo: true, reason: '机会卡' }) },
  { text: '前往最近的公用事业。若无人拥有可购买；若已拥有，掷骰并支付点数的 10 倍。', run: (g, p) => {
      const target = nearest(g, p, UTILITIES);
      const steps = (target - p.pos + 40) % 40;
      p.pos = target;
      const owner = g.owners[target];
      if (!owner) {
        resolveLanding(g, p, { reason: '机会卡' });
      } else if (owner.owner === p.id) {
        pushLog(g, `${p.name} 抵达自己的 ${BOARD[target].name}。`, 'info', p.id);
        g.phase = 'end';
      } else {
        const d1 = die(g), d2 = die(g);
        const amount = (d1 + d2) * 10;
        pushLog(g, `机会卡：掷出 ${d1 + d2} 点，需支付 $${amount}。`, 'warn', p.id);
        if (charge(g, p, amount, owner.owner, '公用事业租金')) g.phase = 'end';
      }
      afterLanding(g, p);
    } },
  { text: '前往最近的铁路。若无人拥有可购买；若已拥有，支付双倍租金。', run: (g, p) => {
      const target = nearest(g, p, RAILS);
      p.pos = target;
      const entry = g.owners[target];
      if (!entry) {
        resolveLanding(g, p, { reason: '机会卡' });
      } else if (entry.owner === p.id) {
        pushLog(g, `${p.name} 抵达自己的 ${BOARD[target].name}。`, 'info', p.id);
        g.phase = 'end';
      } else if (entry.mortgaged) {
        pushLog(g, `${BOARD[target].name} 已抵押，不收租。`, 'info', p.id);
        g.phase = 'end';
      } else {
        const base = rentFor(BOARD[target], entry.owner, g.owners, 7);
        pushLog(g, `机会卡：支付双倍铁路租金 $${base * 2}。`, 'warn', p.id);
        if (charge(g, p, base * 2, entry.owner, '铁路租金（双倍）')) g.phase = 'end';
      }
      afterLanding(g, p);
    } },
  { text: '银行支付股息 $50。', run: (g, p) => { receive(g, p, 50, '股息'); g.phase = 'end'; } },
  { text: '获得一张「出狱免费卡」。', run: (g, p) => { p.cards += 1; pushLog(g, `${p.name} 获得一张出狱免费卡。`, 'system', p.id); g.phase = 'end'; } },
  { text: '后退三格。', run: (g, p) => { moveSteps(g, p, -3, { collectGo: false, reason: '机会卡' }); } },
  { text: '直接入狱，不经过起点。', run: (g, p) => sendToJail(g, p, '抽到机会卡「入狱」') },
  { text: '房屋大修：每栋房屋支付 $25，每座旅馆支付 $100。', run: (g, p) => {
      const { houses, hotels } = buildingCount(g, p.id);
      const amount = houses * 25 + hotels * 100;
      pushLog(g, `机会卡：${houses} 栋房屋、${hotels} 座旅馆，共 $${amount}。`, 'warn', p.id);
      if (amount === 0) { g.phase = 'end'; return; }
      if (charge(g, p, amount, null, '大修费用')) g.phase = 'end';
    } },
  { text: '超速罚款 $15。', run: (g, p) => { if (charge(g, p, 15, null, '超速罚款')) g.phase = 'end'; } },
  { text: '前往雷丁铁路，若经过起点可领取 $200。', run: (g, p) => moveTo(g, p, 5, { collectGo: true, reason: '机会卡' }) },
  { text: '前往木板路。', run: (g, p) => moveTo(g, p, 39, { collectGo: true, reason: '机会卡' }) },
  { text: '你当选董事长，需付给每位玩家 $50。', run: (g, p) => {
      const others = g.players.filter((x) => !x.bankrupt && x.id !== p.id);
      const total = others.length * 50;
      pushLog(g, `机会卡：需支付 $${total}。`, 'warn', p.id);
      if (p.cash < total) { g.phase = 'end'; charge(g, p, total, null, '董事长费用'); return; }
      for (const other of others) { p.cash -= 50; other.cash += 50; }
      pushLog(g, `${p.name} 向每位玩家支付了 $50。`, 'money', p.id);
      g.phase = 'end';
    } },
  { text: '建筑贷款到期，收取 $150。', run: (g, p) => { receive(g, p, 150, '建筑贷款'); g.phase = 'end'; } },
  { text: '赢得填字游戏比赛，收取 $100。', run: (g, p) => { receive(g, p, 100, '填字比赛奖金'); g.phase = 'end'; } },
];

const CHEST = [
  { text: '前往起点，领取 $200。', run: (g, p) => moveTo(g, p, 0, { collectGo: true, reason: '福利卡' }) },
  { text: '银行结算错误，收取 $200。', run: (g, p) => { receive(g, p, 200, '银行赔付'); g.phase = 'end'; } },
  { text: '医疗费 $50。', run: (g, p) => { if (charge(g, p, 50, null, '医疗费')) g.phase = 'end'; } },
  { text: '出售股票获得 $50。', run: (g, p) => { receive(g, p, 50, '股票收益'); g.phase = 'end'; } },
  { text: '获得一张「出狱免费卡」。', run: (g, p) => { p.cards += 1; pushLog(g, `${p.name} 获得一张出狱免费卡。`, 'system', p.id); g.phase = 'end'; } },
  { text: '直接入狱，不经过起点。', run: (g, p) => sendToJail(g, p, '抽到福利卡「入狱」') },
  { text: '假日基金到期，收取 $100。', run: (g, p) => { receive(g, p, 100, '假日基金'); g.phase = 'end'; } },
  { text: '所得税退税 $20。', run: (g, p) => { receive(g, p, 20, '退税'); g.phase = 'end'; } },
  { text: '今天是你的生日，每位玩家送你 $10。', run: (g, p) => {
      const others = g.players.filter((x) => !x.bankrupt && x.id !== p.id);
      for (const other of others) {
        const take = Math.min(10, other.cash);
        other.cash -= take;
        p.cash += take;
      }
      pushLog(g, `其他玩家各送给 ${p.name} $10。`, 'money', p.id);
      g.phase = 'end';
    } },
  { text: '人寿保险到期，收取 $100。', run: (g, p) => { receive(g, p, 100, '人寿保险'); g.phase = 'end'; } },
  { text: '住院费 $100。', run: (g, p) => { if (charge(g, p, 100, null, '住院费')) g.phase = 'end'; } },
  { text: '学费 $50。', run: (g, p) => { if (charge(g, p, 50, null, '学费')) g.phase = 'end'; } },
  { text: '收到咨询费 $25。', run: (g, p) => { receive(g, p, 25, '咨询费'); g.phase = 'end'; } },
  { text: '街道修缮费：每栋房屋 $40，每座旅馆 $115。', run: (g, p) => {
      const { houses, hotels } = buildingCount(g, p.id);
      const amount = houses * 40 + hotels * 115;
      pushLog(g, `福利卡：${houses} 栋房屋、${hotels} 座旅馆，共 $${amount}。`, 'warn', p.id);
      if (amount === 0) { g.phase = 'end'; return; }
      if (charge(g, p, amount, null, '修缮费')) g.phase = 'end';
    } },
  { text: '选美比赛获得二等奖，收取 $10。', run: (g, p) => { receive(g, p, 10, '比赛奖金'); g.phase = 'end'; } },
  { text: '继承遗产 $100。', run: (g, p) => { receive(g, p, 100, '遗产'); g.phase = 'end'; } },
];

function nearest(g, p, list) {
  let best = list[0];
  for (const idx of list) {
    const d = (idx - p.pos + 40) % 40;
    const bd = (best - p.pos + 40) % 40;
    if (d !== 0 && (d < bd || bd === 0)) best = idx;
  }
  return best;
}

export function buildingCount(state, id) {
  let houses = 0;
  let hotels = 0;
  for (const i of propsOf(state, id)) {
    const h = state.owners[i].houses;
    if (h === 5) hotels += 1;
    else houses += h;
  }
  return { houses, hotels };
}

function drawCard(state, p, kind) {
  const deck = kind === 'chance' ? CHANCE : CHEST;
  const order = state.decks[kind];
  if (state.deckPos[kind] >= order.length) {
    state.decks[kind] = shuffle(state, deck.map((_, i) => i));
    state.deckPos[kind] = 0;
  }
  const card = deck[order[state.deckPos[kind]]];
  state.deckPos[kind] += 1;
  pushLog(state, `${p.name} 抽到${kind === 'chance' ? '机会' : '福利'}卡：${card.text}`, 'card', p.id);
  card.run(state, p);
}

/* ------------------------------------------------------------- main intent */

export function applyIntent(state, playerId, intent) {
  const actor = player(state, playerId);
  if (!actor) return state;
  const before = state.rev;

  switch (intent.t) {
    case 'roll':
      doRoll(state, actor);
      break;
    case 'buy':
      doBuy(state, actor);
      break;
    case 'decline':
      doDecline(state, actor);
      break;
    case 'auction-bid':
      doBid(state, actor, intent.amount);
      break;
    case 'auction-pass':
      doPass(state, actor);
      break;
    case 'end-turn':
      doEndTurn(state, actor);
      break;
    case 'jail':
      doJail(state, actor, intent.action);
      break;
    case 'build':
      doBuild(state, actor, intent.space);
      break;
    case 'sell-house':
      doSellHouse(state, actor, intent.space);
      break;
    case 'mortgage':
      doMortgage(state, actor, intent.space);
      break;
    case 'unmortgage':
      doUnmortgage(state, actor, intent.space);
      break;
    case 'settle-charge':
      doSettle(state, actor);
      break;
    case 'bankrupt':
      doBankrupt(state, actor);
      break;
    case 'trade-offer':
      doTradeOffer(state, actor, intent);
      break;
    case 'trade-accept':
      doTradeReply(state, actor, true);
      break;
    case 'trade-decline':
      doTradeReply(state, actor, false);
      break;
    case 'trade-cancel':
      if (state.trade && state.trade.from === actor.id) {
        pushLog(state, `${actor.name} 撤销了交易提案。`, 'info', actor.id);
        state.trade = null;
      }
      break;
    case 'resign':
      doResign(state, actor);
      break;
    default:
      return state;
  }

  if (state.rev === before) state.rev += 1;
  return state;
}

function doRoll(state, p) {
  if (state.phase !== 'roll' || currentPlayer(state).id !== p.id || p.bankrupt) return;
  const d1 = die(state);
  const d2 = die(state);
  state.dice = [d1, d2];
  state.stats.rolls += 1;
  const isDouble = d1 === d2;
  pushLog(state, `${p.name} 掷出 ${d1} + ${d2} = ${d1 + d2}${isDouble ? '（双数）' : ''}。`, 'dice', p.id);

  if (isDouble) {
    state.doubles += 1;
    if (state.doubles >= 3) {
      pushLog(state, `${p.name} 连续三次双数，被送进监狱。`, 'warn', p.id);
      sendToJail(state, p, '连续三次掷出双数');
      return;
    }
    state.canRollAgain = true;
  } else {
    state.canRollAgain = false;
  }

  p.pos0 = p.pos;
  const from = p.pos;
  const target = (p.pos + d1 + d2) % 40;
  p.pos = target;
  if (from + d1 + d2 >= 40) {
    let salary = state.settings.goSalary;
    if (state.settings.doubleGoSalary && target === 0) salary *= 2;
    receive(state, p, salary, target === 0 ? '停在起点' : '经过起点');
  }
  resolveLanding(state, p, {});
}

function doBuy(state, p) {
  if (state.phase !== 'buy' || currentPlayer(state).id !== p.id) return;
  const space = BOARD[p.pos];
  if (state.owners[space.i] || p.cash < space.price) return;
  p.cash -= space.price;
  state.owners[space.i] = { owner: p.id, houses: 0, mortgaged: false };
  pushLog(state, `${p.name} 以 $${space.price} 买下 ${space.name}。`, 'buy', p.id);
  state.phase = 'end';
  afterLanding(state, p);
}

function doDecline(state, p) {
  if (state.phase !== 'buy' || currentPlayer(state).id !== p.id) return;
  const space = BOARD[p.pos];
  if (state.settings.auctionOnDecline) {
    startAuction(state, space);
  } else {
    pushLog(state, `${p.name} 放弃购买 ${space.name}。`, 'info', p.id);
    state.phase = 'end';
  }
}

/* ---------------------------------------------------------------- auction */

function startAuction(state, space) {
  const active = state.players.filter((p) => !p.bankrupt && p.cash > 0).map((p) => p.id);
  if (active.length === 0) {
    state.phase = 'end';
    return;
  }
  state.auction = {
    space: space.i,
    order: active,
    idx: 0,
    high: 0,
    highBidder: null,
    passed: [],
  };
  state.phase = 'auction';
  pushLog(state, `${space.name} 进入拍卖，起拍价 $1。`, 'auction');
}

function auctionSpace(state) {
  return BOARD[state.auction.space];
}

function auctionCurrent(state) {
  const a = state.auction;
  return player(state, a.order[a.idx]);
}

function advanceBidder(state) {
  const a = state.auction;
  const alive = a.order.filter((id) => !a.passed.includes(id));
  if (alive.length === 0) return finishAuction(state, null);
  if (a.highBidder && alive.length === 1 && alive[0] === a.highBidder) {
    return finishAuction(state, a.highBidder, a.high);
  }
  let guard = 0;
  do {
    a.idx = (a.idx + 1) % a.order.length;
    guard += 1;
  } while (a.passed.includes(a.order[a.idx]) && guard < 64);
}

function doBid(state, p, amount) {
  const a = state.auction;
  if (state.phase !== 'auction' || !a || auctionCurrent(state).id !== p.id) return;
  const value = Math.max(0, Math.floor(Number(amount) || 0));
  if (value <= a.high) {
    pushLog(state, `出价必须高于当前最高价 $${a.high}。`, 'warn', p.id);
    return;
  }
  if (value > p.cash) {
    pushLog(state, `${p.name} 现金不足，无法出价 $${value}。`, 'warn', p.id);
    return;
  }
  a.high = value;
  a.highBidder = p.id;
  pushLog(state, `${p.name} 出价 $${value}。`, 'auction', p.id);
  advanceBidder(state);
}

function doPass(state, p) {
  const a = state.auction;
  if (state.phase !== 'auction' || !a || auctionCurrent(state).id !== p.id) return;
  a.passed.push(p.id);
  pushLog(state, `${p.name} 退出竞拍。`, 'auction', p.id);
  advanceBidder(state);
}

function finishAuction(state, winnerId, price) {
  const space = auctionSpace(state);
  if (winnerId) {
    const winner = player(state, winnerId);
    winner.cash -= price;
    state.owners[space.i] = { owner: winnerId, houses: 0, mortgaged: false };
    pushLog(state, `${winner.name} 以 $${price} 拍得 ${space.name}。`, 'auction', winnerId);
  } else {
    pushLog(state, `无人出价，${space.name} 仍归银行所有。`, 'auction');
  }
  state.auction = null;
  state.phase = 'end';
  const cp = currentPlayer(state);
  if (cp && cp.id === winnerId) {
    /* the winning bidder is the current player: nothing further to resolve */
  }
}

/* -------------------------------------------------------------- turn flow */

function doEndTurn(state, p) {
  if (currentPlayer(state).id !== p.id) return;
  if (state.phase === 'roll' && state.canRollAgain) return;
  if (state.phase === 'buy' || state.phase === 'auction' || state.phase === 'resolve') return;
  state.charge = null;
  advanceTurn(state);
}

function doJail(state, p, action) {
  if (state.phase !== 'jail' || currentPlayer(state).id !== p.id || !p.inJail) return;
  if (action === 'pay') {
    const fine = state.settings.jailFine;
    if (p.cash < fine) {
      pushLog(state, `${p.name} 现金不足以支付保释金 $${fine}。`, 'warn', p.id);
      return;
    }
    p.cash -= fine;
    state.pot += state.settings.freeParkingPot ? fine : 0;
    p.inJail = false;
    p.jailTurns = 0;
    state.phase = 'roll';
    pushLog(state, `${p.name} 支付 $${fine} 保释金出狱，可以掷骰。`, 'money', p.id);
    return;
  }
  if (action === 'card') {
    if (p.cards <= 0) return;
    p.cards -= 1;
    p.inJail = false;
    p.jailTurns = 0;
    state.phase = 'roll';
    pushLog(state, `${p.name} 使用出狱免费卡出狱，可以掷骰。`, 'system', p.id);
    return;
  }
  if (action === 'roll') {
    const d1 = die(state), d2 = die(state);
    state.dice = [d1, d2];
    state.stats.rolls += 1;
    if (d1 === d2) {
      p.inJail = false;
      p.jailTurns = 0;
      state.canRollAgain = false;
      pushLog(state, `${p.name} 掷出双数 ${d1} + ${d2}，成功出狱并前进。`, 'dice', p.id);
      const from = p.pos;
      p.pos = (p.pos + d1 + d2) % 40;
      if (from + d1 + d2 >= 40) receive(state, p, state.settings.goSalary, '经过起点');
      resolveLanding(state, p, {});
      return;
    }
    p.jailTurns += 1;
    if (p.jailTurns >= 3) {
      pushLog(state, `${p.name} 三次掷骰失败，必须支付 $${state.settings.jailFine} 保释金。`, 'warn', p.id);
      if (p.cash >= state.settings.jailFine) {
        p.cash -= state.settings.jailFine;
        state.pot += state.settings.freeParkingPot ? state.settings.jailFine : 0;
        p.inJail = false;
        p.jailTurns = 0;
        const from = p.pos;
        p.pos = (p.pos + d1 + d2) % 40;
        if (from + d1 + d2 >= 40) receive(state, p, state.settings.goSalary, '经过起点');
        resolveLanding(state, p, {});
      } else {
        state.charge = { from: p.id, to: null, amount: state.settings.jailFine, reason: '保释金' };
        state.phase = 'resolve';
      }
      return;
    }
    pushLog(state, `${p.name} 掷出 ${d1} + ${d2}，未能出狱（第 ${p.jailTurns} 次）。`, 'dice', p.id);
    state.phase = 'end';
  }
}

/* ------------------------------------------------------------ build/sell */

function canBuild(state, p, idx) {
  const space = BOARD[idx];
  if (!isBuildable(space) || !ownsGroup(state, p.id, space.group)) return '你需要集齐整个色组才能建造。';
  const entry = state.owners[idx];
  if (!entry || entry.owner !== p.id) return '这块地产不属于你。';
  if (entry.mortgaged) return '抵押中的地产不能建造。';
  if (GROUP_MEMBERS[space.group].some((i) => state.owners[i] && state.owners[i].mortgaged)) return '色组内有地产处于抵押状态。';
  if (entry.houses >= 5) return '已经是旅馆了。';
  const levels = GROUP_MEMBERS[space.group].map((i) => state.owners[i]?.houses || 0);
  const min = Math.min(...levels);
  if (entry.houses > min) return '需要均衡建造，先给同色组中房屋较少的地产建造。';
  if (p.cash < space.house) return '现金不足。';
  return null;
}

function doBuild(state, p, idx) {
  idx = Number(idx);
  const err = canBuild(state, p, idx);
  if (err) {
    pushLog(state, err, 'warn', p.id);
    return;
  }
  const space = BOARD[idx];
  p.cash -= space.house;
  state.owners[idx].houses += 1;
  pushLog(state, `${p.name} 在 ${space.name} 建造了${state.owners[idx].houses === 5 ? '旅馆' : '一栋房屋'}，花费 $${space.house}。`, 'build', p.id);
}

function doSellHouse(state, p, idx) {
  idx = Number(idx);
  const entry = state.owners[idx];
  const space = BOARD[idx];
  if (!entry || entry.owner !== p.id || entry.houses <= 0) return;
  const levels = GROUP_MEMBERS[space.group].map((i) => state.owners[i]?.houses || 0);
  const max = Math.max(...levels);
  if (entry.houses < max) {
    pushLog(state, '需要均衡拆除，先拆同色组中房屋较多的地产。', 'warn', p.id);
    return;
  }
  entry.houses -= 1;
  p.cash += Math.floor(space.house / 2);
  pushLog(state, `${p.name} 拆除 ${space.name} 的房屋，收回 $${Math.floor(space.house / 2)}。`, 'money', p.id);
}

function doMortgage(state, p, idx) {
  idx = Number(idx);
  const entry = state.owners[idx];
  const space = BOARD[idx];
  if (!entry || entry.owner !== p.id || entry.mortgaged) return;
  // Unowned plots in the same colour group simply have no houses to block on.
  if (space.type === 'prop' && GROUP_MEMBERS[space.group].some((i) => (state.owners[i]?.houses || 0) > 0)) {
    pushLog(state, '色组内还有房屋，必须先全部拆完才能抵押。', 'warn', p.id);
    return;
  }
  entry.mortgaged = true;
  p.cash += Math.floor(space.price / 2);
  pushLog(state, `${p.name} 抵押 ${space.name}，获得 $${Math.floor(space.price / 2)}。`, 'money', p.id);
}

function doUnmortgage(state, p, idx) {
  idx = Number(idx);
  const entry = state.owners[idx];
  const space = BOARD[idx];
  if (!entry || entry.owner !== p.id || !entry.mortgaged) return;
  const cost = Math.ceil(space.price * 0.55);
  if (p.cash < cost) {
    pushLog(state, `赎回需要 $${cost}，现金不足。`, 'warn', p.id);
    return;
  }
  p.cash -= cost;
  entry.mortgaged = false;
  pushLog(state, `${p.name} 以 $${cost} 赎回 ${space.name}。`, 'money', p.id);
}

/* ------------------------------------------------------- charge & bankrupt */

function doSettle(state, p) {
  const c = state.charge;
  if (!c || c.from !== p.id) return;
  if (p.cash < c.amount) {
    pushLog(state, `仍需筹集 $${c.amount - p.cash}。`, 'warn', p.id);
    return;
  }
  p.cash -= c.amount;
  if (c.to) {
    const creditor = player(state, c.to);
    if (creditor) creditor.cash += c.amount;
  } else {
    state.pot += state.settings.freeParkingPot ? c.amount : 0;
  }
  pushLog(state, `${p.name} 支付 $${c.amount}${c.to ? ` 给 ${player(state, c.to).name}` : ''}。`, 'money', p.id);
  state.charge = null;
  state.phase = state.canRollAgain && !p.inJail ? 'roll' : 'end';
  afterLanding(state, p);
}

function doBankrupt(state, p) {
  const creditorId = state.charge && state.charge.to;
  const creditor = creditorId ? player(state, creditorId) : null;
  const owned = propsOf(state, p.id);
  for (const i of owned) {
    const entry = state.owners[i];
    if (creditor) {
      entry.owner = creditor.id;
    } else {
      delete state.owners[i];
    }
  }
  if (creditor) {
    creditor.cash += p.cash;
    creditor.cards += p.cards;
    if (owned.length) pushLog(state, `${p.name} 破产，全部地产转移给 ${creditor.name}。`, 'bankrupt', p.id);
    else pushLog(state, `${p.name} 破产，剩余现金交给 ${creditor.name}。`, 'bankrupt', p.id);
  } else {
    pushLog(state, `${p.name} 破产，资产收归银行。`, 'bankrupt', p.id);
  }
  p.cash = 0;
  p.cards = 0;
  p.bankrupt = true;
  p.inJail = false;
  state.charge = null;
  state.players.forEach((x) => {
    if (x.bankrupt) return;
  });
  endGameCheck(state);
  if (!state.finished) advanceTurn(state);
}

function doResign(state, p) {
  if (p.bankrupt || state.finished) return;
  state.charge = { from: p.id, to: null, amount: 0, reason: '退出游戏' };
  doBankrupt(state, p);
}

/* ------------------------------------------------------------------ trade */

function doTradeOffer(state, from, intent) {
  const to = player(state, intent.to);
  if (!to || to.bankrupt || to.id === from.id) return;
  if (state.trade) {
    pushLog(state, '当前已有进行中的交易提案。', 'warn', from.id);
    return;
  }
  const give = normaliseBundle(state, from.id, intent.give);
  const get = normaliseBundle(state, to.id, intent.get);
  if (!give || !get) return;
  if (!give.props.length && !get.props.length && give.cash === 0 && get.cash === 0 && give.cards === 0 && get.cards === 0) return;
  state.trade = { from: from.id, to: to.id, give, get, at: Date.now() };
  pushLog(state, `${from.name} 向 ${to.name} 发起交易。`, 'trade', from.id);
}

function normaliseBundle(state, ownerId, bundle = {}) {
  const props = [...new Set((bundle.props || []).map(Number))].filter((i) => {
    const e = state.owners[i];
    return e && e.owner === ownerId;
  });
  const cashAmount = Math.max(0, Math.floor(Number(bundle.cash) || 0));
  if (cashAmount > player(state, ownerId).cash) return null;
  const cards = Math.max(0, Math.floor(Number(bundle.cards) || 0));
  if (cards > player(state, ownerId).cards) return null;
  return { props, cash: cashAmount, cards };
}

function doTradeReply(state, p, accept) {
  const t = state.trade;
  if (!t || t.to !== p.id) return;
  const from = player(state, t.from);
  if (!accept) {
    pushLog(state, `${p.name} 拒绝了交易提案。`, 'trade', p.id);
    state.trade = null;
    return;
  }
  if (from.cash < t.give.cash || p.cash < t.get.cash || from.cards < t.give.cards || p.cards < t.get.cards) {
    pushLog(state, '交易失败：资金或卡片已变化。', 'warn', p.id);
    state.trade = null;
    return;
  }
  // Blocks with houses cannot change hands.
  const blocked = [...t.give.props, ...t.get.props].some((i) => {
    if (state.owners[i].houses <= 0) return false;
    const group = GROUP_MEMBERS[BOARD[i].group] || [];
    return group.some((m) => !state.owners[m] || state.owners[m].owner !== state.owners[i].owner);
  });
  if (blocked) {
    pushLog(state, '交易失败：有房屋的地产不能拆分色组转让。', 'warn', p.id);
    state.trade = null;
    return;
  }
  from.cash -= t.give.cash;
  p.cash -= t.get.cash;
  from.cash += t.get.cash;
  p.cash += t.give.cash;
  from.cards -= t.give.cards;
  p.cards -= t.get.cards;
  from.cards += t.get.cards;
  p.cards += t.give.cards;
  for (const i of t.give.props) state.owners[i].owner = p.id;
  for (const i of t.get.props) state.owners[i].owner = from.id;
  state.stats.trades += 1;
  pushLog(state, `${from.name} 与 ${p.name} 达成交易。`, 'trade', p.id);
  state.trade = null;
  state.rev += 1;
}

/* ------------------------------------------------------------- bot helpers */

export function legalActions(state, id) {
  const p = player(state, id);
  const out = { phase: state.phase, current: currentPlayer(state)?.id, canRoll: false, canBuy: false, canEnd: false, canJail: [] };
  if (!p || p.bankrupt) return out;
  const isTurn = currentPlayer(state).id === id;
  if (isTurn && state.phase === 'roll' && !state.charge) out.canRoll = true;
  if (isTurn && state.phase === 'buy') { out.canBuy = true; out.space = p.pos; }
  if (isTurn && state.phase === 'jail') {
    out.canJail.push('roll');
    if (p.cash >= state.settings.jailFine) out.canJail.push('pay');
    if (p.cards > 0) out.canJail.push('card');
  }
  if (isTurn && (state.phase === 'end' || (state.phase === 'roll' && !state.canRollAgain))) out.canEnd = true;
  if (state.charge && state.charge.from === id) out.canSettle = p.cash >= state.charge.amount;
  if (state.phase === 'auction' && state.auction && auctionCurrent(state)?.id === id) {
    out.canBid = true;
    out.minBid = state.auction.high + 1;
    out.maxBid = p.cash;
  }
  return out;
}

export { CHANCE, CHEST, charge, receive, moveTo, pushLog, resolveLanding, startAuction, canBuild };
