// The relayer side of Mist: quotes its fee for a withdrawal (the gas it will pay, with a margin, never more than half the note), checks a
// proof before spending gas on it, and sends the withdrawal with the gardener's key. The relayer learns nothing a block explorer would
// not: the proof, the recipient and the fee are public the moment the transaction is. Anyone may relay instead (the proof names its
// relayer), and a holder with a funded fresh wallet needs no relayer at all.
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as snarkjs from 'snarkjs';
import { getAddress } from 'viem';
import { CONFIG } from './config.mjs';
import { publicClient, gardenerAddress, reason } from './chain.mjs';
import { sendGardener } from './sender.mjs';
import { mist, calldata, readMistKnownRoot, readMistSpent, readMistDenominations } from './contracts.mjs';

export const VK = JSON.parse(fs.readFileSync(new URL('../zk/verification_key.json', import.meta.url), 'utf8'));
export const SETUP = JSON.parse(fs.readFileSync(new URL('../zk/setup.json', import.meta.url), 'utf8'));
/**
 * Whether the circuit artifacts this server ships agree with each other and with the deployment: the browser's zkey and wasm
 * (public/zk) must be the ones zk/setup.json records, and that setup must be the one the deployment record (deployments/<chain>.json)
 * was made with, or the proofs holders make in the browser will not verify on chain. Returns { ok, problems: [...] }.
 */
export function checkArtifacts(record = null) {
  const problems = []; const sha = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
  const zkey = sha(new URL('../public/zk/withdraw.zkey', import.meta.url)), wasm = sha(new URL('../public/zk/withdraw.wasm', import.meta.url));
  if (!zkey || !wasm) problems.push('public/zk/withdraw.zkey or withdraw.wasm is missing (zk/build.mjs writes them)');
  else { if (zkey !== SETUP.zkey) problems.push('public/zk/withdraw.zkey is not the one zk/setup.json records'); if (wasm !== SETUP.wasm) problems.push('public/zk/withdraw.wasm is not the one zk/setup.json records'); }
  if (sha(new URL('../zk/verification_key.json', import.meta.url)) !== SETUP.vk) problems.push('zk/verification_key.json is not the one zk/setup.json records');
  if (record && record.zk) { if (record.zk.zkey && record.zk.zkey !== SETUP.zkey) problems.push(`the deployment record was made with another setup (zkey ${String(record.zk.zkey).slice(0, 12)}…, this one ${String(SETUP.zkey).slice(0, 12)}…): the deployed verifier will not accept these proofs`); if (record.zk.dev && !SETUP.dev) problems.push('the deployment record says a development setup, this one is not'); }
  return { ok: problems.length === 0, problems };
}
export const WITHDRAW_GAS = 330_000n;
const RELAY_WAIT_MS = 45_000; /* how long /api/mist/relay waits for the block before answering with the hash alone */
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** What relaying a note of `denom` costs right now: the gas at the current price plus the margin, capped at half the note. */
export async function relayQuote(denom) {
  const d = BigInt(denom); const gasPrice = await publicClient().getGasPrice(); const cost = WITHDRAW_GAS * gasPrice;
  let fee = cost + cost * BigInt(CONFIG.mistRelayMarginPct) / 100n; if (fee > d / 2n) fee = d / 2n;
  return { relayer: gardenerAddress(), fee, gasPrice, gas: WITHDRAW_GAS };
}
/** The six public signals of a withdraw proof, as the circuit orders them. */
export function signalsOf(publicSignals) {
  const s = (publicSignals || []).map(x => BigInt(x)); if (s.length !== 6) throw new Error('six public signals');
  const addr = v => getAddress(`0x${v.toString(16).padStart(40, '0')}`); if (s[3] >= 2n ** 160n || s[4] >= 2n ** 160n) throw new Error('address');
  return { root: s[0], nullifierHash: s[1], denom: s[2], recipient: addr(s[3]), relayer: addr(s[4]), fee: s[5] };
}
/** A proof as the contract takes it: the three points of the Groth16 proof in calldata order. */
export async function proofArgs(proof, publicSignals) {
  const cd = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`);
  return { a: cd[0].map(BigInt), b: cd[1].map(r => r.map(BigInt)), c: cd[2].map(BigInt) };
}
/**
 * Relay a withdrawal: the proof must name this relayer and pay at least most of the quoted fee (gas moves between the quote and the
 * proof), spend an allowed denomination against a root the pool still knows, and verify here before a transaction is spent on it.
 */
export async function relay({ proof, publicSignals }, { send = true } = {}) {
  const sig = signalsOf(publicSignals); for (const v of [sig.root, sig.nullifierHash, sig.fee]) if (v >= FIELD) throw new Error('signal');
  if (sig.relayer.toLowerCase() !== gardenerAddress().toLowerCase()) throw new Error('the proof names another relayer');
  const denoms = (await readMistDenominations()).map(BigInt); if (!denoms.includes(sig.denom)) throw new Error('denomination');
  const q = await relayQuote(sig.denom); if (sig.fee < q.fee * 8n / 10n) throw new Error(`fee too low: the relayer asks ${q.fee} wei now`);
  if (sig.fee > sig.denom / 2n) throw new Error('fee');
  if (!(await readMistKnownRoot(sig.root))) throw new Error('the root is not one the pool knows (rebuild the proof on the latest notes)');
  if (await readMistSpent(sig.nullifierHash)) throw new Error('this note was spent');
  if (!(await snarkjs.groth16.verify(VK, publicSignals, proof))) throw new Error('the proof does not verify');
  const { a, b, c } = await proofArgs(proof, publicSignals); const data = calldata.withdrawMist(a, b, c, sig.root, sig.nullifierHash, sig.denom, sig.recipient, sig.relayer, sig.fee);
  if (!send) return { ...sig, data };
  /* the caller is an HTTP request: the hash comes back as soon as the transaction is out, the block when it is in one within the wait (0 when it is still out: the gardener follows it) */
  try { const r = await sendGardener({ to: mist().address, data }, { label: `mist withdraw ${sig.denom} to ${sig.recipient}`, waitMs: RELAY_WAIT_MS }); return { ...sig, hash: r.hash, block: r.pending ? 0 : Number(r.receipt.blockNumber) }; } catch (e) { throw new Error(/^busy:/.test(String(e.message)) ? 'the relayer is busy with an earlier transaction; try again in a minute, or withdraw from a wallet of your own' : reason(e)); }
}
