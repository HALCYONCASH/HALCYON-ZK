// The operator's stock registry. The Harvest module can only buy tokens the platform wallet has allowed on chain (HalcyonFees.setStockAllowed)
// and that this registry has a route for: a Uniswap v3 path from WETH (`buyStock`) or Uniswap v4 hops from ETH or WETH (`buyStockV4`).
// This script keeps the registry (DATA_DIR/halcyon-stocks.json, the same file the server reads; it starts from eth/stocks-seed.json for
// the chain) and prints the calldata the platform wallet sends; it never holds a key.
//   node scripts/stocks.mjs list
//   node scripts/stocks.mjs seed                     (put the chain's seed list back into the registry, keeping what you added)
//   node scripts/stocks.mjs bake                     (the other way: write the registry into eth/stocks-seed.json, so a fresh host starts with your routes)
//   node scripts/stocks.mjs add 0xSTOCK --path 0xWETH,fee,[0xMID,fee,]0xSTOCK        (a v3 route)
//   node scripts/stocks.mjs add 0xSTOCK --v4 eth|weth,0xCURRENCY:fee:spacing[:0xHOOKS],...,0xSTOCK:fee:spacing[:0xHOOKS]   (a v4 route)
//       [--symbol NVDAon --name "NVIDIA (Ondo Tokenized)" --decimals 18 --issuer "Ondo Stocks" --logo https://… --category stock|etf|commodity --note "…"]
//   node scripts/stocks.mjs remove 0xSTOCK
//   node scripts/stocks.mjs quote 0xSTOCK 0.1          (what 0.1 ETH buys through the registered route right now, via the v3 or v4 quoter)
//   node scripts/stocks.mjs calldata 0xSTOCK [--deny]  (the setStockAllowed calldata for the platform wallet)
//   node scripts/stocks.mjs calldata --routed [--deny] (one setStocksAllowed calldata for every routed stock in the registry, and the array for an explorer's form)
//   node scripts/stocks.mjs allow --routed | 0xSTOCK... [--deny] [--go]   (send it as the platform wallet, from HALCYON_PLATFORM_KEY in .env; dry unless --go)
//   node scripts/stocks.mjs import --ondo | --file tokenlist.json | --file catalog.csv   (every stock token of the issuer's official list, routes kept)
//   node scripts/stocks.mjs catch [0xSTOCK | --all] [--probe 0.05] [--max-impact 3] [--go] [--quiet]
//       (ask the chain itself where a stock trades: the v3 factory's pools against WETH, USDC and USDT, and every v4 pool the
//        PoolManager ever opened with the stock on either side, from its Initialize log. Each pool with liquidity gets a route from
//        ETH and a quote for --probe ETH; the pool that gives the most stock wins when the probe moves its price at most --max-impact
//        percent; --go records the route, otherwise it only prints what it would do; --quiet skips the stocks with no pool at all)
//   node scripts/stocks.mjs discover [0xSTOCK | --all] [--min-usd 50000] [--probe 0.05] [--max-impact 3] [--go] [--from pairs.json] [--quiet]
//       (the same from DexScreener's pair list: the deepest Uniswap v3 or v4 pool over the floor that a route from ETH can reach)
// `add` reads name, symbol and decimals from the chain when ETH_RPC_URL is set and they are not given. A v3 path is weth,fee,(mid,fee)*,stock
// with fees in hundredths of a bip (500, 3000, 10000); a v4 route starts at eth or weth and names each pool's far currency, fee and tick
// spacing (and hooks, when the pool has them). A stock with no route is listed on the site as "no route yet" and never bought.
import fs from 'node:fs';
import { formatUnits, parseEther, getAddress } from 'viem';
import { CONFIG, chainInfo, ensureDataDir } from '../eth/config.mjs';
import { loadRegistry, saveRegistry, upsertStock, encodePath, routeOf, describeToken, quoteStock, listStocks, SEED, parseIssuerList, discoverRoute, catchRoute, routeFields, describeRoute, describePools, describeV4, describeV3, hopOf, ONDO_TOKEN_LIST, ZERO } from '../eth/stocks.mjs';
import { calldata } from '../eth/contracts.mjs';
import { low, isAddress } from '../eth/chain.mjs';

const argv = process.argv.slice(2); const cmd = argv[0] || 'list';
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = name => argv.includes(`--${name}`);
ensureDataDir();
const out = m => fs.writeSync(1, `${m}\n`); /* synchronous: Windows drops piped console output on exit */
const fail = m => { fs.writeSync(2, `${m}\n`); process.exit(2); };
const allowLine = address => `allow it on chain from the platform wallet ${CONFIG.platform || '(HALCYON_PLATFORM)'}:\n  to:   ${CONFIG.fees || '(HALCYON_FEES)'}\n  data: ${calldata.setStockAllowed(getAddress(address), true)}`;
const pause = ms => new Promise(r => setTimeout(r, ms));
/** The stocks a search runs over: one address, or every registry row without a route; a row the registry cannot name is read from the chain. */
const targetsOf = async () => { const list = has('all') ? loadRegistry().filter(x => !routeOf(x.address)) : [argv[1]].filter(a => isAddress(a)).map(a => loadRegistry().find(x => low(x.address) === low(a)) || { address: low(a), symbol: '' }); for (const t of list) if ((!t.symbol || t.symbol === '?') && CONFIG.rpcUrls.length) { try { const d = await describeToken(t.address); Object.assign(t, { symbol: d.symbol, name: t.name || d.name, decimals: t.decimals || d.decimals }); } catch { t.symbol = t.symbol || '?'; } } return list; };
const routeLine = (t, d, probe) => `${t.symbol} ${t.address}: ${describeRoute(d)}; ${formatUnits(probe, 18)} ETH buys about ${formatUnits(d.quote, Number(t.decimals || 18))} through ${d.kind === 'v4' ? describeV4(d.from, d.hops, { [low(t.address)]: t.symbol }) : describeV3(d.route, { [low(t.address)]: t.symbol })}`;
const recordRoute = (t, d, source) => { const f = routeFields(d, source); const row = { ...t, address: getAddress(t.address), discovered: new Date().toISOString().slice(0, 10) }; delete row.path; delete row.v4; if (f.path) row.path = f.path; if (f.v4) row.v4 = f.v4; row.note = f.note; upsertStock(row); out(`  recorded; ${allowLine(t.address)}`); };

if (cmd === 'list') {
  const rows = listStocks(); if (!rows.length) { out('no stocks in the registry and none allowed on chain (as far as the indexer has seen)'); process.exit(0); }
  for (const r of rows) out(`${r.allowed ? 'allowed ' : 'pending '} ${r.routed ? `${r.via}      ` : 'no route'} ${r.address} ${r.symbol || '?'} ${r.name || ''} (${r.decimals} dec)${r.issuer ? ` by ${r.issuer}` : ''}${r.logo ? ' logo' : ''}`);
} else if (cmd === 'seed') {
  const seed = SEED[String(CONFIG.chainId)] || []; if (!seed.length) fail(`no seed list for chain ${CONFIG.chainId}`);
  const list = loadRegistry(); let added = 0; for (const s of seed) if (!list.some(x => low(x.address) === low(s.address))) { list.push({ ...s, address: low(s.address), seeded: true }); added++; }
  saveRegistry(list); out(`${added} seeded, ${list.length} in the registry`);
} else if (cmd === 'add') {
  const address = argv[1]; if (!isAddress(address)) fail('add needs the stock token address');
  const pathArg = opt('path'), v4Arg = opt('v4'); if (!pathArg && !v4Arg) fail('--path weth,fee,...,stock (v3) or --v4 eth|weth,currency:fee:spacing,...,stock:fee:spacing (v4) is required');
  const weth = chainInfo().uniswap.weth; let hops = null, v4 = null, howMany = '';
  if (pathArg) {
    hops = pathArg.split(',').map(s => s.trim()).filter(Boolean);
    if (weth && low(hops[0]) !== low(weth)) fail(`the path must start at WETH ${weth}`); if (low(hops[hops.length - 1]) !== low(address)) fail('the path must end at the stock');
    const bytes = encodePath(hops); howMany = `a ${(hops.length - 1) / 2}-hop v3 route (${bytes.length / 2 - 1} bytes)`;
  } else {
    const parts = v4Arg.split(',').map(s => s.trim()).filter(Boolean); const start = parts.shift(); if (!['eth', 'weth'].includes(String(start).toLowerCase())) fail('a v4 route starts with eth or weth');
    if (start.toLowerCase() === 'weth' && !weth) fail('this chain has no WETH in its configuration');
    const parsed = parts.map(p => { const [currency, fee, tickSpacing, hooks] = p.split(':'); if (!isAddress(currency) || !fee || !tickSpacing) fail(`a v4 hop is 0xCURRENCY:fee:tickSpacing[:0xHOOKS], not ${p}`); if (hooks && !isAddress(hooks)) fail(`hooks must be an address, not ${hooks}`); return hopOf({ currency, fee, tickSpacing, hooks: hooks || ZERO }); });
    if (!parsed.length || low(parsed[parsed.length - 1].currency) !== low(address)) fail('the v4 route must end at the stock');
    v4 = { from: start.toLowerCase() === 'eth' ? ZERO : getAddress(weth), hops: parsed }; howMany = `a ${parsed.length}-hop v4 route from ${start.toUpperCase()}`;
  }
  const prior = loadRegistry().find(x => low(x.address) === low(address)) || {};
  let name = opt('name') || prior.name, symbol = opt('symbol') || prior.symbol, decimals = opt('decimals') || prior.decimals;
  if ((!name || !symbol || !decimals) && CONFIG.rpcUrls.length) { try { const d = await describeToken(address); name = name || d.name; symbol = symbol || d.symbol; decimals = decimals || String(d.decimals); } catch (e) { out(`could not read the token from the chain (${String(e.message || e).split('\n')[0]}); give --symbol, --name and --decimals`); } }
  if (!symbol) fail('--symbol is required when the token cannot be read from the chain');
  const row = { ...prior, address: getAddress(address), symbol, name: name || symbol, decimals: Number(decimals || 18), issuer: opt('issuer') || prior.issuer || '', logo: opt('logo') || prior.logo || '', category: opt('category') || prior.category || 'stock', note: opt('note') || prior.note || '', addedAt: new Date().toISOString() };
  delete row.path; delete row.v4; if (hops) row.path = hops.map((h, i) => (i % 2 ? Number(h) : getAddress(h))); if (v4) row.v4 = v4;
  upsertStock(row); const route = routeOf(address); if (!route) fail('the route did not register (a malformed hop?)');
  out(`registered ${row.symbol} ${row.address} with ${howMany}: ${route.label}${row.logo ? ', with a logo' : ', no logo (add --logo)'}`);
  out(allowLine(address));
} else if (cmd === 'bake') {
  // the registry becomes the chain's seed list, so a fresh DATA_DIR (a new host, a new disk) starts with every route found here
  const list = loadRegistry(); const file = new URL('../eth/stocks-seed.json', import.meta.url); const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = list.map(({ seeded, imported, addedAt, ...r }) => r).sort((a, b) => Number(Boolean(routeOf(b.address))) - Number(Boolean(routeOf(a.address))) || String(a.symbol).localeCompare(String(b.symbol)));
  seed[String(CONFIG.chainId)] = rows; fs.writeFileSync(file, JSON.stringify(seed, null, 1) + '\n');
  out(`${rows.length} stocks baked into eth/stocks-seed.json for chain ${CONFIG.chainId}, ${rows.filter(x => routeOf(x.address)).length} with a route; a server with a fresh DATA_DIR starts from them (commit the file)`);
} else if (cmd === 'remove') {
  const address = argv[1]; if (!isAddress(address)) fail('remove needs the stock token address');
  const before = loadRegistry().length; saveRegistry(loadRegistry().filter(x => low(x.address) !== low(address)));
  out(before === loadRegistry().length ? 'not in the registry' : `removed ${address} from the registry; to deny it on chain send from the platform wallet:\n  to:   ${CONFIG.fees || '(HALCYON_FEES)'}\n  data: ${calldata.setStockAllowed(getAddress(address), false)}`);
} else if (cmd === 'quote') {
  const address = argv[1]; if (!isAddress(address)) fail('quote needs the stock token address'); const ethIn = parseEther(argv[2] || '0.1');
  const route = routeOf(address); if (!route) fail('no route in the registry for that stock (add it first)'); if (!CONFIG.rpcUrls.length) fail('ETH_RPC_URL is needed to quote');
  const got = await quoteStock(route, ethIn); out(got ? `${formatUnits(ethIn, 18)} ETH buys about ${formatUnits(got, route.decimals)} ${route.symbol} through Uniswap ${route.kind}: ${route.label}` : `the ${route.kind} quoter returned nothing: the route has no liquidity, or this chain has no quoter for it`);
} else if (cmd === 'allow') {
  // send setStocksAllowed as the platform wallet, from HALCYON_PLATFORM_KEY in .env: every routed stock, or the addresses given; dry unless --go
  const given = argv.slice(1).filter(a => isAddress(a)); const routed = has('routed') ? loadRegistry().filter(x => routeOf(x.address)) : [];
  const targets = [...new Map([...routed.map(x => [low(x.address), x]), ...given.map(a => [low(a), loadRegistry().find(x => low(x.address) === low(a)) || { address: low(a), symbol: '?' }])]).values()].sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
  if (!targets.length) fail('allow needs --routed (every routed stock in the registry) or stock addresses; --deny takes them back, --go sends');
  if (!CONFIG.rpcUrls.length) fail('ETH_RPC_URL is needed');
  const { sendAsPlatform } = await import('../eth/platform.mjs'); const allowed = !has('deny');
  out(`setStocksAllowed(${targets.length} stock${targets.length > 1 ? 's' : ''}, ${allowed}): ${targets.map(x => x.symbol || x.address).join(', ')}`);
  try { await sendAsPlatform({ data: calldata.setStocksAllowed(targets.map(x => getAddress(x.address)), allowed), label: `setStocksAllowed(${targets.length}, ${allowed})`, go: has('go'), log: out }); } catch (e) { fail(String(e.message || e)); }
  if (has('go')) out(`done: ${targets.length} stock${targets.length > 1 ? 's' : ''} ${allowed ? 'allowed' : 'denied'} on chain; the site shows them as ${allowed ? 'ready' : 'not allowed'} once the indexer sees the block`);
} else if (cmd === 'calldata') {
  if (has('routed')) {
    const routed = loadRegistry().filter(x => routeOf(x.address)).sort((a, b) => String(a.symbol).localeCompare(String(b.symbol))); if (!routed.length) fail('no routed stock in the registry');
    out(`setStocksAllowed([${routed.length} stocks], ${!has('deny')}) from the platform wallet, one transaction: ${routed.map(x => x.symbol || x.address).join(', ')}\n  to:   ${CONFIG.fees || '(HALCYON_FEES)'}\n  data: ${calldata.setStocksAllowed(routed.map(x => getAddress(x.address)), !has('deny'))}`);
    out(`for an explorer's form (setStocksAllowed: stocks, allowed):\n  stocks:  ${JSON.stringify(routed.map(x => getAddress(x.address)))}\n  allowed: ${!has('deny')}`);
  } else {
    const address = argv[1]; if (!isAddress(address)) fail('calldata needs the stock token address, or --routed for every routed stock in one transaction');
    out(`setStockAllowed(${getAddress(address)}, ${!has('deny')}) from the platform wallet ${CONFIG.platform || '(HALCYON_PLATFORM)'}:\n  to:   ${CONFIG.fees || '(HALCYON_FEES)'}\n  data: ${calldata.setStockAllowed(getAddress(address), !has('deny'))}`);
  }
} else if (cmd === 'import') {
  let text; let source;
  if (has('ondo')) { source = ONDO_TOKEN_LIST; const r = await fetch(ONDO_TOKEN_LIST).catch(e => { fail(`could not fetch the issuer's list: ${e.message}`); }); if (!r.ok) fail(`the issuer's list answered ${r.status}`); text = await r.text(); }
  else if (opt('file')) { source = opt('file'); text = fs.readFileSync(source, 'utf8'); }
  else fail('import needs --ondo (the issuer\'s official token list from GitHub) or --file <tokenlist.json | catalog.csv>');
  const tokens = parseIssuerList(text); if (!tokens.length) fail('no stock tokens for this chain in that list');
  const list = loadRegistry(); let added = 0, updated = 0;
  for (const t of tokens) { const i = list.findIndex(x => low(x.address) === low(t.address)); if (i < 0) { list.push({ ...t, address: low(t.address), imported: source }); added++; } else { const prior = list[i]; list[i] = { ...prior, symbol: prior.symbol || t.symbol, name: prior.name || t.name, decimals: prior.decimals || t.decimals, logo: prior.logo || t.logo, issuer: prior.issuer || t.issuer, category: prior.category || t.category }; updated++; } }
  saveRegistry(list); out(`${tokens.length} stock tokens in the list: ${added} added, ${updated} already in the registry (routes kept), ${list.length} in the registry now; ${list.filter(x => routeOf(x.address)).length} with a route`);
} else if (cmd === 'catch') {
  const probe = parseEther(opt('probe') || '0.05'); const maxImpact = Number(opt('max-impact') || 3) / 100; const go = has('go'); const quiet = has('quiet');
  const targets = await targetsOf(); if (!targets.length) fail('catch needs a stock address, or --all for every stock without a route');
  if (!CONFIG.rpcUrls.length) fail('ETH_RPC_URL is needed: the pools come from the v3 factory and the PoolManager\'s log, the quotes from the quoters');
  if (!chainInfo().uniswap.stateView || !chainInfo().uniswap.v4Quoter) out('this chain has no v4 state view or quoter configured: only v3 pools can be found');
  let found = 0, none = 0, empty = 0, thin = 0, other = 0, failed = 0; const calls = { n: 0 }; const t0 = Date.now();
  for (const t of targets) {
    let d; try { d = await catchRoute(t.address, { probe, maxImpact, calls }); } catch (e) { failed++; const m = String(e.message || e).split('\n')[0]; out(`${t.symbol} ${t.address}: ${m}${/range|limit|too many|exceed|10000/i.test(m) ? ' (this RPC limits log queries; Alchemy, Infura or QuickNode answer a query on an indexed topic over the whole range in one call)' : ''}`); continue; }
    if (!d.quote) { if (/^no pool/.test(d.reason)) none++; else if (/none with liquidity/.test(d.reason)) empty++; else if (/over the .* ceiling/.test(d.reason)) thin++; else other++; if (!(quiet && /^no pool/.test(d.reason))) out(`${t.symbol} ${t.address}: ${d.reason}`); continue; }
    found++; out(routeLine(t, d, probe) + (d.pools.length > 1 ? ` (pools seen: ${describePools(d.pools, { [low(t.address)]: t.symbol })})` : ''));
    if (go) recordRoute(t, d, 'PoolManager');
    if (has('all')) await pause(100);
  }
  out(`${found} of ${targets.length} with a pool a route can buy through${go ? ', recorded' : found ? ' (add --go to record them)' : ''}; ${none} with no pool on Uniswap at all, ${empty} with pools but no liquidity in them, ${thin} over the ${(maxImpact * 100).toFixed(1)}% impact ceiling, ${other} with liquidity but no way from ETH${failed ? `, ${failed} the RPC did not answer` : ''} (${calls.n} log queries, ${Math.round((Date.now() - t0) / 1000)} s)`);
} else if (cmd === 'discover') {
  const minUsd = Number(opt('min-usd') || 50_000); const probe = parseEther(opt('probe') || '0.05'); const maxImpact = Number(opt('max-impact') || 3) / 100; const go = has('go'); const from = opt('from');
  const targets = await targetsOf(); if (!targets.length) fail('discover needs a stock address, or --all for every stock without a route');
  if (!CONFIG.rpcUrls.length) fail('ETH_RPC_URL is needed: the pools are confirmed on the chain and quoted through the quoters');
  const pairsOf = async address => { if (from) { const all = JSON.parse(fs.readFileSync(from, 'utf8')); return Array.isArray(all) ? all : all[low(address)] || all.pairs || []; } const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/ethereum/${address}`, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`DexScreener answered ${r.status}`); return r.json(); };
  let found = 0, none = 0, other = 0, thin = 0, failed = 0; const quiet = has('quiet');
  for (const t of targets) {
    let pairs; try { pairs = await pairsOf(t.address); } catch (e) { failed++; out(`${t.symbol} ${t.address}: ${e.message}`); if (has('all') && !from) await pause(1000); continue; }
    const d = await discoverRoute(t.address, pairs, { minUsd, probe, maxImpact });
    if (!d.quote) { const noPairs = /no pairs on any DEX/.test(d.reason); if (noPairs) none++; else if (/under the .* floor/.test(d.reason)) thin++; else other++; if (!(quiet && noPairs)) out(`${t.symbol} ${t.address}: ${d.reason}`); if (has('all') && !from) await pause(250); continue; }
    found++; out(routeLine(t, d, probe));
    if (go) recordRoute(t, d, 'DexScreener');
    if (has('all') && !from) await pause(250);
  }
  out(`${found} of ${targets.length} with a usable pool${go ? ', recorded' : found ? ' (add --go to record them)' : ''}; ${none} with no pairs on any DEX, ${other} with pairs but no Uniswap way from ETH, ${thin} under the floor${failed ? `, ${failed} not answered by the indexer` : ''}`);
} else fail(`unknown command ${cmd}: list | seed | bake | add | remove | quote | calldata | allow | import | catch | discover`);
