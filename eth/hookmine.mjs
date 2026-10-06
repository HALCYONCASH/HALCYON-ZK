// A Uniswap v4 hook's address spells its permissions in its low 14 bits. The Halcyon hook is deployed through Create2Deployer with
// a salt that gives it the right bits: this finds the salt. Pure, shared by the deploy script and the tests.
import { keccak256, encodePacked, getAddress, toHex, encodeAbiParameters } from 'viem';

export const HOOK_FLAGS = { BEFORE_INITIALIZE: 1 << 13, AFTER_INITIALIZE: 1 << 12, BEFORE_ADD_LIQUIDITY: 1 << 11, AFTER_ADD_LIQUIDITY: 1 << 10, BEFORE_REMOVE_LIQUIDITY: 1 << 9, AFTER_REMOVE_LIQUIDITY: 1 << 8, BEFORE_SWAP: 1 << 7, AFTER_SWAP: 1 << 6, BEFORE_DONATE: 1 << 5, AFTER_DONATE: 1 << 4, BEFORE_SWAP_RETURNS_DELTA: 1 << 3, AFTER_SWAP_RETURNS_DELTA: 1 << 2, AFTER_ADD_LIQUIDITY_RETURNS_DELTA: 1 << 1, AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA: 1 << 0 };
export const ALL_FLAGS_MASK = 0x3fff;
/** What HalcyonHook.permissions() says: afterInitialize, beforeAddLiquidity, beforeSwap, afterSwap. */
export const HALCYON_HOOK_FLAGS = HOOK_FLAGS.AFTER_INITIALIZE | HOOK_FLAGS.BEFORE_ADD_LIQUIDITY | HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.AFTER_SWAP;

/** The init code of the hook: its creation bytecode followed by the ABI-encoded constructor arguments. */
export function hookInitCode(bytecode, { manager, fees, locker }) {
  return bytecode + encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [manager, fees, locker]).slice(2);
}
export const create2Address = (deployer, salt, initCodeHash) => getAddress(`0x${keccak256(encodePacked(['bytes1', 'address', 'bytes32', 'bytes32'], ['0xff', deployer, salt, initCodeHash])).slice(26)}`);
/** The first salt (counting up from `start`) whose CREATE2 address carries exactly `flags` in its low 14 bits. */
export function mineHookSalt(deployer, initCodeHash, flags = HALCYON_HOOK_FLAGS, start = 0, limit = 2_000_000) {
  for (let i = start; i < start + limit; i++) {
    const salt = toHex(i, { size: 32 }); const address = create2Address(deployer, salt, initCodeHash);
    if ((Number(BigInt(address) & BigInt(ALL_FLAGS_MASK))) === flags) return { salt, address, tries: i - start + 1 };
  }
  throw new Error(`no salt found in ${limit} tries`);
}
export const hasFlags = (address, flags = HALCYON_HOOK_FLAGS) => Number(BigInt(address) & BigInt(ALL_FLAGS_MASK)) === flags;
