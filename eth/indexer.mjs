// The indexer: reads the chain's logs from the deployment block on and keeps the state up to date. Launches from the launchpad;
// deposits, modules, branches, payouts, burns, stock buys, draws and mist keys from the fees contract; the mist pool's notes, batches and
// withdrawals; collects from the lockers; every
// coin's Transfer events (the holders, and since when they hold); every v3 pool's Swap events and the PoolManager's Swap events
// for every v4 pool (the trades and the price). Idempotent per log (block, index); the checkpoint trails the head by the configured
// confirmations so a reorg of that depth is never indexed.
import { decodeEventLog, getAddress, keccak256, toHex } from 'viem';
import { recordOf, fetchMeta } from './meta.mjs';
import { CONFIG, chainInfo } from './config.mjs';
import { publicClient, low } from './chain.mjs';
import { ABI, ERC20_ABI, V3_POOL_ABI, POOL_MANAGER_ABI, DEAD } from './contracts.mjs';
import { loadState, saveState } from './store.mjs';
import * as P from '../shared/pool.mjs';
import { noteTrade, noteDeposit, notePayout, noteLaunch, noteWithdrawal, noteBurn } from './series.mjs';
import { noteCandle, saveCandles } from './candles.mjs';

const TRADES_KEEP = 600;
const sig = s => keccak256(toHex(s));
export const TOPICS = { transfer: sig('Transfer(address,address,uint256)'), swapV3: sig('Swap(address,address,int256,int256,uint160,uint128,int24)'), swapV4: sig('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)') };
const str = v => (typeof v === 'bigint' ? v.toString() : v);
const ZERO = '0x0000000000000000000000000000000000000000';

/** Decode a log against an ABI; null when it is not one of its events. */
function decode(abi, log) { try { return decodeEventLog({ abi, data: log.data, topics: log.topics }); } catch { return null; } }
const seen = (s, log) => { const k = `${log.blockNumber}:${log.logIndex}`; s.seen = s.seen || {}; if (s.seen[k]) return true; s.seen[k] = 1; return false; };
const trimSeen = s => { const keys = Object.keys(s.seen || {}); if (keys.length > 20_000) { for (const k of keys.slice(0, keys.length - 10_000)) delete s.seen[k]; } };

/** The coin row the state keeps for a launch. */
export function newCoin(ev, log) {
  const pool = Number(ev.pool); const startTick = Number(ev.startTick);
  const [tickLower, tickUpper] = pool === P.POOL_V3 ? [startTick, P.TICK_EDGE] : [-P.TICK_EDGE, startTick];
  const sqrtP = P.sqrtPriceAtTick(startTick); const fresh = { pool, tickLower, tickUpper, sqrtA: P.sqrtPriceAtTick(tickLower), sqrtB: P.sqrtPriceAtTick(tickUpper), sqrtP, liquidity: 0n };
  const liquidity = pool === P.POOL_V3 ? P.mulDiv(P.SUPPLY, P.mulDiv(fresh.sqrtA, fresh.sqrtB, P.Q96), fresh.sqrtB - fresh.sqrtA) : P.mulDiv(P.SUPPLY, P.Q96, fresh.sqrtB - fresh.sqrtA);
  return { token: low(ev.token), creator: low(ev.creator), name: ev.name, symbol: ev.symbol, uri: ev.uri, pool, module: Number(ev.module), stock: Number(ev.module) === P.MODULES.harvest ? low(ev.stock) : '', startCapUsd: Number(ev.startCapUsd), startTick, tickLower, tickUpper,
    v3Pool: pool === P.POOL_V3 ? low(`0x${String(ev.poolRef).slice(26)}`) : '', poolId: pool === P.POOL_V4 ? String(ev.poolRef).toLowerCase() : '', tokenId: '0', liquidity: liquidity.toString(), ethUsdAtLaunch: str(ev.ethUsd), block: Number(log.blockNumber), tx: log.transactionHash, createdAt: 0,
    price: { sqrtP: sqrtP.toString(), tick: startTick }, rules: null, branches: [], draw: null,
    stats: { trades: 0, buys: 0, sells: 0, volumeEth: '0', lastPrice: P.price({ ...fresh }).toString(), lastTradeAt: 0, holders: 0, founderEth: '0', founderCoins: '0', burned: '0', burnedByBuybacks: '0' },
    fees: { received: '0', pot: '0', paid: '0', platform: '0', stockHeld: '0', collected: '0' } };
}
const add = (a, b) => (BigInt(a || 0) + BigInt(b || 0)).toString();
const sub = (a, b) => { const r = BigInt(a || 0) - BigInt(b || 0); return (r < 0n ? 0n : r).toString(); };
const abs = v => (v < 0n ? -v : v);

function pushTrade(s, token, t) { const list = (s.trades[token] = s.trades[token] || []); list.push(t); if (list.length > TRADES_KEEP) list.splice(0, list.length - TRADES_KEEP); const c = s.coins[token]; if (c) { c.stats.trades++; if (t.buy) c.stats.buys++; else c.stats.sells++; c.stats.volumeEth = add(c.stats.volumeEth, t.eth); c.stats.lastPrice = t.price; c.stats.lastTradeAt = t.t || c.stats.lastTradeAt; c.price = { sqrtP: t.sqrtP, tick: t.tick }; noteTrade(s, c, t); noteCandle(token, { t: t.t, price: t.price, eth: t.eth }); } }
function moveBalance(s, token, from, to, value, t) {
  const b = (s.balances[token] = s.balances[token] || {}); const since = (s.since[token] = s.since[token] || {}); const v = BigInt(value);
  if (from !== ZERO) { const nb = BigInt(b[from] || 0) - v; if (nb <= 0n) { delete b[from]; delete since[from]; } else b[from] = nb.toString(); }
  if (to !== ZERO) { if (!b[to] || BigInt(b[to]) === 0n) since[to] = t || since[to] || 0; b[to] = (BigInt(b[to] || 0) + v).toString(); }
}
/** The addresses that are never holders: the coin, the dead and zero addresses, Halcyon's contracts, the coin's pool and Uniswap's. */
export function systemAddresses(s, token, opts = {}) {
  const c = s.coins[token]; const u = chainInfo().uniswap;
  return new Set([token, low(DEAD), ZERO, opts.launchpad || low(CONFIG.launchpad), opts.fees || low(CONFIG.fees), low(CONFIG.locker), low(CONFIG.v4Locker), low(CONFIG.swap), low(CONFIG.hook), c?.v3Pool || '', low(u.poolManager), low(u.nfpm), low(u.swapRouter02), low(u.universalRouter)].filter(Boolean));
}
/** The holders of a coin from its balances, system addresses out, largest first, each with since when it has held. Pure. */
export function holdersOf(s, token, opts = {}) {
  const skip = systemAddresses(s, token, opts); const since = s.since?.[token] || {};
  return Object.entries(s.balances[token] || {}).filter(([a, v]) => !skip.has(a) && BigInt(v) > 0n).map(([address, balance]) => ({ address, balance, since: since[address] || 0 })).sort((x, y) => (BigInt(y.balance) > BigInt(x.balance) ? 1 : -1));
}

/** Apply one log to the state. Exported for the tests, which feed synthetic logs. */
export function applyLog(s, log, { launchpad = low(CONFIG.launchpad), fees = low(CONFIG.fees), lockers = [low(CONFIG.locker), low(CONFIG.v4Locker)], mist = low(CONFIG.mist), poolManager = low(chainInfo().uniswap.poolManager), timestamp = 0, from = '' } = {}) {
  if (seen(s, log)) return;
  const at = low(log.address); const t = timestamp || 0;
  if (at === launchpad) {
    const e = decode(ABI.launchpad, log); if (!e) return; const a = e.args; const token = low(a.token);
    if (e.eventName === 'Launched') { if (!s.coins[token]) { s.coins[token] = newCoin(a, log); noteLaunch(s, t); noteCandle(token, { t, price: s.coins[token].stats.lastPrice, eth: 0n }); } s.coins[token].createdAt = t; if (!recordOf(a.uri)) fetchMeta(a.uri, { log: console.log }); return; }
    if (e.eventName === 'FounderBought' && s.coins[token]) { s.coins[token].stats.founderEth = str(a.eth); s.coins[token].stats.founderCoins = str(a.coins); }
    return;
  }
  if (at === fees) {
    const e = decode(ABI.fees, log); if (!e) return; const a = e.args; const token = a.token ? low(a.token) : ''; const c = s.coins[token];
    if (e.eventName === 'StockAllowed') { s.stocks[low(a.stock)] = Boolean(a.allowed); return; }
    if (e.eventName === 'PlatformWithdrawn') { noteWithdrawal(s, t, low(a.to), a.amount, log.transactionHash); return; }
    if (e.eventName === 'MistKeySet') { s.mistKeys = s.mistKeys || {}; const key = String(a.key || '0x').toLowerCase(); if (key.length > 2) s.mistKeys[low(a.holder)] = key; else delete s.mistKeys[low(a.holder)]; return; }
    if (!c) return;
    const row = (kind, extra = {}) => { s.payouts.push({ t, block: Number(log.blockNumber), tx: log.transactionHash, token, kind, ...extra }); notePayout(s, t, kind, extra.total || 0); };
    if (e.eventName === 'ModuleSet') { c.module = Number(a.module); c.stock = Number(a.module) === P.MODULES.harvest ? low(a.stock) : ''; c.draw = null; return; }
    if (e.eventName === 'CreatorSet') { c.creator = low(a.creator); return; }
    if (e.eventName === 'BranchesSet') { c.branches = a.to.map((to, i) => ({ to: low(to), bps: Number(a.bps[i]) })); return; }
    if (e.eventName === 'Deposited') { c.fees.received = add(c.fees.received, a.amount); c.fees.platform = add(c.fees.platform, a.platformShare); noteDeposit(s, t, a.amount, a.platformShare); const m = Number(a.module); if (m === P.MODULES.roots || m === P.MODULES.branch) { c.fees.paid = add(c.fees.paid, a.coinShare); row(m === P.MODULES.roots ? 'roots' : 'branch', { total: str(a.coinShare), count: m === P.MODULES.roots ? 1 : c.branches.length }); } else c.fees.pot = add(c.fees.pot, a.coinShare); return; }
    if (e.eventName === 'PaidHolders') { c.fees.pot = sub(c.fees.pot, a.total); c.fees.paid = add(c.fees.paid, a.total); row(c.module === P.MODULES.rings ? 'rings' : 'rain', { total: str(a.total), count: Number(a.count), open: c.module === P.MODULES.mist || undefined }); return; }
    if (e.eventName === 'Burned') { c.fees.pot = sub(c.fees.pot, a.eth); c.fees.paid = add(c.fees.paid, a.eth); row('prune', { total: str(a.eth), count: 1, coins: str(a.tokens) }); return; }
    if (e.eventName === 'StockBought') { c.fees.pot = sub(c.fees.pot, a.eth); c.fees.paid = add(c.fees.paid, a.eth); c.fees.stockHeld = add(c.fees.stockHeld, a.amount); row('harvest', { total: str(a.eth), count: 1, stock: low(a.stock), amount: str(a.amount) }); return; }
    if (e.eventName === 'StockPaid') { c.fees.stockHeld = sub(c.fees.stockHeld, a.total); row('stockPaid', { total: str(a.total), count: Number(a.count), stock: low(a.stock), unclaimed: str(a.unclaimed) }); return; }
    if (e.eventName === 'DrawOpened') { c.draw = { drawBlock: Number(a.drawBlock), pot: str(a.pot), committedAt: t, tx: log.transactionHash }; return; }
    if (e.eventName === 'PaidMist') { c.fees.pot = sub(c.fees.pot, a.total); c.fees.paid = add(c.fees.paid, a.total); row('mist', { total: str(a.total), count: Number(a.count), batch: Number(a.batch) }); return; }
    if (e.eventName === 'DrawPaid') { c.fees.pot = sub(c.fees.pot, a.amount); c.fees.paid = add(c.fees.paid, a.amount); c.draw = null; row('clover', { total: str(a.amount), count: 1, winner: low(a.winner), drawBlock: Number(a.drawBlock), seed: a.seed }); return; }
    return;
  }
  if (mist && at === mist) {
    const e = decode(ABI.mist, log); if (!e) return; const a = e.args; const m = (s.mist = s.mist || { notes: [], batches: [], spent: 0, withdrawn: '0', withdrawals: [] });
    if (e.eventName === 'Note') { m.notes.push({ t, block: Number(log.blockNumber), tx: log.transactionHash, batch: Number(a.batch), index: Number(a.index), token: low(a.token), commit: str(a.commit), denom: str(a.denom), ephemeral: String(a.ephemeral).toLowerCase(), viewTag: Number(a.viewTag) }); return; }
    if (e.eventName === 'Sown') { m.batches.push({ t, block: Number(log.blockNumber), tx: log.transactionHash, batch: Number(a.batch), token: low(a.token), count: Number(a.count), total: str(a.total), root: str(a.root) }); return; }
    if (e.eventName === 'Spent') { m.spent++; m.withdrawn = add(m.withdrawn, a.denom); m.withdrawals.push({ t, block: Number(log.blockNumber), tx: log.transactionHash, denom: str(a.denom), fee: str(a.fee), recipient: low(a.recipient), relayer: low(a.relayer) }); if (m.withdrawals.length > 500) m.withdrawals.splice(0, m.withdrawals.length - 500); return; }
    return;
  }
  if (lockers.includes(at)) {
    const e = decode(at === lockers[0] ? ABI.locker : ABI.v4Locker, log); if (!e) return; const a = e.args; const c = s.coins[low(a.token || '')]; if (!c) return;
    if (e.eventName === 'Collected') { c.fees.collected = add(c.fees.collected, a.eth); } if (e.eventName === 'Locked') { c.tokenId = str(a.tokenId); } if (e.eventName === 'Seeded') { c.liquidity = str(a.liquidity); }
    return;
  }
  // a coin's own logs: Transfer (holders)
  if (s.coins[at]) { if (log.topics[0] === TOPICS.transfer) { const e = decode(ERC20_ABI, log); if (e) { const from = low(e.args.from), to = low(e.args.to); moveBalance(s, at, from, to, e.args.value, t); /* the launchpad's rounding dust at launch is not a burn, nor is less than a thousandth of a coin */ if ((to === ZERO || to === low(DEAD)) && e.args.value >= 10n ** 15n && from !== launchpad) noteBurn(s, s.coins[at], { t, from, value: e.args.value, tx: log.transactionHash, buyback: from === fees }); } } return; }
  // a v3 pool's Swap: the coin is token0 (the launch sorts it below WETH), amounts are the pool's deltas
  const v3 = s.v3Pools?.[at]; if (v3 && log.topics[0] === TOPICS.swapV3) {
    const e = decode(V3_POOL_ABI, log); if (!e) return; const a = e.args; const buy = a.amount1 > 0n && a.amount0 < 0n; const eth = buy ? a.amount1 : -a.amount1; const coins = buy ? -a.amount0 : a.amount0; if (coins <= 0n || eth <= 0n) return;
    const sqrtP = a.sqrtPriceX96; pushTrade(s, v3, { t, block: Number(log.blockNumber), tx: log.transactionHash, trader: from || low(a.recipient), buy, eth: str(eth), coins: str(coins), fee: (buy ? eth * P.FEE_PIPS / P.PIPS : coins * P.FEE_PIPS / P.PIPS).toString(), price: P.price({ pool: 0, sqrtP }).toString(), sqrtP: str(sqrtP), tick: Number(a.tick) }); return;
  }
  // the PoolManager's Swap for one of our v4 pools: the coin is currency1, amounts are the swapper's deltas (negative = paid)
  if (at === poolManager && log.topics[0] === TOPICS.swapV4) {
    const id = String(log.topics[1]).toLowerCase(); const token = s.v4Pools?.[id]; if (!token) return; const e = decode(POOL_MANAGER_ABI, log); if (!e) return; const a = e.args;
    const buy = a.amount0 < 0n && a.amount1 > 0n; const eth = buy ? -a.amount0 : a.amount0; const coins = buy ? a.amount1 : -a.amount1; if (coins <= 0n || eth <= 0n) return;
    const fee = BigInt(a.fee); pushTrade(s, token, { t, block: Number(log.blockNumber), tx: log.transactionHash, trader: from || low(a.sender), buy, eth: str(eth), coins: str(coins), fee: (buy ? eth * fee / P.PIPS : coins * fee / P.PIPS).toString(), feePips: Number(fee), price: P.price({ pool: 1, sqrtP: a.sqrtPriceX96 }).toString(), sqrtP: str(a.sqrtPriceX96), tick: Number(a.tick) });
  }
}

/** Keep the lookup tables of pools in step with the coins (v3 pool address => token, v4 pool id => token). */
export function reindexPools(s) { s.v3Pools = {}; s.v4Pools = {}; for (const c of Object.values(s.coins)) { if (c.v3Pool) s.v3Pools[c.v3Pool] = c.token; if (c.poolId) s.v4Pools[c.poolId] = c.token; } }

const sortLogs = logs => logs.sort((a, b) => (a.blockNumber === b.blockNumber ? Number(a.logIndex) - Number(b.logIndex) : Number(a.blockNumber - b.blockNumber)));
/** Pull the logs of a block range and apply them: the launchpad, fees and lockers first (new coins appear), then the coins and the pools. */
export async function indexRange(s, from, to, opts = {}) {
  const pc = publicClient(); const stamps = {}; const senders = {};
  const stamp = async n => { const k = String(n); if (s.blocks[k]) return s.blocks[k]; if (stamps[k]) return stamps[k]; const b = await pc.getBlock({ blockNumber: BigInt(n) }); stamps[k] = Number(b.timestamp); s.blocks[k] = stamps[k]; return stamps[k]; };
  const sender = async hash => { if (senders[hash]) return senders[hash]; try { const tx = await pc.getTransaction({ hash }); senders[hash] = low(tx.from); } catch { senders[hash] = ''; } return senders[hash]; };
  const core = [CONFIG.launchpad, CONFIG.fees, CONFIG.locker, CONFIG.v4Locker, CONFIG.mist].filter(Boolean).map(a => getAddress(a)); const padAddr = low(CONFIG.launchpad);
  // within a block the launchpad's logs go first: a launch emits Registered, Locked or Seeded before Launched, and the coin must exist to take them
  const logs = (await pc.getLogs({ address: core, fromBlock: BigInt(from), toBlock: BigInt(to) })).sort((a, b) => (a.blockNumber !== b.blockNumber ? Number(a.blockNumber - b.blockNumber) : (low(a.address) === padAddr) !== (low(b.address) === padAddr) ? (low(a.address) === padAddr ? -1 : 1) : Number(a.logIndex) - Number(b.logIndex)));
  /* within a block the launchpad's logs go first (a launch emits Registered, Locked or Seeded before Launched); the rest keep their order, so the pool's Note logs (emitted inside payMist, before PaidMist) come in order */
  for (const log of logs) applyLog(s, log, { ...opts, timestamp: await stamp(log.blockNumber) });
  reindexPools(s);
  const coins = Object.values(s.coins); const addresses = coins.map(c => getAddress(c.token));
  if (addresses.length) {
    const tl = sortLogs(await pc.getLogs({ address: addresses, event: ERC20_ABI.find(x => x.name === 'Transfer'), fromBlock: BigInt(from), toBlock: BigInt(to) }));
    for (const log of tl) applyLog(s, log, { ...opts, timestamp: await stamp(log.blockNumber) });
  }
  const v3 = Object.keys(s.v3Pools).map(a => getAddress(a));
  if (v3.length) { const pl = sortLogs(await pc.getLogs({ address: v3, event: V3_POOL_ABI.find(x => x.name === 'Swap'), fromBlock: BigInt(from), toBlock: BigInt(to) })); for (const log of pl) applyLog(s, log, { ...opts, timestamp: await stamp(log.blockNumber), from: await sender(log.transactionHash) }); }
  const v4 = Object.keys(s.v4Pools); const pm = chainInfo().uniswap.poolManager;
  if (v4.length && pm) { const pl = sortLogs(await pc.getLogs({ address: getAddress(pm), event: POOL_MANAGER_ABI.find(x => x.name === 'Swap'), args: { id: v4 }, fromBlock: BigInt(from), toBlock: BigInt(to) })); for (const log of pl) applyLog(s, log, { ...opts, timestamp: await stamp(log.blockNumber), from: await sender(log.transactionHash) }); }
  for (const c of coins) c.stats.holders = holdersOf(s, c.token, opts).length;
  trimSeen(s);
  const keep = Object.keys(s.blocks); if (keep.length > 5000) for (const k of keep.slice(0, keep.length - 2000)) delete s.blocks[k];
}

let running = false;
/** One indexing pass: from the checkpoint (or the deploy block) to the head minus the confirmations, in ranges. */
export async function indexOnce({ range = 2000, log = () => {} } = {}) {
  if (running) return { skipped: true }; running = true;
  try {
    const s = loadState(); const pc = publicClient(); const head = Number(await pc.getBlockNumber({ cacheTime: 0 })); const to = head - CONFIG.confirmations; let from = Math.max(s.checkpoint + 1, CONFIG.deployBlock || 1);
    if (from > to) return { head, checkpoint: s.checkpoint, ranges: 0 };
    let ranges = 0;
    while (from <= to) { const end = Math.min(from + range - 1, to); await indexRange(s, from, end); s.checkpoint = end; from = end + 1; ranges++; if (ranges % 10 === 0) { saveState(); saveCandles(); log(`[index] ${s.checkpoint}/${to}`); } }
    saveState(); saveCandles(); return { head, checkpoint: s.checkpoint, ranges };
  } finally { running = false; }
}
export function startIndexer({ intervalMs = CONFIG.indexIntervalMs, log = console.log } = {}) {
  let stopped = false; const tick = async () => { if (stopped) return; try { const r = await indexOnce({ log }); if (r.ranges) log(`[index] at block ${r.checkpoint} (head ${r.head})`); } catch (e) { log(`[index] ${String(e?.message || e).split('\n')[0].slice(0, 200)}`); } if (!stopped) setTimeout(tick, intervalMs); };
  tick(); return () => { stopped = true; };
}
