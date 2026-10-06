// The demo: a state full of sample coins so the site can be seen, tested and screenshotted with no chain behind it (HALCYON_DEMO=1
// or --demo). Every address here is made up; every number is computed with the real pool math, so the pages show what mainnet would.
import { keccak256, toHex, parseEther } from 'viem';
import { resetState, EMPTY, putMeta } from './store.mjs';
import { rebuild } from './series.mjs';
import { rebuildCandles } from './candles.mjs';
import { newCoin } from './indexer.mjs';
import { SEED } from './stocks.mjs';
import * as P from '../shared/pool.mjs';
import * as M from '../shared/mist.mjs';

const addr = seed => `0x${keccak256(toHex(`halcyon-demo-${seed}`)).slice(26)}`;
let r = 7; const rnd = () => { r = (r * 48271) % 2147483647; return r / 2147483647; };
const now = Math.floor(Date.now() / 1000);
const ANSWER = 3000n * 10n ** 8n; const ETH_USD = 3000;
/** The demo's stock list is the whole catalog: the five routed ones allowed and ready, three allowed without a route, the rest waiting. */
export const DEMO_STOCKS = (SEED['1'] || []).map(s => ({ ...s, address: s.address.toLowerCase(), routed: Boolean(s.path || s.v4), via: s.v4 ? 'v4' : s.path ? 'v3' : '', allowed: Boolean(s.path || s.v4) || ['AAPLon', 'MSFTon', 'GLDon'].includes(s.symbol) }));
const NVDA = DEMO_STOCKS.find(s => s.symbol === 'NVDAon');
/**
 * The demo's mist key: derived from hardhat's first published test account signing the mist sentence (a key everyone has, never funds on
 * a real chain), so a browser holding that account finds the demo's notes; there is no pool behind them. They look exactly like real ones.
 */
export const DEMO_MIST_SIGNATURE = '0x42da51d4c6cf9efc84e4d0eeaf6b12faa6b8071453ff607b973f477c31e792d708b92c53479c781fb7e43de48e1c50bd505ef5ff1a3cf990fcdc66d9c88710621c';
export const DEMO_MIST_HOLDER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
export const DEMO_DENOMS = [parseEther('0.01'), parseEther('0.1'), parseEther('1')];
const DEMO_KEY = M.publicKey(M.keysFromSignature(DEMO_MIST_SIGNATURE));

const COINS = [
  { symbol: 'KING', name: 'Kingfisher', pool: 1, module: 1, cap: 7000, trades: 150, age: 6, rules: { launchFee: 500000, sellFee: 30000, window: 900, maxSwapBps: 300 }, description: 'The bird the launchpad is named after. A rules pool: the first fifteen minutes charged snipers up to 50%, and every sell pays 3% to the holders.', image: '/demo/king.svg', links: { x: 'https://x.com/halcyoncash' } },
  { symbol: 'LAMP', name: 'Aurora Lamps', pool: 0, module: 1, cap: 5000, trades: 90, age: 5, description: 'A lamp for every window. It rains on holders in ETH, every day the gardener has enough to pay.', image: '/demo/lamp.svg', links: { x: 'https://x.com/halcyoncash', site: 'https://halcyon.cash' } },
  { symbol: 'TIDE', name: 'Slow Tide', pool: 1, module: 2, cap: 5000, trades: 120, age: 4, rules: { launchFee: 300000, sellFee: 20000, window: 600, maxSwapBps: 500 }, description: 'Every collect buys a little of it back and prunes it. Supply only goes down.', image: '/demo/tide.svg', links: { site: 'https://halcyon.cash' } },
  { symbol: 'BCG', name: 'Blue Chip Garden', pool: 0, module: 3, stock: NVDA, cap: 10000, trades: 110, age: 4, description: 'A meme coin whose fees buy tokenized NVIDIA for its holders. A harvest, in the stock, from the gardener.', image: '/demo/bcg.svg', links: { x: 'https://x.com/halcyoncash' } },
  { symbol: 'MARM', name: 'Marmalade', pool: 0, module: 0, cap: 4000, trades: 40, age: 3, description: 'Breakfast coin. The creator keeps the 80% and spends it on oranges.', image: '/demo/marm.svg', links: {} },
  { symbol: 'TRIO', name: 'Three Rivers', pool: 0, module: 4, cap: 5000, trades: 60, age: 3, branches: [[addr('river-1'), 5000], [addr('river-2'), 3000], [addr('river-3'), 2000]], description: 'Three founders, one coin, three branches: half, three tenths and a fifth of every fee, pushed the moment it lands.', image: '/demo/trio.svg', links: {} },
  { symbol: 'LUCK', name: 'Lucky Fish', pool: 1, module: 5, cap: 4000, trades: 80, age: 2, rules: { launchFee: 0, sellFee: 10000, window: 0, maxSwapBps: 0 }, description: 'Every time the pot fills, one lucky holder takes it all. The block hash picks; anyone can check the draw.', image: '/demo/luck.svg', links: { x: 'https://x.com/halcyoncash' } },
  { symbol: 'GEM', name: 'Quiet Gem', pool: 0, module: 6, cap: 7000, trades: 70, age: 2, description: 'Old growth gets paid: the longer you hold, the bigger your share of every round, up to thirty days.', image: '/demo/gem.svg', links: {} },
  { symbol: 'MIST', name: 'Lake Mist', pool: 1, module: 7, cap: 7000, trades: 130, age: 3, rules: { launchFee: 400000, sellFee: 20000, window: 1200, maxSwapBps: 400 }, description: 'Paid in the mist: every round sows private notes into the pool. Holders with a mist key find theirs and spend them with a proof; the chain cannot tell whose.', image: '/demo/mist.svg', links: { x: 'https://x.com/halcyoncash', site: 'https://halcyon.cash' } },
  { symbol: 'BOAT', name: 'Paper Boat', pool: 1, module: 1, cap: 4000, trades: 6, age: 0, rules: { launchFee: 600000, sellFee: 20000, window: 1800, maxSwapBps: 200 }, description: 'Just launched, the opening fee still falling. Fold one, float it.', image: '/demo/boat.svg', links: {} },
];

function simulate(s, spec, i) {
  const token = addr(`token-${spec.symbol}`); const creator = addr(`creator-${i}`); const createdAt = spec.age === 0 ? now - 120 : now - spec.age * 86_400 - 3600 * i;
  const startTick = P.startTick(spec.pool, spec.cap, ANSWER); const poolRef = spec.pool === P.POOL_V3 ? toHex(BigInt(addr(`pool-${spec.symbol}`)), { size: 32 }) : keccak256(toHex(`pool-${spec.symbol}`));
  const ev = { token, creator, name: spec.name, symbol: spec.symbol, uri: `meta:${spec.symbol.toLowerCase()}`, pool: spec.pool, module: spec.module, stock: spec.stock ? spec.stock.address : '0x0000000000000000000000000000000000000000', startCapUsd: spec.cap, startTick, poolRef, ethUsd: ANSWER };
  const c = newCoin(ev, { blockNumber: 23_400_000n + BigInt(i * 1000), transactionHash: addr(`launch-${i}`).padEnd(66, '0') }); c.createdAt = createdAt; c.tokenId = spec.pool === P.POOL_V3 ? String(1_000_000 + i) : '0'; s.coins[token] = c;
  if (spec.pool === P.POOL_V4) c.rules = { launchFee: spec.rules.launchFee, sellFee: spec.rules.sellFee, window: spec.rules.window, start: createdAt, maxSwap: (P.SUPPLY * BigInt(spec.rules.maxSwapBps) / 10_000n).toString() };
  if (spec.branches) c.branches = spec.branches.map(([to, bps]) => ({ to, bps }));
  putMeta(spec.symbol.toLowerCase(), { name: spec.name, symbol: spec.symbol, description: spec.description, image: spec.image, links: spec.links });
  let pool = P.freshPool(spec.pool, spec.cap, ANSWER); const bal = (s.balances[token] = {}); const since = (s.since[token] = {}); const trades = (s.trades[token] = []); let t = createdAt;
  const traders = Array.from({ length: 30 }, (_, k) => addr(`trader-${i}-${k}`)); const tally = { received: 0n, pot: 0n, paid: 0n, platform: 0n, collected: 0n, stockHeld: 0n }; let uncollected = 0n;
  const payout = (kind, extra) => s.payouts.push({ t, block: c.block + trades.length + 1, tx: addr(`pay-${i}-${s.payouts.length}`).padEnd(66, '0'), token, kind, ...extra });
  const deposit = fee => { const sp = P.splitFee(fee); tally.received += fee; tally.platform += sp.platform; tally.collected += fee; if (spec.module === P.MODULES.roots || spec.module === P.MODULES.branch) { tally.paid += sp.coin; payout(spec.module === P.MODULES.roots ? 'roots' : 'branch', { total: sp.coin.toString(), count: spec.module === P.MODULES.roots ? 1 : spec.branches.length }); } else tally.pot += sp.coin; };
  const feeFor = buy => (spec.pool === P.POOL_V4 ? (buy ? P.openingFee(c.rules, t - createdAt) : BigInt(spec.rules.sellFee)) : P.FEE_PIPS);
  // founder buy
  if (spec.age > 0 || i % 2) { const eth = parseEther((0.05 + rnd() * 0.2).toFixed(3)); const { state, quote } = P.applyBuy(pool, eth, P.FEE_PIPS); pool = state; bal[creator] = quote.coinsOut.toString(); since[creator] = t; c.stats.founderEth = eth.toString(); c.stats.founderCoins = quote.coinsOut.toString(); uncollected += quote.fee; trades.push({ t, block: c.block, tx: c.tx, trader: creator, buy: true, eth: eth.toString(), coins: quote.coinsOut.toString(), fee: quote.fee.toString(), price: quote.priceAfter.toString(), sqrtP: state.sqrtP.toString(), tick: P.tickAtSqrtPrice(state.sqrtP) }); }
  for (let k = 0; k < spec.trades; k++) {
    t += spec.age === 0 ? 15 : 600 + Math.floor(rnd() * (spec.age > 3 ? 5400 : 2400)); const who = traders[Math.floor(rnd() * traders.length)]; const buy = rnd() < 0.62 || !bal[who]; const fee = feeFor(buy);
    if (buy) { const eth = parseEther((spec.age === 0 ? 0.004 + rnd() * 0.02 : 0.02 + rnd() * 0.5).toFixed(4)); const { state, quote } = P.applyBuy(pool, eth, fee); if (c.rules && BigInt(c.rules.maxSwap) > 0n && quote.coinsOut > BigInt(c.rules.maxSwap) && t - createdAt < c.rules.window) continue; pool = state; if (!bal[who]) since[who] = t; bal[who] = (BigInt(bal[who] || 0) + quote.coinsOut).toString(); uncollected += quote.fee; trades.push({ t, block: c.block + k + 1, tx: addr(`tx-${i}-${k}`).padEnd(66, '0'), trader: who, buy: true, eth: quote.used.toString(), coins: quote.coinsOut.toString(), fee: quote.fee.toString(), feePips: Number(fee), price: quote.priceAfter.toString(), sqrtP: state.sqrtP.toString(), tick: P.tickAtSqrtPrice(state.sqrtP) }); }
    else { const have = BigInt(bal[who]); const amount = have * BigInt(15 + Math.floor(rnd() * 50)) / 100n; if (amount === 0n) continue; const { state, quote } = P.applySell(pool, amount, fee); pool = state; bal[who] = (have - amount).toString(); if (BigInt(bal[who]) === 0n) { delete bal[who]; delete since[who]; } uncollected += quote.fee * quote.priceAfter / 10n ** 18n; trades.push({ t, block: c.block + k + 1, tx: addr(`tx-${i}-${k}`).padEnd(66, '0'), trader: who, buy: false, eth: quote.ethOut.toString(), coins: amount.toString(), fee: quote.fee.toString(), feePips: Number(fee), price: quote.priceAfter.toString(), sqrtP: state.sqrtP.toString(), tick: P.tickAtSqrtPrice(state.sqrtP) }); }
    if (k % 25 === 24 && uncollected > parseEther('0.02')) { deposit(uncollected); uncollected = 0n; const pot = tally.pot; const price = P.price(pool);
      if (spec.module === P.MODULES.rain && pot >= parseEther('0.05')) { tally.pot = 0n; tally.paid += pot; payout('rain', { total: pot.toString(), count: Object.keys(bal).length }); }
      if (spec.module === P.MODULES.rings && pot >= parseEther('0.05')) { tally.pot = 0n; tally.paid += pot; payout('rings', { total: pot.toString(), count: Object.keys(bal).length }); }
      if (spec.module === P.MODULES.mist && pot >= parseEther('0.05')) { /* about two thirds of the holders have a mist key: their part goes out as notes, the rest in the open */
        let keyed = pot * 2n / 3n; const open = pot - keyed; tally.pot = 0n; tally.paid += pot; const batch = s.mist.batches.length; const notes = []; const leaves = [];
        for (const d of [...DEMO_DENOMS].reverse()) { while (keyed >= d && notes.length < M.BATCH) { const n = M.note(DEMO_KEY, d); notes.push(n); leaves.push(M.leafOf(n.commit, d)); keyed -= d; } }
        notes.forEach((n, j) => s.mist.notes.push({ t, block: c.block + k + 1, tx: addr(`mist-${i}-${k}`).padEnd(66, '0'), batch, index: j, token, commit: n.commit.toString(), denom: n.denom.toString(), ephemeral: n.ephemeral, viewTag: n.viewTag }));
        const sown = notes.reduce((a, n) => a + n.denom, 0n); s.mist.batches.push({ t, block: c.block + k + 1, tx: addr(`mist-${i}-${k}`).padEnd(66, '0'), batch, token, count: notes.length, total: sown.toString(), root: M.batchRoot(leaves).toString() });
        payout('mist', { total: sown.toString(), count: notes.length, batch }); payout('rain', { total: (open + keyed).toString(), count: Math.max(1, Math.floor(Object.keys(bal).length / 3)), open: true });
        if (batch % 2 === 1) { s.mist.spent += 2; s.mist.withdrawn = (BigInt(s.mist.withdrawn) + 2n * DEMO_DENOMS[0]).toString(); s.mist.withdrawals.push({ t: t + 1800, block: c.block + k + 2, tx: addr(`spent-${i}-${k}`).padEnd(66, '0'), denom: DEMO_DENOMS[0].toString(), fee: parseEther('0.0007').toString(), recipient: addr(`fresh-${i}-${k}`), relayer: addr('gardener') }); } }
      if (spec.module === P.MODULES.prune && pot >= parseEther('0.05')) { tally.pot = 0n; tally.paid += pot; const { state, quote } = P.applyBuy(pool, pot, feeFor(true)); pool = state; payout('prune', { total: pot.toString(), count: 1, coins: quote.coinsOut.toString() }); }
      if (spec.module === P.MODULES.harvest && pot >= parseEther('0.05')) { tally.pot = 0n; tally.paid += pot; const amount = pot * 3200n / 1000n / 190n; /* about $190 a share at $3000 an ETH */ payout('harvest', { total: pot.toString(), count: 1, stock: spec.stock.address, amount: amount.toString() }); payout('stockPaid', { total: amount.toString(), count: Object.keys(bal).length, stock: spec.stock.address, unclaimed: '0' }); }
      if (spec.module === P.MODULES.clover && pot >= parseEther('0.05')) { tally.pot = 0n; tally.paid += pot; const winner = Object.keys(bal)[Math.floor(rnd() * Object.keys(bal).length)]; const drawBlock = c.block + k; payout('clover', { total: pot.toString(), count: 1, winner, drawBlock, seed: keccak256(toHex(`seed-${i}-${k}`)) }); }
      void price; }
  }
  if (spec.module === P.MODULES.clover && uncollected > 0n) { deposit(uncollected); uncollected = 0n; c.draw = { drawBlock: 23_406_480, pot: tally.pot.toString(), committedAt: t + 60, tx: addr(`draw-${i}`).padEnd(66, '0') }; }
  c.price = { sqrtP: pool.sqrtP.toString(), tick: P.tickAtSqrtPrice(pool.sqrtP) }; c.stats.trades = trades.length; c.stats.buys = trades.filter(x => x.buy).length; c.stats.sells = trades.length - c.stats.buys; c.stats.volumeEth = trades.reduce((a, x) => a + BigInt(x.eth), 0n).toString(); c.stats.lastPrice = P.price(pool).toString(); c.stats.lastTradeAt = t; c.stats.holders = Object.keys(bal).length;
  c.fees = { received: tally.received.toString(), pot: tally.pot.toString(), paid: tally.paid.toString(), platform: tally.platform.toString(), stockHeld: '0', collected: tally.collected.toString() };
  // the story must end before now: shift this coin's clock back so its last event sits a few minutes ago, oldest coins furthest back
  const last = Math.max(t, ...s.payouts.filter(p => p.token === token).map(p => p.t)); const shift = last - (now - 240 - i * 1500); if (shift > 0 && spec.age > 0) { for (const x of trades) x.t -= shift; for (const p of s.payouts) if (p.token === token) p.t -= shift; for (const v of s.mist.notes) if (v.token === token) v.t -= shift; for (const v of s.mist.batches) if (v.token === token) v.t -= shift; for (const w of s.mist.withdrawals) if (w.block < c.block + 1000) w.t -= shift; c.createdAt -= shift; if (c.rules) c.rules.start -= shift; for (const k of Object.keys(since)) since[k] -= shift; c.stats.lastTradeAt -= shift; if (c.draw) c.draw.committedAt -= shift; }
}

/** Build the demo state and make it the state. */
export function loadDemo() {
  const s = EMPTY(); s.checkpoint = 23_406_500; for (const st of DEMO_STOCKS) if (st.allowed) s.stocks[st.address] = true;
  COINS.forEach((spec, i) => simulate(s, spec, i)); s.payouts.sort((a, b) => a.t - b.t);
  // the largest holders of MIST (about two thirds of what is held) carry a mist key, the demo's own; so does hardhat's first account, with a small bag
  const mist = Object.values(s.coins).find(c => c.symbol === 'MIST');
  if (mist) { const bal = s.balances[mist.token]; const held = Object.values(bal).reduce((a, v) => a + BigInt(v), 0n); let covered = 0n; for (const [h, v] of Object.entries(bal).sort((a, b) => (BigInt(b[1]) > BigInt(a[1]) ? 1 : -1))) { if (covered * 3n >= held * 2n) break; s.mistKeys[h] = DEMO_KEY; covered += BigInt(v); }
    bal[DEMO_MIST_HOLDER] = parseEther('250000').toString(); s.since[mist.token][DEMO_MIST_HOLDER] = mist.createdAt + 3600; s.mistKeys[DEMO_MIST_HOLDER] = DEMO_KEY; mist.stats.holders = Object.keys(bal).length; } for (const c of Object.values(s.coins)) { if (c.v3Pool) s.v3Pools[c.v3Pool] = c.token; if (c.poolId) s.v4Pools[c.poolId] = c.token; } rebuild(s); rebuildCandles(s, c => P.price({ pool: c.pool, sqrtP: P.sqrtPriceAtTick(c.startTick) }).toString()); resetState(s); return s;
}
export const DEMO_ETH_USD = ETH_USD;
