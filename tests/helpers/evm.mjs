// An in-process Ethereum for the tests: Hardhat's EDR network behind viem. Deploys the real Uniswap v3 (factory, position manager,
// SwapRouter02, QuoterV2, WETH9 from the published builds, the same bytecode as mainnet), the real Uniswap v4 PoolManager (the
// artifact v4-core ships), and the Halcyon contracts compiled by contracts/compile.mjs. No network.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createPublicClient, createWalletClient, custom, keccak256, parseAbi, getAddress, parseEther, encodeAbiParameters, maxUint128 } from 'viem';
import { hardhat } from 'viem/chains';
import { hookInitCode, mineHookSalt, hasFlags } from '../../eth/hookmine.mjs';
const require = createRequire(import.meta.url);

export const ERC20_ABI = parseAbi([
  'function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)', 'function allowance(address, address) view returns (uint256)', 'function approve(address, uint256) returns (bool)',
  'function transfer(address, uint256) returns (bool)', 'function transferFrom(address, address, uint256) returns (bool)', 'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
export const V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)', 'function liquidity() view returns (uint128)', 'function fee() view returns (uint24)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
]);
export const V3_FACTORY_ABI = parseAbi(['function getPool(address, address, uint24) view returns (address)', 'function createPool(address, address, uint24) returns (address)']);
export const NFPM_ABI = parseAbi([
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function ownerOf(uint256) view returns (address)', 'function createAndInitializePoolIfNecessary(address, address, uint24, uint160) payable returns (address)',
  'function safeTransferFrom(address, address, uint256)', 'function approve(address, uint256)', 'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256, uint256)',
]);
export const ROUTER02_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable', 'function multicall(bytes[] data) payable returns (bytes[] results)', 'function WETH9() view returns (address)',
]);
export const QUOTER_ABI = parseAbi(['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)']);
export const WETH_ABI = parseAbi(['function deposit() payable', 'function withdraw(uint256)', 'function approve(address, uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);

export const artifact = name => JSON.parse(fs.readFileSync(new URL(`../../contracts/artifacts/${name}.json`, import.meta.url), 'utf8'));
/** Uniswap v4 periphery builds the tests carry themselves (tests/helpers/uniswap, abi and bytecode from @uniswap/v4-periphery 1.0.3): the quoter and the state view, the same code as mainnet's. */
export const peripheryBuild = name => JSON.parse(fs.readFileSync(new URL(`./uniswap/${name}.json`, import.meta.url), 'utf8'));
export const POOL_MANAGER_ABI = parseAbi(['function extsload(bytes32) view returns (bytes32)', 'function initialize((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24)', 'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)']);
export const LP_TEST_ABI = parseAbi(['function modifyLiquidity((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt) params, bytes hookData) payable returns (int256)']);
const hex = b => (String(b).startsWith('0x') ? b : '0x' + b);
export const uniswapBuild = name => {
  const paths = {
    WETH9: '@uniswap/v2-periphery/build/WETH9.json',
    UniswapV3Factory: '@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json',
    NonfungiblePositionManager: '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json',
    SwapRouter02: '@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json',
    QuoterV2: '@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json',
    PoolManager: '@uniswap/v4-core/out/PoolManager.sol/PoolManager.json',
    PoolModifyLiquidityTest: '@uniswap/v4-core/out/PoolModifyLiquidityTest.sol/PoolModifyLiquidityTest.json',
  };
  const b = require(paths[name]); return { abi: b.abi, bytecode: hex(typeof b.bytecode === 'string' ? b.bytecode : b.bytecode.object) };
};

/** The revert reason inside a viem error from the Hardhat provider (the reason string sits in `details` down the cause chain). */
export function reasonOf(e) { let c = e; for (let i = 0; c && i < 8; i++) { const d = String(c.details || ''); const m = d.match(/reason string '([^']*)'/); if (m) return m[1]; if (/reverted/.test(d)) return d; c = c.cause; } return String(e?.shortMessage || e?.message || e); }

/** Boot the chain: accounts, clients, deploy/write/read helpers, Uniswap v3 + v4 and a Chainlink-shaped ETH/USD feed. */
export async function boot({ ethUsd = 3000 } = {}) {
  const hre = await import('hardhat'); const provider = (hre.default || hre).network.provider;
  const accounts = (await provider.request({ method: 'eth_accounts' })).map(a => getAddress(a)); /* not .map(getAddress): the index would become viem's chainId */
  const pc = createPublicClient({ chain: hardhat, transport: custom(provider) });
  const wallet = account => createWalletClient({ chain: hardhat, transport: custom(provider), account });
  const deploy = async (from, { abi, bytecode }, args = [], value = 0n) => { const hash = await wallet(from).deployContract({ abi, bytecode, args, value }); const rc = await pc.waitForTransactionReceipt({ hash }); if (rc.status !== 'success') throw new Error('deploy reverted'); return { address: getAddress(rc.contractAddress), receipt: rc, abi }; };
  const write = async (from, { address, abi }, functionName, args = [], value = 0n) => { const hash = await wallet(from).writeContract({ address, abi, functionName, args, value }); const rc = await pc.waitForTransactionReceipt({ hash }); if (rc.status !== 'success') throw new Error(`${functionName} reverted`); return rc; };
  const read = (c, functionName, args = []) => pc.readContract({ address: c.address, abi: c.abi, functionName, args });
  const simulate = async (from, { address, abi }, functionName, args = [], value = 0n) => (await pc.simulateContract({ account: from, address, abi, functionName, args, value })).result;
  /** The revert reason of a call that must fail. */
  const revertsWith = async (from, { address, abi }, functionName, args = [], value = 0n) => { try { await pc.simulateContract({ account: from, address, abi, functionName, args, value }); } catch (e) { return reasonOf(e); } throw new Error(`${functionName} did not revert`); };
  const time = async seconds => { await provider.request({ method: 'evm_increaseTime', params: [seconds] }); await provider.request({ method: 'evm_mine', params: [] }); };
  const mine = async (n = 1) => { for (let i = 0; i < n; i++) await provider.request({ method: 'evm_mine', params: [] }); };
  const d = accounts[0];
  const weth = await deploy(d, uniswapBuild('WETH9')); weth.abi = WETH_ABI;
  const factory = await deploy(d, uniswapBuild('UniswapV3Factory')); factory.abi = V3_FACTORY_ABI;
  const nfpm = await deploy(d, uniswapBuild('NonfungiblePositionManager'), [factory.address, weth.address, '0x0000000000000000000000000000000000000000']); nfpm.abi = NFPM_ABI;
  const router = await deploy(d, uniswapBuild('SwapRouter02'), ['0x0000000000000000000000000000000000000000', factory.address, nfpm.address, weth.address]); router.abi = ROUTER02_ABI;
  const quoter = await deploy(d, uniswapBuild('QuoterV2'), [factory.address, weth.address]); quoter.abi = QUOTER_ABI;
  const poolManager = await deploy(d, uniswapBuild('PoolManager'), [d]); poolManager.abi = POOL_MANAGER_ABI;
  const v4Quoter = await deploy(d, peripheryBuild('V4Quoter'), [poolManager.address]);
  const stateView = await deploy(d, peripheryBuild('StateView'), [poolManager.address]);
  const lpTest = await deploy(d, uniswapBuild('PoolModifyLiquidityTest'), [poolManager.address]); lpTest.abi = LP_TEST_ABI;
  const feed = await deploy(d, artifact('MockFeed'), [BigInt(ethUsd) * 10n ** 8n]);
  return { provider, accounts, pc, wallet, deploy, write, read, simulate, revertsWith, time, mine, weth, factory, nfpm, router, quoter, poolManager, v4Quoter, stateView, lpTest, feed, ethUsd };
}

/** Deploy the Halcyon set on a booted chain, in the order the deploy script uses, and a mock stock with a real v3 pool. */
/** The mist pool's denominations in the tests: small enough for test-sized pots, the real set is the deploy script's. */
export const TEST_DENOMS = [parseEther('0.001'), parseEther('0.01'), parseEther('0.1'), parseEther('1')];
export async function deployHalcyon(chain, { platform, gardener }) {
  const { accounts, deploy, write, read, pc } = chain; const deployer = accounts[0];
  const impl = await deploy(deployer, artifact('HalcyonToken'));
  const swap = await deploy(deployer, artifact('HalcyonSwap'), [chain.poolManager.address]);
  const fees = await deploy(deployer, artifact('HalcyonFees'), [platform, gardener, chain.weth.address, chain.router.address, swap.address]);
  const locker = await deploy(deployer, artifact('HalcyonLocker'), [fees.address, chain.nfpm.address, chain.router.address, chain.weth.address]);
  const v4Locker = await deploy(deployer, artifact('HalcyonV4Locker'), [chain.poolManager.address, fees.address]);
  const create2 = await deploy(deployer, artifact('Create2Deployer'));
  const hookArt = artifact('HalcyonHook'); const initCode = hookInitCode(hookArt.bytecode, { manager: chain.poolManager.address, fees: fees.address, locker: v4Locker.address });
  const mined = mineHookSalt(create2.address, keccak256(initCode));
  await write(deployer, create2, 'deploy', [mined.salt, initCode]);
  const hook = { address: mined.address, abi: hookArt.abi }; if (!hasFlags(hook.address)) throw new Error('hook address flags');
  if ((await pc.getCode({ address: hook.address }) || '0x').length < 10) throw new Error('hook not deployed');
  const config = { implementation: impl.address, fees: fees.address, locker: locker.address, v4Locker: v4Locker.address, hook: hook.address, swap: swap.address, v3Factory: chain.factory.address, nfpm: chain.nfpm.address, swapRouter: chain.router.address, weth: chain.weth.address, poolManager: chain.poolManager.address, ethUsdFeed: chain.feed.address };
  const pad = await deploy(deployer, artifact('Halcyon'), [config]);
  await write(deployer, fees, 'wire', [pad.address, locker.address, v4Locker.address, hook.address]);
  // the mist pool: Poseidon, the circuit's verifier, the pool, set on fees by the deployer as the deploy script does
  const poseidon = await deploy(deployer, artifact('PoseidonT3')); const verifier = await deploy(deployer, artifact('MistVerifier'));
  const mist = await deploy(deployer, artifact('HalcyonMist'), [poseidon.address, verifier.address, fees.address, TEST_DENOMS]); await write(deployer, fees, 'setMist', [mist.address]);
  // a stock with a real v3 pool against WETH (0.3% tier), both sides seeded, so buyStock runs through the real router and quoter
  const stock = await deploy(deployer, artifact('MockStock'));
  const stockAmount = parseEther('100000'), wethAmount = parseEther('10'); /* 1 WETH = 10,000 mSTK */
  await write(deployer, stock, 'mint', [deployer, stockAmount]); await write(deployer, chain.weth, 'deposit', [], wethAmount);
  await write(deployer, stock, 'approve', [chain.nfpm.address, stockAmount]); await write(deployer, chain.weth, 'approve', [chain.nfpm.address, wethAmount]);
  const [t0, t1] = stock.address.toLowerCase() < chain.weth.address.toLowerCase() ? [stock.address, chain.weth.address] : [chain.weth.address, stock.address];
  const stockIs0 = t0 === stock.address; const price = stockIs0 ? wethAmount * 2n ** 192n / stockAmount : stockAmount * 2n ** 192n / wethAmount; /* token1 per token0 */
  const sqrtPrice = bigintSqrt(price);
  await write(deployer, chain.nfpm, 'createAndInitializePoolIfNecessary', [t0, t1, 3000, sqrtPrice]);
  await write(deployer, chain.nfpm, 'mint', [{ token0: t0, token1: t1, fee: 3000, tickLower: -887220, tickUpper: 887220, amount0Desired: stockIs0 ? stockAmount : wethAmount, amount1Desired: stockIs0 ? wethAmount : stockAmount, amount0Min: 0n, amount1Min: 0n, recipient: deployer, deadline: 2n ** 40n }]);
  await write(platform, fees, 'setStockAllowed', [stock.address, true]);
  // the same stock on v4 too: a plain pool against native ETH and one against WETH, at the v3 pool's price; and a second stock
  // (mSTK2) that only a v4 pool against a mock dollar (mUSD) trades, the dollar itself against ETH, so a route needs two hops
  const v4 = {};
  await write(deployer, stock, 'mint', [deployer, stockAmount * 2n]); await write(deployer, chain.weth, 'deposit', [], wethAmount);
  v4.ethStock = await v4Pool(chain, { currency0: ZERO_ADDRESS, currency1: stock.address, fee: 3000, tickSpacing: 60, amount0: wethAmount, amount1: stockAmount, from: deployer });
  v4.wethStock = await v4Pool(chain, { currency0: chain.weth.address, currency1: stock.address, fee: 3000, tickSpacing: 60, amount0: wethAmount, amount1: stockAmount, from: deployer });
  const usd = await deploy(deployer, artifact('MockStock')); const stock2 = await deploy(deployer, artifact('MockStock'));
  const usdAmount = parseEther('30000'), stock2Amount = parseEther('150'); /* 1 ETH = 3,000 mUSD; 1 mSTK2 = 200 mUSD */
  await write(deployer, usd, 'mint', [deployer, usdAmount * 2n]); await write(deployer, stock2, 'mint', [deployer, stock2Amount]);
  v4.ethUsd = await v4Pool(chain, { currency0: ZERO_ADDRESS, currency1: usd.address, fee: 500, tickSpacing: 10, amount0: parseEther('10'), amount1: usdAmount, from: deployer });
  v4.usdStock2 = await v4Pool(chain, { currency0: usd.address, currency1: stock2.address, fee: 3000, tickSpacing: 60, amount0: usdAmount, amount1: stock2Amount, from: deployer });
  await write(platform, fees, 'setStockAllowed', [stock2.address, true]);
  // two thin, narrow pools at the 1% tier (the same prices, a sliver of liquidity within 4% of the price) for the partial-fill paths
  await write(deployer, stock, 'mint', [deployer, parseEther('10')]); await write(deployer, chain.weth, 'deposit', [], parseEther('0.001')); await write(deployer, usd, 'mint', [deployer, parseEther('1')]); await write(deployer, stock2, 'mint', [deployer, parseEther('0.005')]);
  v4.narrowWethStock = await v4Pool(chain, { currency0: chain.weth.address, currency1: stock.address, fee: 10000, tickSpacing: 200, amount0: parseEther('0.001'), amount1: parseEther('10'), width: 400, from: deployer });
  v4.narrowUsdStock2 = await v4Pool(chain, { currency0: usd.address, currency1: stock2.address, fee: 10000, tickSpacing: 200, amount0: parseEther('1'), amount1: parseEther('0.005'), width: 400, from: deployer });
  return { impl, swap, fees, locker, v4Locker, hook, create2, pad, config, stock, stock2, usd, v4, poseidon, verifier, mist, stockPath: encodePath([chain.weth.address, 3000, stock.address]), token: address => ({ address, abi: artifact('HalcyonToken').abi }), gas: { impl: impl.receipt.gasUsed, fees: fees.receipt.gasUsed, pad: pad.receipt.gasUsed, locker: locker.receipt.gasUsed, v4Locker: v4Locker.receipt.gasUsed, swap: swap.receipt.gasUsed, poseidon: poseidon.receipt.gasUsed, verifier: verifier.receipt.gasUsed, mist: mist.receipt.gasUsed }, hookSalt: mined };
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** The id of a v4 pool: keccak256 of the abi-encoded key. Pure. */
export const v4PoolId = key => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
/**
 * A plain (hookless) Uniswap v4 pool with a full-range position: `currency0` and `currency1` as given (address(0) is ETH; sorted here
 * if they are not), priced so the position holds about `amount0` and `amount1`, minted by `from` through v4-core's test router.
 * Returns the key and its id.
 */
export async function v4Pool(chain, { currency0, currency1, fee, tickSpacing, amount0, amount1, from, width = 0 }) {
  const { write, poolManager, lpTest } = chain;
  let c0 = currency0, c1 = currency1, a0 = amount0, a1 = amount1; if (c0.toLowerCase() > c1.toLowerCase()) { [c0, c1, a0, a1] = [c1, c0, a1, a0]; }
  const key = { currency0: getAddress(c0), currency1: getAddress(c1), fee, tickSpacing, hooks: ZERO_ADDRESS };
  const sqrtPrice = bigintSqrt(a1 * 2n ** 192n / a0); const Q96 = 2n ** 96n;
  await write(from, poolManager, 'initialize', [key, sqrtPrice]);
  /* full range unless `width` (ticks each side of the price) narrows it; the liquidity is the full-range figure for these amounts, which a narrow range holds with less of each */
  const edge = Math.floor(887272 / tickSpacing) * tickSpacing; const tick = Math.floor(Math.log(Number(a1) / Number(a0)) / Math.log(1.0001));
  const tickLower = width ? Math.floor((tick - width) / tickSpacing) * tickSpacing : -edge, tickUpper = width ? Math.ceil((tick + width) / tickSpacing) * tickSpacing : edge;
  const l0 = a0 * sqrtPrice / Q96, l1 = a1 * Q96 / sqrtPrice; const liquidity = l0 < l1 ? l0 : l1;
  let value = 0n;
  for (const [c, amount] of [[c0, a0], [c1, a1]]) { if (c === ZERO_ADDRESS) value = amount + amount / 100n; else { const t = { address: getAddress(c), abi: ERC20_ABI }; await write(from, t, 'approve', [lpTest.address, amount * 2n]); } }
  await write(from, lpTest, 'modifyLiquidity', [key, { tickLower, tickUpper, liquidityDelta: liquidity, salt: '0x' + '0'.repeat(64) }, '0x'], value);
  return { key, id: v4PoolId(key), liquidity, tickLower, tickUpper };
}

export function bigintSqrt(n) { if (n < 2n) return n; let x = n, y = (n + 1n) / 2n; while (y < x) { x = y; y = (n / y + y) / 2n; } return x; }
/** A Uniswap v3 path: address, fee, address, ... packed. */
export function encodePath(hops) { let out = '0x'; hops.forEach((h, i) => { out += i % 2 === 0 ? h.slice(2).toLowerCase() : Number(h).toString(16).padStart(6, '0'); }); return out; }
export const encodeArgs = (types, values) => encodeAbiParameters(types.map(t => ({ type: t })), values);
export { maxUint128 };
