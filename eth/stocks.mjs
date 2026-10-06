// The stocks a coin's Harvest module may buy: the on-chain allow-list (HalcyonFees.stockAllowed, indexed from StockAllowed events) joined
// with the operator's registry on disk (symbol, name, decimals, issuer, logo, and the route the gardener buys through: a Uniswap v3 path
// from WETH, or Uniswap v4 hops from ETH or WETH). The registry starts from eth/stocks-seed.json for the chain (the tokenized stocks live on
// Ethereum mainnet, with the routes that have real liquidity). A stock the chain allows but the registry has no route for is listed
// without one, and the gardener will not buy it until the operator adds one. `catchPools` finds a stock's pools on the chain itself
// (the v3 factory, the v4 PoolManager's Initialize log); `discoverRoute` works from an indexer's pair list.
import fs from 'node:fs';
import { encodePacked, encodeAbiParameters, getAddress, keccak256, parseAbi } from 'viem';
import { dataPath, chainInfo, CONFIG } from './config.mjs';
import { readJsonSafe, atomicWrite, loadState } from './store.mjs';
import { publicClient, low } from './chain.mjs';

export const ZERO = '0x0000000000000000000000000000000000000000';
export const registryFile = () => dataPath('halcyon-stocks.json');
export const SEED = readJsonSafe(new URL('./stocks-seed.json', import.meta.url), {});
let reg = null;
/** The registry: the operator's file, seeded once from the chain's seed list when there is no file yet. */
export function loadRegistry() {
  if (reg) return reg;
  const seed = (SEED[String(CONFIG.chainId)] || []).map(r => ({ ...r, address: low(r.address), seeded: true }));
  const onDisk = readJsonSafe(registryFile(), null);
  if (onDisk) {
    // the seed may have moved on since this registry was made (a `bake` elsewhere, a new version): stocks it lacks are added, routes it lacks are taken; what the operator set here stays
    let changed = 0;
    for (const srow of seed) { const i = onDisk.findIndex(x => low(x.address) === srow.address); if (i < 0) { onDisk.push(srow); changed++; continue; } const row = onDisk[i]; const routed = (Array.isArray(row.path) && row.path.length >= 3) || (row.v4 && Array.isArray(row.v4.hops) && row.v4.hops.length); const seedRouted = (Array.isArray(srow.path) && srow.path.length >= 3) || (srow.v4 && Array.isArray(srow.v4.hops) && srow.v4.hops.length); if (!routed && seedRouted) { onDisk[i] = { ...row, path: srow.path, v4: srow.v4, note: srow.note || row.note, discovered: srow.discovered || row.discovered }; changed++; } }
    reg = onDisk; if (changed) try { saveRegistry(reg); } catch {}
    return reg;
  }
  reg = seed;
  if (fs.existsSync(CONFIG.dataDir)) try { saveRegistry(reg); } catch {}
  return reg;
}
/** Drop the cached registry and load it again (a test's, or an operator's, way to pick up a seed that changed under a running process). */
export function reloadRegistry() { reg = null; return loadRegistry(); }
export function saveRegistry(list) { reg = list; atomicWrite(registryFile(), JSON.stringify(list, null, 1)); }
export function upsertStock(row) { const list = loadRegistry().filter(x => low(x.address) !== low(row.address)); list.push({ ...row, address: low(row.address) }); saveRegistry(list); return row; }

/** A Uniswap v3 path from WETH to the stock as the bytes `buyStock` takes: [weth, fee, (mid, fee)*, stock]. Pure. */
export function encodePath(hops) {
  const types = [], values = [];
  hops.forEach((h, i) => { if (i % 2 === 0) { types.push('address'); values.push(getAddress(h)); } else { types.push('uint24'); values.push(Number(h)); } });
  if (types.length < 3 || types[0] !== 'address' || types[types.length - 1] !== 'address') throw new Error('a path is address, fee, address, ...');
  return encodePacked(types, values);
}
/** A v4 hop as the registry and `buyStockV4` hold it: the currency the hop leads to and the pool's fee, tick spacing and hooks. Pure. */
export const hopOf = h => ({ currency: getAddress(h.currency), fee: Number(h.fee), tickSpacing: Number(h.tickSpacing), hooks: getAddress(h.hooks || ZERO) });
/** The id of a v4 pool from its key (keccak256 of the abi-encoded key). Pure. */
export const v4PoolId = key => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [getAddress(key.currency0), getAddress(key.currency1), Number(key.fee), Number(key.tickSpacing), getAddress(key.hooks || ZERO)]));
/** The key of the v4 pool one hop swaps through, from the currency before it. Pure. */
export function v4KeyOf(from, hop) { const a = getAddress(from), b = getAddress(hop.currency); const [currency0, currency1] = low(a) < low(b) ? [a, b] : [b, a]; return { currency0, currency1, fee: Number(hop.fee), tickSpacing: Number(hop.tickSpacing), hooks: getAddress(hop.hooks || ZERO) }; }
/** A pool's fee for labels: "0.3%", or "dynamic fee" when the v4 flag says the hook sets it. Pure. */
export const feeLabel = fee => (Number(fee) & 0x800000 ? 'dynamic fee' : `${Number(fee) / 10_000}%`);
/** A short name for a v4 route, for labels: "ETH > USDC (0.05%) > NVDAon (0.3%)". Pure. */
export function describeV4(from, hops, extra = {}) { const all = { ...names(), ...extra }; const n = a => all[low(a)] || (low(a) === ZERO ? 'ETH' : a); return [from === ZERO || low(from) === ZERO ? 'ETH' : all[low(from)] || 'WETH', ...hops.map(h => `${n(h.currency)} (${feeLabel(h.fee)}${low(h.hooks || ZERO) !== ZERO ? ', hooked' : ''})`)].join(' > '); }
/** A short name for a v3 path, for labels: "WETH > 0.05% > USDC > 1% > AAPLon". */
export function describeV3(hops, extra = {}) { const all = { ...names(), ...extra }; return hops.map((h, i) => (i % 2 ? feeLabel(h) : all[low(h)] || h)).join(' > '); }
/**
 * The route of a stock as the registry holds it, or null when the operator has not set one:
 *   { kind: 'v3', hops: [weth, fee, ..., stock], bytes }           a Uniswap v3 path from WETH, the bytes `buyStock` takes
 *   { kind: 'v4', from, fromWeth, hops: [{ currency, fee, tickSpacing, hooks }] }   Uniswap v4 hops from ETH (from = ZERO) or WETH, for `buyStockV4`
 * Both carry the stock's decimals, symbol and name, and `label`.
 */
export function routeOf(stock) {
  const r = loadRegistry().find(x => low(x.address) === low(stock)); if (!r) return null;
  const base = { decimals: Number(r.decimals || 18), symbol: r.symbol || '', name: r.name || '' }; const weth = low(chainInfo().uniswap.weth || '');
  if (r.v4 && Array.isArray(r.v4.hops) && r.v4.hops.length) {
    const from = low(r.v4.from || ZERO); if (from !== ZERO && from !== weth) return null;
    let hops; try { hops = r.v4.hops.map(hopOf); } catch { return null; }
    if (low(hops[hops.length - 1].currency) !== low(stock)) return null;
    return { ...base, kind: 'v4', from: from === ZERO ? ZERO : getAddress(weth), fromWeth: from !== ZERO, hops, label: describeV4(from, hops, { [low(stock)]: r.symbol || 'the stock' }) };
  }
  if (!Array.isArray(r.path) || r.path.length < 3) return null;
  if (weth && low(r.path[0]) !== weth) return null; if (low(r.path[r.path.length - 1]) !== low(stock)) return null;
  let bytes; try { bytes = encodePath(r.path); } catch { return null; }
  return { ...base, kind: 'v3', hops: r.path, bytes, label: describeV3(r.path, { [low(stock)]: r.symbol || 'the stock' }) };
}
const rowOf = (r, address, allowed) => { const route = routeOf(address); return { address, symbol: r.symbol || '', name: r.name || '', decimals: Number(r.decimals || 18), issuer: r.issuer || '', category: r.category || 'stock', logo: r.logo || '', note: r.note || '', routed: Boolean(route), via: route ? route.kind : '', allowed }; };
/** What the site lists: every stock the chain allows, with what the registry knows about it, then the registry's others as pending. */
export function listStocks() {
  const s = loadState(); const allowed = Object.entries(s.stocks || {}).filter(([, v]) => v).map(([a]) => a); const list = loadRegistry();
  const rows = allowed.map(a => rowOf(list.find(x => low(x.address) === a) || {}, a, true));
  for (const r of list) if (!allowed.includes(low(r.address))) rows.push(rowOf(r, low(r.address), false));
  return rows.sort((a, b) => Number(b.allowed) - Number(a.allowed) || Number(b.routed) - Number(a.routed) || a.symbol.localeCompare(b.symbol));
}
const ERC20 = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
/** Read a stock token's name, symbol and decimals from the chain (the admin script's helper). */
export async function describeToken(address) {
  const pc = publicClient(); const a = getAddress(address);
  const [name, symbol, decimals] = await Promise.all([pc.readContract({ address: a, abi: ERC20, functionName: 'name' }), pc.readContract({ address: a, abi: ERC20, functionName: 'symbol' }), pc.readContract({ address: a, abi: ERC20, functionName: 'decimals' })]);
  return { address: low(a), name, symbol, decimals: Number(decimals) };
}
const QUOTER_ABI = parseAbi(['function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)']);
const V4_QUOTER_ABI = parseAbi(['function quoteExactInput((address exactCurrency, (address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)[] path, uint128 exactAmount) params) returns (uint256 amountOut, uint256 gasEstimate)']);
const STATE_VIEW_ABI = parseAbi(['function getLiquidity(bytes32 poolId) view returns (uint128)', 'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)']);
const FACTORY_ABI = parseAbi(['function getPool(address, address, uint24) view returns (address)']);
const V3_POOL_ABI = parseAbi(['function liquidity() view returns (uint128)']);
const INITIALIZE_EVENT = parseAbi(['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'])[0];
/** The issuer's official token list (Ondo Global Markets), the source of the seed and of `stocks.mjs import --ondo`. */
export const ONDO_TOKEN_LIST = 'https://raw.githubusercontent.com/ondoprotocol/ondo-global-markets-token-list/main/tokenlist.json';
const ETF_WORDS = /\b(ETF|Trust|iShares|SPDR|Vanguard|Invesco|ProShares|Direxion|ARK|Fund|Index|Shares|QQQ)\b/i; const COMMODITY_WORDS = /(Gold|Silver|Platinum|Palladium|Precious Metals|Oil|Natural Gas|Copper Index|Commodity|Cmd|Brent)/i; const MINER_WORDS = /(Miners|Services)/i;
/** A stock, an ETF or a physical commodity fund, from the name. Pure. */
export function categoryOf(name) { const n = String(name || ''); if (!ETF_WORDS.test(n)) return 'stock'; return COMMODITY_WORDS.test(n) && !MINER_WORDS.test(n) ? 'commodity' : 'etf'; }
/**
 * The stock tokens of this chain in an issuer's list: Ondo's token-list JSON (chainId 1, names ending in "(Ondo Tokenized)", the
 * cash and yield tokens left out, as the issuer's own tooling filters it) or a CSV catalog with symbol, address, decimals, logo_url and
 * a name column. Rows without a route; the registry keeps its own routes. Pure.
 */
export function parseIssuerList(text, chainId = CONFIG.chainId) {
  const t = String(text || '').replace(/^﻿/, '').trim(); const rows = [];
  if (t.startsWith('{') || t.startsWith('[')) {
    const j = JSON.parse(t); const tokens = Array.isArray(j) ? j : j.tokens || [];
    for (const x of tokens) { if (!x || Number(x.chainId) !== Number(chainId)) continue; const name = String(x.name || ''); const symbol = String(x.symbol || ''); const tags = Array.isArray(x.tags) ? x.tags : []; if (['USDon', 'USDY'].includes(symbol) || tags.includes('oip') || !name.endsWith('(Ondo Tokenized)')) continue; if (!/^0x[0-9a-fA-F]{40}$/.test(String(x.address || ''))) continue;
      rows.push({ address: low(x.address), symbol, name, decimals: Number(x.decimals ?? 18), issuer: 'Ondo Stocks', category: categoryOf(name), logo: String(x.logoURI || `https://cdn.ondo.finance/tokens/logos/${symbol.toLowerCase()}_160x160.png`) }); }
  } else {
    const lines = t.split(/\r?\n/).filter(Boolean); const split = l => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map(v => v.trim()); };
    const head = split(lines[0]).map(h => h.toLowerCase()); const col = (...names) => head.findIndex(h => names.includes(h));
    const iAddr = col('address'), iSym = col('symbol'), iName = col('underlying_name_short', 'name'), iDec = col('decimals'), iLogo = col('logo_url', 'logo', 'logouri'), iChain = col('chain_id', 'chainid');
    if (iAddr < 0 || iSym < 0) throw new Error('the CSV needs address and symbol columns');
    for (const l of lines.slice(1)) { const c = split(l); if (iChain >= 0 && c[iChain] && Number(c[iChain]) !== Number(chainId)) continue; const address = c[iAddr] || ''; if (!/^0x[0-9a-fA-F]{40}$/.test(address)) continue; const symbol = c[iSym] || ''; const short = iName >= 0 ? c[iName] : ''; const name = short ? (short.endsWith('(Ondo Tokenized)') ? short : `${short} (Ondo Tokenized)`) : symbol;
      rows.push({ address: low(address), symbol, name, decimals: Number((iDec >= 0 && c[iDec]) || 18), issuer: 'Ondo Stocks', category: categoryOf(name), logo: (iLogo >= 0 && c[iLogo]) || `https://cdn.ondo.finance/tokens/logos/${symbol.toLowerCase()}_160x160.png` }); }
  }
  const seen = new Set(); return rows.filter(r => !seen.has(r.address) && seen.add(r.address)).sort((a, b) => a.symbol.localeCompare(b.symbol));
}
/** Mainnet's USDT, the other stable a stock pool may be quoted in (a WETH/USDT 0.05% pool is deep on v3 and v4). */
const USDT = { 1: '0xdac17f958d2ee523a2206206994597c13d831ec7' };
const FEE_TIERS = [100, 500, 3000, 10000];
/** The fee tiers v4 pools are usually opened at, with the tick spacing each one conventionally takes (v4 allows any pair; these are the ones routers try). */
const V4_TIERS = [[100, 1], [500, 10], [3000, 60], [10000, 200]];
/** The names of the currencies a route passes through, for labels: the chain's known ones, the registry's, and what `symbolOf` read. */
const symbols = {};
function names() { const u = chainInfo().uniswap; const n = { [ZERO]: 'ETH', ...symbols }; if (u.weth) n[low(u.weth)] = 'WETH'; if (u.usdc) n[low(u.usdc)] = 'USDC'; if (USDT[CONFIG.chainId]) n[USDT[CONFIG.chainId]] = 'USDT'; for (const r of loadRegistry()) if (r.symbol) n[low(r.address)] = r.symbol; return n; }
/** A currency's symbol for labels: a known name, else read from the chain once (an address when even that fails). */
const SYMBOL32 = parseAbi(['function symbol() view returns (bytes32)']);
async function symbolOf(address) {
  const a = low(address); const n = names(); if (n[a]) return n[a]; const pc = publicClient();
  for (let i = 0; i < 2 && !symbols[a]; i++) {
    try { symbols[a] = String(await pc.readContract({ address: getAddress(a), abi: ERC20, functionName: 'symbol' })).replace(/[^\x20-\x7e]/g, '').trim() || a; }
    catch { try { const raw = await pc.readContract({ address: getAddress(a), abi: SYMBOL32, functionName: 'symbol' }); symbols[a] = Buffer.from(String(raw).slice(2), 'hex').toString('utf8').replace(/\0+$/, '').replace(/[^\x20-\x7e]/g, '').trim() || a; } catch { if (i === 0) await new Promise(r => setTimeout(r, 400)); } }
  }
  return symbols[a] || (symbols[a] = a);
}
/** The v3 pool of a pair at any fee tier, through the factory: { fee, pool } or null (the one at `wanted` when given). */
async function v3PoolOf(a, b, wanted = '') {
  const u = chainInfo().uniswap; if (!u.v3Factory) return null; const pc = publicClient();
  for (const fee of FEE_TIERS) { const pool = await pc.readContract({ address: getAddress(u.v3Factory), abi: FACTORY_ABI, functionName: 'getPool', args: [getAddress(a), getAddress(b), fee] }).catch(() => null); if (!pool || /^0x0{40}$/.test(pool)) continue; if (!wanted || low(pool) === low(wanted)) return { fee, pool: low(pool) }; }
  return null;
}
/** Every v3 pool of a pair with liquidity in it, over the fee tiers: [{ fee, pool, liquidity }]. */
async function v3PoolsOf(a, b) {
  const u = chainInfo().uniswap; if (!u.v3Factory) return []; const pc = publicClient(); const out = [];
  for (const fee of FEE_TIERS) { const pool = await pc.readContract({ address: getAddress(u.v3Factory), abi: FACTORY_ABI, functionName: 'getPool', args: [getAddress(a), getAddress(b), fee] }).catch(() => null); if (!pool || /^0x0{40}$/.test(pool)) continue; const liquidity = await pc.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'liquidity' }).catch(() => 0n); if (liquidity > 0n) out.push({ fee, pool: low(pool), liquidity }); }
  return out;
}
/** A v4 pool's in-range liquidity through the state view (0n when the pool does not exist, or the chain has no state view). */
export async function v4Liquidity(poolId) { const sv = chainInfo().uniswap.stateView; if (!sv) return 0n; try { return BigInt(await publicClient().readContract({ address: getAddress(sv), abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] })); } catch { return 0n; } }
/** The deepest plain (hookless) v4 pool of a pair over the usual tiers, by in-range liquidity: { key, id, liquidity } or null. */
async function deepestPlainPool(a, b) {
  let best = null;
  for (const [fee, tickSpacing] of V4_TIERS) { const key = v4KeyOf(a, { currency: b, fee, tickSpacing, hooks: ZERO }); const id = v4PoolId(key); const liquidity = await v4Liquidity(id); if (liquidity > 0n && (!best || liquidity > best.liquidity)) best = { key, id, liquidity }; }
  return best;
}
/** The way through v4 from ETH to `other` (the stock pool's other side): nothing when it is ETH or WETH, the deepest plain ETH pool of it, else ETH > USDC > it. */
const heads = { v3: {}, v4: {} };
async function v4Head(other) { const o = low(other); if (!(o in heads.v4)) heads.v4[o] = await v4HeadOf(o); return heads.v4[o]; }
async function v4HeadOf(other) {
  const u = chainInfo().uniswap; const weth = low(u.weth || ''), usdc = low(u.usdc || ''); const o = low(other);
  if (o === ZERO) return { from: ZERO, hops: [], via: 'ETH' };
  if (o === weth) return { from: getAddress(weth), hops: [], via: 'WETH' };
  const name = await symbolOf(o);
  const direct = await deepestPlainPool(ZERO, o); if (direct) return { from: ZERO, hops: [{ currency: getAddress(o), fee: direct.key.fee, tickSpacing: direct.key.tickSpacing, hooks: ZERO }], via: name };
  if (usdc && o !== usdc) { const a = await deepestPlainPool(ZERO, usdc); const b = await deepestPlainPool(usdc, o); if (a && b) return { from: ZERO, hops: [{ currency: getAddress(usdc), fee: a.key.fee, tickSpacing: a.key.tickSpacing, hooks: ZERO }, { currency: getAddress(o), fee: b.key.fee, tickSpacing: b.key.tickSpacing, hooks: ZERO }], via: `USDC and ${name}` }; }
  return null;
}
/** The way through v3 from WETH to `other`: [weth] itself, WETH > USDC or USDT at 0.05%, or WETH > USDC > it through a USDC pool of it. */
async function v3Head(other) { const o = low(other); if (!(o in heads.v3)) heads.v3[o] = await v3HeadOf(o); return heads.v3[o]; }
async function v3HeadOf(other) {
  const u = chainInfo().uniswap; const weth = low(u.weth || ''), usdc = low(u.usdc || ''), usdt = USDT[CONFIG.chainId] || ''; const o = low(other);
  if (o === weth) return { head: [getAddress(weth)], via: 'WETH' };
  if (usdc && o === usdc) return { head: [getAddress(weth), 500, getAddress(usdc)], via: 'USDC' };
  if (usdt && o === usdt) return { head: [getAddress(weth), 500, getAddress(usdt)], via: 'USDT' };
  if (usdc) { const bridge = await v3PoolOf(usdc, o); if (bridge) return { head: [getAddress(weth), 500, getAddress(usdc), bridge.fee, getAddress(o)], via: `USDC and ${await symbolOf(o)}` }; }
  return null;
}
/** One line per pair the indexer listed, for the operator's eyes. Pure. */
export function describePairs(pairs) {
  return (Array.isArray(pairs) ? pairs : []).map(p => `${p.dexId || '?'}${Array.isArray(p.labels) && p.labels.length ? ' ' + p.labels.join('/') : ''} ${p.quoteToken?.symbol || '?'} $${Math.round(Number(p.liquidity?.usd || 0)).toLocaleString('en-US')}`).join(', ');
}
/** How much worse the price gets between a tenth of `probe` and `probe` itself: 0 for no impact, 0.05 for 5%. 1 when the probe gets nothing. */
export async function impactOf(quote, probe) { const [small, full] = await Promise.all([quote(probe / 10n), quote(probe)]); if (full === 0n || small === 0n) return 1; return Math.max(0, 1 - Number(full) / (10 * Number(small))); }
/**
 * A route for a stock through one of its pools, quoted: v3 { kind: 'v3', route: hops, quote, impact, fee, via } or v4 { kind: 'v4',
 * from, hops, quote, impact, via }, or { reason }. `pool` is { kind: 'v3', fee, pool } or { kind: 'v4', key }; `other` the pool's
 * other currency.
 */
async function routeThrough(stock, pool, other, probe) {
  const otherSymbol = await symbolOf(other);
  if (pool.kind === 'v3') {
    const h = await v3Head(other); if (!h) return { reason: `no way on v3 from WETH to ${otherSymbol}` };
    const route = [...h.head, pool.fee, getAddress(stock)]; const bytes = encodePath(route); const quote = await quoteStock(bytes, probe); if (quote === 0n) return { reason: `QuoterV2 gives nothing through ${route.join(' > ')}` };
    return { kind: 'v3', route, quote, impact: await impactOf(a => quoteStock(bytes, a), probe), fee: pool.fee, via: h.via, otherSymbol, hooked: false };
  }
  const h = await v4Head(other); if (!h) return { reason: `no way on v4 from ETH to ${otherSymbol}` };
  const hops = [...h.hops, { currency: getAddress(stock), fee: pool.key.fee, tickSpacing: pool.key.tickSpacing, hooks: getAddress(pool.key.hooks || ZERO) }];
  const quote = await quoteV4(h.from, hops, probe); if (quote === 0n) return { reason: `the v4 quoter gives nothing through ${describeV4(h.from, hops, names())}` };
  return { kind: 'v4', from: h.from, hops, quote, impact: await impactOf(a => quoteV4(h.from, hops, a), probe), fee: pool.key.fee, via: h.via, otherSymbol, hooked: low(pool.key.hooks || ZERO) !== ZERO };
}
/** A found route in one line: the pool, its depth when known, the way from ETH, the probe's price impact. Pure. */
export function describeRoute(d) {
  const pct = feeLabel(d.fee); const impact = `${(d.impact * 100).toFixed(1)}% impact at the probe`; const tvl = d.usd ? `, about $${Math.round(d.usd / 1000)}K TVL` : '';
  if (d.kind === 'v3') return `v3 ${d.otherSymbol || d.via} ${pct} pool${tvl}, from WETH via ${d.via}, ${impact}`;
  return `v4 ${d.otherSymbol || d.via} ${pct}${d.hooked ? ' hooked' : ''} pool${tvl}, from ${d.from === ZERO ? 'ETH' : 'WETH'} via ${d.via}, ${impact}`;
}
/** The registry fields a found route is recorded with (path or v4), plus the note. Pure. */
export function routeFields(d, source) {
  const note = `${describeRoute(d)} (${source} ${new Date().toISOString().slice(0, 10)})`;
  return d.kind === 'v3' ? { path: d.route, v4: undefined, note } : { path: undefined, v4: { from: d.from, hops: d.hops }, note };
}
/** The key of a v4 pool from its id: a plain pool of the stock against one of the usual currencies at a usual tier, else the Initialize log with that id. */
async function v4KeyById(poolId, stock, otherHint = '') {
  const u = chainInfo().uniswap; const others = [...new Set([otherHint, ZERO, u.weth, u.usdc, USDT[CONFIG.chainId]].filter(Boolean).map(low))];
  for (const o of others) for (const [fee, tickSpacing] of V4_TIERS) { const key = v4KeyOf(stock, { currency: o === ZERO ? ZERO : getAddress(o), fee, tickSpacing, hooks: ZERO }); if (low(v4PoolId(key)) === low(poolId)) return key; }
  const logs = await initializeLogs({ id: poolId }); return logs.length ? keyOfLog(logs[0]) : null;
}
const keyOfLog = l => ({ currency0: getAddress(l.args.currency0), currency1: getAddress(l.args.currency1), fee: Number(l.args.fee), tickSpacing: Number(l.args.tickSpacing), hooks: getAddress(l.args.hooks), block: Number(l.blockNumber) });
/** The PoolManager's Initialize logs for `args` (an id, a currency0, a currency1), from the chain's v4 start; a provider that limits the range gets the range split. */
export async function initializeLogs(args, { fromBlock = chainInfo().v4FromBlock || 0, calls = { n: 0 } } = {}) {
  const pm = chainInfo().uniswap.poolManager; if (!pm) return []; const pc = publicClient(); const latest = await pc.getBlockNumber();
  const fetch = async (from, to) => { calls.n++; try { return await pc.getLogs({ address: getAddress(pm), event: INITIALIZE_EVENT, args, fromBlock: from, toBlock: to }); } catch (e) { if (to - from < 5_000n || calls.n > 600) throw e; const mid = (from + to) / 2n; return [...await fetch(from, mid), ...await fetch(mid + 1n, to)]; } };
  return fetch(BigInt(fromBlock), latest);
}
/**
 * Every pool of a stock the chain itself knows: the v3 factory's pools against WETH, USDC and USDT with liquidity, and every v4 pool
 * the PoolManager ever initialised with the stock on either side (its Initialize log), with the in-range liquidity of each.
 * [{ kind: 'v3', fee, pool, other, liquidity } | { kind: 'v4', key, id, other, liquidity, block }]
 */
export async function catchPools(stock, { calls = { n: 0 } } = {}) {
  const u = chainInfo().uniswap; const s = low(stock); const out = [];
  for (const other of [u.weth, u.usdc, USDT[CONFIG.chainId]].filter(Boolean)) for (const p of await v3PoolsOf(s, other)) out.push({ kind: 'v3', fee: p.fee, pool: p.pool, other: low(other), liquidity: p.liquidity });
  if (u.poolManager) {
    const logs = [...await initializeLogs({ currency0: getAddress(s) }, { calls }), ...await initializeLogs({ currency1: getAddress(s) }, { calls })];
    for (const l of logs) { const key = keyOfLog(l); const id = v4PoolId(key); out.push({ kind: 'v4', key, id, other: low(key.currency0) === s ? low(key.currency1) : low(key.currency0), liquidity: await v4Liquidity(id), block: key.block }); }
  }
  return out;
}
/**
 * The best route for a stock among its pools on the chain (`catchPools`): every pool with liquidity gets a route from ETH and a quote
 * with `probe` wei; the one that gives the most stock wins, if the price impact of the probe is at most `maxImpact`. Returns the
 * route (as `routeThrough` shapes it, with `pools`, the ones seen) or { reason, pools }.
 */
export async function catchRoute(stock, { probe = 10n ** 16n * 5n, maxImpact = 0.03, calls = { n: 0 } } = {}) {
  const pools = await catchPools(stock, { calls }); const n = names(); const live = pools.filter(p => p.liquidity > 0n);
  if (!pools.length) return { reason: 'no pool on Uniswap v3 (against WETH, USDC or USDT) and none ever opened on v4 (the issuer\'s own market only)', pools };
  if (!live.length) return { reason: `${pools.length} pool${pools.length > 1 ? 's' : ''} on the chain but none with liquidity in range (${describePools(pools, n)})`, pools };
  // plain pools first (v3, and v4 without hooks); hooked v4 pools, mostly other launchpads' coins paired against the stock, only when no plain pool gives a route
  const plain = live.filter(p => p.kind === 'v3' || low(p.key.hooks) === ZERO); const hooked = live.filter(p => !plain.includes(p));
  let best = null; const reasons = []; const seen = new Set();
  const consider = async p => { const d = await routeThrough(stock, p, p.other, probe); if (!d.quote) { const r = `${p.kind} ${names()[p.other] || p.other}: ${d.reason}`; if (!seen.has(r)) { seen.add(r); reasons.push(r); } return; } if (!best || d.quote > best.quote) best = { ...d, pool: p }; };
  for (const p of plain) await consider(p);
  if (!best) for (const p of hooked) await consider(p);
  if (!best) return { reason: `${live.length} pool${live.length > 1 ? 's' : ''} with liquidity but no way from ETH through any (${reasons.slice(0, 8).join('; ')}${reasons.length > 8 ? `; and ${reasons.length - 8} more` : ''})`, pools };
  if (best.impact > maxImpact) return { reason: `the best pool (${best.kind} ${names()[best.pool.other] || best.pool.other} ${feeLabel(best.fee)}) moves ${(best.impact * 100).toFixed(1)}% on the probe, over the ${(maxImpact * 100).toFixed(1)}% ceiling`, pools, best };
  return { ...best, pools };
}
/** One line per pool the chain holds, for the operator's eyes, currencies named where known. */
export function describePools(pools, extra = {}) {
  const n = { ...names(), ...extra }; const name = p => n[p.other] || p.other; const fee = p => feeLabel(p.kind === 'v3' ? p.fee : p.key.fee);
  const live = pools.filter(p => p.liquidity > 0n); const empty = pools.length - live.length;
  const plain = live.filter(p => p.kind === 'v3' || low(p.key.hooks) === ZERO); const hooked = live.filter(p => p.kind === 'v4' && low(p.key.hooks) !== ZERO);
  const parts = plain.map(p => `${p.kind} ${name(p)} ${fee(p)}`);
  if (hooked.length) { const syms = [...new Set(hooked.map(name))]; parts.push(`${hooked.length} hooked v4 pool${hooked.length > 1 ? 's' : ''} against ${syms.slice(0, 6).join(', ')}${syms.length > 6 ? ` and ${syms.length - 6} more` : ''}`); }
  if (empty) parts.push(`${empty} empty`);
  return parts.join(', ');
}
/**
 * A route for a stock from an indexer's pairs for it (DexScreener's shape): the deepest Uniswap pool, v3 or v4, with at least `minUsd`
 * of liquidity that a route from ETH can reach (v3: WETH, USDC, USDT or anything with a USDC pool; v4: ETH, WETH, anything with a
 * plain ETH pool, or through USDC), the pool confirmed on the chain (the v3 factory; a v4 key from the usual tiers or its Initialize
 * log), quoted with `probe` wei. Returns the route (with `usd`) or { reason, seen }.
 */
export async function discoverRoute(stock, pairs, { minUsd = 50_000, probe = 10n ** 16n * 5n, maxImpact = 0.03 } = {}) {
  const u = chainInfo().uniswap; const s = low(stock); const n = names();
  const all = Array.isArray(pairs) ? pairs : []; const seen = describePairs(all);
  if (!all.length) return { reason: 'no pairs on any DEX (the issuer\'s own market only)', seen };
  const uni = all.filter(p => p && String(p.chainId || 'ethereum') === 'ethereum' && /uniswap/i.test(String(p.dexId || '')));
  const cands = uni.map(p => { const base = low(p.baseToken?.address || ''), quote = low(p.quoteToken?.address || ''); const other = base === s ? quote : quote === s ? base : ''; const labels = Array.isArray(p.labels) ? p.labels.map(String) : []; const version = labels.some(l => /v4/i.test(l)) ? 'v4' : labels.some(l => /v3/i.test(l)) || !labels.length ? 'v3' : labels.some(l => /v2/i.test(l)) ? 'v2' : 'v3'; return { pair: low(p.pairAddress || ''), other, otherSymbol: base === s ? p.quoteToken?.symbol : p.baseToken?.symbol, usd: Number(p.liquidity?.usd || 0), version }; }).filter(c => c.pair && c.other !== s && (c.other || c.version === 'v4')).sort((a, b) => b.usd - a.usd);
  const usable = cands.filter(c => c.version !== 'v2');
  if (!usable.length) return { reason: `no Uniswap v3 or v4 pool among the pairs the indexer lists (${seen})`, seen };
  const deep = usable.filter(c => c.usd >= minUsd);
  if (!deep.length) return { reason: `the deepest Uniswap pool (${usable[0].version} ${usable[0].otherSymbol || 'other'}) holds about $${Math.round(usable[0].usd).toLocaleString('en-US')}, under the $${minUsd.toLocaleString('en-US')} floor`, seen };
  const reasons = [];
  for (const c of deep) {
    if (c.version === 'v3') {
      if (!u.v3Factory) { reasons.push('no v3 factory on this chain'); continue; }
      const leg = await v3PoolOf(s, c.other, c.pair); if (!leg) { reasons.push(`${c.pair} is not one of the v3 factory's pools for ${c.otherSymbol || c.other}`); continue; }
      const d = await routeThrough(s, { kind: 'v3', fee: leg.fee, pool: leg.pool }, c.other, probe); if (!d.quote) { reasons.push(d.reason); continue; }
      if (d.impact > maxImpact) { reasons.push(`the v3 ${c.otherSymbol || 'other'} pool moves ${(d.impact * 100).toFixed(1)}% on the probe`); continue; }
      return { ...d, usd: c.usd, otherSymbol: c.otherSymbol, seen };
    }
    if (!u.poolManager) { reasons.push('no v4 PoolManager on this chain'); continue; }
    const key = await v4KeyById(c.pair, s, c.other).catch(() => null); if (!key) { reasons.push(`the v4 pool ${c.pair} (${c.otherSymbol || 'other'}) has a key this chain cannot name (no Initialize log reachable)`); continue; }
    const other = low(key.currency0) === s ? low(key.currency1) : low(key.currency0);
    const d = await routeThrough(s, { kind: 'v4', key }, other, probe); if (!d.quote) { reasons.push(d.reason); continue; }
    if (d.impact > maxImpact) { reasons.push(`the v4 ${n[other] || c.otherSymbol || 'other'} pool moves ${(d.impact * 100).toFixed(1)}% on the probe`); continue; }
    return { ...d, usd: c.usd, otherSymbol: n[other] || c.otherSymbol, seen };
  }
  return { reason: `${deep.length} Uniswap pool${deep.length > 1 ? 's' : ''} over the floor but no route from ETH through any (${reasons.join('; ')})`, seen };
}
/** What `amountIn` wei of ETH buys through a route right now: a registry route (v3 or v4) or v3 path bytes; 0n when the quoter has no answer. */
export async function quoteStock(route, amountIn) {
  if (typeof route === 'string') return quoteV3(route, amountIn);
  if (!route) return 0n;
  return route.kind === 'v4' ? quoteV4(route.from, route.hops, amountIn) : quoteV3(route.bytes, amountIn);
}
async function quoteV3(pathBytes, amountIn) {
  const q = chainInfo().uniswap.quoterV2; if (!q) return 0n;
  try { const r = await publicClient().simulateContract({ address: getAddress(q), abi: QUOTER_ABI, functionName: 'quoteExactInput', args: [pathBytes, amountIn] }); return r.result[0]; } catch { return 0n; }
}
/** The v4 quoter's answer for hops from `from` (ETH when ZERO), or 0n. */
export async function quoteV4(from, hops, amountIn) {
  const q = chainInfo().uniswap.v4Quoter; if (!q || amountIn >= 2n ** 128n) return 0n;
  try { const r = await publicClient().simulateContract({ address: getAddress(q), abi: V4_QUOTER_ABI, functionName: 'quoteExactInput', args: [{ exactCurrency: getAddress(from || ZERO), path: hops.map(h => ({ intermediateCurrency: getAddress(h.currency), fee: Number(h.fee), tickSpacing: Number(h.tickSpacing), hooks: getAddress(h.hooks || ZERO), hookData: '0x' })), exactAmount: amountIn }] }); return r.result[0]; } catch { return 0n; }
}
