// The deployed contracts as viem calls: ABIs from the compiled artifacts, addresses from the configuration, and the reads the site and
// the gardener need (a launch, a coin's pot, a pool's price, a quote). Pure helpers at the bottom.
import fs from 'node:fs';
import { parseAbi, encodeFunctionData, getAddress, keccak256, encodePacked, toHex } from 'viem';
import { CONFIG, chainInfo } from './config.mjs';
import { publicClient } from './chain.mjs';
import * as P from '../shared/pool.mjs';

const art = name => JSON.parse(fs.readFileSync(new URL(`../contracts/artifacts/${name}.json`, import.meta.url), 'utf8'));
export const ABI = { launchpad: art('Halcyon').abi, fees: art('HalcyonFees').abi, token: art('HalcyonToken').abi, locker: art('HalcyonLocker').abi, v4Locker: art('HalcyonV4Locker').abi, hook: art('HalcyonHook').abi, swap: art('HalcyonSwap').abi, mist: art('HalcyonMist').abi };
export const ARTIFACT = Object.fromEntries(['HalcyonToken', 'HalcyonFees', 'HalcyonLocker', 'HalcyonV4Locker', 'HalcyonHook', 'HalcyonSwap', 'Halcyon', 'Create2Deployer', 'PoseidonT3', 'MistVerifier', 'HalcyonMist'].map(n => [n, art(n)]));
export const ERC20_ABI = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address, address) view returns (uint256)', 'event Transfer(address indexed from, address indexed to, uint256 value)']);
export const V3_POOL_ABI = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)', 'function liquidity() view returns (uint128)', 'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)']);
export const NFPM_ABI = parseAbi(['function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)', 'function ownerOf(uint256) view returns (address)']);
export const POOL_MANAGER_ABI = parseAbi(['function extsload(bytes32) view returns (bytes32)', 'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)']);
export const QUOTER_ABI = parseAbi(['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)', 'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)']);
export const FEED_ABI = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)', 'function decimals() view returns (uint8)']);
export const DEAD = '0x000000000000000000000000000000000000dEaD';

export const launchpad = () => ({ address: getAddress(CONFIG.launchpad), abi: ABI.launchpad });
export const fees = () => ({ address: getAddress(CONFIG.fees), abi: ABI.fees });
export const locker = () => ({ address: getAddress(CONFIG.locker), abi: ABI.locker });
export const v4Locker = () => ({ address: getAddress(CONFIG.v4Locker), abi: ABI.v4Locker });
export const hook = () => ({ address: getAddress(CONFIG.hook), abi: ABI.hook });
export const swap = () => ({ address: getAddress(CONFIG.swap), abi: ABI.swap });
export const mist = () => ({ address: getAddress(CONFIG.mist), abi: ABI.mist });
export const token = address => ({ address: getAddress(address), abi: ABI.token });
export const poolManager = () => ({ address: getAddress(chainInfo().uniswap.poolManager), abi: POOL_MANAGER_ABI });
export const quoter = () => ({ address: getAddress(chainInfo().uniswap.quoterV2), abi: QUOTER_ABI });
const read = (c, functionName, args = []) => publicClient().readContract({ address: c.address, abi: c.abi, functionName, args });

/** A coin's launch record, as the launchpad holds it. */
export async function readLaunch(tokenAddress) {
  const l = await read(launchpad(), 'launches', [tokenAddress]);
  return { creator: l[0], pool: Number(l[1]), v3Pool: l[2], tokenId: l[3], poolId: l[4], tickLower: Number(l[5]), tickUpper: Number(l[6]), startCapUsd: Number(l[7]), launchedAt: Number(l[8]), ethUsd: l[9] };
}
/** The coin's fee record. */
export async function readCoin(tokenAddress) {
  const c = await read(fees(), 'coins', [tokenAddress]);
  return { creator: c[0], module: Number(c[1]), pool: Number(c[2]), stock: c[3], pot: c[4], received: c[5], paid: c[6], stockHeld: c[7], drawBlock: Number(c[8]) };
}
/** A v4 pool's rules from the hook. */
export async function readRules(poolId) {
  const r = await read(hook(), 'rules', [poolId]);
  return { launchFee: Number(r[0]), sellFee: Number(r[1]), window: Number(r[2]), start: Number(r[3]), maxSwap: r[4], token: r[5], exempt: r[6] };
}
/** The pool's price and the position's liquidity, in the shape shared/pool.mjs computes on. */
export async function readPoolState(c) {
  const pool = Number(c.pool); const tickLower = Number(c.tickLower), tickUpper = Number(c.tickUpper);
  const base = { pool, tickLower, tickUpper, sqrtA: P.sqrtPriceAtTick(tickLower), sqrtB: P.sqrtPriceAtTick(tickUpper), fee: P.FEE_PIPS, sellFee: P.FEE_PIPS };
  if (pool === P.POOL_V3) {
    const p = { address: getAddress(c.v3Pool), abi: V3_POOL_ABI }; const [s, liq] = await Promise.all([read(p, 'slot0'), read(p, 'liquidity')]);
    const pos = c.tokenId ? await read({ address: getAddress(chainInfo().uniswap.nfpm), abi: NFPM_ABI }, 'positions', [BigInt(c.tokenId)]).catch(() => null) : null;
    return { ...base, sqrtP: s[0], tick: Number(s[1]), liquidity: pos ? pos[7] : liq, activeLiquidity: liq };
  }
  const s = await v4Slot0(c.poolId); const pos = await read(v4Locker(), 'positions', [c.token]); const rules = CONFIG.hook ? await readRules(c.poolId).catch(() => null) : null;
  return { ...base, sqrtP: s.sqrtP, tick: s.tick, liquidity: pos[2], activeLiquidity: s.liquidity, sellFee: rules ? BigInt(rules.sellFee) : P.FEE_PIPS, rules };
}
/** Slot0 and liquidity of a v4 pool straight from the PoolManager's storage (StateLibrary's layout: pools at slot 6, liquidity 3 words in). */
export async function v4Slot0(poolId) {
  const pm = poolManager(); const slot = keccak256(encodePacked(['bytes32', 'bytes32'], [poolId, toHex(6n, { size: 32 })]));
  const [raw, liq] = await Promise.all([read(pm, 'extsload', [slot]), read(pm, 'extsload', [toHex(BigInt(slot) + 3n, { size: 32 })])]);
  const r = BigInt(raw); let tick = Number((r >> 160n) & 0xffffffn); if (tick >= 0x800000) tick -= 0x1000000;
  return { sqrtP: r & ((1n << 160n) - 1n), tick, liquidity: BigInt(liq) & ((1n << 128n) - 1n) };
}
export const readBalance = (tokenAddress, owner) => read(token(tokenAddress), 'balanceOf', [owner]);
export const readTotalSupply = tokenAddress => read(token(tokenAddress), 'totalSupply');
export const readPlatformPot = () => read(fees(), 'platformPot');
export const readClaimable = owner => read(fees(), 'claimable', [owner]);
export const readClaimableStock = (stock, owner) => read(fees(), 'claimableStock', [stock, owner]);
export const readStockAllowed = stock => read(fees(), 'stockAllowed', [stock]);
export const readBranches = tokenAddress => read(fees(), 'branches', [tokenAddress]);
export const readMistKey = owner => read(fees(), 'mistKeys', [owner]);
export const readMistDenominations = () => read(mist(), 'denominationList');
export const readMistRoot = () => read(mist(), 'root');
export const readMistSpent = nullifierHash => read(mist(), 'spent', [nullifierHash]);
export const readMistKnownRoot = r => read(mist(), 'isKnownRoot', [r]);
export const readCount = () => read(launchpad(), 'count');
export const readPoolKey = tokenAddress => read(fees(), 'poolKey', [tokenAddress]);
/** What a collect would deposit right now: [eth, fromCoins], by simulating it as the gardener. */
export async function simulateCollect(c, gardenerAddress) {
  const L = Number(c.pool) === P.POOL_V4 ? v4Locker() : locker();
  const r = await publicClient().simulateContract({ account: gardenerAddress, address: L.address, abi: L.abi, functionName: 'collect', args: [getAddress(c.token), 0n] });
  return { eth: r.result[0], fromCoins: r.result[1] };
}
/** The v3 quoter's answer for a path and an amount, or 0n when the route cannot. */
export async function quotePath(path, amountIn) { try { const r = await publicClient().simulateContract({ address: quoter().address, abi: QUOTER_ABI, functionName: 'quoteExactInput', args: [path, amountIn] }); return r.result[0]; } catch { return 0n; } }
/** ETH/USD from the chain's Chainlink feed, as a number, or 0 when the chain has none or the read fails. */
export async function ethUsd() {
  const feed = chainInfo().ethUsdFeed; if (!feed) return 0;
  try { const [, answer] = await publicClient().readContract({ address: feed, abi: FEED_ABI, functionName: 'latestRoundData' }); return Number(answer) / 1e8; } catch { return 0; }
}

/** The calldata of each transaction the gardener sends. Pure. */
export const calldata = {
  collect: (t, minOut) => encodeFunctionData({ abi: ABI.locker, functionName: 'collect', args: [t, minOut] }),
  collectV4: (t, minOut) => encodeFunctionData({ abi: ABI.v4Locker, functionName: 'collect', args: [t, minOut] }),
  payHolders: (t, to, amounts) => encodeFunctionData({ abi: ABI.fees, functionName: 'payHolders', args: [t, to, amounts] }),
  payMist: (t, commits, denoms, ephemerals, viewTags) => encodeFunctionData({ abi: ABI.fees, functionName: 'payMist', args: [t, commits, denoms, ephemerals, viewTags] }),
  withdrawMist: (a, b, c, root, nullifierHash, denom, recipient, relayer, fee) => encodeFunctionData({ abi: ABI.mist, functionName: 'withdraw', args: [a, b, c, root, nullifierHash, denom, recipient, relayer, fee] }),
  buyback: (t, eth, minOut) => encodeFunctionData({ abi: ABI.fees, functionName: 'buyback', args: [t, eth, minOut] }),
  buyStock: (t, eth, minOut, path) => encodeFunctionData({ abi: ABI.fees, functionName: 'buyStock', args: [t, eth, minOut, path] }),
  buyStockV4: (t, eth, minOut, fromWeth, hops) => encodeFunctionData({ abi: ABI.fees, functionName: 'buyStockV4', args: [t, eth, minOut, fromWeth, hops.map(h => ({ currency: getAddress(h.currency), fee: Number(h.fee), tickSpacing: Number(h.tickSpacing), hooks: getAddress(h.hooks) }))] }),
  payStock: (t, to, amounts) => encodeFunctionData({ abi: ABI.fees, functionName: 'payStock', args: [t, to, amounts] }),
  openDraw: t => encodeFunctionData({ abi: ABI.fees, functionName: 'openDraw', args: [t] }),
  payDraw: (t, winner) => encodeFunctionData({ abi: ABI.fees, functionName: 'payDraw', args: [t, winner] }),
  withdrawPlatform: (to, amount) => encodeFunctionData({ abi: ABI.fees, functionName: 'withdrawPlatform', args: [to, amount] }),
  setStockAllowed: (stock, allowed) => encodeFunctionData({ abi: ABI.fees, functionName: 'setStockAllowed', args: [stock, allowed] }),
  setStocksAllowed: (stocks, allowed) => encodeFunctionData({ abi: ABI.fees, functionName: 'setStocksAllowed', args: [stocks, allowed] }),
};
export { P as pool };
