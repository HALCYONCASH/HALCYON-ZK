// The holder's side of Mist, in the browser: the keys come from one wallet signature and live in memory only; the public feed of notes
// is scanned here with the viewing key; the Merkle tree is rebuilt here from the same feed; the proof is made here (snarkjs, loaded when
// first needed, with the circuit's wasm and zkey from /zk/); a withdrawal goes out through the site's relayer, which pays the gas for a
// fee the proof fixes, or from the connected wallet itself. Nothing in this file stores a key anywhere, and nothing but the signature
// request and the self-paid withdrawal touches the wallet.
import { createPublicClient, custom, isAddress, getAddress, type PublicClient } from 'viem';
import { normalize } from 'viem/ens';
import * as M from '../../shared/mist.mjs';
import { wallet, walletClient, chainFor } from './wallet';
import { api, type Config, type MistNote } from './api';
import { tx, type Addr } from './chain';

export type MistKeys = ReturnType<typeof M.keysFromSignature>;
export interface Found extends MistNote { sh: bigint; leafIndex: number; nullifierHash: bigint; spent: boolean }
let keys: MistKeys | null = null; let keysFor = '';
/** The keys this session derived, when the connected wallet is still the one that derived them. */
export function mistKeys(): MistKeys | null { return keys && keysFor === wallet.account.toLowerCase() ? keys : null; }
export function forget() { keys = null; keysFor = ''; }
/** One signature, the keys. The wallet signs a fixed sentence; the signature is deterministic, so the same wallet always derives the same keys. */
export async function unlock(cfg: Config): Promise<MistKeys> {
  if (!wallet.provider || !wallet.account) throw new Error('connect a wallet first');
  const have = mistKeys(); if (have) return have;
  const sig = await walletClient(cfg.chainId).signMessage({ account: wallet.account as Addr, message: M.SIGN_MESSAGE });
  keys = M.keysFromSignature(sig); keysFor = wallet.account.toLowerCase(); return keys;
}
export const publicKeyOf = (k: MistKeys) => M.publicKey(k) as `0x${string}`;
/** The site's own reads over /api/rpc, never the wallet (which notes are spent is a question the wallet need not hear). */
export function reader(chainId: number): PublicClient {
  return createPublicClient({ chain: chainFor(chainId), transport: custom({ request: async ({ method, params }) => { const r = await fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message || j.error); return j.result; } }, { retryCount: 0 }) });
}
const SPENT_ABI = [{ type: 'function', name: 'spent', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;
/** Every note in the feed, in order (the leaves of the tree), and the ones that are mine with their spending secrets. */
export async function findMine(cfg: Config, k: MistKeys, onProgress?: (seen: number, total: number) => void): Promise<{ all: MistNote[]; mine: Found[] }> {
  const all: MistNote[] = []; let since = 0;
  for (;;) { const page = await api.mistNotes(since, 2000); all.push(...page.notes); since = page.since + page.notes.length; onProgress?.(since, page.total); if (!page.notes.length || since >= page.total) break; }
  const mine = M.scan(k, all).map(n => { const leafIndex = n.batch * M.BATCH + n.index; return { ...n, leafIndex, nullifierHash: M.nullifierOf(k.spend, n.sh, leafIndex), spent: false }; });
  if (mine.length && cfg.mist && !cfg.demo) { const pc = reader(cfg.chainId); let reachable = true; for (let i = 0; i < mine.length; i += 10) { const chunk = mine.slice(i, i + 10); const flags = reachable ? await Promise.all(chunk.map(n => pc.readContract({ address: cfg.mist as Addr, abi: SPENT_ABI, functionName: 'spent', args: [n.nullifierHash] }).catch(() => null))) : chunk.map(() => null); if (flags.some(f => f === null)) reachable = false; chunk.forEach((n, j) => { n.spent = flags[j] === true; }); } }
  return { all, mine };
}
/** The tree from the feed, as the pool built it: batches of 64 in order. */
export function treeOf(all: MistNote[]) {
  const batches: bigint[][] = []; for (const n of all) { (batches[n.batch] = batches[n.batch] || [])[n.index] = M.leafOf(BigInt(n.commit), BigInt(n.denom)); }
  for (let b = 0; b < batches.length; b++) { batches[b] = batches[b] || []; for (let i = 0; i < batches[b].length; i++) if (batches[b][i] === undefined) throw new Error(`the feed misses note ${b}:${i}`); }
  return M.tree(batches);
}
/** Where a withdrawal goes: an address, or an ENS name on a chain that has ENS. */
export async function resolveTo(cfg: Config, text: string): Promise<Addr> {
  const t = text.trim(); if (isAddress(t)) return getAddress(t);
  if (/\.eth$/i.test(t) && (cfg.chainId === 1 || cfg.chainId === 11155111)) { const a = await reader(cfg.chainId).getEnsAddress({ name: normalize(t) }); if (!a) throw new Error(`${t} does not resolve`); return getAddress(a); }
  throw new Error('an address, or an ENS name');
}
/** The proof of one note for (recipient, relayer, fee), made here. snarkjs and the circuit's files load on the first call. */
export async function prove(k: MistKeys, note: Found, all: MistNote[], to: Addr, relayer: Addr, fee: bigint, onStep?: (s: string) => void) {
  onStep?.('rebuilding the tree'); const T = treeOf(all); const path = T.path(note.leafIndex);
  const w = M.witness({ keys: k, sh: note.sh, denom: BigInt(note.denom), index: note.leafIndex, path, root: T.root, recipient: to, relayer, fee });
  onStep?.('loading the prover'); const snarkjs = await import('snarkjs');
  onStep?.('proving (a few seconds)'); const { proof, publicSignals } = await snarkjs.groth16.fullProve(w, '/zk/withdraw.wasm', '/zk/withdraw.zkey');
  return { proof, publicSignals: publicSignals as string[], root: T.root };
}
/** Withdraw through the site's relayer: it quotes its fee, the proof binds it, the relayer pays the gas. Returns the transaction hash. */
export async function withdrawRelayed(cfg: Config, k: MistKeys, note: Found, all: MistNote[], to: Addr, onStep?: (s: string) => void): Promise<{ hash: string; fee: bigint }> {
  void cfg; onStep?.('asking the relayer for its fee'); const q = await api.mistQuote(note.denom); const fee = BigInt(q.fee); if (fee * 2n > BigInt(note.denom)) throw new Error('the relayer fee would be more than half the note: wait for cheaper gas, or pay the gas yourself');
  const { proof, publicSignals } = await prove(k, note, all, to, getAddress(q.relayer), fee, onStep);
  onStep?.('sending through the relayer'); const r = await api.mistRelay({ proof, publicSignals }); return { hash: r.hash, fee };
}
/** Withdraw from the connected wallet: it is the relayer, with no fee, and pays the gas itself. */
export async function withdrawSelf(cfg: Config, k: MistKeys, note: Found, all: MistNote[], to: Addr, onStep?: (s: string) => void): Promise<{ hash: string; fee: bigint }> {
  const me = getAddress(wallet.account as Addr); const { proof, publicSignals } = await prove(k, note, all, to, me, 0n, onStep);
  onStep?.('loading the prover'); const snarkjs = await import('snarkjs'); const cd = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`) as [string[], string[][], string[], string[]];
  onStep?.('sending from your wallet'); const hash = await tx.withdrawMist(cfg, cd[0].map(BigInt), cd[1].map(r => r.map(BigInt)), cd[2].map(BigInt), BigInt(cd[3][0]), BigInt(cd[3][1]), BigInt(note.denom), to, me, 0n);
  return { hash, fee: 0n };
}
