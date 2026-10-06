// The server side on the in-process EVM: the indexer reads what the contracts and the pools emitted, the gardener does what is due
// (collect, pay holders, rings weights, prune, harvest, clover draws, mist rounds) and the API rows say what happened. Then the pure pieces
// and the demo server over HTTP.   npm run test:modules
process.env.HALCYON_NO_DOTENV = '1'; /* the tests never read a developer's .env */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseEther, parseGwei, formatEther, getAddress, encodePacked, toHex, decodeEventLog } from 'viem';
import { hardhat } from 'viem/chains';
import { boot, deployHalcyon, ERC20_ABI, encodePath } from './helpers/evm.mjs';
import * as P from '../shared/pool.mjs';
import * as MI from '../shared/mist.mjs';
import * as snarkjs from 'snarkjs';
import { privateKeyToAccount } from 'viem/accounts';
const SETUP = JSON.parse(fs.readFileSync(new URL('../zk/setup.json', import.meta.url), 'utf8')); /* the circuit setup the build left: development, or a public ceremony's */

let n = 0; const ok = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-test-')); process.env.DATA_DIR = tmp; process.env.CHAIN_ID = '31337'; process.env.HALCYON_GARDENER_ENABLED = '1'; process.env.HALCYON_COLLECT_MIN_ETH = '0.001'; process.env.HALCYON_PAYOUT_MIN_ETH = '0.001'; process.env.HALCYON_PAYOUT_MIN_SHARE_ETH = '0'; process.env.HALCYON_CONFIRMATIONS = '0'; process.env.HALCYON_GAS_CAP_GWEI = '1000'; process.env.HALCYON_STOCK_MAX_BUY_ETH = '100'; process.env.HALCYON_PAYOUT_MAX_GAS_PCT = '1000'; /* test-sized pots: the gas policy would skip them */
const { CONFIG, CHAINS } = await import('../eth/config.mjs'); const chainMod = await import('../eth/chain.mjs'); const K = await import('../eth/contracts.mjs'); const I = await import('../eth/indexer.mjs'); const KP = await import('../eth/gardener.mjs'); const M = await import('../eth/markets.mjs'); const S = await import('../eth/store.mjs'); const ST = await import('../eth/stocks.mjs');

const chain = await boot({ ethUsd: 3000 }); const [deployer, platform, gardener, alice, bob, carol, dave] = chain.accounts; const H = await deployHalcyon(chain, { platform, gardener });
Object.assign(CONFIG, { launchpad: H.pad.address, fees: H.fees.address, tokenImpl: H.impl.address, locker: H.locker.address, v4Locker: H.v4Locker.address, hook: H.hook.address, swap: H.swap.address, mist: H.mist.address, deployBlock: 1 });
Object.assign(CHAINS[31337].uniswap, { weth: chain.weth.address, v3Factory: chain.factory.address, nfpm: chain.nfpm.address, swapRouter02: chain.router.address, quoterV2: chain.quoter.address, poolManager: chain.poolManager.address, v4Quoter: chain.v4Quoter.address, stateView: chain.stateView.address }); CHAINS[31337].ethUsdFeed = chain.feed.address;
chainMod.useProvider(chain.provider, hardhat); chainMod.useGardener(gardener);
const { write, read, mine } = chain; const ZERO = '0x0000000000000000000000000000000000000000'; const DEADLINE = 2n ** 40n; const quiet = () => {};
let salt = 0; const v3Salt = async sender => { for (let i = ++salt * 100; i < salt * 100 + 64; i++) { const s = toHex(i, { size: 32 }); if ((await read(H.pad, 'predict', [sender, s])).toLowerCase() < chain.weth.address.toLowerCase()) return s; } throw new Error('salt'); };
const params = async (sender, o = {}) => ({ name: 'Lamp', symbol: 'LAMP', uri: 'meta:lamp', pool: 0, startCapUsd: 5000, module: 1, stock: ZERO, salt: o.pool === 1 ? toHex(++salt, { size: 32 }) : await v3Salt(sender), splitTo: [], splitBps: [], launchFee: 0, sellFee: 10000, window: 0, maxSwapBps: 0, minOut: 0n, ...o });
const tokenOf = rc => { for (const l of rc.logs) { try { const e = decodeEventLog({ abi: H.pad.abi, data: l.data, topics: l.topics }); if (e.eventName === 'Launched') return getAddress(e.args.token); } catch {} } throw new Error('no launch'); };
const buyV3 = (who, token, eth) => write(who, chain.router, 'exactInputSingle', [{ tokenIn: chain.weth.address, tokenOut: token, fee: 10000, recipient: who, amountIn: eth, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }], eth);
const buyV4 = async (who, token, eth) => write(who, H.swap, 'buy', [await read(H.fees, 'poolKey', [token]), 0n, who, DEADLINE], eth);
const tick = () => KP.tick({ dry: false, log: quiet });

let lamp, king, tideToken;
await ok('the indexer reads launches, pool trades and holders from the chain into the state, for a v3 and a v4 coin; the API row carries the price, the cap and the fees', async () => {
  lamp = tokenOf(await write(alice, H.pad, 'launch', [await params(alice)], parseEther('0.2'))); king = tokenOf(await write(bob, H.pad, 'launch', [await params(bob, { name: 'Kingfisher', symbol: 'KING', pool: 1, startCapUsd: 7000, launchFee: 400000, sellFee: 20000, window: 300, maxSwapBps: 500 })]));
  await buyV3(carol, lamp, parseEther('0.3')); await buyV3(bob, lamp, parseEther('0.1')); await buyV4(carol, king, parseEther('0.05')); await buyV4(dave, king, parseEther('0.02'));
  const r = await I.indexOnce(); assert.ok(r.ranges >= 1); const s = S.loadState(); assert.equal(Object.keys(s.coins).length, 2);
  const c = s.coins[lamp.toLowerCase()]; assert.equal(c.symbol, 'LAMP'); assert.equal(c.module, 1); assert.equal(c.pool, 0); assert.equal(c.creator, alice.toLowerCase()); assert.equal(c.startCapUsd, 5000); assert.ok(c.v3Pool); assert.equal(c.tokenId !== '0', true, 'the locked position id came from the locker');
  assert.equal(s.trades[lamp.toLowerCase()].length, 3, 'the founder buy and two buys'); assert.ok(s.trades[lamp.toLowerCase()].every(t => t.buy)); assert.equal(s.trades[lamp.toLowerCase()][1].trader, carol.toLowerCase(), 'the trader is the transaction sender, not the router');
  const st = await K.readPoolState(c); assert.equal(c.price.sqrtP, st.sqrtP.toString()); assert.equal(c.stats.lastPrice, P.price(st).toString()); assert.equal(c.liquidity, st.liquidity.toString());
  const holders = I.holdersOf(s, lamp.toLowerCase()); assert.equal(holders.length, 3); assert.equal(holders[0].balance, (await K.readBalance(lamp, getAddress(holders[0].address))).toString()); assert.ok(holders.every(h => h.since > 0)); assert.equal(c.stats.holders, 3);
  const row = M.coinRow(c, { ethUsd: 3000 }); assert.equal(row.module, 'rain'); assert.equal(row.poolInfo.name, 'Standard'); assert.ok(row.marketCapUsd > 5000 && row.marketCapUsd < 20000, `cap ${row.marketCapUsd}`); assert.ok(row.progress > 0 && row.progress < 0.5); assert.equal(row.stats.founderEth, parseEther('0.2').toString());
  const k = s.coins[king.toLowerCase()]; assert.equal(k.pool, 1); assert.ok(k.poolId); assert.equal(s.trades[king.toLowerCase()].length, 2); assert.ok(s.trades[king.toLowerCase()][0].feePips > 300000, 'the opening fee is in the trade'); const krow = M.coinRow(k, { ethUsd: 3000 }); assert.equal(krow.poolInfo.name, 'Rules');
  assert.equal(c.fees.received, '0', 'nothing collected yet');
});

await ok('the gardener collects the fees of both pools and pays holders; every action lands in the ledger and the index follows', async () => {
  const t1 = await tick(); const collects = t1.done.filter(x => x.kind === 'collect'); assert.equal(collects.length, 2, `two collects in ${t1.done.map(x => x.kind)}`); assert.ok(collects.every(x => x.hash && !x.error));
  assert.ok((await K.readCoin(lamp)).pot > 0n, 'the pot filled'); const t1b = await tick(); const pays = [...t1.done, ...t1b.done].filter(x => x.kind === 'payHolders'); assert.equal(pays.length, 2, 'the next tick pays both pots'); assert.ok(pays.every(p => p.results[0].hash)); assert.ok((await K.readCoin(lamp)).pot < 1000n, 'only rounding dust stays');
  await I.indexOnce(); const s = S.loadState(); const c = s.coins[lamp.toLowerCase()]; assert.ok(BigInt(c.fees.received) > 0n); assert.equal(c.fees.collected, c.fees.received); assert.ok(BigInt(c.fees.pot) < 1000n); assert.equal(BigInt(c.fees.platform), BigInt(c.fees.received) * 2000n / 10000n);
  const payouts = s.payouts.filter(p => p.kind === 'rain'); assert.equal(payouts.length, 2); assert.equal(payouts.find(p => p.token === lamp.toLowerCase()).total, pays.find(p => p.token === lamp.toLowerCase()).total);
  assert.equal(S.loadLedger().filter(x => x.kind === 'collect').length, 2); const t2 = await tick(); assert.equal(t2.done.length, 0, 'nothing due');
});

await ok('rings: the gardener weighs balance by days held, a month at most; clover: it opens a draw, waits for the block and pays the holder the hash draws; the index records both', async () => {
  const gem = tokenOf(await write(alice, H.pad, 'launch', [await params(alice, { symbol: 'GEM', module: 6 })])); await buyV3(bob, gem, parseEther('0.4')); await buyV3(carol, gem, parseEther('0.4')); await I.indexOnce();
  const s = S.loadState(); const since = s.since[gem.toLowerCase()]; since[bob.toLowerCase()] -= 40 * 86_400; /* bob has held for forty days (capped at thirty), carol since today */ S.saveState();
  await tick(); const t1 = await tick(); const paid = t1.done.find(x => x.kind === 'payHolders' && x.token === gem.toLowerCase()); assert.ok(paid && /rings/.test(paid.label), JSON.stringify(t1.done));
  const bobShare = BigInt(paid.results[0].total) > 0n ? null : null; void bobShare; const w = KP.ringsWeight(Math.floor(Date.now() / 1000)); const hb = I.holdersOf(s, gem.toLowerCase()).find(h => h.address === bob.toLowerCase()); const hc = I.holdersOf(s, gem.toLowerCase()).find(h => h.address === carol.toLowerCase());
  assert.ok(w(hb) > w(hc) * 20n && w(hb) <= w(hc) * 30n * 2n, 'bob weighs about thirty times carol for about the same bag');
  await I.indexOnce(); assert.ok(S.loadState().payouts.some(p => p.kind === 'rings' && p.token === gem.toLowerCase()));
  const luck = tokenOf(await write(bob, H.pad, 'launch', [await params(bob, { symbol: 'LUCK', module: 5, pool: 1 })])); await buyV4(carol, luck, parseEther('0.5')); await buyV4(dave, luck, parseEther('0.3')); await I.indexOnce();
  const t2a = await tick(); assert.ok(t2a.done.some(x => x.kind === 'collect' && x.token === luck.toLowerCase())); const t2 = await tick(); const commit = t2.done.find(x => x.kind === 'openDraw'); assert.ok(commit && commit.hash, 'the draw opened');
  await I.indexOnce(); const draw = S.loadState().coins[luck.toLowerCase()].draw; assert.ok(draw && draw.drawBlock > 0); const t3 = await tick(); assert.ok(!t3.done.some(x => x.kind === 'payDraw'), 'the draw block has not passed');
  await mine(4); const t4 = await tick(); const pay4 = t4.done.find(x => x.kind === 'payDraw'); assert.ok(pay4 && pay4.hash, `paid: ${JSON.stringify(t4.done)}`); assert.ok([carol, dave].map(a => a.toLowerCase()).includes(pay4.winner));
  const block = await chain.pc.getBlock({ blockNumber: BigInt(draw.drawBlock) }); assert.equal(pay4.seed, block.hash); assert.equal(KP.drawWinner(I.holdersOf(S.loadState(), luck.toLowerCase()), block.hash), pay4.winner, 'anyone can recompute the winner');
  await I.indexOnce(); const s2 = S.loadState(); assert.ok(s2.payouts.some(p => p.kind === 'clover' && p.winner === pay4.winner && p.seed === block.hash)); assert.equal(s2.coins[luck.toLowerCase()].draw, null); assert.equal((await K.readCoin(luck)).pot, 0n);
});

await ok('prune and harvest through the gardener: a buyback burns supply on a v4 pool, a routed stock is bought through the real quoter and paid out; an unrouted stock waits', async () => {
  const tide = tokenOf(await write(bob, H.pad, 'launch', [await params(bob, { symbol: 'TIDE', module: 2, pool: 1, launchFee: 300000, window: 600, maxSwapBps: 500 })])); tideToken = tide.toLowerCase(); await buyV4(carol, tide, parseEther('0.05')); /* inside the window: the max per swap holds */ await I.indexOnce();
  const supplyBefore = await K.readTotalSupply(tide); await tick(); const tw = await tick(); assert.ok(!tw.done.some(x => x.kind === 'buyback'), 'no buyback inside the opening window'); const planW = await KP.planCoin(S.loadState(), S.loadState().coins[tide.toLowerCase()]); assert.ok(planW.some(a => a.kind === 'skip' && /opening window/.test(a.label)), JSON.stringify(planW.map(a => a.label)));
  await chain.time(700); const ta = await tick(); const burn = ta.done.find(x => x.kind === 'buyback'); assert.ok(burn && burn.hash, JSON.stringify(ta.done)); assert.ok((await K.readTotalSupply(tide)) < supplyBefore);
  await I.indexOnce(); assert.ok(S.loadState().payouts.some(p => p.kind === 'prune' && p.token === tide.toLowerCase()));
  // stock: switch tide's creator (bob) to the stock module; no route yet, then a route through the real pool
  await write(bob, H.fees, 'setModule', [tide, 3, H.stock.address]); await buyV4(bob, tide, parseEther('1')); await I.indexOnce(); assert.equal(S.loadState().coins[tide.toLowerCase()].module, 3);
  await tick(); await tick(); const plan = await KP.planCoin(S.loadState(), S.loadState().coins[tide.toLowerCase()]); assert.ok(plan.some(a => a.kind === 'skip' && /waits for a route/.test(a.label)), `no route: it waits (${plan.map(a => a.label)})`);
  ST.upsertStock({ address: H.stock.address, symbol: 'mSTK', name: 'Mock Stock', decimals: 18, path: [chain.weth.address, 3000, H.stock.address], logo: 'https://example.invalid/mstk.png' }); const route = ST.routeOf(H.stock.address); assert.equal(route.bytes, encodePath([chain.weth.address, 3000, H.stock.address]));
  const pot = (await K.readCoin(tide)).pot; assert.ok(pot > 0n); const t2 = await tick(); const bought = t2.done.find(x => x.kind === 'buyStock'); assert.ok(bought && bought.hash, JSON.stringify(t2.done)); assert.equal(BigInt(bought.eth), pot);
  const t3 = await tick(); const paid = t3.done.find(x => x.kind === 'payStock'); assert.ok(paid && paid.results[0].hash, JSON.stringify(t3.done)); assert.ok((await chain.pc.readContract({ address: H.stock.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [carol] })) > 0n, 'carol got stock');
  await I.indexOnce(); const s = S.loadState(); assert.ok(s.payouts.some(p => p.kind === 'harvest')); assert.ok(s.payouts.some(p => p.kind === 'stockPaid')); assert.ok((await K.readCoin(tide)).stockHeld < 1000n);
  const stocks = ST.listStocks(); const row = stocks.find(x => x.address === H.stock.address.toLowerCase()); assert.ok(row && row.allowed && row.routed && row.via === 'v3' && row.logo);
  // a seed that moved on (a bake elsewhere, a new version) reaches a registry that already exists: new stocks are added, missing routes taken, the operator's own rows kept
  { const list = ST.loadRegistry(); const mine = list.find(x => x.address === H.stock.address.toLowerCase()); const kept = { ...mine }; delete mine.path; ST.saveRegistry(list); assert.equal(ST.routeOf(H.stock.address), null);
    ST.SEED['31337'] = [{ address: H.stock.address, symbol: 'mSTK', name: 'Mock Stock', decimals: 18, path: kept.path, note: 'from the seed' }, { address: '0x00000000000000000000000000000000000000aa', symbol: 'NEWon', name: 'New (Ondo Tokenized)', decimals: 18 }];
    const reloaded = ST.reloadRegistry(); assert.equal(ST.routeOf(H.stock.address).kind, 'v3', 'the route came from the seed'); assert.equal(reloaded.find(x => x.address === H.stock.address.toLowerCase()).logo, kept.logo, 'the operator\'s fields stay'); assert.ok(reloaded.some(x => x.symbol === 'NEWon'), 'the new stock is added');
    delete ST.SEED['31337']; }
});

await ok('harvest through v4 from the gardener: a stock whose registry route is v4 hops (ETH, a dollar, the stock) is quoted through the v4 quoter and bought with buyStockV4; the chain itself names the pools (catchPools) and picks the route (catchRoute)', async () => {
  const hop = (currency, fee, tickSpacing) => ({ currency, fee, tickSpacing, hooks: ZERO });
  ST.upsertStock({ address: H.stock2.address, symbol: 'mSTK2', name: 'Mock Stock Two', decimals: 18, v4: { from: ZERO, hops: [hop(H.usd.address, 500, 10), hop(H.stock2.address, 3000, 60)] } });
  const route = ST.routeOf(H.stock2.address); assert.equal(route.kind, 'v4'); assert.equal(route.fromWeth, false); assert.equal(route.hops.length, 2); assert.match(route.label, /^ETH > .* > mSTK2 \(0\.3%\)$/);
  assert.equal(ST.routeOf(H.stock.address).kind, 'v3', 'the other stock keeps its v3 path');
  const two = tokenOf(await write(bob, H.pad, 'launch', [await params(bob, { symbol: 'TWO', module: 3, stock: H.stock2.address })])); await buyV3(carol, two, parseEther('1')); await I.indexOnce();
  await tick(); const pot = (await K.readCoin(two)).pot; assert.ok(pot > 0n); const quote = await ST.quoteStock(route, pot); assert.ok(quote > 0n, 'the v4 quoter answers');
  const t2 = await tick(); const bought = t2.done.find(x => x.kind === 'buyStock' && x.token === two.toLowerCase()); assert.ok(bought && bought.hash, JSON.stringify(t2.done)); assert.equal(bought.via, 'v4'); assert.equal(BigInt(bought.eth), pot); assert.equal(BigInt(bought.quote), quote);
  const held = (await K.readCoin(two)).stockHeld; assert.ok(held > 0n && held >= quote * 985n / 1000n, `held ${held} for a quote of ${quote}`);
  const t3 = await tick(); const paid = t3.done.find(x => x.kind === 'payStock' && x.token === two.toLowerCase()); assert.ok(paid && paid.results[0].hash); assert.ok((await chain.pc.readContract({ address: H.stock2.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [carol] })) > 0n, 'carol got mSTK2');
  await I.indexOnce(); const s = S.loadState(); assert.ok(s.payouts.some(p => p.kind === 'harvest' && p.stock === H.stock2.address.toLowerCase()));
  // the chain names the pools: mSTK has a v3 pool against WETH and three v4 pools (ETH, WETH, a thin WETH one); mSTK2 only two v4 pools against the dollar
  const pools = await ST.catchPools(H.stock.address); assert.equal(pools.filter(p => p.kind === 'v3').length, 1); assert.equal(pools.filter(p => p.kind === 'v4').length, 3); assert.ok(pools.every(p => p.liquidity > 0n));
  const pools2 = await ST.catchPools(H.stock2.address); assert.equal(pools2.length, 2); assert.ok(pools2.every(p => p.kind === 'v4' && p.other === H.usd.address.toLowerCase()));
  const best = await ST.catchRoute(H.stock2.address, { probe: parseEther('0.05') }); assert.equal(best.kind, 'v4'); assert.equal(best.hops.length, 2, 'ETH > mUSD > mSTK2'); assert.equal(best.hops[1].fee, 3000, 'the deep pool, not the thin 1% one'); assert.ok(best.impact < 0.03, `impact ${best.impact}`); assert.equal(best.via, 'mSTK', 'the dollar is a MockStock too, so its symbol reads mSTK');
  const best1 = await ST.catchRoute(H.stock.address, { probe: parseEther('0.05') }); assert.ok(['v3', 'v4'].includes(best1.kind)); assert.ok(best1.quote > 0n);
  const thin = await ST.catchRoute(H.stock2.address, { probe: parseEther('5'), maxImpact: 0.01 }); assert.ok(!thin.quote && /over the 1\.0% ceiling/.test(thin.reason), thin.reason);
  const nothing = await ST.catchRoute(alice, { probe: parseEther('0.05') }); assert.ok(!nothing.quote && /no pool on Uniswap v3/.test(nothing.reason));
  const fields = ST.routeFields(best, 'PoolManager'); assert.equal(fields.path, undefined); assert.equal(fields.v4.hops.length, 2); assert.match(fields.note, /^v4 mSTK 0\.3% pool, from ETH via mSTK, \d+\.\d% impact at the probe \(PoolManager \d{4}-\d{2}-\d{2}\)$/);
});

await ok('mist: a holder registers a mist key; the gardener sows the round as notes of the pool\'s denominations, shuffled, keeping nothing that links a note to the holder, and pays the keyless holder in the open; the index rebuilds the tree to the pool\'s root; the holder finds the notes with the viewing key, proves one in the browser\'s way and the relayer sends it to any address', async () => {
  const mist = tokenOf(await write(carol, H.pad, 'launch', [await params(carol, { symbol: 'MIST', module: 7 })])); await buyV3(alice, mist, parseEther('0.6')); await buyV3(bob, mist, parseEther('0.3'));
  const keys = MI.randomKeys(); const pub = MI.publicKey(keys); await write(alice, H.fees, 'setMistKey', [pub]); await I.indexOnce();
  assert.equal(S.loadState().mistKeys[alice.toLowerCase()], pub); assert.equal(M.walletView(alice).mistKey, pub); assert.equal(M.walletView(bob).mistKey, '');
  const t0 = await tick(); assert.ok(t0.done.some(x => x.kind === 'collect' && x.token === mist.toLowerCase()), 'collected'); const pot = (await K.readCoin(mist)).pot;
  const bobBefore = await chain.pc.getBalance({ address: bob }); const t1 = await tick(); const pm = t1.done.find(x => x.kind === 'payMist'); const ph = t1.done.find(x => x.kind === 'payHolders' && x.token === mist.toLowerCase());
  assert.ok(pm && pm.results[0].hash && !pm.error, `mist sown: ${JSON.stringify(t1.done)}`); assert.ok(pm.count >= 3 && pm.count <= 64, `${pm.count} notes`); assert.equal(pm.holders, 1); assert.ok(Object.keys(pm.denoms).length >= 1 && /^0\.(001|01|1)$|^1$/.test(Object.keys(pm.denoms)[0]), JSON.stringify(pm.denoms));
  assert.ok(ph && ph.results[0].hash && ph.count === 1 && /in the open/.test(ph.label) && (await chain.pc.getBalance({ address: bob })) - bobBefore === BigInt(ph.total), 'bob, without a key, is paid in the open');
  assert.ok(BigInt(ph.total) + BigInt(pm.total) <= pot && pot - BigInt(ph.total) - BigInt(pm.total) < parseEther('0.001'), 'all but the change below the smallest note went out');
  const ledger = JSON.stringify(S.loadLedger().filter(x => x.kind === 'payMist')); assert.ok(!ledger.includes(alice.slice(2).toLowerCase()) && !ledger.includes(pub.slice(2, 40)), 'the ledger keeps nothing that names the holder behind a note');
  await I.indexOnce(); const feed = M.mistNotes(0); assert.equal(feed.total, pm.count); assert.ok(feed.notes.every(v => v.token === mist.toLowerCase() && v.symbol === 'MIST' && v.ephemeral.length === 66 && v.batch === 0)); assert.equal(M.mistNotes(feed.total - 2, 1).notes.length, 1);
  const s = S.loadState(); const row = s.payouts.find(p => p.kind === 'mist' && p.token === mist.toLowerCase()); assert.ok(row && row.count === pm.count && row.batch === 0); assert.equal(s.mist.batches.length, 1); assert.equal(s.mist.batches[0].count, pm.count);
  const stats = M.mistStats(); assert.equal(stats.notes, pm.count); assert.equal(stats.batches, 1); assert.equal(stats.keyed, 1); assert.equal(stats.sownEth, pm.total);
  const T = MI.tree([feed.notes.map(n => MI.leafOf(BigInt(n.commit), BigInt(n.denom)))]); assert.equal(T.root, BigInt(s.mist.batches[0].root)); assert.equal(await K.readMistRoot(), T.root, 'the index rebuilds the tree to the root the pool holds');
  const mine = MI.scan(keys, feed.notes); assert.equal(mine.length, pm.count, 'the viewing key finds every note'); assert.equal(MI.scan(MI.randomKeys(), feed.notes).length, 0);
  // the relayer: quote, proof, relay; a stale fee, a wrong relayer and a spent note are refused
  const MR = await import('../eth/mist.mjs'); const note = mine[0]; const idx = note.batch * MI.BATCH + note.index; const q = await MR.relayQuote(BigInt(note.denom)); assert.equal(q.relayer.toLowerCase(), gardener.toLowerCase()); assert.ok(q.fee > 0n && q.fee <= BigInt(note.denom) / 2n);
  const w = MI.witness({ keys, sh: note.sh, denom: BigInt(note.denom), index: idx, path: T.path(idx), root: T.root, recipient: dave, relayer: q.relayer, fee: q.fee });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(w, 'public/zk/withdraw.wasm', 'public/zk/withdraw.zkey'); const daveBefore = await chain.pc.getBalance({ address: dave });
  const r = await MR.relay({ proof, publicSignals }); assert.ok(r.hash && r.recipient === getAddress(dave)); assert.equal((await chain.pc.getBalance({ address: dave })) - daveBefore, BigInt(note.denom) - q.fee, 'relayed: the note minus the fee landed with dave, who never signed anything');
  await assert.rejects(MR.relay({ proof, publicSignals }), /spent/); await I.indexOnce(); assert.equal(M.mistStats().spent, 1); assert.equal(M.mistStats().withdrawnEth, note.denom);
  const wLow = MI.witness({ keys, sh: mine[1].sh, denom: BigInt(mine[1].denom), index: mine[1].batch * MI.BATCH + mine[1].index, path: T.path(mine[1].batch * MI.BATCH + mine[1].index), root: T.root, recipient: dave, relayer: q.relayer, fee: 0n }); const prLow = await snarkjs.groth16.fullProve(wLow, 'public/zk/withdraw.wasm', 'public/zk/withdraw.zkey'); await assert.rejects(MR.relay(prLow), /fee too low/);
  const wOther = MI.witness({ keys, sh: mine[1].sh, denom: BigInt(mine[1].denom), index: mine[1].batch * MI.BATCH + mine[1].index, path: T.path(mine[1].batch * MI.BATCH + mine[1].index), root: T.root, recipient: dave, relayer: dave, fee: q.fee }); const prOther = await snarkjs.groth16.fullProve(wOther, 'public/zk/withdraw.wasm', 'public/zk/withdraw.zkey'); await assert.rejects(MR.relay(prOther), /another relayer/);
  const again = await tick(); assert.ok(!again.done.some(x => x.kind === 'payMist'), 'the change is under the threshold');
});

await ok('dry by default: with the gardener disabled every action is recorded as dry and nothing is sent', async () => {
  const fresh = tokenOf(await write(alice, H.pad, 'launch', [await params(alice, { symbol: 'DRY' })], parseEther('0.5'))); await buyV3(carol, fresh, parseEther('0.5')); await I.indexOnce();
  const t = await KP.tick({ dry: true, log: quiet }); const c = t.done.find(x => x.kind === 'collect' && x.token === fresh.toLowerCase()); assert.ok(c && c.dry && !c.hash); assert.equal((await K.readCoin(fresh)).received, 0n);
});

await ok('the sender: fees with headroom (twice the base fee, a tip floor); a transaction not in a block after the wait stays pending, is sent again at the same nonce with higher fees, and settles its ledger entry once it is in; a nonce used by something else is given up and reported; a transaction waiting at the nonce that the process never sent is replaced; the tick sends nothing while one is pending', async () => {
  const SN = await import('../eth/sender.mjs'); SN.SENDER.lagMs = 10; const pc = chain.pc; const base = (await pc.getBlock({ blockTag: 'latest' })).baseFeePerGas;
  const f = await SN.feesNow(pc); assert.ok(!f.legacy); assert.ok(f.maxFee >= base * 2n, 'twice the base fee'); assert.ok(f.tip >= parseGwei('0.1'), 'the tip floor');
  const self = { to: gardener, data: '0x' }; const hex = x => toHex(BigInt(x));
  await chain.provider.request({ method: 'evm_setAutomine', params: [false] });
  try {
    const nonce0 = await pc.getTransactionCount({ address: gardener, blockTag: 'latest' });
    const r1 = await SN.sendGardener(self, { label: 'a test send', waitMs: 0 }); assert.ok(r1.pending && r1.hash, 'pending after the wait'); const p1 = SN.pendingTx(); assert.equal(p1.nonce, nonce0); assert.equal(p1.hashes.length, 1); assert.equal(p1.hashes[0], r1.hash);
    S.record({ kind: 'test', hash: r1.hash, pending: true });
    assert.equal((await SN.settle({})).bumps, 0, 'no bump before the delay');
    await assert.rejects(SN.sendGardener(self, { label: 'another', waitMs: 0 }), /busy/, 'nothing new while one is pending');
    const p2 = await SN.settle({ now: Date.now() + SN.SENDER.bumpAfterMs + 1 }); assert.equal(p2.bumps, 1); assert.equal(p2.hashes.length, 2); assert.ok(BigInt(p2.maxFee) >= BigInt(p1.maxFee) * 110n / 100n && BigInt(p2.tip) >= BigInt(p1.tip) * 110n / 100n, 'fees up by a tenth at least');
    await mine(1); assert.equal(await SN.settle({}), null, 'settled'); const e1 = S.loadLedger().find(e => e.kind === 'test'); assert.equal(e1.hash, p2.hashes[1], 'the ledger entry carries the hash that went in'); assert.ok(e1.block > 0 && e1.gasUsed && !e1.pending && !e1.error);
    assert.equal(await pc.getTransactionCount({ address: gardener, blockTag: 'latest' }), nonce0 + 1); assert.equal(await pc.getTransactionReceipt({ hash: r1.hash }).catch(() => null), null, 'the first hash never went in');
    // the key used elsewhere: a transaction that is not the gardener's takes the nonce
    const r2 = await SN.sendGardener(self, { label: 'a second test send', waitMs: 0 }); assert.ok(r2.pending); S.record({ kind: 'test2', hash: r2.hash, pending: true }); const p3 = SN.pendingTx();
    await chain.provider.request({ method: 'eth_sendTransaction', params: [{ from: gardener, to: alice, value: '0x0', nonce: hex(p3.nonce), maxFeePerGas: hex(BigInt(p3.maxFee) * 2n), maxPriorityFeePerGas: hex(BigInt(p3.tip) * 2n), gas: hex(21000) }] });
    await mine(1); const logs = []; assert.equal(await SN.settle({ log: m => logs.push(m) }), null); const e2 = S.loadLedger().find(e => e.kind === 'test2'); assert.ok(/used somewhere else/.test(e2.error), e2.error); assert.ok(!SN.pendingTx()); assert.ok(logs.some(m => /given up/.test(m)), logs.join('\n'));
    // a transaction waiting at the nonce that this process never sent (one from before an update, say) is replaced by the next send
    const nonce1 = await pc.getTransactionCount({ address: gardener, blockTag: 'latest' }); const g = await SN.feesNow(pc);
    const foreign = await chain.provider.request({ method: 'eth_sendTransaction', params: [{ from: gardener, to: alice, value: '0x0', nonce: hex(nonce1), maxFeePerGas: hex(g.maxFee / 2n), maxPriorityFeePerGas: hex(g.tip / 2n), gas: hex(21000) }] });
    assert.equal(await pc.getTransactionCount({ address: gardener, blockTag: 'pending' }), nonce1 + 1);
    const logs2 = []; const r3 = await SN.sendGardener(self, { label: 'a third test send', waitMs: 0, log: m => logs2.push(m) }); assert.ok(r3.pending); assert.equal(SN.pendingTx().nonce, nonce1); assert.ok(logs2.some(m => /did not send/.test(m)), logs2.join('\n'));
    // the tick follows the pending transaction and sends nothing else
    const logs3 = []; const t = await KP.tick({ dry: false, log: m => logs3.push(m) }); assert.equal(t.waited, 'pending'); assert.equal(t.done.length, 0); assert.ok(logs3.some(m => /waiting for a third test send/.test(m)), logs3.join('\n'));
    await mine(1); assert.equal(await SN.settle({}), null); assert.equal(await pc.getTransactionReceipt({ hash: foreign }).catch(() => null), null, 'the foreign transaction is gone'); assert.ok(await pc.getTransactionReceipt({ hash: r3.hash }), 'the gardener\'s went in at that nonce');
    assert.ok(!SN.pendingTx()); const t2 = await KP.tick({ dry: false, log: quiet }); assert.ok(!t2.waited, 'the next tick runs');
  } finally { await chain.provider.request({ method: 'evm_setAutomine', params: [true] }); SN.forgetPending(); }
});
await ok('standing: the platform\'s coin is official and first; a coin wearing its symbol is a lookalike and the symbol resolves to the official one; a hidden coin leaves the lists and the numbers but keeps its page; the outlook says what the gardener sees for every coin', async () => {
  const look = tokenOf(await write(bob, H.pad, 'launch', [await params(bob, { name: 'Aurora Lamps', symbol: 'LAMP', module: 0 })], parseEther('0.01'))); await I.indexOnce();
  CONFIG.platformCoin = lamp.toLowerCase(); CONFIG.hiddenCoins = [king.toLowerCase()];
  try {
    const s = S.loadState(); const rowL = M.coinRow(s.coins[lamp.toLowerCase()]); const rowX = M.coinRow(s.coins[look.toLowerCase()]); const rowK = M.coinRow(s.coins[king.toLowerCase()]);
    assert.ok(rowL.official && !rowL.lookalike && !rowL.hidden); assert.ok(rowX.lookalike && !rowX.official, 'the second $LAMP is a lookalike'); assert.equal(rowX.officialToken, lamp.toLowerCase()); assert.ok(rowK.hidden);
    const list = M.listCoins(); assert.equal(list[0].token, lamp.toLowerCase(), 'the official coin comes first'); assert.ok(!list.some(c => c.token === king.toLowerCase()), 'the hidden coin is out of the list'); assert.ok(list.some(c => c.token === look.toLowerCase()), 'the lookalike stays listed, marked');
    assert.equal(M.findCoin('LAMP').token, lamp.toLowerCase(), 'the symbol goes to the official coin'); assert.equal(M.findCoin(look).token, look.toLowerCase(), 'the address goes to the coin itself'); assert.equal(M.findCoin(king).token, king.toLowerCase(), 'a hidden coin is found by address');
    assert.equal(M.stats().coins, list.length); const all = Object.keys(s.coins).length; assert.equal(list.length, all - 1);
    const o = await KP.outlook(); assert.equal(o.coins.length, all, 'the outlook covers every coin, hidden ones too'); const ol = o.coins.find(c => c.token === lamp.toLowerCase()); assert.equal(ol.module, 'rain'); assert.ok(ol.due.length + ol.waiting.length > 0, JSON.stringify(ol));
    const ox = o.coins.find(c => c.token === look.toLowerCase()); assert.equal(ox.module, 'roots'); assert.ok(ox.waiting.some(w => /pushes this module/.test(w)) || ox.due.some(d => /^collect/.test(d)), JSON.stringify(ox)); /* a roots coin: nothing to pay; its fees are collected when worth the gas */ assert.ok(o.thresholds.collectMinEth && o.head > 0);
  } finally { CONFIG.platformCoin = ''; CONFIG.hiddenCoins = []; }
});
await ok('all time: the totals add up from the index, the 24h volume comes from hour buckets that agree with the trades, and a rebuild of the day rows from the kept data matches what the indexer kept as it went', async () => {
  const DEAD = '0x000000000000000000000000000000000000dEaD'; const burnAmount = 1_000_000n * 10n ** 18n; const lampBefore = BigInt(S.loadState().coins[lamp.toLowerCase()].stats.burned || 0);
  await write(alice, H.token(lamp), 'transfer', [DEAD, burnAmount]); await I.indexOnce(); /* a holder's own burn: a transfer to the dead address */
  const SR = await import('../eth/series.mjs'); const s = S.loadState(); const a = M.allTime({ ethUsd: 3000 }); const all = Object.values(s.coins);
  const lampC = s.coins[lamp.toLowerCase()]; assert.equal(BigInt(lampC.stats.burned), lampBefore + burnAmount, 'the burn is on the coin'); assert.equal(BigInt(lampC.stats.burnedByBuybacks || 0), 0n, 'not a buyback'); assert.ok(!I.holdersOf(s, lamp.toLowerCase()).some(h => h.address === DEAD.toLowerCase()), 'the dead address is no holder');
  const tideC = s.coins[tideToken]; assert.ok(BigInt(tideC.stats.burned) > 0n && tideC.stats.burned === tideC.stats.burnedByBuybacks, 'the buyback burns are the coin\'s burns'); assert.ok(s.burns.some(b => b.token === lamp.toLowerCase() && !b.buyback && b.from === alice.toLowerCase()) && s.burns.some(b => b.token === tideToken && b.buyback), JSON.stringify(s.burns.slice(-3)));
  const lampRow = a.burns.byCoin.find(b => b.token === lamp.toLowerCase()); assert.ok(lampRow && BigInt(lampRow.coins) >= burnAmount && lampRow.count === 0 && lampRow.supplyPct >= 0.1, JSON.stringify(lampRow)); assert.ok(BigInt(a.burns.coins) > BigInt(a.burns.byBuybacks), 'every burn counts, buybacks among them'); assert.ok(a.burns.recent.length >= 2 && a.burns.recent[0].token === lamp.toLowerCase());
  assert.equal(a.coins.total, all.length); assert.equal(Object.values(a.coins.byModule).reduce((x, y) => x + y, 0), all.length);
  assert.equal(a.volume.eth, all.reduce((x, c) => x + BigInt(c.stats.volumeEth), 0n).toString()); assert.equal(a.fees.received, all.reduce((x, c) => x + BigInt(c.fees.received), 0n).toString()); assert.equal(a.fees.platform, all.reduce((x, c) => x + BigInt(c.fees.platform), 0n).toString());
  assert.ok(a.burns.count >= 1 && a.burns.byCoin.some(b => b.symbol === 'TIDE' && BigInt(b.coins) > 0n), JSON.stringify(a.burns)); assert.ok(a.payouts.rain && a.payouts.rain.count >= 1 && a.payouts.prune && BigInt(a.payouts.prune.coins) > 0n); assert.ok(a.holders > 3); assert.ok(a.days.length >= 1 && a.days.reduce((x, d) => x + d.launches, 0) === all.length);
  const now = Math.floor(Date.now() / 1000); for (const c of all) { const fromTrades = (s.trades[c.token] || []).filter(t => t.t >= SR.hourOf(now) - 23 * 3600).reduce((x, t) => x + BigInt(t.eth), 0n); assert.equal(SR.volume24h(c, now), fromTrades, `${c.symbol}: the hour buckets agree with the trades`); }
  const copy = JSON.parse(JSON.stringify(s)); SR.rebuild(copy); for (const [day, d] of Object.entries(s.days)) { const r = copy.days[day]; assert.ok(r, `day ${day} rebuilt`); for (const k of ['volume', 'trades', 'paid', 'burned', 'launches']) assert.equal(String(r[k]), String(d[k]), `${day}.${k}`); } /* burnedCoins differs by the hand burn above: a rebuild knows only the buybacks */
  for (const c of all) assert.deepEqual(copy.coins[c.token].stats.hours, c.stats.hours, `${c.symbol}: hours rebuilt`);
});
await ok('candles: every frame follows the trades (the last close is the last price, the volume adds up, a new candle opens at the last close), the launch is the first candle, the files are written with the state, and a rebuild from the kept trades matches', async () => {
  const CD = await import('../eth/candles.mjs'); const s = S.loadState(); const c = s.coins[lamp.toLowerCase()]; const trades = s.trades[c.token]; assert.ok(trades.length >= 3);
  const k = CD.candlesOf(c.token); for (const f of ['m1', 'm5', 'h1', 'd1']) { const arr = k[f]; assert.ok(arr.length >= 1, `${f} has candles`); const last = arr[arr.length - 1]; assert.ok(Math.abs(last.c - Number(BigInt(trades[trades.length - 1].price)) / 1e18) < 1e-18, `${f}: the last close is the last trade's price`); const vol = arr.reduce((a, x) => a + x.v, 0); const traded = trades.reduce((a, t) => a + Number(BigInt(t.eth)) / 1e18, 0); assert.ok(Math.abs(vol - traded) < 1e-9, `${f}: the volume adds up (${vol} vs ${traded})`); for (let i = 1; i < arr.length; i++) { assert.ok(arr[i].t > arr[i - 1].t, 'in order'); assert.equal(arr[i].o, arr[i - 1].c, `${f}: a candle opens at the last close`); assert.ok(arr[i].h >= Math.max(arr[i].o, arr[i].c) && arr[i].l <= Math.min(arr[i].o, arr[i].c), 'high and low hold'); } }
  assert.ok(k.m1[0].t <= c.createdAt && k.m1[0].t > c.createdAt - 60, 'the first candle is the launch'); assert.ok(Math.abs(k.m1[0].o - Number(BigInt(P.price({ pool: c.pool, sqrtP: P.sqrtPriceAtTick(c.startTick) }))) / 1e18) < 1e-18, 'at the starting price');
  assert.ok(fs.existsSync(path.join(tmp, 'candles', `${c.token}.json`)), 'the candles file is written'); const rows = CD.candleRows(c.token, 'm5', { since: k.m5[k.m5.length - 1].t }); assert.equal(rows.length, 1); assert.equal(rows[0][4], k.m5[k.m5.length - 1].c);
  const before = JSON.parse(JSON.stringify(k)); CD.rebuildCandles(s, x => P.price({ pool: x.pool, sqrtP: P.sqrtPriceAtTick(x.startTick) }).toString()); const after = CD.candlesOf(c.token); for (const f of ['m1', 'm5', 'h1', 'd1']) assert.deepEqual(after[f].map(x => [x.t, x.o, x.h, x.l, x.c]), before[f].map(x => [x.t, x.o, x.h, x.l, x.c]), `${f}: the rebuild matches`);
});
await ok('patience: under the thresholds a coin is still tended once the patience has run, as long as what is due is worth ten times its gas; inside the patience it waits and the outlook says until when', async () => {
  const saved = { c: CONFIG.collectMinEth, p: CONFIG.payoutMinEth }; CONFIG.collectMinEth = '10'; CONFIG.payoutMinEth = '10'; const gasPriceWei = await chain.pc.getGasPrice(); const L = lamp.toLowerCase();
  try {
    await buyV3(carol, lamp, parseEther('0.2')); await I.indexOnce(); const col = await K.simulateCollect(S.loadState().coins[L], chainMod.gardenerAddress()); assert.ok(col.eth > 0n && col.eth < parseEther('10'), 'fees under the threshold');
    process.env.HALCYON_GARDENER_PATIENCE_MIN = '600'; const inside = await KP.planCoin(S.loadState(), S.loadState().coins[L], { gasPriceWei }); assert.ok(!inside.some(a => a.kind === 'collect'), 'inside the patience it waits (the ledger has a collect from before)');
    const o = await KP.outlook(); const row = o.coins.find(c => c.token === L); assert.ok(row.waiting.some(w => /worth its gas, so collected within \d+ min/.test(w)), JSON.stringify(row.waiting)); assert.equal(o.thresholds.patienceMin, 600);
    process.env.HALCYON_GARDENER_PATIENCE_MIN = '0'; const spent = await KP.planCoin(S.loadState(), S.loadState().coins[L], { gasPriceWei }); assert.ok(spent.some(a => a.kind === 'collect'), 'the patience spent, the collect is due under the threshold');
    assert.ok(!(await KP.planCoin(S.loadState(), S.loadState().coins[L], { gasPriceWei: 0n })).some(a => a.kind === 'collect'), 'with no gas price known, the thresholds alone decide');
    const t = await tick(); assert.ok(t.done.some(x => x.kind === 'collect' && x.token === L && !x.error), JSON.stringify(t.done.map(x => [x.kind, x.token === L, x.error])));
    const t2 = await tick(); assert.ok(t2.done.some(x => x.kind === 'payHolders' && x.token === L && !x.error), 'and the pot, under its threshold too, is paid');
  } finally { CONFIG.collectMinEth = saved.c; CONFIG.payoutMinEth = saved.p; delete process.env.HALCYON_GARDENER_PATIENCE_MIN; }
});
await ok('pure: shares, batches, rings weights, the draw; the pool math round-trips the contract\'s starting tick at every preset; the metadata record and key; the v3 path encoder', async () => {
  const sh = KP.shares([{ address: 'a', balance: '300' }, { address: 'b', balance: '100' }, { address: 'c', balance: '1' }], 1_000_000n, 10_000n); assert.deepEqual(sh.map(x => [x.address, x.amount]), [['a', 748_129n], ['b', 249_376n]]); assert.deepEqual(KP.batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  const now = 1_800_000_000; const w = KP.ringsWeight(now); assert.equal(w({ balance: '10', since: now - 10 * 86_400 }), 100n); assert.equal(w({ balance: '10', since: now - 100 * 86_400 }), 300n); assert.equal(w({ balance: '10', since: now - 3600 }), 10n); assert.equal(w({ balance: '10', since: 0 }), 10n);
  const hs = [{ address: '0xb', balance: '10' }, { address: '0xa', balance: '90' }]; assert.equal(KP.drawWinner(hs, '0x' + '0'.repeat(63) + '5'), '0xa'); assert.equal(KP.drawWinner(hs, toHex(95n, { size: 32 })), '0xb'); assert.equal(KP.drawWinner(hs, toHex(100n, { size: 32 })), '0xa');
  for (const cap of P.CAP_PRESETS) for (const pool of [0, 1]) { const tick = P.startTick(pool, cap, 3000n * 10n ** 8n); assert.ok(tick % 200 === 0); const f = P.freshPool(pool, cap, 3000n * 10n ** 8n); const capUsd = Number(P.marketCap(f)) / 1e18 * 3000; assert.ok(capUsd <= cap && capUsd > cap / 1.0202, `${pool} ${cap} ${capUsd}`); const q = P.quoteBuy(f, parseEther('1')); assert.ok(q.coinsOut > 0n && q.refund === 0n); const back = P.quoteSell({ ...f, sqrtP: q.sqrtNext }, q.coinsOut); assert.ok(back.ethOut < parseEther('1') && back.ethOut > parseEther('0.97')); }
  assert.ok(Math.abs(P.ethToReachCap(5000, 100000) - 17360.68) < 1);
  const { cleanMeta, metaKey } = await import('../server.mjs'); const rec = cleanMeta({ name: ' Lamp ', symbol: 'lamp', description: 'x', image: 'https://a.b/c.png', links: { x: 'https://x.com/a', site: 'javascript:alert(1)' } }); assert.equal(rec.symbol, 'LAMP'); assert.equal(rec.name, 'Lamp'); assert.equal(rec.links.site, ''); assert.equal(metaKey(rec).length, 32); assert.throws(() => cleanMeta({ name: '' }), /name/);
  assert.equal(ST.encodePath([chain.weth.address, 500, H.stock.address]).length, 2 + 43 * 2); assert.throws(() => ST.encodePath([chain.weth.address]), /path/);
});

await ok('the demo server over HTTP: config, stats, coins of both pools and every module, a coin with trades, holders, payouts and rules, quotes, stocks with logos, hosted metadata', async () => {
  const port = 4199; const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, HALCYON_DEMO: '1', PORT: String(port), DATA_DIR: path.join(tmp, 'demo'), HALCYON_GARDENER_ENABLED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = `http://127.0.0.1:${port}`; for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
    const cfg = await (await fetch(`${base}/api/config`)).json(); assert.equal(cfg.demo, true); assert.equal(cfg.model.feePips, 10000); assert.deepEqual(cfg.model.capPresets, [4000, 5000, 7000, 10000]); assert.equal(cfg.modules.clover.id, 5); assert.equal(cfg.modules.mist.name, 'Mist'); assert.equal(cfg.pools[1].name, 'Rules'); assert.equal(cfg.xHandle, 'halcyoncash');
    const stats = await (await fetch(`${base}/api/stats`)).json(); assert.equal(stats.coins, 10); assert.equal(stats.v4, 5); assert.ok(BigInt(stats.feesEth) > 0n && BigInt(stats.lockedEth) > 0n); assert.ok(BigInt(stats.volumeEth) > BigInt(stats.volume24hEth), 'all-time volume above the day\'s');
    const all = await (await fetch(`${base}/api/alltime`)).json(); assert.equal(all.coins.total, 10); assert.equal(Object.values(all.coins.byModule).reduce((a, b) => a + b, 0), 10); assert.equal(all.volume.eth, stats.volumeEth); assert.equal(all.fees.received, stats.feesEth); assert.ok(all.burns.count >= 1 && all.burns.byCoin[0].symbol === 'TIDE' && BigInt(all.burns.coins) > 0n && all.burns.coins === all.burns.byBuybacks && all.burns.byCoin[0].supplyPct > 0 && all.burns.recent.length >= 1 && all.burns.recent[0].buyback, JSON.stringify(all.burns)); assert.ok(all.payouts.rain.count > 0 && all.payouts.mist.count > 0); assert.ok(all.holders > 10); assert.ok(all.days.length >= 5 && all.days.reduce((a, d) => a + d.launches, 0) === 10, 'every launch on a day'); assert.equal(BigInt(all.platform.pot), BigInt(all.fees.platform), 'the pot from the index when there is no chain'); assert.ok(all.since > 0 && all.mist.notes > 10);
    const { coins } = await (await fetch(`${base}/api/coins`)).json(); assert.equal(coins.length, 10); assert.deepEqual([...new Set(coins.map(c => c.module))].sort(), ['branch', 'clover', 'harvest', 'mist', 'prune', 'rain', 'rings', 'roots']);
    const kingRow = coins.find(c => c.symbol === 'KING'); const cd = await (await fetch(`${base}/api/coin/${kingRow.token}/candles?tf=m5`)).json(); assert.ok(cd.candles.length > 50 && cd.candles.every(r => r.length === 6 && r[2] >= r[3]) && cd.price === kingRow.stats.lastPrice, 'candles for the chart'); const tail = await (await fetch(`${base}/api/coin/${kingRow.token}/candles?tf=m5&since=${cd.candles[cd.candles.length - 2][0]}`)).json(); assert.equal(tail.candles.length, 2, 'the tail from a time'); const d1 = await (await fetch(`${base}/api/coin/${kingRow.token}/candles?tf=d1`)).json(); assert.ok(d1.candles.length >= 3 && d1.candles.length < cd.candles.length, 'days are fewer than five-minute candles');
    const kingPage = await (await fetch(`${base}/api/coin/${kingRow.token}`)).json(); assert.ok(Array.isArray(kingPage.burns), 'a coin page carries its burns');
    const mist = coins.find(c => c.symbol === 'MIST'); const mistPage = await (await fetch(`${base}/api/coin/${mist.token}`)).json(); assert.ok(mistPage.holders.keyed >= 2 && mistPage.holders.top.some(h => h.mist) && mistPage.payouts.some(p => p.kind === 'mist' && p.count > 0 && typeof p.batch === 'number'), 'the mist coin shows keyed holders and sown rounds');
    const feed = await (await fetch(`${base}/api/mist/notes`)).json(); assert.ok(feed.total > 10 && feed.notes.length === feed.total && feed.notes.every(v => v.symbol === 'MIST' && v.ephemeral.length === 66 && v.viewTag >= 0 && v.viewTag < 256 && /^\d+$/.test(v.commit))); const page2 = await (await fetch(`${base}/api/mist/notes?since=${feed.total - 3}&limit=2`)).json(); assert.equal(page2.notes.length, 2); assert.equal(page2.since, feed.total - 3);
    const ms = await (await fetch(`${base}/api/mist`)).json(); assert.ok(ms.notes === feed.total && ms.batches >= 3 && ms.spent >= 2 && ms.denominations.length === 3 && ms.zk && ms.zk.dev === SETUP.dev && ms.zk.constraints === SETUP.constraints && ms.zk.ok === true && ms.recent.length >= 1);
    { const MIx = await import('../eth/mist.mjs'); assert.equal(MIx.checkArtifacts(null).ok, true, 'the shipped artifacts agree with zk/setup.json'); const bad = MIx.checkArtifacts({ zk: { zkey: 'another', dev: SETUP.dev } }); assert.ok(!bad.ok && /another setup/.test(bad.problems[0]), 'a deployment made with another setup is flagged'); } assert.equal((await fetch(`${base}/api/mist/quote?denom=1`)).status, 503); assert.equal((await fetch(`${base}/api/mist/relay`, { method: 'POST', body: '{}' })).status, 503);
    const { DEMO_MIST_SIGNATURE, DEMO_MIST_HOLDER } = await import('../eth/demo.mjs'); const me = await (await fetch(`${base}/api/me/${DEMO_MIST_HOLDER}`)).json(); assert.equal(me.mistKey, MI.publicKey(MI.keysFromSignature(DEMO_MIST_SIGNATURE))); assert.equal(MI.scan(MI.keysFromSignature(DEMO_MIST_SIGNATURE), feed.notes).length, feed.total, 'the demo signature finds every demo note');
    const king = coins.find(c => c.symbol === 'KING'); assert.ok(king.pool === 1 && king.rules && !king.rules.open && king.image && king.description); const boat = coins.find(c => c.symbol === 'BOAT'); assert.ok(boat.rules.open && boat.rules.feeNow > 10000, 'the opening fee is still falling'); const luck = coins.find(c => c.symbol === 'LUCK'); assert.ok(luck.draw && luck.draw.drawBlock);
    const page = await (await fetch(`${base}/api/coin/${king.token}`)).json(); assert.ok(page.trades.length > 10 && page.holders.count > 5 && page.payouts.length > 0); assert.ok(page.trades.some(t => t.feePips > 10000), 'early trades paid the opening fee');
    const trio = coins.find(c => c.symbol === 'TRIO'); assert.equal(trio.branches.length, 3); assert.equal(trio.branches.reduce((a, x) => a + x.bps, 0), 10000);
    const q = await (await fetch(`${base}/api/quote?token=${king.token}&side=buy&amount=${parseEther('0.1')}`)).json(); assert.equal(q.feePips, 10000); assert.ok(BigInt(q.out) > 0n); const q2 = await (await fetch(`${base}/api/quote?token=${king.token}&side=sell&amount=${parseEther('1000')}`)).json(); assert.equal(q2.feePips, 30000); assert.ok(BigInt(q2.out) > 0n);
    const q3 = await (await fetch(`${base}/api/quote?token=${boat.token}&side=buy&amount=${parseEther('0.01')}`)).json(); assert.ok(q3.feePips > 10000 && q3.feePips <= 600000, `opening fee ${q3.feePips}`);
    const stocks = await (await fetch(`${base}/api/stocks`)).json(); assert.ok(stocks.stocks.length >= 400, 'the whole catalog'); { const seedRows = JSON.parse(fs.readFileSync(new URL('../eth/stocks-seed.json', import.meta.url), 'utf8'))['1']; const routed = seedRows.filter(r => (Array.isArray(r.path) && r.path.length >= 3) || (r.v4 && r.v4.hops && r.v4.hops.length)).length; assert.equal(stocks.stocks.filter(s => s.routed && s.allowed).length, routed, 'the demo allows every routed stock of the seed'); } assert.ok(stocks.stocks.every(s => s.logo && s.symbol.endsWith('on'))); assert.ok(stocks.stocks.find(s => s.symbol === 'NVDAon').routed);
    const meta = await (await fetch(`${base}/api/meta`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Paper Boat', symbol: 'boat', description: 'float', links: { x: 'https://x.com/boat' } }) })).json(); assert.ok(meta.uri.endsWith(`/m/${meta.key}.json`)); const hosted = await (await fetch(meta.uri.replace(/^http:\/\/[^/]+/, base))).json(); assert.equal(hosted.symbol, 'BOAT');
    const img = await (await fetch(`${base}/api/image`, { method: 'POST', headers: { 'content-type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg"/>' })).json(); assert.ok(/^\/i\/[a-f0-9]{32}\.svg$/.test(img.url)); assert.equal((await fetch(`${base}${img.url}`)).status, 200);
    assert.equal((await fetch(`${base}/api/rpc`, { method: 'POST', body: '{}' })).status, 503, 'no chain in the demo'); assert.equal((await fetch(`${base}/api/coin/nope`)).status, 404);
  } finally { child.kill('SIGTERM'); }
});

await ok('pinning through Pinata: with a JWT the picture and the metadata go to IPFS (the current upload API, or the old pinning API when the key is for that) and the uri is ipfs://; the site resolves ipfs:// records and pictures; without a JWT nothing changes', async () => {
  const http = await import('node:http'); const META = await import('../eth/meta.mjs'); const PIN = await import('../eth/pinata.mjs');
  // pure: the record cleaner takes ipfs pictures, the key of every uri shape
  const rec = META.cleanMeta({ name: 'Pin', symbol: 'pin', image: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/pic.png', links: {} }); assert.ok(rec.image.startsWith('ipfs://'));
  assert.equal(META.keyOfUri('https://halcyon.cash/m/0123456789abcdef0123456789abcdef.json'), '0123456789abcdef0123456789abcdef'); assert.equal(META.keyOfUri('meta:abc'), 'abc'); assert.equal(META.keyOfUri('ipfs://bafyfoo/x.json'), 'bafyfoo'); assert.equal(META.keyOfUri('data:,x'), '');
  assert.equal(PIN.gatewayUrl('ipfs://bafyfoo/a.png'), `${PIN.PINATA.gateway}/bafyfoo/a.png`); assert.equal(PIN.gatewayUrl('https://a.b/c'), 'https://a.b/c'); assert.ok(PIN.PINATA.gateway.endsWith('/ipfs'));
  // a stand-in for Pinata: one that takes the v3 upload, one that only knows the old pinning API
  const pins = []; let v3 = true;
  const fake = http.createServer((req, res) => { let body = []; req.on('data', d => body.push(d)); req.on('end', () => { const bytes = Buffer.concat(body);
    if (req.url.startsWith('/ipfs/')) { const cid = req.url.slice(6).split('/')[0]; const hit = pins.find(p => p.cid === cid && p.record); if (!hit) { res.writeHead(404); return res.end('no'); } res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(hit.record)); }
    const auth = req.headers.authorization; if (auth !== 'Bearer test-jwt') { res.writeHead(401); return res.end('{"error":"no"}'); }
    if (req.url === '/v3/files') { if (!v3) { res.writeHead(404); return res.end('not here'); } const cid = 'bafy' + createHash('sha256').update(bytes).digest('hex').slice(0, 40); pins.push({ api: 'v3', cid, size: bytes.length }); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: { id: '1', cid, size: bytes.length } })); }
    if (req.url === '/pinning/pinFileToIPFS') { const cid = 'Qm' + createHash('sha256').update(bytes).digest('hex').slice(0, 40); pins.push({ api: 'legacy', cid }); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ IpfsHash: cid, PinSize: bytes.length })); }
    res.writeHead(404); res.end(); }); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r)); const fakePort = fake.address().port; const fakeBase = `http://127.0.0.1:${fakePort}`;
  const port = 4197; const dataDir = path.join(tmp, 'pin'); const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, HALCYON_DEMO: '1', PORT: String(port), DATA_DIR: dataDir, HALCYON_GARDENER_ENABLED: '0', PINATA_JWT: 'test-jwt', PINATA_UPLOAD_URL: `${fakeBase}/v3/files`, PINATA_API_URL: fakeBase, PINATA_GATEWAY_URL: `${fakeBase}/ipfs/` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  try {
    const base = `http://127.0.0.1:${port}`; for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
    const img = await (await fetch(`${base}/api/image`, { method: 'POST', headers: { 'content-type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>' })).json();
    assert.ok(img.pinned && img.ipfs.startsWith('ipfs://bafy') && img.gateway === `${fakeBase}/ipfs/${img.ipfs.slice(7)}` && /^\/i\/[a-f0-9]{32}\.svg$/.test(img.url), JSON.stringify(img));
    const meta = await (await fetch(`${base}/api/meta`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Pinned Boat', symbol: 'pboat', description: 'float', image: img.url, links: { x: 'https://x.com/boat' } }) })).json();
    assert.ok(meta.pinned && meta.uri.startsWith('ipfs://bafy') && meta.meta.image === img.ipfs && meta.hosted.endsWith(`/m/${meta.key}.json`), 'the record names the pinned picture by its cid and is itself pinned: ' + JSON.stringify(meta));
    assert.equal(pins.length, 2); assert.ok(pins.every(p => p.api === 'v3')); const hosted = await (await fetch(`${base}/m/${meta.key}.json`)).json(); assert.equal(hosted.image, img.ipfs);
    // the same server resolves the ipfs uri to the record it kept, and the picture to its own copy
    const recs = JSON.parse(fs.readFileSync(path.join(dataDir, 'halcyon-meta.json'), 'utf8')); assert.ok(recs[meta.uri.slice(7)] && recs[meta.key], 'kept under the cid and under the key');
    const imgs = JSON.parse(fs.readFileSync(path.join(dataDir, 'halcyon-images.json'), 'utf8')); assert.ok(Object.values(imgs).some(v => v.cid === img.ipfs.slice(7) && v.ext === 'svg'));
    // a key for the old API: the upload endpoint says 404, the pinning endpoint takes it
    v3 = false; const img2 = await (await fetch(`${base}/api/image`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) })).json(); assert.ok(img2.pinned && img2.ipfs.startsWith('ipfs://Qm'), JSON.stringify(img2)); assert.equal(pins[pins.length - 1].api, 'legacy');
    // a foreign ipfs uri: fetched through the gateway once, cleaned and kept
    const foreign = { name: 'Elsewhere', symbol: 'ELSE', description: 'launched through another front end', image: 'https://a.b/else.png', links: { site: 'https://else.example' } }; pins.push({ api: 'gw', cid: 'bafyelsewhere', record: foreign }); process.env.PINATA_GATEWAY_URL = `${fakeBase}/ipfs/`;
    const fetched = await META.fetchMeta('ipfs://bafyelsewhere'); assert.ok(fetched && fetched.symbol === 'ELSE'); assert.equal(META.recordOf('ipfs://bafyelsewhere').name, 'Elsewhere'); assert.equal(META.imageUrl('https://a.b/else.png'), 'https://a.b/else.png'); assert.equal(await META.fetchMeta('ipfs://bafyelsewhere'), null, 'once is enough');
    assert.equal(await META.fetchMeta('ipfs://bafynothere'), null); assert.equal(META.recordOf('ipfs://bafynothere'), null);
  } finally { child.kill('SIGTERM'); fake.close(); }
});

fs.rmSync(tmp, { recursive: true, force: true });
fs.writeSync(1, `\n${n} module checks passed.\n`);
process.exit(0);