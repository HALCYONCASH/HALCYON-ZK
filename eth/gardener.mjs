// The gardener: the one key the platform runs, paying the gas nobody else should. Every tick it looks at every coin and does what is due:
//   collect    a coin's pool fees, once they are worth collecting, become ETH in HalcyonFees (80% to the coin's pot, 20% to the platform)
//   rain       a pot past the threshold is paid out pro rata to holders, in batches, in ETH; shares below the minimum wait in the pot
//   rings      the same, weighted by balance times time held (a month of holding weighs thirty times a day)
//   prune      a pot past the threshold buys the coin back through its own pool and burns it
//   harvest    a pot past the threshold buys the coin's stock through Uniswap v3 or v4 (the registry's route); stock held is paid out to holders of at least 10,000 coins
//   clover     a pot past the threshold opens a draw (a commit to a block three ahead); once that block is in, its hash picks one holder
//              weighted by balance, and the gardener pays the whole pot to them with the hash in the record
//   mist       a pot past the threshold is sown into the mist pool: each holder with a mist key gets their share as notes of the pool's
//              denominations (the remainder by lot), each note a commitment only that holder can find and spend, shuffled, nothing kept
//              that links a note to a holder; holders without a key are paid in the open
//   roots, branch  nothing: the fees contract pushes those at deposit
// Dry by default: with HALCYON_GARDENER_ENABLED unset every action is computed, logged and recorded as `dry`, and nothing is sent.
// Gas-aware: a payout whose gas would eat more than the cap of what it pays waits; a tick above the gas price cap waits. One transaction
// at a time (eth/sender.mjs): a tick first follows the transaction still out from before, and sends nothing while one is pending.
import { parseEther, formatEther, getAddress, formatGwei, keccak256, encodePacked } from 'viem';
import { CONFIG } from './config.mjs';
import { publicClient, gardenerAddress, reason, low } from './chain.mjs';
import { sendGardener, settle, SENDER } from './sender.mjs';
import { locker, v4Locker, fees, readCoin, readPoolState, simulateCollect, calldata, quotePath, readMistDenominations } from './contracts.mjs';
import { loadState, saveState, record, loadLedger } from './store.mjs';
import { holdersOf } from './indexer.mjs';
import { routeOf, quoteStock } from './stocks.mjs';
import * as P from '../shared/pool.mjs';
import * as M from '../shared/mist.mjs';

export const GARDENER = { intervalMs: () => CONFIG.gardenerIntervalMs, maxTxPerTick: 6, maxGasPct: Number(process.env.HALCYON_PAYOUT_MAX_GAS_PCT || 10), patienceSec: () => Number(process.env.HALCYON_GARDENER_PATIENCE_MIN || 15) * 60 };
/**
 * The gardener's patience. The thresholds (HALCYON_COLLECT_MIN_ETH, HALCYON_PAYOUT_MIN_ETH) say when a coin is tended at once; below them a
 * coin is still tended every HALCYON_GARDENER_PATIENCE_MIN minutes (fifteen) as long as what is due is worth ten times its gas (the gas
 * share HALCYON_PAYOUT_MAX_GAS_PCT), so a small coin sees its fees collected and its module paid at a steady rhythm rather than never.
 */
const GAS_UNITS = { collectV3: 400_000, collectV4: 260_000, payBase: 40_000, payHolder: 25_000, prune: 200_000, harvest: 300_000, clover: 100_000, mistBase: 100_000, mistNote: 60_000 };
/** When the gardener last did `kinds` for a coin, from the ledger (0 when never). */
export function lastActionAt(token, kinds) { const l = loadLedger(); const k = low(token); for (let i = l.length - 1; i >= 0; i--) { const e = l[i]; if (e.token === k && kinds.includes(e.kind) && !e.error && !e.dry) return Number(e.at || 0); } return 0; }
/** Is `amount` worth at least ten times (100 / maxGasPct) the gas of an action of `gasUnits`, at this gas price? */
export const worthIt = (amount, gasUnits, gasPriceWei) => gasPriceWei > 0n && amount >= gasPriceWei * BigInt(gasUnits) * 100n / BigInt(GARDENER.maxGasPct);
const minus = (x, bps) => x - x * BigInt(bps) / 10_000n;
/** A stock payout goes to holders of at least 0.001% of the supply (10,000 coins); smaller bags wait for the next one. */
export const STOCK_MIN_HOLDING = 10_000n * 10n ** 18n;
export const RINGS_MAX_DAYS = 30;
export const DRAW_DELAY = 3, DRAW_WINDOW = 250;

/** Pro-rata shares of `pot` across holders by `weight`, those below `minShare` left out (they stay in the pot). Pure. */
export function shares(holders, pot, minShare = 0n, weight = h => BigInt(h.balance)) {
  const ws = holders.map(h => ({ address: h.address, w: weight(h) })); const total = ws.reduce((a, h) => a + h.w, 0n); if (total === 0n || pot === 0n) return [];
  return ws.map(h => ({ address: h.address, amount: pot * h.w / total })).filter(x => x.amount >= minShare && x.amount > 0n);
}
/** Rings weight: balance times days held, a day at least, thirty at most. Pure. */
export const ringsWeight = (now = Math.floor(Date.now() / 1000)) => h => { const days = h.since ? Math.min(RINGS_MAX_DAYS, Math.max(1, Math.floor((now - h.since) / 86_400))) : 1; return BigInt(h.balance) * BigInt(days); };
/** Split a list into batches of n. Pure. */
export const batches = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
/**
 * The clover draw: holders in address order, each weighted by balance; the seed (the draw block's hash) taken modulo the total
 * picks a point on the line and the holder it falls in wins. Anyone can recompute it from the Transfer events and the block hash. Pure.
 */
export function drawWinner(holders, seed) {
  const list = [...holders].sort((a, b) => (a.address < b.address ? -1 : 1)); const total = list.reduce((a, h) => a + BigInt(h.balance), 0n); if (total === 0n) return null;
  let point = BigInt(seed) % total; for (const h of list) { const b = BigInt(h.balance); if (point < b) return h.address; point -= b; } return list[list.length - 1].address;
}

/** A Fisher-Yates shuffle from the platform's randomness: the order of the notes in a transaction must say nothing. Pure given `rnd`. */
export function shuffle(list, rnd = Math.random) { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
/**
 * Each share as notes of the pool's denominations: the largest first, as many as fit; what is left below the smallest becomes one more
 * smallest note with the probability of the remainder (the seed and the address decide), so nothing is lost in expectation and no
 * fraction is remembered anywhere. The extras never take the sum past `budget`: when the draws overshoot, the weakest claims go. Pure.
 */
export function roundNotes(shares, denoms, seed, budget) {
  const ds = [...denoms].map(BigInt).sort((a, b) => (a < b ? 1 : -1)); const smallest = ds[ds.length - 1]; if (!ds.length || smallest <= 0n) return [];
  const rows = []; let sum = 0n;
  for (const sh of shares) {
    let left = sh.amount; const notes = []; for (const d of ds) { while (left >= d) { notes.push(d); left -= d; } }
    const draw = BigInt(keccak256(encodePacked(['bytes32', 'address'], [seed, getAddress(sh.address)]))) % smallest;
    sum += sh.amount - left; rows.push({ address: sh.address, notes, extra: left > 0n && draw < left, claim: left > 0n ? Number(draw) / Number(left) : 1 });
  }
  let room = budget - sum;
  for (const r of rows.filter(r => r.extra).sort((a, b) => a.claim - b.claim)) { if (room >= smallest) { r.notes.push(smallest); room -= smallest; } }
  return rows.filter(r => r.notes.length).map(({ address, notes }) => ({ address, notes }));
}
/**
 * A Mist round over `holders` (with balances) and the registered keys: exact shares of the pot; the holders with a valid mist key get
 * theirs as notes (`roundNotes`), each note a fresh commitment for that holder; the rest in the open. Returns the notes (shuffled, at
 * most `maxNotes`, the largest kept when there are too many; the rest of the pot waits) and the open list. Nothing in the result ties a
 * note to a holder. Pure given `rnd`.
 */
export function mistRound(holders, mistKeys, pot, { denoms, seed, maxNotes = CONFIG.mistMaxNotes, minShare = 0n, rnd = Math.random } = {}) {
  const list = shares(holders, pot, 0n); const keyed = list.filter(x => M.isPublicKey(mistKeys[x.address])); const open = list.filter(x => !M.isPublicKey(mistKeys[x.address]) && x.amount >= minShare && x.amount > 0n);
  const keyedTotal = keyed.reduce((a, x) => a + x.amount, 0n);
  const rows = roundNotes(keyed, denoms, seed, keyedTotal); let planned = rows.flatMap(r => r.notes.map(d => ({ key: mistKeys[r.address], denom: d })));
  if (planned.length > maxNotes) planned = planned.sort((a, b) => (a.denom < b.denom ? 1 : -1)).slice(0, maxNotes);
  const notes = shuffle(planned.map(n => M.note(n.key, n.denom)), rnd);
  return { notes, holders: rows.length, total: notes.reduce((a, n) => a + n.denom, 0n), open, openTotal: open.reduce((a, x) => a + x.amount, 0n) };
}
let denomsCache = null;
/** The pool's denominations, read once per process (they never change). */
export async function mistDenoms() { if (!denomsCache) denomsCache = (await readMistDenominations()).map(BigInt); return denomsCache; }

/** The latest block's timestamp (the wall clock when the chain cannot be read). */
export async function chainNow() { try { return Number((await publicClient().getBlock({ blockTag: 'latest' })).timestamp); } catch { return Math.floor(Date.now() / 1000); } }
/** Everything that is due for one coin, as plain actions (no sends): what the tick executes and what the tests check. */
export async function planCoin(s, c, { gasPriceWei = 0n, now = null, head = 0, facts = null } = {}) {
  const actions = []; const token = getAddress(c.token); const who = gardenerAddress();
  if (now == null) now = await chainNow(); /* the chain's clock, not this machine's: a rules window is measured in block time */
  // the pool's fees
  let col = null; try { col = await simulateCollect(c, who); } catch (e) { actions.push({ kind: 'skip', token, label: `$${c.symbol}: collect would fail: ${reason(e)}` }); }
  const wall = Math.floor(Date.now() / 1000); const patient = kinds => wall - lastActionAt(c.token, kinds) >= GARDENER.patienceSec(); /* the ledger keeps this machine's time */
  const collectDue = col && (col.eth >= parseEther(CONFIG.collectMinEth) || (patient(['collect']) && worthIt(col.eth, Number(c.pool) === P.POOL_V4 ? GAS_UNITS.collectV4 : GAS_UNITS.collectV3, gasPriceWei)));
  if (collectDue) actions.push({ kind: 'collect', token, pool: Number(c.pool), label: `collect $${c.symbol}: about ${formatEther(col.eth)} ETH of fees`, eth: col.eth, minOut: minus(col.fromCoins, CONFIG.slippageBps) });
  const coin = await readCoin(token); const pot = coin.pot; const m = coin.module; const nHolders = holdersOf(s, c.token).length;
  /* a pot is paid at the threshold, or every so often when it is worth ten times the gas of paying it */
  const payKinds = ['payHolders', 'buyback', 'buyStock', 'openDraw', 'payDraw', 'payMist']; const gasFor = { [P.MODULES.rain]: GAS_UNITS.payBase + GAS_UNITS.payHolder * Math.min(nHolders, CONFIG.payoutBatch), [P.MODULES.rings]: GAS_UNITS.payBase + GAS_UNITS.payHolder * Math.min(nHolders, CONFIG.payoutBatch), [P.MODULES.prune]: GAS_UNITS.prune, [P.MODULES.harvest]: GAS_UNITS.harvest, [P.MODULES.clover]: GAS_UNITS.clover, [P.MODULES.mist]: GAS_UNITS.mistBase + GAS_UNITS.mistNote * Math.min(Math.max(1, Object.keys(s.mistKeys || {}).length), CONFIG.mistMaxNotes) };
  const potDue = pot >= parseEther(CONFIG.payoutMinEth) || (patient(payKinds) && worthIt(pot, gasFor[m] || GAS_UNITS.prune, gasPriceWei)); const minPot = potDue ? pot : parseEther(CONFIG.payoutMinEth); /* so `pot >= minPot` below reads as "due" */
  if (facts) Object.assign(facts, { fees: col ? col.eth : 0n, pot, module: m, stock: coin.stock, stockHeld: coin.stockHeld, drawBlock: coin.drawBlock, holders: nHolders, collectDue: Boolean(collectDue), potDue, collectWorth: col ? worthIt(col.eth, Number(c.pool) === P.POOL_V4 ? GAS_UNITS.collectV4 : GAS_UNITS.collectV3, gasPriceWei) : false, potWorth: worthIt(pot, gasFor[m] || GAS_UNITS.prune, gasPriceWei), lastCollectAt: lastActionAt(c.token, ['collect']), lastPayAt: lastActionAt(c.token, payKinds) });
  if ((m === P.MODULES.rain || m === P.MODULES.rings) && pot >= minPot) {
    const list = shares(holdersOf(s, c.token), pot, parseEther(CONFIG.payoutMinShareEth), m === P.MODULES.rings ? ringsWeight(now) : undefined); const total = list.reduce((a, x) => a + x.amount, 0n);
    if (list.length) actions.push({ kind: 'payHolders', token, label: `pay ${list.length} holders of $${c.symbol} ${formatEther(total)} ETH${m === P.MODULES.rings ? ' (rings weights)' : ''}`, list, total, batches: batches(list, CONFIG.payoutBatch) });
  }
  if (m === P.MODULES.mist && pot >= minPot) {
    const h = head || Number(await publicClient().getBlockNumber({ cacheTime: 0 })); const seed = (await publicClient().getBlock({ blockNumber: BigInt(h) })).hash;
    const r = mistRound(holdersOf(s, c.token), s.mistKeys || {}, pot, { denoms: await mistDenoms(), seed, minShare: parseEther(CONFIG.payoutMinShareEth) });
    if (r.notes.length) { const byDenom = {}; for (const n of r.notes) byDenom[formatEther(n.denom)] = (byDenom[formatEther(n.denom)] || 0) + 1; actions.push({ kind: 'payMist', token, label: `mist: sow ${r.notes.length} notes (${Object.entries(byDenom).map(([d, k]) => `${k} of ${d}`).join(', ')} ETH) for ${r.holders} holders of $${c.symbol}`, notes: r.notes, holders: r.holders, total: r.total, denoms: byDenom, batches: batches(r.notes, M.BATCH) }); }
    if (r.open.length) actions.push({ kind: 'payHolders', token, label: `pay ${r.open.length} holders of $${c.symbol} without a mist key ${formatEther(r.openTotal)} ETH, in the open`, list: r.open, total: r.openTotal, batches: batches(r.open, CONFIG.payoutBatch) });
  }
  if (m === P.MODULES.prune && pot >= minPot) {
    const st = await readPoolState(c); const opening = st.pool === P.POOL_V4 && st.rules && st.rules.window > 0 && now < st.rules.start + st.rules.window;
    /* a rules pool's opening window would charge the buyback its opening fee and cap it at the max per swap: the pot waits for the window to end */
    if (opening) actions.push({ kind: 'skip', token, label: `$${c.symbol}: ${formatEther(pot)} ETH waits for the opening window to end (${Math.max(0, st.rules.start + st.rules.window - now)} s)` });
    else { const q = P.quoteBuy(st, pot, st.pool === P.POOL_V4 && st.rules ? P.openingFee(st.rules, now - st.rules.start) : st.fee); if (q.coinsOut > 0n) actions.push({ kind: 'buyback', token, label: `buy back and burn $${c.symbol} with ${formatEther(pot)} ETH`, eth: pot, quote: q.coinsOut, minOut: minus(q.coinsOut, CONFIG.slippageBps) }); }
  }
  if (m === P.MODULES.harvest) {
    const route = routeOf(coin.stock);
    if (pot >= minPot && route) { const eth = pot > parseEther(CONFIG.stockMaxBuyEth) ? parseEther(CONFIG.stockMaxBuyEth) : pot; const quote = await quoteStock(route, eth); if (quote > 0n) actions.push({ kind: 'buyStock', token, label: `buy ${route.symbol || 'the stock'} for $${c.symbol} with ${formatEther(eth)} ETH through Uniswap ${route.kind}`, eth, quote, minOut: minus(quote, CONFIG.slippageBps), route: route.kind === 'v4' ? { kind: 'v4', fromWeth: route.fromWeth, hops: route.hops } : { kind: 'v3', path: route.bytes }, stock: low(coin.stock) }); else actions.push({ kind: 'skip', token, label: `$${c.symbol}: the quoter gives nothing for ${route.symbol} right now` }); }
    else if (pot >= minPot && !route) actions.push({ kind: 'skip', token, label: `$${c.symbol}: ${formatEther(pot)} ETH waits for a route to its stock (${coin.stock})`, stock: coin.stock });
    if (coin.stockHeld > 0n) { const holders = holdersOf(s, c.token).filter(h => BigInt(h.balance) >= STOCK_MIN_HOLDING); const list = shares(holders, coin.stockHeld, 0n); const total = list.reduce((a, x) => a + x.amount, 0n); if (list.length) actions.push({ kind: 'payStock', token, label: `pay ${list.length} holders of $${c.symbol} their stock`, list, total, batches: batches(list, CONFIG.payoutBatch), stock: low(coin.stock) }); }
  }
  if (m === P.MODULES.clover) {
    const drawBlock = coin.drawBlock; const h = head || Number(await publicClient().getBlockNumber({ cacheTime: 0 }));
    if (drawBlock && h > drawBlock && h <= drawBlock + DRAW_WINDOW) { const block = await publicClient().getBlock({ blockNumber: BigInt(drawBlock) }); const winner = drawWinner(holdersOf(s, c.token), block.hash); if (winner) actions.push({ kind: 'payDraw', token, label: `clover draw of $${c.symbol}: ${formatEther(pot)} ETH to ${winner} (block ${drawBlock}, hash ${block.hash.slice(0, 10)})`, winner, drawBlock, seed: block.hash, amount: pot }); }
    else if ((!drawBlock || h > drawBlock + DRAW_WINDOW) && pot >= minPot && holdersOf(s, c.token).length > 0) actions.push({ kind: 'openDraw', token, label: `open a clover draw for $${c.symbol} (${formatEther(pot)} ETH)`, pot });
  }
  void gasPriceWei;
  return actions;
}
/**
 * What the gardener sees for every coin right now, for the operator (/api/gardener?plan=1): the module, the pot, the fees a collect would
 * bring, what is due (the same actions a tick would send) and, when nothing is, why it waits. Reads only.
 */
export async function outlook({ now = null } = {}) {
  const s = loadState(); const pc = publicClient(); if (now == null) now = await chainNow(); const head = Number(await pc.getBlockNumber({ cacheTime: 0 }).catch(() => 0n)); const gasPriceWei = await pc.getGasPrice().catch(() => 0n); const minPot = parseEther(CONFIG.payoutMinEth); const minCollect = parseEther(CONFIG.collectMinEth); const rows = []; const wall = Math.floor(Date.now() / 1000); const patience = GARDENER.patienceSec();
  const inMin = last => Math.max(0, Math.ceil((last + patience - wall) / 60)); const agoMin = last => Math.round((wall - last) / 60);
  for (const c of Object.values(s.coins)) {
    const facts = {}; let actions = []; let error = '';
    try { actions = await planCoin(s, c, { now, head, facts, gasPriceWei }); } catch (e) { error = reason(e); }
    const name = P.MODULE_NAMES[facts.module ?? c.module] || 'roots'; const due = actions.filter(a => a.kind !== 'skip').map(a => a.label); const waiting = actions.filter(a => a.kind === 'skip').map(a => a.label);
    if (!error && !due.length) {
      if ((facts.fees ?? 0n) > 0n && !facts.collectDue) waiting.push(`${formatEther(facts.fees ?? 0n)} ETH of pool fees, under the ${CONFIG.collectMinEth} ETH threshold${facts.collectWorth ? `; worth its gas, so collected within ${inMin(facts.lastCollectAt)} min (last collect ${agoMin(facts.lastCollectAt)} min ago)` : '; not yet worth ten times the gas of a collect'}`);
      else if ((facts.fees ?? 0n) === 0n) waiting.push('no pool fees to collect yet');
      if (name === 'roots' || name === 'branch') waiting.push('the fees contract pushes this module\'s share at deposit; nothing for the gardener');
      else if ((facts.pot ?? 0n) === 0n && !(name === 'harvest' && facts.stockHeld > 0n)) waiting.push('the pot is empty');
      else if ((facts.pot ?? 0n) < minPot && !facts.potDue && !(name === 'harvest' && facts.stockHeld > 0n)) waiting.push(`pot ${formatEther(facts.pot ?? 0n)} ETH, under the ${CONFIG.payoutMinEth} ETH threshold${facts.potWorth ? `; worth its gas, so paid within ${inMin(facts.lastPayAt)} min (last payout ${facts.lastPayAt ? `${agoMin(facts.lastPayAt)} min ago` : 'never'})` : '; not yet worth ten times the gas of paying it'}`);
      else if (name === 'clover' && facts.drawBlock && head <= facts.drawBlock) waiting.push(`the draw waits for block ${facts.drawBlock} (head ${head})`);
      else if ((name === 'rain' || name === 'rings' || name === 'mist') && !facts.holders) waiting.push('no holder to pay');
      else if (name === 'harvest' && facts.stockHeld > 0n) waiting.push('the stock held waits for holders of at least 10,000 coins');
      if (!waiting.length) waiting.push(`nothing due now (a pot of ${formatEther(facts.pot ?? 0n)} ETH; every share may be under ${CONFIG.payoutMinShareEth} ETH)`);
    }
    rows.push({ token: c.token, symbol: c.symbol, name: c.name, module: name, pool: Number(c.pool), holders: facts.holders ?? 0, fees: (facts.fees ?? 0n).toString(), pot: (facts.pot ?? 0n).toString(), stockHeld: (facts.stockHeld ?? 0n).toString(), due, waiting, error: error || undefined });
  }
  return { at: now, head, gasGwei: Number(formatGwei(gasPriceWei)), thresholds: { collectMinEth: CONFIG.collectMinEth, payoutMinEth: CONFIG.payoutMinEth, payoutMinShareEth: CONFIG.payoutMinShareEth, gasCapGwei: CONFIG.gasCapGwei, patienceMin: patience / 60, maxGasPct: GARDENER.maxGasPct }, coins: rows };
}

/**
 * Send one action (or record it dry). Returns the ledger entry: with `hash`, `gasUsed` and `block` once the transaction is in a block, with
 * `hash` and `pending` when it is still out after the wait (the sender follows it and settles the entry later), with `error` when it was
 * refused or reverted. An action of several batches waits longer for each; a batch still pending leaves the rest for a later tick.
 */
export async function execute(action, { dry = !CONFIG.gardenerEnabled, gasPriceWei = 0n, log = () => {} } = {}) {
  const f = fees(); const entryBase = { kind: action.kind, token: low(action.token), label: action.label, gardener: gardenerAddress() };
  const send = async (to, data, label, waitMs) => { if (dry) return { hash: '', dry: true }; const r = await sendGardener({ to, data }, { label, log, waitMs }); return r.pending ? { hash: r.hash, pending: true } : { hash: r.hash, gasUsed: r.receipt.gasUsed.toString(), block: Number(r.receipt.blockNumber) }; };
  const batchWait = SENDER.waitMs * 5;
  try {
    if (action.kind === 'collect') { const L = action.pool === P.POOL_V4 ? v4Locker() : locker(); return record({ ...entryBase, eth: action.eth.toString(), ...(await send(L.address, action.pool === P.POOL_V4 ? calldata.collectV4(action.token, action.minOut) : calldata.collect(action.token, action.minOut), action.label)) }); }
    if (action.kind === 'buyback') return record({ ...entryBase, eth: action.eth.toString(), quote: action.quote.toString(), ...(await send(f.address, calldata.buyback(action.token, action.eth, action.minOut), action.label)) });
    if (action.kind === 'buyStock') return record({ ...entryBase, eth: action.eth.toString(), quote: action.quote.toString(), stock: action.stock, via: action.route.kind, ...(await send(f.address, action.route.kind === 'v4' ? calldata.buyStockV4(action.token, action.eth, action.minOut, action.route.fromWeth, action.route.hops) : calldata.buyStock(action.token, action.eth, action.minOut, action.route.path), action.label)) });
    if (action.kind === 'openDraw') return record({ ...entryBase, pot: action.pot.toString(), ...(await send(f.address, calldata.openDraw(action.token), action.label)) });
    if (action.kind === 'payDraw') return record({ ...entryBase, winner: action.winner, drawBlock: action.drawBlock, seed: action.seed, amount: action.amount.toString(), ...(await send(f.address, calldata.payDraw(action.token, getAddress(action.winner)), action.label)) });
    if (action.kind === 'payMist') {
      const results = [];
      for (const b of action.batches) {
        const commits = b.map(x => x.commit); const denoms = b.map(x => x.denom); const eph = b.map(x => x.ephemeral); const tags = b.map(x => x.viewTag); const total = denoms.reduce((a, x) => a + x, 0n);
        if (gasPriceWei > 0n && !dry) { const gas = await publicClient().estimateGas({ account: gardenerAddress(), to: f.address, data: calldata.payMist(action.token, commits, denoms, eph, tags) }).catch(() => 0n); if (gas > 0n && gas * gasPriceWei * 100n > total * BigInt(GARDENER.maxGasPct)) { results.push({ count: b.length, total: total.toString(), skipped: 'gas' }); continue; } }
        const r = await send(f.address, calldata.payMist(action.token, commits, denoms, eph, tags), `${action.label} (${b.length})`, batchWait);
        results.push({ count: b.length, total: total.toString(), ...r }); if (r.pending) break;
      }
      return record({ ...entryBase, total: action.total.toString(), count: action.notes.length, holders: action.holders, denoms: action.denoms, results, left: action.batches.length - results.length || undefined, dry: dry || undefined });
    }
    if (action.kind === 'payHolders' || action.kind === 'payStock') {
      const results = [];
      for (const b of action.batches) {
        const to = b.map(x => getAddress(x.address)); const amounts = b.map(x => x.amount); const total = amounts.reduce((a, x) => a + x, 0n);
        if (action.kind === 'payHolders' && gasPriceWei > 0n && !dry) { const gas = await publicClient().estimateGas({ account: gardenerAddress(), to: f.address, data: calldata.payHolders(action.token, to, amounts) }).catch(() => 0n); if (gas > 0n && gas * gasPriceWei * 100n > total * BigInt(GARDENER.maxGasPct)) { results.push({ count: to.length, total: total.toString(), skipped: 'gas' }); continue; } }
        const r = await send(f.address, action.kind === 'payHolders' ? calldata.payHolders(action.token, to, amounts) : calldata.payStock(action.token, to, amounts), `${action.label} (${to.length})`, batchWait);
        results.push({ count: to.length, total: total.toString(), ...r }); if (r.pending) break;
      }
      return record({ ...entryBase, total: action.total.toString(), count: action.list.length, results, left: action.batches.length - results.length || undefined, dry: dry || undefined });
    }
    return record({ ...entryBase, skipped: true });
  } catch (e) { return record({ ...entryBase, error: reason(e) }); }
}

let ticking = false;
/** One gardener pass over every coin. Returns what it did. */
export async function tick({ dry = !CONFIG.gardenerEnabled, log = console.log } = {}) {
  if (ticking) return { skipped: 'busy' }; ticking = true;
  try {
    if (!dry) { const p = await settle({ log }); if (p) { log(`[gardener] waiting for ${p.label}: ${p.hashes.at(-1)} (nonce ${p.nonce}, sent ${Math.round((Date.now() - p.firstAt) / 1000)} s ago${p.bumps ? `, bumped ${p.bumps} time${p.bumps > 1 ? 's' : ''}` : ''}); nothing else goes out until it is in a block`); return { waited: 'pending', pending: p, done: [] }; } }
    const s = loadState(); const pc = publicClient(); const gasPriceWei = await pc.getGasPrice().catch(() => 0n); const head = Number(await pc.getBlockNumber({ cacheTime: 0 }).catch(() => 0n)); const now = await chainNow();
    if (gasPriceWei > parseEther('0.000000001') * BigInt(CONFIG.gasCapGwei)) { log(`[gardener] gas ${formatGwei(gasPriceWei)} gwei is over the cap of ${CONFIG.gasCapGwei}: waiting`); return { waited: 'gas', gasPriceWei, done: [] }; }
    const done = []; let sent = 0; let stuck = false;
    for (const c of Object.values(s.coins)) {
      if (sent >= GARDENER.maxTxPerTick || stuck) break;
      let actions; try { actions = await planCoin(s, c, { gasPriceWei, head, now }); } catch (e) { log(`[gardener] $${c.symbol}: ${reason(e)}`); continue; }
      for (const a of actions) {
        if (a.kind === 'skip') { log(`[gardener] ${a.label}`); continue; }
        const r = await execute(a, { dry, gasPriceWei, log }); done.push(r); const pending = Boolean(r.pending || r.results?.some(x => x.pending));
        log(`[gardener] ${dry ? 'dry: ' : ''}${a.label}${r.error ? ` failed: ${r.error}` : r.hash ? ` ${r.hash}${r.pending ? ' (pending)' : ''}` : ''}${r.left ? ` (${r.left} batch${r.left > 1 ? 'es' : ''} left for a later tick)` : ''}`);
        if (!dry && !r.error) sent++; if (pending) { stuck = true; break; } if (sent >= GARDENER.maxTxPerTick) break;
      }
    }
    saveState(); return { done, gasPriceWei, pending: stuck || undefined };
  } finally { ticking = false; }
}
export function startGardener({ log = console.log } = {}) {
  let stopped = false; const run = async () => { if (stopped) return; try { await tick({ log }); } catch (e) { log(`[gardener] ${String(e?.message || e).split('\n')[0].slice(0, 200)}`); } if (!stopped) setTimeout(run, GARDENER.intervalMs()); };
  setTimeout(run, 5000); return () => { stopped = true; };
}
