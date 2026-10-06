// The transactions the site sends, built from the artifacts' ABIs and sent through the connected wallet: launch, buy and sell on a v3
// pool (Uniswap's SwapRouter02) or on a v4 pool (HalcyonSwap), approve, claim, the creator's module and split. Every write waits
// for its receipt. The v3 salt is mined here too: a v3 coin's address must sort below WETH, and the launchpad's `predict` says where
// a salt lands, so the site tries salts until one does.
import launchpadArtifact from '../../contracts/artifacts/Halcyon.json';
import mistArtifact from '../../contracts/artifacts/HalcyonMist.json';
import feesArtifact from '../../contracts/artifacts/HalcyonFees.json';
import tokenArtifact from '../../contracts/artifacts/HalcyonToken.json';
import swapArtifact from '../../contracts/artifacts/HalcyonSwap.json';
import { parseAbi, decodeEventLog, encodeFunctionData, keccak256, encodePacked, encodeAbiParameters, getAddress, toHex, type Abi, type Hash } from 'viem';
import { walletClient, publicClient, wallet } from './wallet';
import type { Config } from './api';

export const ABI = { launchpad: launchpadArtifact.abi as Abi, fees: feesArtifact.abi as Abi, token: tokenArtifact.abi as Abi, swap: swapArtifact.abi as Abi, mist: mistArtifact.abi as Abi };
export const ROUTER02_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable', 'function multicall(bytes[] data) payable returns (bytes[] results)',
]);
export const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address, address) view returns (uint256)', 'function approve(address, uint256) returns (bool)']);
export type Addr = `0x${string}`;
export const ZERO: Addr = '0x0000000000000000000000000000000000000000';
export const DYNAMIC_FEE = 0x800000; export const V3_FEE = 10000; export const V4_TICK_SPACING = 200;
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 1200);
export const poolKey = (cfg: Config, token: Addr) => ({ currency0: ZERO, currency1: token, fee: DYNAMIC_FEE, tickSpacing: V4_TICK_SPACING, hooks: cfg.hook as Addr });

export interface LaunchParams { name: string; symbol: string; uri: string; pool: number; startCapUsd: number; module: number; stock: Addr; salt: `0x${string}`; splitTo: Addr[]; splitBps: number[]; launchFee: number; sellFee: number; window: number; maxSwapBps: number; minOut: bigint }

async function send(cfg: Config, req: { address: Addr; abi: Abi; functionName: string; args: unknown[]; value?: bigint }): Promise<Hash> {
  const wc = walletClient(cfg.chainId); const pc = publicClient(cfg.chainId);
  // simulate first so a refusal comes back as its reason, not as a failed transaction; then send the same request
  await pc.simulateContract({ ...req, account: wallet.account as Addr } as Parameters<typeof pc.simulateContract>[0]);
  const hash = await wc.writeContract({ ...req, account: wallet.account as Addr, chain: wc.chain } as unknown as Parameters<typeof wc.writeContract>[0]); const rc = await pc.waitForTransactionReceipt({ hash }); if (rc.status !== 'success') throw new Error('the transaction reverted'); return hash;
}
export const tx = {
  launch: (cfg: Config, p: LaunchParams, value: bigint) => send(cfg, { address: cfg.launchpad as Addr, abi: ABI.launchpad, functionName: 'launch', args: [p], value }),
  approve: (cfg: Config, token: Addr, spender: Addr, amount: bigint) => send(cfg, { address: token, abi: ERC20_ABI as unknown as Abi, functionName: 'approve', args: [spender, amount] }),
  /** v3: ETH in through SwapRouter02 (it wraps), the coin to the buyer. */
  buyV3: (cfg: Config, token: Addr, minOut: bigint, value: bigint) => send(cfg, { address: cfg.uniswap.swapRouter02 as Addr, abi: ROUTER02_ABI as unknown as Abi, functionName: 'exactInputSingle', args: [{ tokenIn: cfg.uniswap.weth, tokenOut: token, fee: V3_FEE, recipient: wallet.account, amountIn: value, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }], value }),
  /** v3: the coin in, WETH to the router, unwrapped to the seller: one multicall. */
  sellV3: (cfg: Config, token: Addr, amount: bigint, minEthOut: bigint) => send(cfg, { address: cfg.uniswap.swapRouter02 as Addr, abi: ROUTER02_ABI as unknown as Abi, functionName: 'multicall', args: [[
    encodeFunctionData({ abi: ROUTER02_ABI, functionName: 'exactInputSingle', args: [{ tokenIn: token, tokenOut: cfg.uniswap.weth as Addr, fee: V3_FEE, recipient: cfg.uniswap.swapRouter02 as Addr, amountIn: amount, amountOutMinimum: minEthOut, sqrtPriceLimitX96: 0n }] }),
    encodeFunctionData({ abi: ROUTER02_ABI, functionName: 'unwrapWETH9', args: [minEthOut, wallet.account as Addr] }),
  ]] }),
  buyV4: (cfg: Config, token: Addr, minOut: bigint, value: bigint) => send(cfg, { address: cfg.swap as Addr, abi: ABI.swap, functionName: 'buy', args: [poolKey(cfg, token), minOut, wallet.account, deadline()], value }),
  sellV4: (cfg: Config, token: Addr, amount: bigint, minEthOut: bigint) => send(cfg, { address: cfg.swap as Addr, abi: ABI.swap, functionName: 'sell', args: [poolKey(cfg, token), amount, minEthOut, wallet.account, deadline()] }),
  claim: (cfg: Config) => send(cfg, { address: cfg.fees as Addr, abi: ABI.fees, functionName: 'claim', args: [] }),
  claimStock: (cfg: Config, stock: Addr) => send(cfg, { address: cfg.fees as Addr, abi: ABI.fees, functionName: 'claimStock', args: [stock] }),
  setModule: (cfg: Config, token: Addr, module: number, stock: Addr) => send(cfg, { address: cfg.fees as Addr, abi: ABI.fees, functionName: 'setModule', args: [token, module, stock] }),
  setBranches: (cfg: Config, token: Addr, to: Addr[], bps: number[]) => send(cfg, { address: cfg.fees as Addr, abi: ABI.fees, functionName: 'setBranches', args: [token, to, bps] }),
  /** The public half of a mist key (64 bytes), or '0x' to remove it. */
  setMistKey: (cfg: Config, key: `0x${string}`) => send(cfg, { address: cfg.fees as Addr, abi: ABI.fees, functionName: 'setMistKey', args: [key] }),
  /** A mist withdrawal sent by the connected wallet itself (it is the relayer, with no fee): for a fresh wallet that can pay its own gas. */
  withdrawMist: (cfg: Config, a: bigint[], b: bigint[][], c: bigint[], root: bigint, nullifierHash: bigint, denom: bigint, recipient: Addr, relayer: Addr, fee: bigint) => send(cfg, { address: cfg.mist as Addr, abi: ABI.mist, functionName: 'withdraw', args: [a, b, c, root, nullifierHash, denom, recipient, relayer, fee] }),
};
/** Where a launch by `sender` with `salt` puts the coin: the launchpad's CREATE2 of the clone (Halcyon.predict, computed here). */
export function predict(cfg: Config, sender: Addr, salt: `0x${string}`): Addr {
  const s = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [sender, salt]));
  const h = keccak256(encodePacked(['bytes', 'address', 'bytes'], ['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', cfg.tokenImpl as Addr, '0x5af43d82803e903d91602b57fd5bf3']));
  return getAddress(`0x${keccak256(encodePacked(['bytes1', 'address', 'bytes32', 'bytes32'], ['0xff', cfg.launchpad as Addr, s, h])).slice(26)}`);
}
/** A salt for a v3 launch: the first random one whose coin address sorts below WETH (about three in four do). */
export function mineV3Salt(cfg: Config, sender: Addr): `0x${string}` {
  for (let i = 0; i < 10_000; i++) { const r = new Uint8Array(32); crypto.getRandomValues(r); const salt = toHex(r); if (predict(cfg, sender, salt).toLowerCase() < cfg.uniswap.weth.toLowerCase()) return salt; }
  throw new Error('no salt found');
}
export function randomSalt(): `0x${string}` { const r = new Uint8Array(32); crypto.getRandomValues(r); return toHex(r); }
/** Launch and return the new coin's address, read from the Launched event of the receipt. */
export async function launchCoin(cfg: Config, p: LaunchParams, value: bigint): Promise<{ hash: Hash; token: string }> {
  const hash = await tx.launch(cfg, p, value); const rc = await publicClient(cfg.chainId).getTransactionReceipt({ hash });
  for (const l of rc.logs) { if (l.address.toLowerCase() !== cfg.launchpad.toLowerCase()) continue; try { const e = decodeEventLog({ abi: ABI.launchpad, data: l.data, topics: l.topics }); if (e.eventName === 'Launched') return { hash, token: String((e.args as unknown as { token: string }).token).toLowerCase() }; } catch {} }
  return { hash, token: '' };
}
export const reads = {
  balance: (cfg: Config, token: Addr, owner: Addr) => publicClient(cfg.chainId).readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }) as Promise<bigint>,
  allowance: (cfg: Config, token: Addr, owner: Addr, spender: Addr) => publicClient(cfg.chainId).readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] }) as Promise<bigint>,
  ethBalance: (cfg: Config, owner: Addr) => publicClient(cfg.chainId).getBalance({ address: owner }),
  ethUsd: (cfg: Config) => publicClient(cfg.chainId).readContract({ address: cfg.launchpad as Addr, abi: ABI.launchpad, functionName: 'ethUsd', args: [] }) as Promise<bigint>,
  claimable: (cfg: Config, owner: Addr) => publicClient(cfg.chainId).readContract({ address: cfg.fees as Addr, abi: ABI.fees, functionName: 'claimable', args: [owner] }) as Promise<bigint>,
};
export function explainError(e: unknown): string { const s = String((e as { shortMessage?: string })?.shortMessage || (e as Error)?.message || e); const m = s.match(/reason:\s*([^\n]+)/) || s.match(/reverted with the following reason:\s*([^\n]+)/); if (m) return m[1].trim(); if (/max per swap/i.test(s)) return 'over the max per swap while the opening rules hold: buy less, or wait'; if (/rejected|denied/i.test(s)) return 'you declined in the wallet'; if (/insufficient funds/i.test(s)) return 'not enough ETH for this and the gas'; return s.split('\n')[0].slice(0, 160); }
