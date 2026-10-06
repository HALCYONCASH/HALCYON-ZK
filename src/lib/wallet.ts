// The wallet: EIP-6963 discovery (every injected wallet announces itself), window.ethereum as the fallback, a viem wallet client over the
// chosen provider, the chain switched to the launchpad's when it differs. One small store the components subscribe to.
import { createWalletClient, createPublicClient, custom, type EIP1193Provider, type WalletClient, type PublicClient, defineChain } from 'viem';
import { mainnet, sepolia, hardhat } from 'viem/chains';

export interface WalletInfo { uuid: string; name: string; icon: string; rdns: string; provider: EIP1193Provider }
type Listener = () => void;
const listeners = new Set<Listener>(); const emit = () => listeners.forEach(l => l());
export const wallet = { wallets: [] as WalletInfo[], account: '' as string, chainId: 0, provider: null as EIP1193Provider | null, name: '', busy: false };
export function subscribe(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; }

export function discover() {
  if (typeof window === 'undefined') return;
  const seen = new Set<string>();
  window.addEventListener('eip6963:announceProvider', (e: Event) => { const d = (e as CustomEvent).detail; if (!d?.info?.uuid || seen.has(d.info.uuid)) return; seen.add(d.info.uuid); wallet.wallets = [...wallet.wallets, { uuid: d.info.uuid, name: d.info.name, icon: d.info.icon, rdns: d.info.rdns, provider: d.provider }]; emit(); });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  setTimeout(() => { const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum; if (eth && !wallet.wallets.length) { wallet.wallets = [{ uuid: 'injected', name: 'Browser wallet', icon: '', rdns: 'injected', provider: eth }]; emit(); } }, 400);
}
export function chainFor(id: number) { if (id === 1) return mainnet; if (id === 11155111) return sepolia; if (id === 31337) return hardhat; return defineChain({ id, name: `chain ${id}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } }); }
export async function connect(w: WalletInfo, wantChainId: number) {
  wallet.busy = true; emit();
  try {
    const accounts = (await w.provider.request({ method: 'eth_requestAccounts' })) as string[]; if (!accounts?.length) throw new Error('no account');
    wallet.provider = w.provider; wallet.account = accounts[0]; wallet.name = w.name; wallet.chainId = Number(await w.provider.request({ method: 'eth_chainId' }));
    if (wantChainId && wallet.chainId !== wantChainId) await switchChain(wantChainId);
    w.provider.on?.('accountsChanged', (a: unknown) => { const list = a as string[]; wallet.account = list?.[0] || ''; emit(); });
    w.provider.on?.('chainChanged', (c: unknown) => { wallet.chainId = Number(c); emit(); });
    try { localStorage.setItem('halcyon-wallet', w.rdns); } catch {}
  } finally { wallet.busy = false; emit(); }
}
export async function switchChain(id: number) {
  if (!wallet.provider) return; const hex = `0x${id.toString(16)}`;
  try { await wallet.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); } catch (e: unknown) { const code = (e as { code?: number })?.code; if (code === 4902 && id === 11155111) await wallet.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: 'Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.sepolia.org'], blockExplorerUrls: ['https://sepolia.etherscan.io'] }] }); else throw e; }
  wallet.chainId = Number(await wallet.provider.request({ method: 'eth_chainId' })); emit();
}
export function disconnect() { wallet.account = ''; wallet.provider = null; wallet.name = ''; try { localStorage.removeItem('halcyon-wallet'); } catch {} emit(); }
export function walletClient(chainId: number): WalletClient { if (!wallet.provider || !wallet.account) throw new Error('connect a wallet first'); return createWalletClient({ account: wallet.account as `0x${string}`, chain: chainFor(chainId), transport: custom(wallet.provider) }); }
export function publicClient(chainId: number): PublicClient { if (wallet.provider) return createPublicClient({ chain: chainFor(chainId), transport: custom(wallet.provider) }); return createPublicClient({ chain: chainFor(chainId), transport: custom({ request: async ({ method, params }) => { const r = await fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message || j.error); return j.result; } }) }); }
/** Reconnect silently to the wallet used last time, when it is still around and still authorized. */
export async function resume(wantChainId: number) { let rdns = ''; try { rdns = localStorage.getItem('halcyon-wallet') || ''; } catch {} if (!rdns) return; const tryIt = async () => { const w = wallet.wallets.find(x => x.rdns === rdns); if (!w) return false; const accounts = (await w.provider.request({ method: 'eth_accounts' })) as string[]; if (!accounts?.length) return true; wallet.provider = w.provider; wallet.account = accounts[0]; wallet.name = w.name; wallet.chainId = Number(await w.provider.request({ method: 'eth_chainId' })); w.provider.on?.('accountsChanged', (a: unknown) => { wallet.account = (a as string[])?.[0] || ''; emit(); }); w.provider.on?.('chainChanged', (c: unknown) => { wallet.chainId = Number(c); emit(); }); emit(); void wantChainId; return true; }; if (!(await tryIt())) setTimeout(() => { tryIt(); }, 800); }
