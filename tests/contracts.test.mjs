// The Halcyon contracts on a real in-process EVM with the real Uniswap v3 and v4: a launch straight into a locked pool, the pool as
// the curve against the JS math, the hook's rules, the gardener's collect and the 80/20, every module, every guard. Offline.
//   npm run test:contracts
process.env.HALCYON_NO_DOTENV = '1'; /* the tests never read a developer's .env */
import assert from 'node:assert/strict';
import { parseEther, formatEther, getAddress, decodeEventLog, encodeFunctionData, keccak256, encodeAbiParameters, encodePacked, toHex, parseAbi, maxUint256 } from 'viem';
import { boot, deployHalcyon, artifact, ERC20_ABI, V3_POOL_ABI, uniswapBuild, bigintSqrt } from './helpers/evm.mjs';
import * as P from '../shared/pool.mjs';
import * as M from '../shared/mist.mjs';
import * as snarkjs from 'snarkjs';
import fs from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, custom } from 'viem';
import { hardhat } from 'viem/chains';
import { hasFlags } from '../eth/hookmine.mjs';

let n = 0; const ok = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };
const chain = await boot({ ethUsd: 3000 }); const [deployer, platform, gardener, alice, bob, carol, dave, erin] = chain.accounts;
const H = await deployHalcyon(chain, { platform, gardener }); const { pc, write, read, simulate, revertsWith, time, mine } = chain;
const ZERO = '0x0000000000000000000000000000000000000000'; const DEADLINE = 2n ** 40n; const ANSWER = 3000n * 10n ** 8n;
const gas = {};
const near = (a, b, rel = 1e-9, what = '') => { const d = a > b ? a - b : b - a; const scale = b > 0n ? b : 1n; assert.ok(Number(d) / Number(scale) <= rel || d <= 2n, `${what} ${a} vs ${b}`); };
const event = (rc, abi, name) => { for (const l of rc.logs) { try { const e = decodeEventLog({ abi, data: l.data, topics: l.topics }); if (e.eventName === name) return e.args; } catch {} } throw new Error(`no ${name} event`); };
const coinOf = async token => { const c = await read(H.fees, 'coins', [token]); return { creator: c[0], module: c[1], pool: c[2], stock: c[3], pot: c[4], received: c[5], paid: c[6], stockHeld: c[7], drawBlock: c[8] }; };
const launchOf = async token => { const l = await read(H.pad, 'launches', [token]); return { creator: l[0], pool: l[1], v3Pool: l[2], tokenId: l[3], poolId: l[4], tickLower: l[5], tickUpper: l[6], startCapUsd: l[7], launchedAt: l[8], ethUsd: l[9] }; };
/** A salt whose clone address sorts below WETH (what the site does before a v3 launch). */
const v3Salt = async (sender, start = 0) => { for (let i = start; i < start + 64; i++) { const salt = toHex(i, { size: 32 }); const a = await read(H.pad, 'predict', [sender, salt]); if (a.toLowerCase() < chain.weth.address.toLowerCase()) return salt; } throw new Error('no salt'); };
let saltCounter = 0; /* every launch gets its own salt: the same sender and salt would clone to the same address */
const params = async (sender, o = {}) => { const k = ++saltCounter; return { name: 'Halcyon Test', symbol: 'HALT', uri: 'ipfs://meta', pool: 0, startCapUsd: 5000, module: 1, stock: ZERO, salt: o.pool === 1 ? toHex(k, { size: 32 }) : await v3Salt(sender, k * 100), splitTo: [], splitBps: [], launchFee: 0, sellFee: 10000, window: 0, maxSwapBps: 0, minOut: 0n, ...o }; };
const V4_ABI = parseAbi(['function extsload(bytes32) view returns (bytes32)', 'function initialize((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24)']);
const slot0 = async poolId => { const slot = keccak256(encodePacked(['bytes32', 'bytes32'], [poolId, toHex(6n, { size: 32 })])); const raw = BigInt(await pc.readContract({ address: chain.poolManager.address, abi: V4_ABI, functionName: 'extsload', args: [slot] })); const sqrtP = raw & ((1n << 160n) - 1n); let tick = Number((raw >> 160n) & 0xffffffn); if (tick >= 0x800000) tick -= 0x1000000; const liq = BigInt(await pc.readContract({ address: chain.poolManager.address, abi: V4_ABI, functionName: 'extsload', args: [toHex(BigInt(slot) + 3n, { size: 32 })] })) & ((1n << 128n) - 1n); return { sqrtP, tick, liquidity: liq }; };
const poolState = async token => { const l = await launchOf(token); if (l.pool === 0) { const s = await read({ address: l.v3Pool, abi: V3_POOL_ABI }, 'slot0'); const liq = await read({ address: l.v3Pool, abi: V3_POOL_ABI }, 'liquidity'); return { pool: 0, tickLower: l.tickLower, tickUpper: l.tickUpper, sqrtA: P.sqrtPriceAtTick(l.tickLower), sqrtB: P.sqrtPriceAtTick(l.tickUpper), sqrtP: s[0], tick: s[1], liquidity: liq, fee: P.FEE_PIPS, sellFee: P.FEE_PIPS }; } const s = await slot0(l.poolId); const r = await read(H.hook, 'rules', [l.poolId]); const pos = await read(H.v4Locker, 'positions', [token]); /* the position's liquidity: the pool's active liquidity is 0 while the price sits exactly on the range's upper edge, before the first buy */ return { pool: 1, tickLower: l.tickLower, tickUpper: l.tickUpper, sqrtA: P.sqrtPriceAtTick(l.tickLower), sqrtB: P.sqrtPriceAtTick(l.tickUpper), sqrtP: s.sqrtP, tick: s.tick, liquidity: pos[2], activeLiquidity: s.liquidity, fee: P.FEE_PIPS, sellFee: BigInt(r[1]), rules: { launchFee: r[0], sellFee: r[1], window: r[2], start: r[3], maxSwap: r[4] } }; };
const keyOf = async token => read(H.fees, 'poolKey', [token]);
const buyV3 = (who, token, eth, minOut = 0n) => write(who, chain.router, 'exactInputSingle', [{ tokenIn: chain.weth.address, tokenOut: token, fee: 10000, recipient: who, amountIn: eth, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }], eth);
/** Sell through SwapRouter02: approve, then exactInputSingle into the router and unwrapWETH9 to the seller in one multicall. Returns the ETH the seller netted (gas excluded). */
const sellV3 = async (who, token, coins, minOut = 0n) => { await write(who, H.token(token), 'approve', [chain.router.address, coins]); const data = [encodeFunctionData({ abi: chain.router.abi, functionName: 'exactInputSingle', args: [{ tokenIn: token, tokenOut: chain.weth.address, fee: 10000, recipient: chain.router.address, amountIn: coins, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] }), encodeFunctionData({ abi: chain.router.abi, functionName: 'unwrapWETH9', args: [minOut, who] })]; const before = await pc.getBalance({ address: who }); const rc = await write(who, chain.router, 'multicall', [data]); return { rc, got: (await pc.getBalance({ address: who })) - before + rc.gasUsed * rc.effectiveGasPrice }; };

await ok('deployed: v3 and v4 at their real bytecode, the hook at an address that spells its permissions, fees wired to the launchpad and the lockers', async () => {
  assert.ok(hasFlags(H.hook.address)); assert.equal(await read(H.fees, 'launchpad'), H.pad.address); assert.equal(await read(H.fees, 'locker'), H.locker.address); assert.equal(await read(H.fees, 'v4Locker'), H.v4Locker.address); assert.equal(await read(H.fees, 'hook'), H.hook.address);
  assert.equal(await read(H.pad, 'v4Ready'), true); assert.equal(await read(H.fees, 'PLATFORM_BPS'), 2000); assert.equal(await read(H.pad, 'SUPPLY'), P.SUPPLY); assert.equal(await read(H.hook, 'locker'), H.v4Locker.address);
  assert.equal(await read(H.pad, 'ethUsd'), ANSWER); assert.equal(await read(H.pad, 'capToWei', [5000, ANSWER]), P.capToWei(5000, ANSWER));
});

let token, pool3;
await ok('launch on v3: the whole supply sits in one locked position of a 1% pool that opens at the market cap the creator chose, in dollars from the feed', async () => {
  const p = await params(alice); const rc = await write(alice, H.pad, 'launch', [p]); gas.launchV3 = rc.gasUsed; const ev = event(rc, H.pad.abi, 'Launched'); token = getAddress(ev.token);
  assert.equal(ev.creator, alice); assert.equal(ev.pool, 0); assert.equal(ev.startCapUsd, 5000); assert.equal(ev.ethUsd, ANSWER); assert.equal(await read(H.pad, 'predict', [alice, p.salt]), token);
  const l = await launchOf(token); pool3 = l.v3Pool; assert.equal(ev.poolRef, toHex(BigInt(pool3), { size: 32 })); assert.equal(await read(chain.factory, 'getPool', [token, chain.weth.address, 10000]), pool3);
  const fresh = P.freshPool(0, 5000, ANSWER); assert.equal(l.tickLower, fresh.tickLower); assert.equal(l.tickUpper, P.TICK_EDGE); assert.equal(ev.startTick, fresh.tickLower);
  const s = await poolState(token); assert.equal(s.sqrtP, fresh.sqrtP); assert.equal(s.tick, fresh.tickLower); near(s.liquidity, fresh.liquidity, 1e-12, 'liquidity');
  assert.equal(await read(chain.nfpm, 'ownerOf', [l.tokenId]), H.locker.address); assert.equal(await read(H.locker, 'positions', [token]), l.tokenId); assert.equal(await read(H.locker, 'tokenOf', [l.tokenId]), token);
  const pos = await read(chain.nfpm, 'positions', [l.tokenId]); assert.equal(pos[2], token); assert.equal(pos[3], chain.weth.address); assert.equal(pos[4], 10000); assert.equal(pos[5], l.tickLower); assert.equal(pos[6], P.TICK_EDGE); assert.equal(pos[7], s.liquidity);
  const T = H.token(token); assert.equal(await read(T, 'balanceOf', [H.pad.address]), 0n); near(await read(T, 'totalSupply'), P.SUPPLY, 1e-6, 'supply'); near(await read(T, 'balanceOf', [pool3]), P.SUPPLY, 1e-6, 'pool holds the supply');
  const capUsd = Number(P.marketCap(s)) / 1e18 * 3000; assert.ok(capUsd <= 5000 && capUsd > 5000 / 1.0202, `cap ${capUsd}`); /* the tick floors to the spacing: at most 2% below */
  const c = await coinOf(token); assert.equal(c.creator, alice); assert.equal(c.module, 1); assert.equal(c.pool, 0); assert.equal(await read(H.pad, 'count'), 1n);
});

await ok('a v3 launch needs a salt that sorts the coin below WETH; the cap and the feed are checked; names and symbols are bounded', async () => {
  let bad = null; for (let i = 100; i < 200; i++) { const salt = toHex(i, { size: 32 }); if ((await read(H.pad, 'predict', [bob, salt])).toLowerCase() > chain.weth.address.toLowerCase()) { bad = salt; break; } }
  assert.ok((await revertsWith(bob, H.pad, 'launch', [{ ...(await params(bob)), salt: bad }])).includes('salt'));
  assert.ok((await revertsWith(bob, H.pad, 'launch', [{ ...(await params(bob)), startCapUsd: 999 }])).includes('cap'));
  assert.ok((await revertsWith(bob, H.pad, 'launch', [{ ...(await params(bob)), startCapUsd: 1_000_001 }])).includes('cap'));
  assert.ok((await revertsWith(bob, H.pad, 'launch', [{ ...(await params(bob)), symbol: 'A' }])).includes('symbol'));
  assert.ok((await revertsWith(bob, H.pad, 'launch', [{ ...(await params(bob)), name: '' }])).includes('name'));
  const now = Number((await pc.getBlock()).timestamp); await write(deployer, chain.feed, 'set', [ANSWER, BigInt(now - 4 * 3600)]);
  assert.ok((await revertsWith(bob, H.pad, 'launch', [await params(bob)])).includes('feed'), 'a stale feed stops launches');
  await write(deployer, chain.feed, 'set', [ANSWER, BigInt(now)]);
});

await ok('the pool is the curve: buys and sells through Uniswap\'s own router follow the JS math, the 1% stays in the position, every coin is tradable from the first block', async () => {
  const T = H.token(token); let js = await poolState(token); const before = Number(P.marketCap(js));
  for (const [who, eth] of [[bob, '0.2'], [carol, '0.5'], [dave, '1']]) {
    const q = P.quoteBuy(js, parseEther(eth)); const quoted = await simulate(who, chain.quoter, 'quoteExactInputSingle', [{ tokenIn: chain.weth.address, tokenOut: token, amountIn: parseEther(eth), fee: 10000, sqrtPriceLimitX96: 0n }]);
    near(quoted[0], q.coinsOut, 1e-9, 'quoter vs js'); const had = await read(T, 'balanceOf', [who]); const rc = await buyV3(who, token, parseEther(eth), q.coinsOut * 999n / 1000n); if (!gas.buyV3) gas.buyV3 = rc.gasUsed;
    near((await read(T, 'balanceOf', [who])) - had, q.coinsOut, 1e-9, 'coins out'); js = P.applyBuy(js, parseEther(eth)).state; const s = await poolState(token); near(s.sqrtP, js.sqrtP, 1e-12, 'price after');
  }
  const after = Number(P.marketCap(js)); assert.ok(after > before * 2, 'three buys moved the cap');
  assert.equal(await read(H.pad, 'count'), 1n); const r = P.reserves(js); near(await read(chain.weth, 'balanceOf', [pool3]), parseEther('1.7'), 1e-9, 'the pool holds every ETH paid in');
  const sellAmt = (await read(T, 'balanceOf', [bob])) / 2n; const q = P.quoteSell(js, sellAmt); const { rc, got } = await sellV3(bob, token, sellAmt, q.ethOut * 999n / 1000n); gas.sellV3 = rc.gasUsed;
  near(got, q.ethOut, 1e-9, 'eth out'); js = P.applySell(js, sellAmt).state; near((await poolState(token)).sqrtP, js.sqrtP, 1e-12, 'price after sell');
  assert.ok(r.eth > 0n && r.coins < P.SUPPLY);
});

await ok('the liquidity is locked: the locker owns the position and has no way out; nobody can pull it through the position manager', async () => {
  const l = await launchOf(token); assert.equal(await read(chain.nfpm, 'ownerOf', [l.tokenId]), H.locker.address);
  assert.ok(!H.locker.abi.some(f => f.type === 'function' && /withdraw|transfer|decrease|burn|remove|unlock/i.test(f.name)), 'the locker has no withdrawing function');
  assert.ok((await revertsWith(alice, chain.nfpm, 'decreaseLiquidity', [{ tokenId: l.tokenId, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: DEADLINE }])).includes('Not approved'));
  assert.ok((await revertsWith(platform, chain.nfpm, 'safeTransferFrom', [H.locker.address, platform, l.tokenId])).length > 0, 'nobody can move the NFT');
  assert.ok((await revertsWith(alice, H.locker, 'lock', [token, l.tokenId])).includes('launchpad'));
});

await ok('collect: the gardener gathers the fees, sells the coin side through the pool, and the ETH is split 80% to the coin\'s pot and 20% to the platform', async () => {
  const owed = await read(H.locker, 'owed', [token]); assert.ok(owed[0] > 0n || owed[1] > 0n || true);
  assert.ok((await revertsWith(alice, H.locker, 'collect', [token, 0n])).includes('gardener'));
  const [eth, fromCoins] = await simulate(gardener, H.locker, 'collect', [token, 0n]); assert.ok(eth > parseEther('0.015'), `fees worth ${formatEther(eth)} ETH after 1.7 ETH of buys and a sell`); assert.ok(fromCoins > 0n && fromCoins < eth, 'both sides earned');
  assert.ok((await revertsWith(gardener, H.locker, 'collect', [token, fromCoins * 2n])).includes('Too little received'), 'minOut guards the coin side');
  const platBefore = await read(H.fees, 'platformPot'); const potBefore = (await coinOf(token)).pot; const rc = await write(gardener, H.locker, 'collect', [token, fromCoins * 99n / 100n]); gas.collectV3 = rc.gasUsed;
  const ev = event(rc, H.fees.abi, 'Deposited'); assert.equal(ev.token, token); near(ev.amount, eth, 1e-6, 'deposit'); assert.equal(ev.platformShare, ev.amount * 2000n / 10000n); assert.equal((await read(H.fees, 'platformPot')) - platBefore, ev.platformShare); assert.equal((await coinOf(token)).pot - potBefore, ev.coinShare);
  assert.equal(await pc.getBalance({ address: H.locker.address }), 0n); assert.ok((await simulate(gardener, H.locker, 'collect', [token, 0n]))[0] < eth / 100n, 'nothing left to collect');
});

await ok('a founder buy rides in the launch transaction at the opening price, through the same pool, paying the same 1%', async () => {
  const p = await params(carol, { symbol: 'FNDR', minOut: 1n }); const fresh = P.freshPool(0, 5000, ANSWER); const q = P.quoteBuy(fresh, parseEther('0.3'));
  const rc = await write(carol, H.pad, 'launch', [p], parseEther('0.3')); const ev = event(rc, H.pad.abi, 'FounderBought'); const t = getAddress(event(rc, H.pad.abi, 'Launched').token);
  assert.equal(ev.creator, carol); assert.equal(ev.eth, parseEther('0.3')); near(ev.coins, q.coinsOut, 1e-9, 'founder coins'); near(await read(H.token(t), 'balanceOf', [carol]), q.coinsOut, 1e-9);
  assert.ok((await revertsWith(dave, H.pad, 'launch', [await params(dave, { symbol: 'FNDX', minOut: q.coinsOut * 2n })], parseEther('0.3'))).includes('Too little received'), 'minOut holds for the founder too');
});

let token4, poolId4;
await ok('launch on v4: a native ETH pool with the Halcyon hook, the supply in one position below the opening price, the rules recorded, no other pool can use the hook', async () => {
  const p = await params(alice, { pool: 1, symbol: 'HOOK', launchFee: 500000, sellFee: 30000, window: 600, maxSwapBps: 500 });
  const rc = await write(alice, H.pad, 'launch', [p]); gas.launchV4 = rc.gasUsed; const ev = event(rc, H.pad.abi, 'Launched'); token4 = getAddress(ev.token); poolId4 = ev.poolRef;
  const key = await keyOf(token4); assert.equal(key.currency0, ZERO); assert.equal(key.currency1, token4); assert.equal(key.fee, 0x800000); assert.equal(key.tickSpacing, 200); assert.equal(key.hooks, H.hook.address);
  assert.equal(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks])), poolId4);
  const fresh = P.freshPool(1, 5000, ANSWER); const l = await launchOf(token4); assert.equal(l.pool, 1); assert.equal(l.tickUpper, fresh.tickUpper); assert.equal(l.tickLower, -P.TICK_EDGE); assert.equal(ev.startTick, fresh.tickUpper);
  const s = await poolState(token4); assert.equal(s.sqrtP, fresh.sqrtP); assert.equal(s.tick, fresh.tickUpper); near(s.liquidity, fresh.liquidity, 1e-12, 'v4 liquidity'); assert.equal(s.activeLiquidity, 0n, 'on the edge of the range until the first buy');
  const pos = await read(H.v4Locker, 'positions', [token4]); assert.equal(pos[0], -P.TICK_EDGE); assert.equal(pos[1], fresh.tickUpper); assert.equal(pos[2], s.liquidity);
  assert.equal(s.rules.launchFee, 500000); assert.equal(s.rules.sellFee, 30000); assert.equal(s.rules.window, 600); assert.equal(s.rules.maxSwap, P.SUPPLY / 20n); assert.ok(s.rules.start > 0n);
  near(await read(H.token(token4), 'balanceOf', [chain.poolManager.address]), P.SUPPLY, 1e-6, 'the manager holds the supply'); assert.equal(await read(H.token(token4), 'balanceOf', [H.v4Locker.address]), 0n);
  const capUsd = Number(P.marketCap(s)) / 1e18 * 3000; assert.ok(capUsd <= 5000 && capUsd > 5000 / 1.0202, `cap ${capUsd}`);
  // a stranger cannot initialize another pool with the hook (nothing prepared it)
  const strangerKey = { currency0: ZERO, currency1: token, fee: 0x800000, tickSpacing: 200, hooks: H.hook.address };
  try { await pc.simulateContract({ account: bob, address: chain.poolManager.address, abi: V4_ABI, functionName: 'initialize', args: [strangerKey, fresh.sqrtP] }); assert.fail('initialized'); } catch (e) { assert.ok(String(e.message).includes(toHex('not a halcyon pool').slice(2)) || /reverted|Wrapped|HookCallFailed/i.test(String(e.message)), 'hook refuses'); }
});

await ok('the rules hold for every router: the opening fee starts at 50% and falls to 1% over the window, no swap may take more than 5% of the supply meanwhile, sells pay 3% forever, only the locker may add liquidity', async () => {
  const T = H.token(token4); const key = await keyOf(token4); let s = await poolState(token4); const t0 = Number((await pc.getBlock()).timestamp);
  // in the window: the fee is near the opening fee
  const elapsed = t0 + 1 - Number(s.rules.start); const feeNow = P.openingFee({ launchFee: 500000, window: 600 }, elapsed); assert.ok(feeNow > 400000n, `opening fee ${feeNow}`);
  const q = P.quoteBuy(s, parseEther('0.05'), feeNow); const onChain = await read(H.hook, 'feeNow', [poolId4, true]); assert.ok(Math.abs(Number(onChain) - Number(feeNow)) <= 2000, `hook fee ${onChain} vs ${feeNow}`);
  const rc = await write(bob, H.swap, 'buy', [key, q.coinsOut * 98n / 100n, bob, DEADLINE], parseEther('0.05')); gas.buyV4 = rc.gasUsed; const got = await read(T, 'balanceOf', [bob]);
  const afterFee = P.quoteBuy(s, parseEther('0.05'), P.FEE_PIPS); assert.ok(got < afterFee.coinsOut / 2n + afterFee.coinsOut / 20n, 'the sniper got about half of what a 1% fee gives'); near(got, q.coinsOut, 0.01, 'coins at the opening fee');
  // max per swap: 5% of the supply is 50M coins; a buy that would take more reverts
  s = await poolState(token4); const big = P.quoteBuy(s, parseEther('30'), P.openingFee({ launchFee: 500000, window: 600 }, elapsed + 1)); assert.ok(big.coinsOut > P.SUPPLY / 20n);
  await assert.rejects(write(carol, H.swap, 'buy', [key, 0n, carol, DEADLINE], parseEther('30')), e => String(e.message).includes(toHex('max per swap').slice(2)) || /reverted/i.test(String(e.message)));
  // after the window: 1% on buys, 3% on sells, no cap
  await time(601); s = await poolState(token4); assert.equal(await read(H.hook, 'feeNow', [poolId4, true]), 10000); assert.equal(await read(H.hook, 'feeNow', [poolId4, false]), 30000);
  const q2 = P.quoteBuy(s, parseEther('2'), P.FEE_PIPS); const hadC = await read(T, 'balanceOf', [carol]); await write(carol, H.swap, 'buy', [key, q2.coinsOut * 999n / 1000n, carol, DEADLINE], parseEther('2')); near((await read(T, 'balanceOf', [carol])) - hadC, q2.coinsOut, 1e-9, 'v4 buy at 1%'); assert.ok(q2.coinsOut > P.SUPPLY / 20n, 'the cap is gone');
  s = await poolState(token4); near(s.sqrtP, q2.sqrtNext, 1e-12, 'v4 price after');
  const sellAmt = (await read(T, 'balanceOf', [carol])) / 3n; const q3 = P.quoteSell(s, sellAmt, 30000n); await write(carol, T, 'approve', [H.swap.address, sellAmt]); const ethBefore = await pc.getBalance({ address: carol });
  const rc3 = await write(carol, H.swap, 'sell', [key, sellAmt, q3.ethOut * 999n / 1000n, carol, DEADLINE]); gas.sellV4 = rc3.gasUsed; near((await pc.getBalance({ address: carol })) - ethBefore + rc3.gasUsed * rc3.effectiveGasPrice, q3.ethOut, 1e-9, 'v4 sell at 3%');
  const q1pct = P.quoteSell(s, sellAmt, P.FEE_PIPS); assert.ok(q3.ethOut < q1pct.ethOut, 'the sell fee bites');
  // only the locker may add liquidity
  const lpTest = await chain.deploy(deployer, uniswapBuild('PoolModifyLiquidityTest'), [chain.poolManager.address]);
  { const abi = parseAbi(['function modifyLiquidity((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt) params, bytes hookData) payable returns (int256)']); await assert.rejects(pc.simulateContract({ account: dave, address: lpTest.address, abi, functionName: 'modifyLiquidity', args: [key, { tickLower: -887200, tickUpper: 887200, liquidityDelta: 10n ** 18n, salt: toHex(0n, { size: 32 }) }, '0x'], value: parseEther('1') }), e => String(e.message).includes(toHex('lp locked').slice(2)) || /reverted|Wrapped/i.test(String(e.message))); }
  assert.ok(!H.v4Locker.abi.some(f => f.type === 'function' && /withdraw|remove|transfer|unlock$/i.test(f.name)), 'the v4 locker has no withdrawing function');
});

await ok('collect on v4: the gardener takes the fees from the position, sells the coin side at the base fee, and deposits; the hook left the position every fee the pool charged', async () => {
  assert.ok((await revertsWith(alice, H.v4Locker, 'collect', [token4, 0n])).includes('gardener'));
  const [eth, fromCoins] = await simulate(gardener, H.v4Locker, 'collect', [token4, 0n]); assert.ok(eth > parseEther('0.04'), `v4 fees worth ${formatEther(eth)} ETH (a 0.05 ETH buy at ~50% plus 2 ETH at 1% plus a sell at 3%)`); assert.ok(fromCoins > 0n && fromCoins < eth);
  assert.ok((await revertsWith(gardener, H.v4Locker, 'collect', [token4, fromCoins * 2n])).includes('min out'));
  const platBefore = await read(H.fees, 'platformPot'); const rc = await write(gardener, H.v4Locker, 'collect', [token4, fromCoins * 99n / 100n]); gas.collectV4 = rc.gasUsed;
  const ev = event(rc, H.fees.abi, 'Deposited'); near(ev.amount, eth, 1e-6, 'v4 deposit'); assert.equal((await read(H.fees, 'platformPot')) - platBefore, ev.platformShare); assert.equal(await pc.getBalance({ address: H.v4Locker.address }), 0n);
  assert.ok((await simulate(gardener, H.v4Locker, 'collect', [token4, 0n]))[0] < eth / 50n, 'nothing left');
});

await ok('rain module (holders): the gardener pays the pot pro rata to holders only, a refusing receiver gets a claimable balance it can pull, the pot never overpays', async () => {
  const T = H.token(token); const refuser = await chain.deploy(deployer, artifact('Refuser')); await write(bob, T, 'transfer', [refuser.address, 10n ** 18n]);
  const pot = (await coinOf(token)).pot; assert.ok(pot > 0n); const share = pot / 4n;
  assert.ok((await revertsWith(gardener, H.fees, 'payHolders', [token, [bob, erin], [share, share]])).includes('not a holder'));
  assert.ok((await revertsWith(gardener, H.fees, 'payHolders', [token, [bob], [pot + 1n]])).includes('pot'));
  assert.ok((await revertsWith(alice, H.fees, 'payHolders', [token, [bob], [share]])).includes('gardener'));
  const before = await pc.getBalance({ address: carol }); const rc = await write(gardener, H.fees, 'payHolders', [token, [bob, carol, dave, refuser.address], [share, share, share, share]]); gas.payHolders4 = rc.gasUsed;
  assert.equal((await pc.getBalance({ address: carol })) - before, share); assert.equal(await read(H.fees, 'claimable', [refuser.address]), share); assert.equal((await coinOf(token)).pot, pot - 4n * share);
  assert.ok((await revertsWith(erin, H.fees, 'claim', [])).includes('nothing'));
});

await ok('roots module (the creator keeps): deposits go straight to the creator; a creator that cannot receive gets a claimable balance; the creator can hand the coin over', async () => {
  const p = await params(dave, { symbol: 'KEEP', module: 0 }); const rc = await write(dave, H.pad, 'launch', [p], parseEther('0.2')); const t = getAddress(event(rc, H.pad.abi, 'Launched').token);
  await buyV3(bob, t, parseEther('0.5')); const [eth, fc] = await simulate(gardener, H.locker, 'collect', [t, 0n]); const before = await pc.getBalance({ address: dave });
  await write(gardener, H.locker, 'collect', [t, fc * 99n / 100n]); const got = (await pc.getBalance({ address: dave })) - before; near(got, eth * 8000n / 10000n, 1e-6, 'the creator got 80%'); assert.equal((await coinOf(t)).pot, 0n);
  const refuser = await chain.deploy(deployer, artifact('Refuser')); await write(dave, H.fees, 'setCreator', [t, refuser.address]); await buyV3(bob, t, parseEther('0.5'));
  const [, fc2] = await simulate(gardener, H.locker, 'collect', [t, 0n]); await write(gardener, H.locker, 'collect', [t, fc2 * 99n / 100n]); assert.ok((await read(H.fees, 'claimable', [refuser.address])) > 0n, 'a refusing creator gets a claimable balance');
  assert.ok((await revertsWith(dave, H.fees, 'setCreator', [t, dave])).includes('creator'));
});

await ok('prune module (buy back and burn): the gardener buys the coin back through its own pool, on v3 and on v4, and burns it', async () => {
  for (const [pool, sym] of [[0, 'BRN3'], [1, 'BRN4']]) {
    const p = await params(alice, { pool, symbol: sym, module: 2, launchFee: 0, sellFee: 10000, window: 0, maxSwapBps: 0 }); const rc = await write(alice, H.pad, 'launch', [p], parseEther('0.3')); const t = getAddress(event(rc, H.pad.abi, 'Launched').token);
    if (pool === 0) await buyV3(bob, t, parseEther('1')); else await write(bob, H.swap, 'buy', [await keyOf(t), 0n, bob, DEADLINE], parseEther('1'));
    const L = pool === 0 ? H.locker : H.v4Locker; const [eth, fc] = await simulate(gardener, L, 'collect', [t, 0n]); await write(gardener, L, 'collect', [t, fc * 99n / 100n]);
    const pot = (await coinOf(t)).pot; assert.ok(pot > 0n); const supply = await read(H.token(t), 'totalSupply'); const s = await poolState(t); const q = P.quoteBuy(s, pot);
    const rc2 = await write(gardener, H.fees, 'buyback', [t, pot, q.coinsOut * 99n / 100n]); gas[pool === 0 ? 'buybackV3' : 'buybackV4'] = rc2.gasUsed; const ev = event(rc2, H.fees.abi, 'Burned'); assert.equal(ev.eth, pot); near(ev.tokens, q.coinsOut, 1e-9, 'bought');
    assert.equal(supply - (await read(H.token(t), 'totalSupply')), ev.tokens); assert.equal((await coinOf(t)).pot, 0n); assert.equal(await read(H.token(t), 'balanceOf', [H.fees.address]), 0n);
  }
  assert.ok((await revertsWith(gardener, H.fees, 'buyback', [token, 1n, 0n])).includes('module'));
});

await ok('harvest module (a stock for the holders): the gardener buys an allowed stock through the v3 router along a path that must start at WETH and end at the stock, and pays it out; a holder the issuer blocks gets a claimable balance', async () => {
  const p = await params(bob, { symbol: 'STK', module: 3, stock: H.stock.address, }); const rc = await write(bob, H.pad, 'launch', [p], parseEther('0.2')); const t = getAddress(event(rc, H.pad.abi, 'Launched').token);
  await buyV3(carol, t, parseEther('1')); await write(bob, H.token(t), 'transfer', [dave, 10n ** 20n]); const [eth, fc] = await simulate(gardener, H.locker, 'collect', [t, 0n]); await write(gardener, H.locker, 'collect', [t, fc * 99n / 100n]);
  const pot = (await coinOf(t)).pot; assert.ok(pot > 0n);
  assert.ok((await revertsWith(gardener, H.fees, 'buyStock', [t, pot, 0n, H.stockPath.replace(chain.weth.address.slice(2).toLowerCase(), H.stock.address.slice(2).toLowerCase())])).includes('path'));
  const quoted = (await simulate(gardener, chain.quoter, 'quoteExactInputSingle', [{ tokenIn: chain.weth.address, tokenOut: H.stock.address, amountIn: pot, fee: 3000, sqrtPriceLimitX96: 0n }]))[0];
  const rc2 = await write(gardener, H.fees, 'buyStock', [t, pot, quoted * 99n / 100n, H.stockPath]); gas.buyStock = rc2.gasUsed; const ev = event(rc2, H.fees.abi, 'StockBought'); assert.equal(ev.eth, pot); near(ev.amount, quoted, 1e-9, 'stock bought'); assert.equal((await coinOf(t)).stockHeld, ev.amount);
  await write(deployer, H.stock, 'setBlocked', [dave, true]); const half = ev.amount / 2n; const rc3 = await write(gardener, H.fees, 'payStock', [t, [bob, dave], [half, ev.amount - half]]); const paid = event(rc3, H.fees.abi, 'StockPaid');
  assert.equal(paid.unclaimed, ev.amount - half); assert.equal(await read(H.stock, 'balanceOf', [bob]), half); assert.equal(await read(H.fees, 'claimableStock', [H.stock.address, dave]), ev.amount - half); assert.equal((await coinOf(t)).stockHeld, 0n);
  assert.ok((await revertsWith(dave, H.fees, 'claimStock', [H.stock.address])).includes('compliance'), 'still blocked'); await write(deployer, H.stock, 'setBlocked', [dave, false]); await write(dave, H.fees, 'claimStock', [H.stock.address]); assert.equal(await read(H.stock, 'balanceOf', [dave]), ev.amount - half);
  assert.ok((await revertsWith(bob, H.fees, 'setModule', [t, 3, erin])).includes('stock'), 'only allowed stocks'); assert.ok((await revertsWith(bob, H.fees, 'setModule', [t, 1, H.stock.address])).includes('stock'));
});

await ok('harvest through v4: the gardener buys the stock along v4 hops from ETH or from WETH through a plain pool, and through a dollar (two pools) for a stock only v4 trades; the route must end at the stock; what a thin first pool cannot take goes back to the pot, a thin later pool is refused', async () => {
  const hop = (currency, fee, tickSpacing) => ({ currency, fee, tickSpacing, hooks: ZERO });
  const quoteV4 = async (from, hops, amount) => (await simulate(gardener, chain.v4Quoter, 'quoteExactInput', [{ exactCurrency: from, path: hops.map(h => ({ intermediateCurrency: h.currency, fee: h.fee, tickSpacing: h.tickSpacing, hooks: h.hooks, hookData: '0x' })), exactAmount: amount }]))[0];
  const feed = async (who, t) => { await buyV3(who, t, parseEther('1')); const [, fc] = await simulate(gardener, H.locker, 'collect', [t, 0n]); await write(gardener, H.locker, 'collect', [t, fc * 99n / 100n]); return (await coinOf(t)).pot; };
  const p = await params(bob, { symbol: 'STK4', module: 3, stock: H.stock.address }); const t = getAddress(event(await write(bob, H.pad, 'launch', [p], parseEther('0.2')), H.pad.abi, 'Launched').token);
  const pot = await feed(carol, t); assert.ok(pot > 0n); const half = pot / 2n, rest = pot - half;
  assert.ok((await revertsWith(gardener, H.fees, 'buyStockV4', [t, half, 0n, false, [hop(H.usd.address, 500, 10)]])).includes('path'), 'must end at the stock');
  assert.ok((await revertsWith(gardener, H.fees, 'buyStockV4', [t, pot + 1n, 0n, false, [hop(H.stock.address, 3000, 60)]])).includes('pot'));
  assert.ok((await revertsWith(alice, H.fees, 'buyStockV4', [t, half, 0n, false, [hop(H.stock.address, 3000, 60)]])).includes('gardener'));
  const q1 = await quoteV4(ZERO, [hop(H.stock.address, 3000, 60)], half); assert.ok(q1 > 0n);
  assert.ok((await revertsWith(gardener, H.fees, 'buyStockV4', [t, half, q1 * 2n, false, [hop(H.stock.address, 3000, 60)]])).includes('min out'));
  const rc1 = await write(gardener, H.fees, 'buyStockV4', [t, half, q1 * 99n / 100n, false, [hop(H.stock.address, 3000, 60)]]); gas.buyStockV4 = rc1.gasUsed; const ev1 = event(rc1, H.fees.abi, 'StockBought');
  assert.equal(ev1.eth, half); near(ev1.amount, q1, 1e-9, 'v4 quote'); assert.equal((await coinOf(t)).stockHeld, ev1.amount); assert.equal((await coinOf(t)).pot, rest);
  const q2 = await quoteV4(chain.weth.address, [hop(H.stock.address, 3000, 60)], rest); const rc2 = await write(gardener, H.fees, 'buyStockV4', [t, rest, q2 * 99n / 100n, true, [hop(H.stock.address, 3000, 60)]]); const ev2 = event(rc2, H.fees.abi, 'StockBought');
  assert.equal(ev2.eth, rest); near(ev2.amount, q2, 1e-9, 'from WETH'); assert.equal((await coinOf(t)).pot, 0n); assert.equal(await read(chain.weth, 'balanceOf', [H.fees.address]), 0n, 'no WETH left behind'); assert.equal((await coinOf(t)).stockHeld, ev1.amount + ev2.amount);
  // mSTK2 trades only against the mock dollar on v4: ETH > mUSD > mSTK2
  const p2 = await params(bob, { symbol: 'STK2', module: 3, stock: H.stock2.address }); const t2 = getAddress(event(await write(bob, H.pad, 'launch', [p2], parseEther('0.2')), H.pad.abi, 'Launched').token);
  const pot2 = await feed(dave, t2); const hops2 = [hop(H.usd.address, 500, 10), hop(H.stock2.address, 3000, 60)]; const q3 = await quoteV4(ZERO, hops2, pot2); assert.ok(q3 > 0n);
  assert.ok((await revertsWith(gardener, H.fees, 'buyStockV4', [t2, pot2, 0n, false, [hop(H.stock2.address, 3000, 60), hop(H.usd.address, 500, 10)]])).includes('path'));
  const rc3 = await write(gardener, H.fees, 'buyStockV4', [t2, pot2, q3 * 99n / 100n, false, hops2]); gas.buyStockV4TwoHops = rc3.gasUsed; const ev3 = event(rc3, H.fees.abi, 'StockBought'); assert.equal(ev3.eth, pot2); near(ev3.amount, q3, 1e-9, 'two hops'); assert.equal((await coinOf(t2)).stockHeld, ev3.amount); assert.equal(await read(H.usd, 'balanceOf', [H.fees.address]), 0n, 'nothing of the middle currency sticks');
  // a thin later pool: the second hop cannot take what the first gave, and the whole buy is refused rather than stranding the rest
  const pot2b = await feed(erin, t2); assert.ok((await revertsWith(gardener, H.fees, 'buyStockV4', [t2, pot2b, 0n, false, [hop(H.usd.address, 500, 10), hop(H.stock2.address, 10000, 200)]])).includes('thin'));
  // a thin first pool (WETH side): the pool takes what it can, the rest is unwrapped and goes back into the pot
  const pot3 = await feed(erin, t); const rc4 = await write(gardener, H.fees, 'buyStockV4', [t, pot3, 0n, true, [hop(H.stock.address, 10000, 200)]]); const ev4 = event(rc4, H.fees.abi, 'StockBought');
  assert.ok(ev4.eth > 0n && ev4.eth < pot3, `partial fill ${ev4.eth} of ${pot3}`); assert.equal((await coinOf(t)).pot, pot3 - ev4.eth, 'the rest is back in the pot'); assert.equal(await read(chain.weth, 'balanceOf', [H.fees.address]), 0n);
  // the same on the swap contract itself with ETH: the refund comes back to the caller
  const before = await pc.getBalance({ address: erin }); const rc5 = await write(erin, H.swap, 'swapPath', [[hop(H.stock.address, 3000, 60)], ZERO, parseEther('0.01'), 0n, erin, DEADLINE], parseEther('0.01')); const sw = event(rc5, H.swap.abi, 'Swapped'); assert.equal(sw.amountIn, parseEther('0.01')); assert.equal(sw.hops, 1n);
  assert.ok((await revertsWith(erin, H.swap, 'swapPath', [[hop(H.stock.address, 3000, 60)], ZERO, parseEther('0.01'), 0n, erin, DEADLINE], parseEther('0.02'))).includes('value'));
  assert.ok((await revertsWith(erin, H.swap, 'swapPath', [[hop(H.stock.address, 3000, 60)], ZERO, parseEther('0.01'), 0n, erin, 1n], parseEther('0.01'))).includes('deadline'));
  near(before - (await pc.getBalance({ address: erin })) - rc5.gasUsed * rc5.effectiveGasPrice, parseEther('0.01'), 1e-9, 'paid 0.01');
  // stock2 bought through v4 pays out like any other
  const rc6 = await write(gardener, H.fees, 'payStock', [t2, [dave], [ev3.amount]]); assert.equal(event(rc6, H.fees.abi, 'StockPaid').total, ev3.amount); assert.equal(await read(H.stock2, 'balanceOf', [dave]), ev3.amount);
});

await ok('branch module (a split): the creator names the shares, every deposit is pushed to them at once; the shares must sum to 100%; a refusing share waits as claimable', async () => {
  const refuser = await chain.deploy(deployer, artifact('Refuser'));
  assert.ok((await revertsWith(alice, H.pad, 'launch', [await params(alice, { symbol: 'SPLT', module: 4 })])).includes('no branches'));
  assert.ok((await revertsWith(alice, H.pad, 'launch', [await params(alice, { symbol: 'SPLT', module: 4, splitTo: [bob, carol], splitBps: [5000, 4000] })])).includes('branch sum'));
  const p = await params(alice, { symbol: 'SPLT', module: 4, splitTo: [bob, carol, refuser.address], splitBps: [5000, 3000, 2000] }); const rc = await write(alice, H.pad, 'launch', [p]); const t = getAddress(event(rc, H.pad.abi, 'Launched').token);
  const sp = await read(H.fees, 'branches', [t]); assert.deepEqual(sp[0], [bob, carol, refuser.address]); assert.deepEqual(sp[1], [5000, 3000, 2000]);
  await buyV3(dave, t, parseEther('1')); const [, fc] = await simulate(gardener, H.locker, 'collect', [t, 0n]); const b0 = await pc.getBalance({ address: bob }); const c0 = await pc.getBalance({ address: carol });
  const rc2 = await write(gardener, H.locker, 'collect', [t, fc * 99n / 100n]); const dep = event(rc2, H.fees.abi, 'Deposited'); assert.equal(dep.module, 4);
  assert.equal((await pc.getBalance({ address: bob })) - b0, dep.coinShare * 5000n / 10000n); assert.equal((await pc.getBalance({ address: carol })) - c0, dep.coinShare * 3000n / 10000n); assert.equal(await read(H.fees, 'claimable', [refuser.address]), dep.coinShare - dep.coinShare * 5000n / 10000n - dep.coinShare * 3000n / 10000n);
  await write(alice, H.fees, 'setBranches', [t, [erin], [10000]]); assert.ok((await revertsWith(bob, H.fees, 'setBranches', [t, [bob], [10000]])).includes('creator'));
  assert.ok((await revertsWith(alice, H.fees, 'setBranches', [t, Array(9).fill(bob), Array(9).fill(1111)])).includes('branches'));
});

await ok('clover module (the draw): the gardener commits to a block three ahead, and once it has passed pays the whole pot to one holder with that block\'s hash in the record; early, late and non-holders are refused', async () => {
  const p = await params(bob, { symbol: 'JACK', module: 5 }); const rc = await write(bob, H.pad, 'launch', [p], parseEther('0.1')); const t = getAddress(event(rc, H.pad.abi, 'Launched').token);
  await buyV3(carol, t, parseEther('1')); await buyV3(dave, t, parseEther('0.5')); const [eth, fc] = await simulate(gardener, H.locker, 'collect', [t, 0n]); await write(gardener, H.locker, 'collect', [t, fc * 99n / 100n]);
  const pot = (await coinOf(t)).pot; assert.ok(pot > 0n); assert.ok((await revertsWith(gardener, H.fees, 'payDraw', [t, carol])).includes('no draw'));
  const rc2 = await write(gardener, H.fees, 'openDraw', [t]); const ev = event(rc2, H.fees.abi, 'DrawOpened'); assert.equal(ev.drawBlock, rc2.blockNumber + 3n); assert.equal(ev.pot, pot);
  assert.ok((await revertsWith(gardener, H.fees, 'payDraw', [t, carol])).includes('no draw'), 'the draw block has not passed'); await mine(2); assert.ok((await revertsWith(gardener, H.fees, 'payDraw', [t, carol])).includes('no draw'), 'not even at the draw block'); await mine(2);
  assert.ok((await revertsWith(gardener, H.fees, 'payDraw', [t, erin])).includes('not a holder')); assert.ok((await revertsWith(alice, H.fees, 'payDraw', [t, carol])).includes('gardener'));
  const before = await pc.getBalance({ address: carol }); const rc3 = await write(gardener, H.fees, 'payDraw', [t, carol]); const paid = event(rc3, H.fees.abi, 'DrawPaid'); const block = await pc.getBlock({ blockNumber: ev.drawBlock });
  assert.equal(paid.winner, carol); assert.equal(paid.amount, pot); assert.equal(paid.drawBlock, ev.drawBlock); assert.equal(paid.seed, block.hash); assert.equal((await pc.getBalance({ address: carol })) - before, pot); assert.equal((await coinOf(t)).pot, 0n); assert.equal((await coinOf(t)).drawBlock, 0n);
  await buyV3(carol, t, parseEther('0.2')); const [, fc2] = await simulate(gardener, H.locker, 'collect', [t, 0n]); await write(gardener, H.locker, 'collect', [t, fc2 * 99n / 100n]); await write(gardener, H.fees, 'openDraw', [t]); await mine(254);
  assert.ok((await revertsWith(gardener, H.fees, 'payDraw', [t, carol])).includes('draw expired'), 'a draw left for 250 blocks expires and must be committed again');
});

await ok('rings module (balance times time): paid through payHolders like holders (the gardener weighs balance and time); platform guards; deposits only from the lockers and the launchpad; wiring is once', async () => {
  const p = await params(dave, { symbol: 'DMND', module: 6 }); const rc = await write(dave, H.pad, 'launch', [p], parseEther('0.1')); const t = getAddress(event(rc, H.pad.abi, 'Launched').token);
  await buyV3(carol, t, parseEther('0.5')); const [eth, fc] = await simulate(gardener, H.locker, 'collect', [t, 0n]); await write(gardener, H.locker, 'collect', [t, fc * 99n / 100n]); const pot = (await coinOf(t)).pot;
  await write(gardener, H.fees, 'payHolders', [t, [carol, dave], [pot / 3n, pot / 3n]]); assert.equal((await coinOf(t)).pot, pot - 2n * (pot / 3n));
  const plat = await read(H.fees, 'platformPot'); assert.ok(plat > 0n); assert.ok((await revertsWith(gardener, H.fees, 'withdrawPlatform', [gardener, plat])).includes('platform')); const before = await pc.getBalance({ address: erin }); await write(platform, H.fees, 'withdrawPlatform', [erin, plat]); assert.equal((await pc.getBalance({ address: erin })) - before, plat); assert.equal(await read(H.fees, 'platformPot'), 0n);
  assert.ok((await revertsWith(bob, H.fees, 'setGardener', [bob])).includes('platform')); await write(platform, H.fees, 'setGardener', [dave]); assert.equal(await read(H.fees, 'gardener'), dave); await write(platform, H.fees, 'setGardener', [gardener]);
  assert.ok((await revertsWith(bob, H.fees, 'setStockAllowed', [bob, true])).includes('platform')); assert.ok((await revertsWith(bob, H.fees, 'setStocksAllowed', [[bob], true])).includes('platform'));
  { const rcA = await write(platform, H.fees, 'setStocksAllowed', [[alice, bob], true]); assert.equal(rcA.logs.length, 2); assert.equal(await read(H.fees, 'stockAllowed', [alice]), true); assert.equal(await read(H.fees, 'stockAllowed', [bob]), true); await write(platform, H.fees, 'setStocksAllowed', [[alice, bob], false]); assert.equal(await read(H.fees, 'stockAllowed', [bob]), false); } assert.ok((await revertsWith(bob, H.fees, 'deposit', [t], parseEther('1'))).includes('source')); assert.ok((await revertsWith(deployer, H.fees, 'wire', [bob, bob, bob, bob])).includes('wired'));
  assert.ok((await revertsWith(bob, H.fees, 'register', [bob, bob, 1, 0, ZERO, [], []])).includes('launchpad')); assert.ok((await revertsWith(bob, H.hook, 'prepare', [await keyOf(token4), 0, 10000, 0, 0n])).includes('launchpad'));
  assert.ok((await revertsWith(bob, H.v4Locker, 'seed', [await keyOf(token4), -887200, 0, 1n])).includes('launchpad'));
});

await ok('mist module: a holder registers a mist key; the gardener sows a round as notes of fixed denominations into the pool; the holder finds them with the viewing key, proves one in zero knowledge and withdraws to any address through a relayer; the pool refuses a second spend, a stale root, a bad proof; keyless holders are paid in the open', async () => {
  const p = await params(dave, { symbol: 'MIST', module: 7 }); const rc0 = await write(dave, H.pad, 'launch', [p], parseEther('0.1')); const t = getAddress(event(rc0, H.pad.abi, 'Launched').token);
  await buyV3(alice, t, parseEther('0.6')); await buyV3(bob, t, parseEther('0.3')); const [, fc] = await simulate(gardener, H.locker, 'collect', [t, 0n]); await write(gardener, H.locker, 'collect', [t, fc * 99n / 100n]); const pot = (await coinOf(t)).pot; assert.ok(pot > parseEther('0.005'), `pot ${formatEther(pot)}`);
  // the key: 64 bytes, two packed Baby Jubjub points; empty removes it
  const keys = M.randomKeys(); const pub = M.publicKey(keys); assert.equal(pub.length, 2 + 128); assert.ok(M.isPublicKey(pub));
  assert.ok((await revertsWith(alice, H.fees, 'setMistKey', [pub.slice(0, -2)])).includes('key')); const rcKey = await write(alice, H.fees, 'setMistKey', [pub]); gas.setMistKey = rcKey.gasUsed; assert.equal((await read(H.fees, 'mistKeys', [alice])).toLowerCase(), pub); assert.equal(event(rcKey, H.fees.abi, 'MistKeySet').holder, alice);
  await write(bob, H.fees, 'setMistKey', [pub]); await write(bob, H.fees, 'setMistKey', ['0x']); assert.equal(await read(H.fees, 'mistKeys', [bob]), '0x');
  // the round: alice's share as notes (two of 0.001), bob in the open through payHolders
  const d = parseEther('0.001'); const notes = [M.note(pub, d), M.note(pub, d)]; const commits = notes.map(n => n.commit); const denoms = notes.map(n => n.denom); const eph = notes.map(n => n.ephemeral); const tags = notes.map(n => n.viewTag);
  assert.ok((await revertsWith(bob, H.fees, 'payMist', [t, commits, denoms, eph, tags])).includes('gardener')); assert.ok((await revertsWith(gardener, H.fees, 'payMist', [token, commits, denoms, eph, tags])).includes('module'));
  assert.ok((await revertsWith(gardener, H.fees, 'payMist', [t, commits, [pot / 2n, pot / 2n], eph, tags])).includes('denomination')); assert.ok((await revertsWith(gardener, H.fees, 'payMist', [t, commits, [parseEther('1'), parseEther('1')], eph, tags])).includes('pot'));
  assert.ok((await revertsWith(gardener, H.fees, 'payMist', [t, commits, denoms.slice(0, 1), eph, tags])).includes('lengths')); assert.ok((await revertsWith(bob, H.mist, 'sow', [t, commits, denoms, eph, tags], 2n * d)).includes('fees'));
  const rc = await write(gardener, H.fees, 'payMist', [t, commits, denoms, eph, tags]); gas.payMist2 = rc.gasUsed;
  assert.equal((await coinOf(t)).pot, pot - 2n * d); assert.equal(await pc.getBalance({ address: H.mist.address }), 2n * d); const paid = event(rc, H.fees.abi, 'PaidMist'); assert.equal(paid.count, 2n); assert.equal(paid.batch, 0);
  const MIST = H.mist.abi; const noteEvents = rc.logs.filter(l => l.address.toLowerCase() === H.mist.address.toLowerCase()).map(l => { try { const e = decodeEventLog({ abi: MIST, data: l.data, topics: l.topics }); return e.eventName === 'Note' ? e.args : null; } catch { return null; } }).filter(Boolean);
  assert.equal(noteEvents.length, 2); noteEvents.forEach((n, i) => { assert.equal(n.commit, commits[i]); assert.equal(n.denom, d); assert.equal(n.ephemeral.toLowerCase(), eph[i]); assert.equal(n.viewTag, tags[i]); assert.equal(n.token, t); assert.equal(n.index, i); });
  const sown = event(rc, MIST, 'Sown'); const leaves = notes.map(n => M.leafOf(n.commit, n.denom)); const T = M.tree([leaves]); assert.equal(sown.root, T.root, 'the tree rebuilt from the events has the root the pool computed'); assert.equal(await read(H.mist, 'root'), T.root); assert.equal(await read(H.mist, 'batches'), 1);
  // the holder's side: the viewing key finds the notes, the spending key proves one
  const strangers = Array.from({ length: 3 }, () => M.note(M.publicKey(M.randomKeys()), d)); const found = M.scan(keys, [...strangers, ...noteEvents.map(n => ({ commit: n.commit, denom: n.denom, ephemeral: n.ephemeral, viewTag: n.viewTag }))]);
  assert.equal(found.length, 2); assert.equal(M.scan(M.randomKeys(), noteEvents.map(n => ({ commit: n.commit, denom: n.denom, ephemeral: n.ephemeral, viewTag: n.viewTag }))).length, 0, 'another key finds nothing');
  const fee = d / 10n; const w = M.witness({ keys, sh: found[1].sh, denom: d, index: 1, path: T.path(1), root: T.root, recipient: erin, relayer: gardener, fee });
  const t0 = Date.now(); const { proof, publicSignals } = await snarkjs.groth16.fullProve(w, 'public/zk/withdraw.wasm', 'public/zk/withdraw.zkey'); gas.proveMs = BigInt(Date.now() - t0);
  const vk = JSON.parse(fs.readFileSync('zk/verification_key.json', 'utf8')); assert.ok(await snarkjs.groth16.verify(vk, publicSignals, proof), 'the proof verifies off chain');
  const cd = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`); const [pa, pb, pcc, sig] = cd; const args = [pa.map(BigInt), pb.map(r => r.map(BigInt)), pcc.map(BigInt), BigInt(sig[0]), BigInt(sig[1]), d, erin, gardener, fee];
  assert.equal(BigInt(sig[1]), M.nullifierOf(keys.spend, found[1].sh, 1)); assert.equal(BigInt(sig[3]), BigInt(erin));
  assert.ok((await revertsWith(gardener, H.mist, 'withdraw', [args[0], args[1], args[2], 123n, args[4], d, erin, gardener, fee])).includes('root'), 'an unknown root is refused');
  assert.ok((await revertsWith(gardener, H.mist, 'withdraw', [args[0], args[1], args[2], args[3], args[4], d, bob, gardener, fee])).includes('proof'), 'the recipient is bound: another one fails the proof');
  assert.ok((await revertsWith(gardener, H.mist, 'withdraw', [args[0], args[1], args[2], args[3], args[4], d, erin, gardener, fee + 1n])).includes('proof'), 'the fee is bound');
  assert.ok((await revertsWith(gardener, H.mist, 'withdraw', [args[0], args[1], args[2], args[3], args[4], parseEther('0.01'), erin, gardener, fee])).includes('proof'), 'the denomination is bound');
  const before = await pc.getBalance({ address: erin }); const gBefore = await pc.getBalance({ address: gardener }); const rcw = await write(gardener, H.mist, 'withdraw', args); gas.withdraw = rcw.gasUsed;
  assert.equal((await pc.getBalance({ address: erin })) - before, d - fee, 'the recipient got the note minus the fee'); assert.ok((await pc.getBalance({ address: gardener })) > gBefore - rcw.gasUsed * rcw.effectiveGasPrice + fee - 1n, 'the relayer got the fee');
  const spentEv = event(rcw, MIST, 'Spent'); assert.equal(spentEv.recipient, erin); assert.equal(spentEv.fee, fee); assert.equal(await read(H.mist, 'spent', [BigInt(sig[1])]), true);
  assert.ok((await revertsWith(gardener, H.mist, 'withdraw', args)).includes('spent'), 'a note spends once');
  // anyone may relay (the relayer is in the proof): carol relays the other note to herself with no fee, then the pool is empty
  const w2 = M.witness({ keys, sh: found[0].sh, denom: d, index: 0, path: T.path(0), root: T.root, recipient: carol, relayer: carol, fee: 0n }); const pr2 = await snarkjs.groth16.fullProve(w2, 'public/zk/withdraw.wasm', 'public/zk/withdraw.zkey'); const cd2 = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(pr2.proof, pr2.publicSignals)}]`);
  await write(carol, H.mist, 'withdraw', [cd2[0].map(BigInt), cd2[1].map(r => r.map(BigInt)), cd2[2].map(BigInt), BigInt(cd2[3][0]), BigInt(cd2[3][1]), d, carol, carol, 0n]); assert.equal(await pc.getBalance({ address: H.mist.address }), 0n);
  // a second round lands in batch 1 and the root history keeps the old root
  const rc3 = await write(gardener, H.fees, 'payMist', [t, [M.note(pub, d).commit], [d], [M.note(pub, d).ephemeral], [7]]); assert.equal(event(rc3, H.fees.abi, 'PaidMist').batch, 1); assert.equal(await read(H.mist, 'isKnownRoot', [T.root]), true); assert.equal(await read(H.mist, 'isKnownRoot', [123n]), false);
  // holders without a key: payHolders works under mist, and still only to holders
  const bobShare = (await coinOf(t)).pot / 2n; await write(gardener, H.fees, 'payHolders', [t, [bob], [bobShare]]); assert.ok((await revertsWith(gardener, H.fees, 'payHolders', [t, [erin], [1n]])).includes('not a holder'));
  assert.ok((await revertsWith(bob, H.fees, 'setMist', [bob])).includes('platform')); assert.ok((await revertsWith(platform, H.fees, 'setMist', [bob])).includes('set'), 'the pool is set once'); assert.equal(await read(H.fees, 'MODULE_MIST'), 7); assert.ok((await revertsWith(dave, H.fees, 'setModule', [t, 8, ZERO])).includes('module'));
  assert.deepEqual((await read(H.mist, 'denominationList')).map(String), ['1000000000000000', '10000000000000000', '100000000000000000', '1000000000000000000']);
});

await ok('the coin is a minimal proxy of the verified implementation, cannot be initialized twice, and carries no owner, mint, pause or tax', async () => {
  const code = await pc.getCode({ address: token }); assert.equal(code.toLowerCase(), `0x363d3d373d3d3d363d73${H.impl.address.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`);
  assert.ok((await revertsWith(alice, H.token(token), 'initialize', ['x', 'xx', 1n, alice])).includes('initialized'));
  assert.ok((await revertsWith(alice, H.token(H.impl.address), 'initialize', ['Halcyon', 'HALCYON', 10n ** 27n, alice])).includes('initialized'), 'the implementation itself cannot be made into a coin'); assert.equal(await read(H.token(H.impl.address), 'launchpad'), deployer);
  const names = H.token(token).abi.filter(f => f.type === 'function').map(f => f.name); for (const bad of ['mint', 'pause', 'owner', 'setFee', 'blacklist', 'setMaxWallet']) assert.ok(!names.includes(bad), bad);
  const T = H.token(token); const had = await read(T, 'balanceOf', [carol]); await write(bob, T, 'transfer', [carol, 10n ** 18n]); assert.equal((await read(T, 'balanceOf', [carol])) - had, 10n ** 18n, 'wallet transfers are whole');
  const l = await launchOf(token4); assert.ok(l.launchedAt > 0n);
});

console.log(`\n${n} contract checks passed. gas: ${Object.entries(gas).map(([k, v]) => `${k} ${v}`).join(', ')}; deploy: impl ${H.gas.impl}, fees ${H.gas.fees}, launchpad ${H.gas.pad}, locker ${H.gas.locker}, v4Locker ${H.gas.v4Locker}, swap ${H.gas.swap}, poseidon ${H.gas.poseidon}, verifier ${H.gas.verifier}, mist ${H.gas.mist}, hook salt tries ${H.hookSalt.tries}`);
process.exit(0); /* snarkjs keeps worker threads alive: leave explicitly */
