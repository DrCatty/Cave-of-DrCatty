// Heuristic computer opponent. Produces one intent per tick so the host can
// animate the same way it does for human players.

import { BOARD, GROUP_MEMBERS, RAILS, rentFor } from './board.js';
import { currentPlayer, player, propsOf, ownsGroup, legalActions } from './engine.js';

const GOOD_GROUPS = { orange: 1.5, red: 1.45, yellow: 1.35, lightblue: 1.2, pink: 1.25, green: 1.15, blue: 1.2, brown: 1.0 };

function groupProgress(state, id, group) {
  const members = GROUP_MEMBERS[group] || [];
  const mine = members.filter((i) => state.owners[i] && state.owners[i].owner === id).length;
  return members.length ? mine / members.length : 0;
}

function spaceValue(state, p, idx) {
  const space = BOARD[idx];
  let value = space.price;
  if (space.type === 'rail') {
    const count = RAILS.filter((i) => state.owners[i] && state.owners[i].owner === p.id).length;
    value *= 1.1 + count * 0.18;
  }
  if (space.type === 'prop') {
    const progress = groupProgress(state, p.id, space.group);
    value *= 1 + progress * 0.6;
    value *= GOOD_GROUPS[space.group] || 1;
  }
  return value;
}

/** Amount of cash the bot wants to keep on hand. */
function reserveFor(state, p) {
  const threats = state.players.filter((x) => !x.bankrupt && x.id !== p.id);
  let worst = 0;
  for (const t of threats) {
    for (const i of propsOf(state, t.id)) {
      const space = BOARD[i];
      const rent = rentFor(space, t.id, state.owners, 7);
      if (rent > worst) worst = rent;
    }
  }
  return Math.min(Math.max(worst, 80), 600);
}

export function botIntent(state, id) {
  const p = player(state, id);
  if (!p || p.bankrupt || state.finished) return null;
  const acts = legalActions(state, id);
  const isTurn = acts.current === id;

  /* ---- unsettled charge: liquidate, then settle or fold ---- */
  if (state.charge && state.charge.from === id) {
    if (p.cash >= state.charge.amount) return { t: 'settle-charge' };
    const plan = liquidateStep(state, p, state.charge.amount);
    if (plan) return plan;
    return { t: 'bankrupt' };
  }

  /* ------------------------------- auction ------------------------------ */
  if (state.phase === 'auction' && acts.canBid) {
    const space = BOARD[state.auction.space];
    const budget = Math.max(0, p.cash - reserveFor(state, p) * 0.5);
    const ceiling = Math.min(Math.round(spaceValue(state, p, space.i) * 1.15), budget);
    const next = state.auction.high + Math.max(5, Math.round(space.price * 0.1));
    if (next <= ceiling && next <= p.cash) return { t: 'auction-bid', amount: next };
    return { t: 'auction-pass' };
  }

  /* -------------------------------- jail -------------------------------- */
  if (isTurn && state.phase === 'jail') {
    if (p.cards > 0 && p.cash < 600) return { t: 'jail', action: 'card' };
    if (p.cash > 350) return { t: 'jail', action: 'pay' };
    return { t: 'jail', action: 'roll' };
  }

  /* -------------------------------- buy --------------------------------- */
  if (isTurn && state.phase === 'buy') {
    const space = BOARD[p.pos];
    const reserve = reserveFor(state, p);
    const completes = space.type === 'prop' && groupProgress(state, p.id, space.group) === 1;
    const cheap = space.price <= 140;
    const spare = p.cash - space.price;
    if (completes || (cheap && spare >= 30) || spare >= reserve) return { t: 'buy' };
    if (space.price <= 200 && spare >= 0 && groupProgress(state, p.id, space.group) >= 0.5) return { t: 'buy' };
    return { t: 'decline' };
  }

  /* -------------------------------- roll -------------------------------- */
  if (isTurn && state.phase === 'roll') return { t: 'roll' };

  /* ------------------------------ end turn ------------------------------ */
  if (isTurn && (state.phase === 'end' || (state.phase === 'roll' && !state.canRollAgain))) {
    const build = buildStep(state, p);
    if (build) return build;
    return { t: 'end-turn' };
  }

  // Between turns the bot may still tidy its portfolio.
  if (p.cash < 120) {
    const plan = liquidateStep(state, p, 200);
    if (plan) return plan;
  }
  return null;
}

function buildStep(state, p) {
  if (p.cash < 350) return null;
  const candidates = [];
  for (const i of propsOf(state, p.id)) {
    const space = BOARD[i];
    if (space.type !== 'prop') continue;
    if (!ownsGroup(state, p.id, space.group)) continue;
    const entry = state.owners[i];
    if (entry.mortgaged || entry.houses >= 5) continue;
    const levels = GROUP_MEMBERS[space.group].map((m) => state.owners[m]?.houses || 0);
    if (entry.houses > Math.min(...levels)) continue;
    if (p.cash - space.house < 150) continue;
    candidates.push({ i, score: (GOOD_GROUPS[space.group] || 1) * 100 - space.house * 0.1 + entry.houses * 4 });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return { t: 'build', space: candidates[0].i };
}

function liquidateStep(state, p, needed) {
  // 1) Sell houses from the most developed block.
  let best = null;
  for (const i of propsOf(state, p.id)) {
    const entry = state.owners[i];
    if (entry.houses <= 0) continue;
    const space = BOARD[i];
    const levels = GROUP_MEMBERS[space.group].map((m) => state.owners[m]?.houses || 0);
    if (entry.houses < Math.max(...levels)) continue;
    const value = Math.floor(space.house / 2);
    if (!best || value > best.value) best = { i, value };
  }
  if (best && p.cash + best.value <= needed + 400) return { t: 'sell-house', space: best.i };

  // 2) Mortgage the least valuable holdings.
  if (p.cash < needed) {
    const options = propsOf(state, p.id)
      .filter((i) => !state.owners[i].mortgaged && state.owners[i].houses === 0)
      .sort((a, b) => BOARD[a].price - BOARD[b].price);
    if (options.length) return { t: 'mortgage', space: options[0] };
  }
  return null;
}

export function botName(i) {
  const names = ['赵管家', '钱老板', '孙教授', '李医生', '周船长', '吴先生', '郑小姐', '王掌柜'];
  return names[i % names.length];
}
