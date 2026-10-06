// Sending a transaction as the platform wallet from a script, for the operator who keeps that wallet's key in .env (HALCYON_PLATFORM_KEY)
// rather than in a browser wallet. Dry by default: what would be sent, to where, with the gas estimate; --go sends and waits. The key is
// never printed, and a key that is not the platform the fees contract names is refused before anything is estimated.
import { createWalletClient, http, formatEther, formatGwei, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CONFIG } from './config.mjs';
import { publicClient, viemChain } from './chain.mjs';
import { ABI } from './contracts.mjs';

/** The platform wallet's account from HALCYON_PLATFORM_KEY, or null when it is not set. */
export function platformAccount() {
  const key = String(process.env.HALCYON_PLATFORM_KEY || '').trim(); if (!key) return null;
  return privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);
}
/**
 * Send `data` to the fees contract as the platform: dry unless `go`. Checks the key is the platform the contract names, estimates the gas,
 * refuses a gas price over HALCYON_GAS_CAP_GWEI, and with `go` sends and waits for the receipt. Returns { hash, gas, gasPrice } (hash '' when dry).
 */
export async function sendAsPlatform({ to = CONFIG.fees, data, label, go = false, log = m => process.stdout.write(`${m}\n`) }) {
  const account = platformAccount(); if (!account) throw new Error('HALCYON_PLATFORM_KEY is not set: put the platform wallet\'s private key in .env (only there), or send the calldata from that wallet by hand');
  if (!to) throw new Error('no fees contract address (HALCYON_FEES, or deployments/<chain>.json)');
  const pc = publicClient(); const onChain = await pc.readContract({ address: getAddress(to), abi: ABI.fees, functionName: 'platform' });
  if (onChain.toLowerCase() !== account.address.toLowerCase()) throw new Error(`the key in HALCYON_PLATFORM_KEY is ${account.address}, and the fees contract's platform is ${onChain}: not the same wallet, nothing sent`);
  const gasPrice = await pc.getGasPrice(); const cap = Number(process.env.HALCYON_GAS_CAP_GWEI || 30); if (Number(formatGwei(gasPrice)) > cap) throw new Error(`gas is ${formatGwei(gasPrice)} gwei, over HALCYON_GAS_CAP_GWEI=${cap}; later`);
  const gas = await pc.estimateGas({ account: account.address, to: getAddress(to), data });
  const balance = await pc.getBalance({ address: account.address });
  log(`${label}: ${gas} gas at ${formatGwei(gasPrice)} gwei (about ${formatEther(gas * gasPrice)} ETH), from ${account.address} (${formatEther(balance)} ETH) to ${getAddress(to)}`);
  if (!go) { log('dry run: add --go to send'); return { hash: '', gas, gasPrice }; }
  if (balance < gas * gasPrice * 3n / 2n) throw new Error('the platform wallet holds less than one and a half times the gas this needs');
  const wc = createWalletClient({ chain: viemChain(), transport: http(CONFIG.rpcUrls[0]), account });
  const hash = await wc.sendTransaction({ to: getAddress(to), data, gas: gas + gas / 5n }); log(`sent ${hash}; waiting for the receipt`);
  const rc = await pc.waitForTransactionReceipt({ hash, timeout: 30 * 60_000, pollingInterval: 4_000 }); if (rc.status !== 'success') throw new Error(`${label} reverted (${hash})`);
  log(`mined in block ${rc.blockNumber}, ${rc.gasUsed} gas`); return { hash, gas, gasPrice };
}
