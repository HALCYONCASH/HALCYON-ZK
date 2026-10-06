// The pool as the curve: one single-sided Uniswap position from the starting price up, in BigInt, mirrored exactly from the
// contracts and Uniswap's own math. The site quotes with it, the server prices with it, the demo simulates with it, and the tests
// check the chain against it. Two layouts: v3 (the coin is token0, price = WETH per coin, buys push the price up the range) and
// v4 (ETH is currency0, the coin currency1, price = coins per ETH, buys push the price down the range). Same curve, mirrored.
export const SUPPLY = 1_000_000_000n * 10n ** 18n;
export const FEE_PIPS = 10_000n;                 // the 1% tier, in millionths
export const PLATFORM_BPS = 2_000n;              // 20% of every fee is the platform's
export const TICK_SPACING = 200;
export const TICK_EDGE = 887_200;
export const MIN_CAP_USD = 1_000;
export const MAX_CAP_USD = 1_000_000;
export const CAP_PRESETS = [4_000, 5_000, 7_000, 10_000];
export const MODULE_NAMES = ['roots', 'rain', 'prune', 'harvest', 'branch', 'clover', 'rings', 'mist'];
export const MODULES = Object.fromEntries(MODULE_NAMES.map((n, i) => [n, i]));
export const POOL_V3 = 0, POOL_V4 = 1;
export const Q96 = 2n ** 96n;
export const Q192 = 2n ** 192n;
export const PIPS = 1_000_000n;

/** Uniswap's sqrt(1.0001^tick) * 2^96, bit for bit (TickMath.getSqrtPriceAtTick). */
export function sqrtPriceAtTick(tick) {
  const abs = BigInt(Math.abs(tick)); if (abs > 887272n) throw new Error('tick');
  let ratio = (abs & 1n) ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const M = [[2n, 0xfff97272373d413259a46990580e213an], [4n, 0xfff2e50f5f656932ef12357cf3c7fdccn], [8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [16n, 0xffcb9843d60f6159c9db58835c926644n], [32n, 0xff973b41fa98c081472e6896dfb254c0n], [64n, 0xff2ea16466c96a3843ec78b326b52861n], [128n, 0xfe5dee046a99a2a811c461f1969c3053n], [256n, 0xfcbe86c7900a88aedcffc83b479aa3a4n], [512n, 0xf987a7253ac413176f2b074cf7815e54n], [1024n, 0xf3392b0822b70005940c7a398e4b70f3n], [2048n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [4096n, 0xd097f3bdfd2022b8845ad8f792aa5825n], [8192n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [16384n, 0x70d869a156d2a1b890bb3df62baf32f7n], [32768n, 0x31be135f97d08fd981231505542fcfa6n], [65536n, 0x9aa508b5b7a84e1c677de54f3e99bc9n], [131072n, 0x5d6af8dedb81196699c329225ee604n], [262144n, 0x2216e584f5fa1ea926041bedfe98n], [524288n, 0x48a170391f7dc42444e8fa2n]];
  for (const [bit, m] of M) if (abs & bit) ratio = (ratio * m) >> 128n;
  if (tick > 0) ratio = (2n ** 256n - 1n) / ratio;
  return (ratio >> 32n) + ((ratio % (1n << 32n)) === 0n ? 0n : 1n);
}
/** The greatest tick whose sqrt price is at or below `sqrtPriceX96` (TickMath.getTickAtSqrtPrice), by bisection. */
export function tickAtSqrtPrice(sqrtPriceX96) {
  let lo = -887272, hi = 887272;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (sqrtPriceAtTick(mid) <= sqrtPriceX96) lo = mid; else hi = mid - 1; }
  return lo;
}
export const floorTick = (tick, spacing = TICK_SPACING) => { let t = Math.trunc(tick / spacing) * spacing; if (tick < 0 && t !== tick) t -= spacing; return t; };
export const ceilTick = (tick, spacing = TICK_SPACING) => { let t = Math.trunc(tick / spacing) * spacing; if (tick > 0 && t !== tick) t += spacing; return t; };
export function bigintSqrt(n) { if (n < 2n) return n; let x = n, y = (n + 1n) / 2n; while (y < x) { x = y; y = (n / y + y) / 2n; } return x; }

/** The wei a market cap in dollars is at an ETH/USD answer with `feedDecimals` (what Halcyon.capToWei computes). */
export const capToWei = (capUsd, answer, feedDecimals = 8) => BigInt(capUsd) * 10n ** 18n * 10n ** BigInt(feedDecimals) / BigInt(answer);
/** The starting tick a launch gets for a cap, exactly as the contract computes it. */
export function startTick(pool, capUsd, answer, feedDecimals = 8) {
  const capWei = capToWei(capUsd, answer, feedDecimals);
  if (pool === POOL_V3) return floorTick(tickAtSqrtPrice(bigintSqrt(capWei * Q192 / SUPPLY)));
  return ceilTick(tickAtSqrtPrice(bigintSqrt(SUPPLY * Q192 / capWei)));
}
/** A fresh pool as the launch leaves it: the whole supply in one range at the starting tick. @param {number} pool @param {number} capUsd @param {bigint} answer @param {number} [feedDecimals] */
export function freshPool(pool, capUsd, answer, feedDecimals = 8) {
  const tick = startTick(pool, capUsd, answer, feedDecimals);
  const [tickLower, tickUpper] = pool === POOL_V3 ? [tick, TICK_EDGE] : [-TICK_EDGE, tick];
  const sqrtA = sqrtPriceAtTick(tickLower), sqrtB = sqrtPriceAtTick(tickUpper); const sqrtP = sqrtPriceAtTick(tick);
  const liquidity = pool === POOL_V3 ? mulDiv(SUPPLY, mulDiv(sqrtA, sqrtB, Q96), sqrtB - sqrtA) : mulDiv(SUPPLY, Q96, sqrtB - sqrtA);
  return { pool, tickLower, tickUpper, sqrtA, sqrtB, sqrtP, liquidity, fee: FEE_PIPS, sellFee: FEE_PIPS };
}
/** @param {bigint} a @param {bigint} b @param {bigint} d @returns {bigint} */
export const mulDiv = (a, b, d) => (a * b) / d;

/** WETH (wei) per whole coin (1e18 units). @param {{pool: number, sqrtP: bigint}} p @returns {bigint} */
export function price(p) {
  if (p.pool === POOL_V3) return p.sqrtP * p.sqrtP * 10n ** 18n / Q192;
  return Q192 * 10n ** 18n / (p.sqrtP * p.sqrtP);
}
export const marketCap = (p, supply = SUPPLY) => price(p) * supply / 10n ** 18n;
/** The ETH the pool holds (what sells can take out), and the coins still in it. */
export function reserves(p) {
  const L = p.liquidity;
  if (p.pool === POOL_V3) return { eth: mulDiv(L, p.sqrtP - p.sqrtA, Q96), coins: mulDiv(mulDiv(L, Q96, p.sqrtP), p.sqrtB - p.sqrtP, p.sqrtB) };
  return { eth: mulDiv(mulDiv(L, Q96, p.sqrtP), p.sqrtB - p.sqrtP, p.sqrtB), coins: mulDiv(L, p.sqrtP - p.sqrtA, Q96) };
}
/** How far up the range the price has gone, 0..1, as a share of the coins sold out of the pool. */
export const progress = p => Number(SUPPLY - reserves(p).coins) / Number(SUPPLY);

/**
 * A buy with `ethIn` wei: the fee (in ETH), the coins out, the price after. `fee` in pips overrides the pool's (the v4 opening fee).
 * @param {any} p @param {bigint} ethIn @param {bigint} [fee]
 * @returns {{coinsOut: bigint, fee: bigint, used: bigint, refund: bigint, sqrtNext: bigint, priceAfter: bigint}}
 */
export function quoteBuy(p, ethIn, fee = p.fee) {
  const feeAmt = ethIn * fee / PIPS; const net = ethIn - feeAmt; const L = p.liquidity;
  let sqrtNext, coinsOut, used = ethIn;
  if (p.pool === POOL_V3) {
    sqrtNext = p.sqrtP + mulDiv(net, Q96, L); if (sqrtNext > p.sqrtB) sqrtNext = p.sqrtB; /* every coin gone */
    coinsOut = mulDiv(mulDiv(L, Q96, p.sqrtP), sqrtNext - p.sqrtP, sqrtNext);
    if (sqrtNext === p.sqrtB) { const netUsed = mulDiv(L, p.sqrtB - p.sqrtP, Q96); used = netUsed * PIPS / (PIPS - fee); }
  } else {
    const denom = L * Q96 + net * p.sqrtP; sqrtNext = mulDiv(L * Q96, p.sqrtP, denom); if (sqrtNext < p.sqrtA) sqrtNext = p.sqrtA;
    coinsOut = mulDiv(L, p.sqrtP - sqrtNext, Q96);
    if (sqrtNext === p.sqrtA) { const netUsed = mulDiv(mulDiv(L, Q96, sqrtNext), p.sqrtP - sqrtNext, p.sqrtP); used = netUsed * PIPS / (PIPS - fee); }
  }
  return { coinsOut, fee: used * fee / PIPS, used, refund: ethIn - used, sqrtNext, priceAfter: price({ ...p, sqrtP: sqrtNext }) };
}
/**
 * A sell of `coins`: the fee (in coins), the ETH out, the price after. Sells pay the pool's sell fee (v4 may set it above 1%).
 * @param {any} p @param {bigint} coins @param {bigint} [fee]
 * @returns {{ethOut: bigint, fee: bigint, used: bigint, refund: bigint, sqrtNext: bigint, priceAfter: bigint}}
 */
export function quoteSell(p, coins, fee = p.sellFee) {
  const feeAmt = coins * fee / PIPS; const net = coins - feeAmt; const L = p.liquidity;
  let sqrtNext, ethOut, used = coins;
  if (p.pool === POOL_V3) {
    const denom = L * Q96 + net * p.sqrtP; sqrtNext = mulDiv(L * Q96, p.sqrtP, denom); if (sqrtNext < p.sqrtA) sqrtNext = p.sqrtA;
    ethOut = mulDiv(L, p.sqrtP - sqrtNext, Q96);
    if (sqrtNext === p.sqrtA) { const netUsed = mulDiv(mulDiv(L, Q96, sqrtNext), p.sqrtP - sqrtNext, p.sqrtP); used = netUsed * PIPS / (PIPS - fee); }
  } else {
    sqrtNext = p.sqrtP + mulDiv(net, Q96, L); if (sqrtNext > p.sqrtB) sqrtNext = p.sqrtB;
    ethOut = mulDiv(mulDiv(L, Q96, p.sqrtP), sqrtNext - p.sqrtP, sqrtNext);
    if (sqrtNext === p.sqrtB) { const netUsed = mulDiv(L, p.sqrtB - p.sqrtP, Q96); used = netUsed * PIPS / (PIPS - fee); }
  }
  return { ethOut, fee: used * fee / PIPS, used, refund: coins - used, sqrtNext, priceAfter: price({ ...p, sqrtP: sqrtNext }) };
}
export const applyBuy = (p, ethIn, fee) => { const q = quoteBuy(p, ethIn, fee); return { state: { ...p, sqrtP: q.sqrtNext }, quote: q }; };
export const applySell = (p, coins, fee) => { const q = quoteSell(p, coins, fee); return { state: { ...p, sqrtP: q.sqrtNext }, quote: q }; };

/** The ETH it takes to move a fresh pool from its starting cap to `capTarget` (same unit as `capStart`): sqrt(M0 * M) - M0, before fees. */
/** @param {number} capStart @param {number} capTarget @returns {number} */
export const ethToReachCap = (capStart, capTarget) => Math.sqrt(capStart * capTarget) - capStart;
/** The 80/20 of a fee. */
export const splitFee = fee => { const platform = fee * PLATFORM_BPS / 10_000n; return { platform, coin: fee - platform }; };
/** The v4 opening fee at `elapsed` seconds into a window, in pips (HalcyonHook.feeNow for a buy). */
export function openingFee(rules, elapsed) {
  if (!rules || !rules.launchFee || elapsed >= rules.window) return FEE_PIPS;
  return BigInt(rules.launchFee) - (BigInt(rules.launchFee) - FEE_PIPS) * BigInt(Math.max(0, Math.floor(elapsed))) / BigInt(rules.window);
}
export const fmtEth = wei => (Number(wei) / 1e18).toFixed(4);
