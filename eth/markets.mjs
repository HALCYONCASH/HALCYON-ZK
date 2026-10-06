// What the site reads: coin rows built from the indexed state (plus the metadata a launch's uri points at), the trades, the holders, the
// payouts, and a wallet's standing. Numbers leave as strings of wei; the site formats them. Pure over the state, so the demo feeds it too.
import { CONFIG, chainInfo } from './config.mjs';
import { loadState, loadMeta, loadLedger } from './store.mjs';
import { recordOf, imageUrl } from './meta.mjs';
import { gatewayUrl } from './pinata.mjs';
import { holdersOf } from './indexer.mjs';
import { loadRegistry } from './stocks.mjs';
import { volume24h } from './series.mjs';
import * as P from '../shared/pool.mjs';

export const MODULE_INFO = {
  roots: { id: 0, name: 'Roots', line: 'The 80% goes to the coin\'s roots, its creator, trade by trade.' },
  rain: { id: 1, name: 'Rain', line: 'The 80% rains on holders in ETH, pro rata. The gardener pays the gas.' },
  prune: { id: 2, name: 'Prune', line: 'The 80% buys the coin back and prunes it from the supply.' },
  harvest: { id: 3, name: 'Harvest', line: 'The 80% buys a tokenized stock and hands holders the harvest.' },
  branch: { id: 4, name: 'Branch', line: 'The 80% branches to up to eight addresses, in the creator\'s shares, trade by trade.' },
  clover: { id: 5, name: 'Clover', line: 'The whole pot to one lucky holder at a time, drawn by a block hash, weighted by balance.' },
  rings: { id: 6, name: 'Rings', line: 'Holders paid by balance and by how long they have held, like a tree\'s rings.' },
  mist: { id: 7, name: 'Mist', line: 'Holders paid as private notes in the mist pool, spent with a zero-knowledge proof to any address. The chain cannot tell whose.' },
};
export const POOL_INFO = { 0: { id: 0, name: 'Standard', line: 'Uniswap v3, the coin against WETH, 1% fee.' }, 1: { id: 1, name: 'Rules', line: 'Uniswap v4 with the Halcyon hook: an opening fee that falls to 1%, a max per swap, a sell fee, one liquidity provider.' } };
/** Metadata for a coin: the record its uri names (the site's own /m/<key>.json, or ipfs://<cid>, pinned here or fetched), with the picture as a URL the browser can load. */
export function metaOf(c) {
  const rec = recordOf(c.uri); const uri = String(c.uri || '');
  return { description: rec?.description || '', image: imageUrl(rec?.image || ''), links: rec?.links || {}, hosted: Boolean(rec), metaUrl: uri.startsWith('ipfs://') ? gatewayUrl(uri) : uri };
}
/** What is known about a stock address: the registry's row, else nothing but the address. */
export function stockInfo(address) {
  if (!address || /^0x0{40}$/i.test(address)) return null; const a = String(address).toLowerCase();
  const r = loadRegistry().find(x => String(x.address).toLowerCase() === a);
  return { address: a, symbol: r?.symbol || '', name: r?.name || '', decimals: Number(r?.decimals || 18), issuer: r?.issuer || '', logo: r?.logo || '' };
}
/** The pool state of a coin from the index (its last known price and the position), in the shape shared/pool.mjs computes on. */
export function poolOf(c) {
  const sqrtP = BigInt(c.price?.sqrtP || P.sqrtPriceAtTick(c.startTick)); const rules = c.rules || null;
  return { pool: c.pool, tickLower: c.tickLower, tickUpper: c.tickUpper, sqrtA: P.sqrtPriceAtTick(c.tickLower), sqrtB: P.sqrtPriceAtTick(c.tickUpper), sqrtP, liquidity: BigInt(c.liquidity || 0), fee: P.FEE_PIPS, sellFee: rules ? BigInt(rules.sellFee) : P.FEE_PIPS, rules };
}
/** A coin row for the API. */
const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
/** The platform's own coin, when HALCYON_PLATFORM_COIN names one the index knows. */
export function officialCoin(s = loadState()) { return (CONFIG.platformCoin && s.coins[CONFIG.platformCoin]) || null; }
/** Official: the platform's coin. Lookalike: another coin wearing its name or its symbol. Hidden: kept out of the lists by the operator. */
export function standing(c, s = loadState()) {
  const off = officialCoin(s); const official = Boolean(off && c.token === off.token);
  const lookalike = Boolean(off && !official && (norm(c.symbol) === norm(off.symbol) || norm(c.name) === norm(off.name) || norm(c.name) === norm(off.symbol) || norm(c.symbol) === norm(off.name)));
  return { official, lookalike, hidden: CONFIG.hiddenCoins.includes(c.token) };
}
export function coinRow(c, { ethUsd = 0 } = {}) {
  const pool = poolOf(c); const price = P.price(pool); const mcap = price * P.SUPPLY / 10n ** 18n; const res = P.reserves(pool);
  const s = loadState(); const v24 = volume24h(c); const st = standing(c, s);
  const meta = metaOf(c); const explorer = chainInfo().explorer; const now = Math.floor(Date.now() / 1000);
  const rules = c.rules ? { ...c.rules, maxSwap: String(c.rules.maxSwap), feeNow: Number(P.openingFee(c.rules, now - c.rules.start)), windowEndsAt: c.rules.start + c.rules.window, open: now < c.rules.start + c.rules.window } : null;
  return { token: c.token, name: c.name, symbol: c.symbol, creator: c.creator, uri: c.uri, official: st.official, lookalike: st.lookalike, hidden: st.hidden, officialToken: officialCoin(s)?.token || '', metaUrl: meta.metaUrl, image: meta.image, description: meta.description, links: meta.links, module: P.MODULE_NAMES[c.module] || 'roots', moduleInfo: MODULE_INFO[P.MODULE_NAMES[c.module] || 'roots'], stock: c.stock || '', stockInfo: stockInfo(c.stock), branches: c.branches || [], draw: c.draw || null,
    pool: c.pool, poolInfo: POOL_INFO[c.pool], v3Pool: c.v3Pool || '', poolId: c.poolId || '', tokenId: c.tokenId || '0', tickLower: c.tickLower, tickUpper: c.tickUpper, startTick: c.startTick, startCapUsd: c.startCapUsd, liquidity: c.liquidity, rules, createdAt: c.createdAt, block: c.block, tx: c.tx,
    progress: P.progress(pool), ethInPool: res.eth.toString(), coinsInPool: res.coins.toString(), price: price.toString(), priceUsd: ethUsd ? Number(price) / 1e18 * ethUsd : 0, marketCapEth: mcap.toString(), marketCapUsd: ethUsd ? Number(mcap) / 1e18 * ethUsd : 0,
    stats: { ...c.stats, volume24hEth: v24.toString() }, fees: c.fees, explorer: explorer ? { token: `${explorer}/token/${c.token}`, pool: c.v3Pool ? `${explorer}/address/${c.v3Pool}` : '', tx: `${explorer}/tx/${c.tx}` } : null, route: `/c/${c.token}` };
}
/** Every coin that is not hidden, the official one first, then by the latest trade. */
export function listCoins({ ethUsd = 0 } = {}) { const s = loadState(); return Object.values(s.coins).filter(c => !CONFIG.hiddenCoins.includes(c.token)).map(c => coinRow(c, { ethUsd })).sort((a, b) => Number(b.official) - Number(a.official) || (b.stats.lastTradeAt || b.createdAt) - (a.stats.lastTradeAt || a.createdAt)); }
/** A coin by token, pool or symbol; a symbol several coins wear goes to the official one, else the earliest that is not hidden or a lookalike. */
export function findCoin(key) {
  const s = loadState(); const k = String(key || '').toLowerCase(); const all = Object.values(s.coins);
  const exact = all.find(c => c.token === k || c.v3Pool === k || c.poolId === k); if (exact) return exact;
  const same = all.filter(c => c.symbol.toLowerCase() === k); if (!same.length) return null;
  const rank = c => { const st = standing(c, s); return (st.official ? 0 : 1) * 4 + (st.hidden ? 2 : 0) + (st.lookalike ? 1 : 0); };
  return same.sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)[0];
}
export function tradesOf(token, limit = 100) { const s = loadState(); return (s.trades[String(token).toLowerCase()] || []).slice(-limit).reverse(); }
export function holdersView(token, limit = 100) { const s = loadState(); const list = holdersOf(s, String(token).toLowerCase()); const total = list.reduce((a, h) => a + BigInt(h.balance), 0n); const keys = s.mistKeys || {}; return { count: list.length, held: total.toString(), keyed: list.filter(h => keys[h.address]).length, top: list.slice(0, limit).map(h => ({ ...h, pct: Number(BigInt(h.balance) * 1_000_000n / P.SUPPLY) / 10_000, mist: Boolean(keys[h.address]) })) }; }
/** A coin's burns, latest first: the gardener's buybacks and anyone's transfers to the dead address. */
export function burnsOf(token, limit = 100) { const s = loadState(); const k = String(token || '').toLowerCase(); return (s.burns || []).filter(b => b.token === k).slice(-limit).reverse(); }
export function payoutsOf(token, limit = 100) { const s = loadState(); const k = String(token || '').toLowerCase(); return s.payouts.filter(p => !k || p.token === k).slice(-limit).reverse(); }
export function gardenerLog(limit = 50) { return loadLedger().slice(-limit).reverse(); }
/** Mist notes, oldest first, from `since` (a count): what a holder's browser scans with its viewing key, and the leaves of the tree. Public, like the events. */
export function mistNotes(since = 0, limit = 2000) { const s = loadState(); const all = s.mist?.notes || []; const from = Math.max(0, Math.min(since, all.length)); return { total: all.length, since: from, notes: all.slice(from, from + limit).map(v => ({ ...v, symbol: s.coins[v.token]?.symbol || '' })) }; }
/** The pool in numbers: notes sown, batches, notes spent, ETH withdrawn, the last withdrawals (amount and time only). */
export function mistStats() { const s = loadState(); const m = s.mist || { notes: [], batches: [], spent: 0, withdrawn: '0', withdrawals: [] }; const sown = m.notes.reduce((a, n) => a + BigInt(n.denom), 0n); const byDenom = {}; for (const n of m.notes) byDenom[n.denom] = (byDenom[n.denom] || 0) + 1; return { notes: m.notes.length, batches: m.batches.length, spent: m.spent, sownEth: sown.toString(), withdrawnEth: m.withdrawn, byDenom, keyed: Object.keys(s.mistKeys || {}).length, recent: m.withdrawals.slice(-10).reverse().map(w => ({ t: w.t, denom: w.denom, fee: w.fee })) }; }
/** Everything the home page needs in one read. */
export function stats({ ethUsd = 0 } = {}) {
  const coins = listCoins({ ethUsd }); const s = loadState();
  const v24 = coins.reduce((a, c) => a + BigInt(c.stats.volume24hEth), 0n); const volume = coins.reduce((a, c) => a + BigInt(c.stats.volumeEth), 0n); const received = coins.reduce((a, c) => a + BigInt(c.fees.received), 0n); const paid = coins.reduce((a, c) => a + BigInt(c.fees.paid), 0n); const locked = coins.reduce((a, c) => a + BigInt(c.ethInPool), 0n);
  return { coins: coins.length, v4: coins.filter(c => c.pool === 1).length, volume24hEth: v24.toString(), volumeEth: volume.toString(), feesEth: received.toString(), paidEth: paid.toString(), lockedEth: locked.toString(), ethUsd, checkpoint: s.checkpoint, chain: chainInfo().name, gardener: CONFIG.gardenerEnabled };
}
/**
 * Everything since the first launch, for the stats page: launches by pool and module, volume and trades, the fees and where they went
 * (the platform's 20%, what creators and holders received by module, the pots waiting), the buybacks and burns coin by coin, the holders,
 * the mist, the platform's withdrawals, and one row per day. Hidden coins are left out, as everywhere on the site.
 */
export function allTime({ ethUsd = 0, platformPot = null, now = Math.floor(Date.now() / 1000) } = {}) {
  const s = loadState(); const hidden = new Set(CONFIG.hiddenCoins); const coins = Object.values(s.coins).filter(c => !hidden.has(c.token)); const sum = (list, f) => list.reduce((a, x) => a + BigInt(f(x) || 0), 0n);
  const byModule = {}; for (const n of P.MODULE_NAMES) byModule[n] = 0; for (const c of coins) byModule[P.MODULE_NAMES[c.module] || 'roots']++;
  const payouts = (s.payouts || []).filter(p => !hidden.has(p.token)); const byKind = {};
  for (const p of payouts) { const k = byKind[p.kind] || (byKind[p.kind] = { count: 0, eth: 0n, coins: 0n }); k.count++; if (p.kind === 'stockPaid') k.coins += BigInt(p.total || 0); else k.eth += BigInt(p.total || 0); if (p.coins) k.coins += BigInt(p.coins); }
  const kinds = {}; for (const [k, v] of Object.entries(byKind)) kinds[k] = { count: v.count, eth: v.eth.toString(), coins: v.coins.toString() };
  /* burns: every coin that lost supply, by the gardener's buybacks (ETH spent, from the prune payouts) or by anyone's transfer to the dead or zero address (the coin's tally, from the transfers) */
  const burnsByCoin = {}; for (const c of coins) if (BigInt(c.stats.burned || 0) > 0n) burnsByCoin[c.token] = { token: c.token, symbol: c.symbol, name: c.name, count: 0, eth: 0n, coins: BigInt(c.stats.burned), byBuybacks: BigInt(c.stats.burnedByBuybacks || 0) };
  for (const p of payouts) { if (p.kind !== 'prune') continue; const b = burnsByCoin[p.token] || (burnsByCoin[p.token] = { token: p.token, symbol: s.coins[p.token]?.symbol || '', name: s.coins[p.token]?.name || '', count: 0, eth: 0n, coins: 0n, byBuybacks: 0n }); b.count++; b.eth += BigInt(p.total || 0); }
  const burns = Object.values(burnsByCoin).sort((a, b) => (b.coins > a.coins ? 1 : b.coins < a.coins ? -1 : 0)).map(b => ({ ...b, eth: b.eth.toString(), coins: b.coins.toString(), byBuybacks: b.byBuybacks.toString(), supplyPct: Number(b.coins * 1_000_000n / P.SUPPLY) / 10_000 }));
  const burnedCoins = coins.reduce((a, c) => a + BigInt(c.stats.burned || 0), 0n); const burnedByBuybacks = coins.reduce((a, c) => a + BigInt(c.stats.burnedByBuybacks || 0), 0n);
  const recentBurns = (s.burns || []).filter(b => !hidden.has(b.token)).slice(-30).reverse().map(b => ({ ...b, symbol: s.coins[b.token]?.symbol || '' }));
  const holders = new Set(); for (const c of coins) for (const [a, v] of Object.entries(s.balances[c.token] || {})) if (BigInt(v) > 0n) holders.add(a);
  const received = sum(coins, c => c.fees.received); const platform = sum(coins, c => c.fees.platform); const paid = sum(coins, c => c.fees.paid); const pots = sum(coins, c => c.fees.pot); const withdrawn = BigInt(s.platform?.withdrawn || 0);
  const creators = (byKind.roots?.eth || 0n) + (byKind.branch?.eth || 0n); const holdersEth = (byKind.rain?.eth || 0n) + (byKind.rings?.eth || 0n) + (byKind.clover?.eth || 0n) + (byKind.mist?.eth || 0n); const burned = byKind.prune?.eth || 0n; const stock = byKind.harvest?.eth || 0n;
  const days = Object.entries(s.days || {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, d]) => ({ day, ...d }));
  const since = coins.reduce((a, c) => (c.createdAt && (!a || c.createdAt < a) ? c.createdAt : a), 0);
  const usdOf = wei => (ethUsd ? Number(wei) / 1e18 * ethUsd : 0);
  return {
    since, now, ethUsd, chain: chainInfo().name, checkpoint: s.checkpoint,
    coins: { total: coins.length, v3: coins.filter(c => Number(c.pool) === 0).length, v4: coins.filter(c => Number(c.pool) === 1).length, byModule, withTrades: coins.filter(c => c.stats.trades > 0).length },
    volume: { eth: sum(coins, c => c.stats.volumeEth).toString(), usd: usdOf(sum(coins, c => c.stats.volumeEth)), eth24h: coins.reduce((a, c) => a + volume24h(c, now), 0n).toString(), trades: coins.reduce((a, c) => a + Number(c.stats.trades || 0), 0), buys: coins.reduce((a, c) => a + Number(c.stats.buys || 0), 0), sells: coins.reduce((a, c) => a + Number(c.stats.sells || 0), 0) },
    fees: { received: received.toString(), receivedUsd: usdOf(received), platform: platform.toString(), platformUsd: usdOf(platform), paid: paid.toString(), creators: creators.toString(), holders: holdersEth.toString(), burned: burned.toString(), stock: stock.toString(), pots: pots.toString(), collected: sum(coins, c => c.fees.collected).toString() },
    platform: { received: platform.toString(), withdrawn: withdrawn.toString(), pot: platformPot !== null ? String(platformPot) : (platform - withdrawn < 0n ? 0n : platform - withdrawn).toString(), potFromChain: platformPot !== null, withdrawals: (s.platform?.withdrawals || []).slice(-20).reverse() },
    burns: { count: byKind.prune?.count || 0, eth: burned.toString(), coins: burnedCoins.toString(), byBuybacks: burnedByBuybacks.toString(), byCoin: burns.slice(0, 20), recent: recentBurns },
    payouts: kinds, holders: holders.size, mist: mistStats(), days: days.slice(-120),
  };
}
/** A wallet's standing: the coins it holds (from the index), what it created, what it may claim. */
export function walletView(address) {
  const s = loadState(); const a = String(address || '').toLowerCase(); const held = []; for (const [token, b] of Object.entries(s.balances)) { const v = BigInt(b[a] || 0); if (v > 0n && s.coins[token]) held.push({ token, symbol: s.coins[token].symbol, name: s.coins[token].name, balance: v.toString(), pct: Number(v * 1_000_000n / P.SUPPLY) / 10_000, since: s.since?.[token]?.[a] || 0 }); }
  const created = Object.values(s.coins).filter(c => c.creator === a).map(c => ({ token: c.token, symbol: c.symbol, name: c.name, module: P.MODULE_NAMES[c.module], pool: c.pool }));
  const payouts = s.payouts.filter(p => ['rain', 'rings', 'clover', 'stockPaid', 'mist'].includes(p.kind)).slice(-20).reverse();
  return { address: a, held, created, recentPayouts: payouts, mistKey: s.mistKeys?.[a] || '' };
}
