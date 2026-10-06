// The chain clients: one public client over every RPC in ETH_RPC_URL (viem's fallback transport ranks them), one wallet client for the
// gardener when its key is set. Everything that reads or writes the chain goes through here.
import { createPublicClient, createWalletClient, http, fallback, custom, defineChain, getAddress, isAddress as viemIsAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia, hardhat } from 'viem/chains';
import { CONFIG, chainInfo } from './config.mjs';

export const low = a => String(a || '').toLowerCase();
export const isAddress = a => { try { return viemIsAddress(String(a)); } catch { return false; } };
export const checksum = a => getAddress(String(a));
export function viemChain() {
  const c = chainInfo();
  if (c.id === 1) return mainnet; if (c.id === 11155111) return sepolia; if (c.id === 31337) return hardhat;
  return defineChain({ id: c.id, name: c.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: CONFIG.rpcUrls } } });
}
let pub = null, wal = null, acct = null, injected = null;
/** Tests inject an EIP-1193 provider (the in-process EVM) instead of RPC URLs. */
export function useProvider(provider, chain) { injected = { provider, chain }; pub = null; wal = null; }
export function publicClient() {
  if (pub) return pub;
  if (injected) { pub = createPublicClient({ chain: injected.chain, transport: custom(injected.provider) }); return pub; }
  if (!CONFIG.rpcUrls.length) throw new Error('ETH_RPC_URL missing');
  const transports = CONFIG.rpcUrls.map(u => http(u, { timeout: 20_000, retryCount: 2, batch: true }));
  pub = createPublicClient({ chain: viemChain(), transport: transports.length === 1 ? transports[0] : fallback(transports, { rank: false }) });
  return pub;
}
export function gardenerAccount() {
  if (acct) return acct;
  if (injected?.account) return (acct = injected.account);
  if (!CONFIG.gardenerKey) return null;
  acct = privateKeyToAccount(CONFIG.gardenerKey.startsWith('0x') ? CONFIG.gardenerKey : `0x${CONFIG.gardenerKey}`);
  return acct;
}
export const gardenerAddress = () => { const a = gardenerAccount(); return typeof a === 'string' ? a : a?.address || ''; };
export function walletClient() {
  if (wal) return wal;
  const account = gardenerAccount(); if (!account) throw new Error('HALCYON_GARDENER_KEY missing');
  if (injected) { wal = createWalletClient({ chain: injected.chain, transport: custom(injected.provider), account }); return wal; }
  const transports = CONFIG.rpcUrls.map(u => http(u, { timeout: 30_000 }));
  wal = createWalletClient({ chain: viemChain(), transport: transports.length === 1 ? transports[0] : fallback(transports, { rank: false }), account });
  return wal;
}
export function useGardener(account) { injected = { ...(injected || {}), account }; acct = null; wal = null; }
/* The gardener's transactions are sent by eth/sender.mjs (sendGardener): fees with headroom, one at a time, followed until they are in a block. */
/** The reason inside a viem error, short. */
export function reason(e) { let c = e; for (let i = 0; c && i < 8; i++) { const d = String(c.details || ''); const m = d.match(/reason string '([^']*)'/); if (m) return m[1]; const r = String(c.reason || ''); if (r) return r; c = c.cause; } return String(e?.shortMessage || e?.message || e).split('\n')[0].slice(0, 160); }
