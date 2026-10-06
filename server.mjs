// Halcyon's server: the site (dist/), the API the site reads, the hosted coin metadata, the indexer and the gardener. One Node process.
//   node server.mjs                 live, against the chain in CHAIN_ID / ETH_RPC_URL, contracts from HALCYON_LAUNCHPAD / HALCYON_FEES
//   npm run start:demo              the demo: sample coins, no chain, no keys
// The gardener key never leaves the process; the site gets public addresses only (/api/config). The RPC proxy is allow-listed: reads, and signed transactions relayed as they are.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CONFIG, chainInfo, chainReady, publicConfig, ensureDataDir, dataPath } from './eth/config.mjs';
import { loadState, putMeta, loadMeta, loadImages, putImage, sweep } from './eth/store.mjs';
import { metaKey, cleanMeta, keyOfUri } from './eth/meta.mjs';
import { pinningEnabled, pinFile, pinJson, gatewayUrl, configSummary as pinningSummary } from './eth/pinata.mjs';
import * as M from './eth/markets.mjs';
import * as P from './shared/pool.mjs';
/** Whether the mist circuit artifacts agree with each other and with this chain's deployment record (checked once, at the first ask). */
let artifactsReport = null;
async function mistArtifacts() {
  if (artifactsReport) return artifactsReport;
  try { const MI = await import('./eth/mist.mjs'); let record = null; try { record = JSON.parse(fs.readFileSync(new URL(`./deployments/${chainInfo().short}.json`, import.meta.url), 'utf8')); } catch {} artifactsReport = { ...MI.checkArtifacts(record), setup: MI.SETUP, record: Boolean(record) }; }
  catch (e) { artifactsReport = { ok: false, problems: [String(e.message || e)], setup: null, record: false }; }
  return artifactsReport;
}

const here = path.dirname(fileURLToPath(import.meta.url)); const dist = path.join(here, 'dist'); const publicDir = path.join(here, 'public');
const imageDir = path.resolve(process.env.IMAGE_DIR || dataPath('images'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json' };
const json = (res, code, body, headers = {}) => { const text = JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? v.toString() : v)); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(text); };
const text = (res, code, body) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(body); };
const bad = (res, msg, code = 400) => json(res, code, { error: msg });

let ethUsd = CONFIG.demo ? 3000 : 0; let ethUsdAt = 0; let chainMods = null; let planCache = null; let potCache = null;
async function chain() { if (!chainMods) chainMods = { contracts: await import('./eth/contracts.mjs'), indexer: await import('./eth/indexer.mjs'), gardener: await import('./eth/gardener.mjs'), stocks: await import('./eth/stocks.mjs'), chain: await import('./eth/chain.mjs'), mist: await import('./eth/mist.mjs') }; return chainMods; }
async function refreshEthUsd() { if (CONFIG.demo || !chainReady()) return ethUsd; if (Date.now() - ethUsdAt < 60_000) return ethUsd; try { const v = await (await chain()).contracts.ethUsd(); if (v > 0) ethUsd = v; ethUsdAt = Date.now(); } catch {} return ethUsd; }

/** A small per-IP budget for the endpoints that cost something. */
const buckets = new Map();
function rate(req, key, perMinute) { const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); const k = `${key}:${ip}`; const now = Date.now(); const b = buckets.get(k) || { n: 0, at: now }; if (now - b.at > 60_000) { b.n = 0; b.at = now; } b.n++; buckets.set(k, b); if (buckets.size > 5000) buckets.clear(); return b.n <= perMinute; }
const readBody = (req, max = 1_200_000) => new Promise((resolve, reject) => { const chunks = []; let n = 0; req.on('data', c => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); }); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); });
const publicBase = req => CONFIG.publicBase || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;

/** The hosted metadata a launch's uri points at: content-addressed, immutable once written (eth/meta.mjs; re-exported for the tests). */
export { metaKey, cleanMeta };

async function api(req, res, url) {
  const p = url.pathname.replace(/^\/api/, ''); const get = req.method === 'GET'; const usd = await refreshEthUsd();
  if (p === '/config' && get) return json(res, 200, { ...publicConfig(), ethUsd: usd, model: { supply: P.SUPPLY.toString(), feePips: Number(P.FEE_PIPS), platformBps: Number(P.PLATFORM_BPS), minCapUsd: P.MIN_CAP_USD, maxCapUsd: P.MAX_CAP_USD, capPresets: P.CAP_PRESETS, tickSpacing: P.TICK_SPACING, tickEdge: P.TICK_EDGE }, modules: M.MODULE_INFO, pools: M.POOL_INFO }, { 'cache-control': 'public, max-age=10' });
  if (p === '/stats' && get) return json(res, 200, M.stats({ ethUsd: usd }), { 'cache-control': 'public, max-age=5' });
  if (p === '/coins' && get) return json(res, 200, { coins: M.listCoins({ ethUsd: usd }) }, { 'cache-control': 'public, max-age=5' });
  /* everything since the first launch; the platform pot read from the chain once a minute */
  if (p === '/alltime' && get) { let pot = null; if (!CONFIG.demo && chainReady() && CONFIG.fees) { try { if (!potCache || Date.now() - potCache.t > 60_000) potCache = { t: Date.now(), pot: await (await chain()).contracts.readPlatformPot() }; pot = potCache.pot.toString(); } catch {} } return json(res, 200, M.allTime({ ethUsd: usd, platformPot: pot }), { 'cache-control': 'public, max-age=15' }); }
  let m;
  /* the launch form asks whether a symbol is worn already: the coin it would go to, or null, always 200 */
  if (p === '/taken' && get) { const sym = String(url.searchParams.get('symbol') || '').trim().toLowerCase(); const c = /^[a-z0-9]{2,12}$/.test(sym) ? M.findCoin(sym) : null; return json(res, 200, { taken: c && c.symbol.toLowerCase() === sym ? { symbol: c.symbol, name: c.name, token: c.token, official: Boolean(M.standing(c).official) } : null }, { 'cache-control': 'public, max-age=5' }); }
  if ((m = p.match(/^\/coin\/([^/]+)$/)) && get) { const c = M.findCoin(decodeURIComponent(m[1])); if (!c) return bad(res, 'no such coin', 404);
    if (!CONFIG.demo && chainReady()) { try { const K = (await chain()).contracts; const st = await K.readPoolState(c); c.price = { sqrtP: st.sqrtP.toString(), tick: st.tick }; if (st.liquidity > 0n) c.liquidity = st.liquidity.toString(); if (st.rules) c.rules = { launchFee: st.rules.launchFee, sellFee: st.rules.sellFee, window: st.rules.window, start: st.rules.start, maxSwap: st.rules.maxSwap.toString() }; } catch {} }
    return json(res, 200, { coin: M.coinRow(c, { ethUsd: usd }), trades: M.tradesOf(c.token, 60), holders: M.holdersView(c.token, 25), payouts: M.payoutsOf(c.token, 30), burns: M.burnsOf(c.token, 50) }, { 'cache-control': 'public, max-age=3' }); }
  /* candles for the chart: ?tf=m1|m5|h1|d1, ?since=<unix time> for the tail only */
  if ((m = p.match(/^\/coin\/([^/]+)\/candles$/)) && get) { const c = M.findCoin(decodeURIComponent(m[1])); if (!c) return bad(res, 'no such coin', 404); const { candleRows } = await import('./eth/candles.mjs'); const tf = String(url.searchParams.get('tf') || 'm5'); const since = Number(url.searchParams.get('since') || 0); return json(res, 200, { token: c.token, tf, candles: candleRows(c.token, tf, { since, limit: Math.min(5000, Number(url.searchParams.get('limit') || 2000)) }), price: c.stats.lastPrice, at: c.stats.lastTradeAt }, { 'cache-control': 'public, max-age=3' }); }
  if ((m = p.match(/^\/coin\/([^/]+)\/trades$/)) && get) { const c = M.findCoin(decodeURIComponent(m[1])); if (!c) return bad(res, 'no such coin', 404); return json(res, 200, { trades: M.tradesOf(c.token, Math.min(500, Number(url.searchParams.get('limit') || 200))) }); }
  if ((m = p.match(/^\/coin\/([^/]+)\/holders$/)) && get) { const c = M.findCoin(decodeURIComponent(m[1])); if (!c) return bad(res, 'no such coin', 404); return json(res, 200, M.holdersView(c.token, Math.min(500, Number(url.searchParams.get('limit') || 100)))); }
  if (p === '/payouts' && get) return json(res, 200, { payouts: M.payoutsOf(url.searchParams.get('token') || '', 100) });
  if (p === '/mist/notes' && get) return json(res, 200, M.mistNotes(Number(url.searchParams.get('since') || 0), Math.min(5000, Math.max(1, Number(url.searchParams.get('limit') || 2000)))), { 'cache-control': 'public, max-age=5' });
  if (p === '/mist' && get) { let denominations = CONFIG.demo ? ['10000000000000000', '100000000000000000', '1000000000000000000'] : []; let relayer = ''; let setup = null; try { setup = (await import('./eth/mist.mjs')).SETUP; } catch {} if (!CONFIG.demo && chainReady() && CONFIG.mist) { try { const K = (await chain()).contracts; denominations = (await K.readMistDenominations()).map(String); relayer = (await chain()).chain.gardenerAddress(); } catch {} } return json(res, 200, { ...M.mistStats(), pool: CONFIG.mist, denominations, relayer, zk: setup ? { dev: setup.dev, constraints: setup.constraints, zkey: setup.zkey, verifier: setup.verifier, ptau: setup.dev ? '' : setup.ptau?.file || '', ok: (await mistArtifacts()).ok } : null }, { 'cache-control': 'public, max-age=5' }); }
  if (p === '/mist/quote' && get) { if (CONFIG.demo || !chainReady() || !CONFIG.mist) return bad(res, 'no relayer here', 503); let denom; try { denom = BigInt(url.searchParams.get('denom') || '0'); } catch { return bad(res, 'denom'); } if (denom <= 0n) return bad(res, 'denom'); try { const q = await (await chain()).mist.relayQuote(denom); return json(res, 200, { relayer: q.relayer, fee: q.fee.toString(), gasPrice: q.gasPrice.toString(), gas: q.gas.toString() }); } catch (e) { return bad(res, String(e.message), 502); } }
  if (p === '/mist/relay' && req.method === 'POST') { if (CONFIG.demo || !chainReady() || !CONFIG.mist) return bad(res, 'no relayer here', 503); if (!rate(req, 'relay', 10)) return bad(res, 'slow down', 429); let body; try { body = JSON.parse((await readBody(req, 50_000)).toString('utf8') || '{}'); } catch { return bad(res, 'json'); } if (!body?.proof || !Array.isArray(body?.publicSignals)) return bad(res, 'proof and publicSignals'); try { const r = await (await chain()).mist.relay({ proof: body.proof, publicSignals: body.publicSignals }); return json(res, 200, { hash: r.hash, block: r.block, recipient: r.recipient, denom: r.denom.toString(), fee: r.fee.toString() }); } catch (e) { return bad(res, String(e.message).slice(0, 200)); } }
  if (p === '/gardener' && get) {
    let pending = null; if (!CONFIG.demo) { try { const t = (await import('./eth/sender.mjs')).pendingTx(); if (t) pending = { label: t.label, nonce: t.nonce, hash: t.hashes.at(-1), hashes: t.hashes, sentAt: Math.floor(t.firstAt / 1000), bumps: t.bumps }; } catch {} }
    /* ?plan=1: what the gardener sees for every coin right now (reads only, kept for 30 s); null when there is no chain behind the site */
    let plan = undefined; if (url.searchParams.get('plan')) { plan = null; if (!CONFIG.demo && chainReady()) { try { if (!planCache || Date.now() - planCache.t > 30_000) planCache = { t: Date.now(), plan: await (await chain()).gardener.outlook() }; plan = planCache.plan; } catch (e) { plan = { error: String(e.message || e).slice(0, 200) }; } } }
    return json(res, 200, { enabled: CONFIG.gardenerEnabled, demo: CONFIG.demo, pending, ...(plan !== undefined ? { plan } : {}), log: CONFIG.demo ? [] : M.gardenerLog(Math.min(500, Number(url.searchParams.get('limit') || 50))) });
  }
  if (p === '/stocks' && get) { if (CONFIG.demo) { const { DEMO_STOCKS } = await import('./eth/demo.mjs'); return json(res, 200, { stocks: DEMO_STOCKS }); } const S = (await chain()).stocks; return json(res, 200, { stocks: S.listStocks() }); }
  if ((m = p.match(/^\/me\/(0x[a-fA-F0-9]{40})$/)) && get) { const v = M.walletView(m[1]); let claimable = '0'; const claimableStock = []; if (!CONFIG.demo && chainReady()) { try { const K = (await chain()).contracts; claimable = (await K.readClaimable(m[1])).toString(); v.mistKey = String(await K.readMistKey(m[1]).catch(() => v.mistKey) || '').toLowerCase().replace(/^0x$/, ''); const S = (await chain()).stocks; for (const st of S.listStocks()) { const a = await K.readClaimableStock(st.address, m[1]).catch(() => 0n); if (a > 0n) claimableStock.push({ stock: st.address, symbol: st.symbol, amount: a.toString() }); } } catch {} } return json(res, 200, { ...v, claimable, claimableStock }); }
  if (p === '/quote' && get) {
    const c = M.findCoin(url.searchParams.get('token') || ''); if (!c) return bad(res, 'no such coin', 404); const side = url.searchParams.get('side') === 'sell' ? 'sell' : 'buy'; let amount; try { amount = BigInt(url.searchParams.get('amount') || '0'); } catch { return bad(res, 'amount'); } if (amount <= 0n) return bad(res, 'amount');
    if (!CONFIG.demo && chainReady()) { try { const K = (await chain()).contracts; const st = await K.readPoolState(c); c.price = { sqrtP: st.sqrtP.toString(), tick: st.tick }; if (st.liquidity > 0n) c.liquidity = st.liquidity.toString(); if (st.rules) c.rules = { launchFee: st.rules.launchFee, sellFee: st.rules.sellFee, window: st.rules.window, start: st.rules.start, maxSwap: st.rules.maxSwap.toString() }; } catch {} }
    const pool = M.poolOf(c); const now = Math.floor(Date.now() / 1000); const fee = side === 'buy' ? (c.rules ? P.openingFee(c.rules, now - c.rules.start) : P.FEE_PIPS) : pool.sellFee;
    try { const q = side === 'buy' ? P.quoteBuy(pool, amount, fee) : P.quoteSell(pool, amount, fee); const capped = c.rules && side === 'buy' && now < c.rules.start + c.rules.window && BigInt(c.rules.maxSwap) > 0n && q.coinsOut > BigInt(c.rules.maxSwap); return json(res, 200, { side, feePips: Number(fee), out: (side === 'buy' ? q.coinsOut : q.ethOut).toString(), fee: q.fee.toString(), used: q.used.toString(), refund: q.refund.toString(), priceAfter: q.priceAfter.toString(), maxSwap: c.rules ? String(c.rules.maxSwap) : '0', overMax: Boolean(capped) }); } catch (e) { return bad(res, String(e.message)); }
  }

  if (p === '/meta' && req.method === 'POST') {
    if (!rate(req, 'meta', 20)) return bad(res, 'slow down', 429); let body; try { body = JSON.parse((await readBody(req, 20_000)).toString('utf8') || '{}'); } catch { return bad(res, 'json'); }
    let rec; try { rec = cleanMeta(body); } catch (e) { return bad(res, e.message); }
    /* a picture uploaded here and pinned is named by its cid in the record, so the record stands on its own wherever it is read */
    const own = rec.image.match(/^\/i\/([a-f0-9]{16,64})\.[a-z]+$/i)?.[1]; const pinnedImage = own ? loadImages()[own]?.cid : ''; if (pinnedImage) rec.image = `ipfs://${pinnedImage}`;
    const key = metaKey(rec); putMeta(key, rec); const hosted = `${publicBase(req)}/m/${key}.json`;
    if (!pinningEnabled()) return json(res, 200, { key, uri: hosted, meta: rec, pinned: false });
    try { const cid = await pinJson(rec, `halcyon-${rec.symbol.toLowerCase()}-${key.slice(0, 8)}`); putMeta(cid, rec); return json(res, 200, { key, uri: `ipfs://${cid}`, hosted, gateway: gatewayUrl(`ipfs://${cid}`), meta: rec, pinned: true }); }
    catch (e) { console.error(`[halcyon] pinning the metadata failed, hosting it instead: ${e.message}`); return json(res, 200, { key, uri: hosted, meta: rec, pinned: false, pinError: String(e.message).slice(0, 200) }); }
  }
  if (p === '/image' && req.method === 'POST') {
    if (!rate(req, 'image', 10)) return bad(res, 'slow down', 429); const ct = String(req.headers['content-type'] || ''); const mime = ct.split(';')[0].trim(); const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[mime]; if (!ext) return bad(res, 'png, jpg, webp, gif or svg');
    let buf; try { buf = await readBody(req, 1_100_000); } catch { return bad(res, 'at most 1 MB'); } if (!buf.length) return bad(res, 'empty');
    const key = createHash('sha256').update(buf).digest('hex').slice(0, 32); fs.mkdirSync(imageDir, { recursive: true }); fs.writeFileSync(path.join(imageDir, `${key}.${ext}`), buf); putImage(key, { ext });
    let cid = loadImages()[key]?.cid || '';
    if (pinningEnabled() && !cid) { try { cid = await pinFile(buf, `${key}.${ext}`, mime); putImage(key, { ext, cid }); } catch (e) { console.error(`[halcyon] pinning the picture failed, hosting it instead: ${e.message}`); } }
    return json(res, 200, { url: `/i/${key}.${ext}`, ipfs: cid ? `ipfs://${cid}` : '', gateway: cid ? gatewayUrl(`ipfs://${cid}`) : '', pinned: Boolean(cid) });
  }
  if (p === '/rpc' && req.method === 'POST') { if (CONFIG.demo || !chainReady()) return bad(res, 'no chain', 503); if (!rate(req, 'rpc', 240)) return bad(res, 'slow down', 429); let body; try { body = JSON.parse((await readBody(req, 50_000)).toString('utf8')); } catch { return bad(res, 'json'); } const calls = Array.isArray(body) ? body : [body]; if (calls.length > 10) return bad(res, 'batch'); const ALLOW = new Set(['eth_call', 'eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_estimateGas', 'eth_gasPrice', 'eth_feeHistory', 'eth_maxPriorityFeePerGas', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getCode', 'eth_getTransactionCount', 'eth_getBlockByNumber', 'net_version', 'eth_sendRawTransaction']); for (const c of calls) if (!ALLOW.has(c?.method)) return bad(res, `method ${c?.method} is not proxied`);
    /* a signed transaction is relayed as it is: nothing here can change or read into it, and it is rate limited apart */ if (calls.some(c => c?.method === 'eth_sendRawTransaction') && !rate(req, 'send', 30)) return bad(res, 'slow down', 429);
    const upstream = CONFIG.rpcUrls[0]; const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Array.isArray(body) ? calls : calls[0]), signal: AbortSignal.timeout(20_000) }).catch(() => null); if (!r) return bad(res, 'upstream', 502); const out = await r.text(); res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(out); }
  return bad(res, 'not found', 404);
}

function serveFile(res, file, cache = 'public, max-age=3600') { let st; try { st = fs.statSync(file); } catch { return false; } if (!st.isFile()) return false; res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': cache }); fs.createReadStream(file).pipe(res); return true; }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); res.setHeader('x-content-type-options', 'nosniff');
  try {
    if (url.pathname === '/healthz') return text(res, 200, 'ok');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let m;
    if ((m = url.pathname.match(/^\/m\/([a-f0-9]{16,64})\.json$/))) { const rec = loadMeta()[m[1]]; if (!rec) return bad(res, 'no such metadata', 404); return json(res, 200, rec, { 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' }); }
    if ((m = url.pathname.match(/^\/i\/([a-f0-9]{16,64}\.(png|jpe?g|webp|gif|svg))$/))) { if (serveFile(res, path.join(imageDir, m[1]), 'public, max-age=31536000, immutable')) return; return bad(res, 'no such image', 404); }
    const safe = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (safe !== '/' && (serveFile(res, path.join(dist, safe)) || serveFile(res, path.join(publicDir, safe)))) return;
    if (serveFile(res, path.join(dist, 'index.html'), 'no-cache')) return;
    return text(res, 503, 'The site is not built yet: npm run build');
  } catch (e) { console.error(e); return bad(res, 'server error', 500); }
});

async function main() {
  ensureDataDir(); loadState();
  if (CONFIG.demo) { const { loadDemo } = await import('./eth/demo.mjs'); loadDemo(); console.log(`[halcyon] demo state: ${Object.keys(loadState().coins).length} coins`); }
  else if (chainReady()) { const K = await chain(); K.indexer.startIndexer({ log: console.log }); if (CONFIG.gardenerEnabled || process.env.HALCYON_GARDENER_DRY === '1') K.gardener.startGardener({ log: console.log }); console.log(`[halcyon] ${chainInfo().name}: launchpad ${CONFIG.launchpad}, fees ${CONFIG.fees}, gardener ${CONFIG.gardenerEnabled ? 'on' : process.env.HALCYON_GARDENER_DRY === '1' ? 'dry' : 'off'}`);
    const z = await mistArtifacts(); console.log(z.ok ? `[halcyon] mist circuit: ${z.setup.dev ? 'DEVELOPMENT setup' : `setup on ${z.setup.ptau.file}`}, the artifacts agree${z.record ? ' with the deployment record' : ''}` : `[halcyon] MIST CIRCUIT PROBLEM: ${z.problems.join('; ')}`); }
  else console.log('[halcyon] no chain configured (ETH_RPC_URL, HALCYON_LAUNCHPAD, HALCYON_FEES): serving the site and the index on disk only');
  console.log(`[halcyon] coin metadata: ${pinningSummary()}`);
  if (!CONFIG.demo) setInterval(() => { try { const referenced = new Set(Object.values(loadState().coins || {}).map(c => keyOfUri(c.uri)).filter(Boolean)); const r = sweep({ referenced, imageDir }); if (r.dropped || r.images) console.log(`[halcyon] swept ${r.dropped} unreferenced metadata records and ${r.images} pictures`); } catch (e) { console.error(`[halcyon] sweep failed: ${e.message}`); } }, 3_600_000).unref();
  server.listen(CONFIG.port, () => console.log(`[halcyon] listening on ${CONFIG.port}`));
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
export { server, api };
