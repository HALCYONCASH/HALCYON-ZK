// The gardener's transactions, one at a time. Each goes out with its own fees (twice the base fee plus a tip, the tip the node suggests
// or at least HALCYON_GARDENER_TIP_GWEI, the whole under HALCYON_GAS_CAP_GWEI: a transaction priced at the base fee of the moment is
// stranded by the next rise, and only the base fee of the block it lands in is paid) and its own nonce, read from the chain. A transaction
// that is not in a block after the wait is not a failure: it is kept on disk as pending, and every tick (and every start) follows it:
// in a block, its ledger entry is settled; waiting longer than the bump delay, it is sent again at the same nonce with fees fifteen
// percent higher and at least the fees of now; its nonce used by a transaction that is not one of its own, it is given up and reported,
// since that means the key was used somewhere else. Nothing new goes out while one is pending: behind a stuck transaction everything
// is stuck. A transaction waiting at the gardener's nonce that this process never sent (one from before an update, or from elsewhere)
// is replaced by the next one sent, for the same reason.
import fs from 'node:fs';
import { formatGwei, parseGwei, getAddress } from 'viem';
import { CONFIG, dataPath } from './config.mjs';
import { publicClient, walletClient, gardenerAccount, gardenerAddress, reason } from './chain.mjs';
import { atomicWrite, settleLedger } from './store.mjs';

export const SENDER = { waitMs: 120_000, bumpAfterMs: 150_000, bumpPct: 15, headroom: 2n, pollMs: 4_000, lagMs: 3_000 };
const file = () => dataPath('halcyon-pending.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const big = (a, b) => (a > b ? a : b);
let pending; /* the pending transaction, read from disk once */
/** The transaction that is out and not yet in a block, or null. */
export function pendingTx() { if (pending === undefined) { try { pending = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { pending = null; } } return pending; }
function keep(p) { pending = p; if (p) atomicWrite(file(), JSON.stringify(p)); else { try { fs.unlinkSync(file()); } catch {} } }
export function forgetPending() { keep(null); }
let queue = Promise.resolve();
const serial = fn => { const p = queue.then(fn, fn); queue = p.then(() => {}, () => {}); return p; };
const errorText = e => String(e?.details || e?.shortMessage || e?.message || e).toLowerCase();

/** The fees for a transaction now: twice the base fee plus the tip (the node's estimate, at least the floor), the whole under the gas cap. */
export async function feesNow(pc = publicClient()) {
  const block = await pc.getBlock({ blockTag: 'latest' }); const cap = parseGwei(String(CONFIG.gasCapGwei));
  if (block.baseFeePerGas === undefined || block.baseFeePerGas === null) { const gasPrice = await pc.getGasPrice(); return { legacy: true, gasPrice: gasPrice > cap ? cap : gasPrice }; }
  const base = block.baseFeePerGas; const floor = parseGwei(String(CONFIG.gardenerTipGwei));
  let tip = 0n; try { tip = await pc.estimateMaxPriorityFeePerGas(); } catch {} if (tip < floor) tip = floor;
  let maxFee = base * SENDER.headroom + tip; if (maxFee > cap) maxFee = cap; if (tip > maxFee) tip = maxFee;
  return { legacy: false, base, tip, maxFee };
}
const feeFields = f => (f.legacy ? { gasPrice: f.gasPrice } : { maxFeePerGas: f.maxFee, maxPriorityFeePerGas: f.tip });
const describe = tx => (tx.gasPrice !== undefined ? `${formatGwei(tx.gasPrice)} gwei` : `${formatGwei(tx.maxPriorityFeePerGas)} gwei tip, ${formatGwei(tx.maxFeePerGas)} gwei max`);

/** The receipt of any of the pending transaction's hashes, or null. */
async function receiptOf(pc, p) { for (const h of p.hashes) { const r = await pc.getTransactionReceipt({ hash: h }).catch(() => null); if (r) return r; } return null; }
/**
 * One look at the pending transaction: in a block, it is settled (the ledger entry that carries one of its hashes takes the outcome)
 * and { done, receipt } comes back (with `error` when it reverted); its nonce used by something else, { done, error }; still waiting
 * past the bump delay, it is sent again with higher fees; otherwise { done: false, pending }.
 */
async function check(p, { log = () => {}, now = Date.now() } = {}) {
  const pc = publicClient(); let r = await receiptOf(pc, p);
  if (!r) { const latest = await pc.getTransactionCount({ address: getAddress(gardenerAddress()), blockTag: 'latest' }); for (let i = 0; i < 3 && !r && latest > p.nonce; i++) { await sleep(SENDER.lagMs); r = await receiptOf(pc, p); } /* a node that knows the nonce before the receipt */ if (!r && latest > p.nonce) { const error = `nonce ${p.nonce} was used by a transaction that is not this one: the gardener's key was used somewhere else`; settleLedger(p.hashes, { pending: undefined, error }); log(`[gardener] ${p.label}: ${error}; given up`); keep(null); return { done: true, error }; } }
  if (r) {
    const ok = r.status === 'success'; const bumps = p.bumps ? `, after ${p.bumps} bump${p.bumps > 1 ? 's' : ''}` : '';
    settleLedger(p.hashes, { hash: r.transactionHash, pending: undefined, block: Number(r.blockNumber), ...(ok ? { gasUsed: r.gasUsed.toString() } : { error: 'reverted' }) });
    log(`[gardener] ${p.label}: ${ok ? 'in' : 'reverted in'} block ${r.blockNumber} (${r.transactionHash}${bumps})`); keep(null); return { done: true, receipt: r, error: ok ? undefined : `reverted (${r.transactionHash})` };
  }
  if (now - p.sentAt < SENDER.bumpAfterMs || p.gasPrice) return { done: false, pending: p };
  const f = await feesNow(pc); if (f.legacy) return { done: false, pending: p };
  const cap = parseGwei(String(CONFIG.gasCapGwei)); const up = x => x + x * BigInt(SENDER.bumpPct) / 100n + 1n; const least = x => x + x / 10n + 1n;
  let maxFee = big(up(BigInt(p.maxFee)), f.maxFee); let tip = big(up(BigInt(p.tip)), f.tip); if (maxFee > cap) maxFee = cap; if (tip > maxFee) tip = maxFee;
  if (maxFee < least(BigInt(p.maxFee)) || tip < least(BigInt(p.tip))) { log(`[gardener] ${p.label}: still waiting (${p.hashes.at(-1)}); a bump would pass the gas cap of ${CONFIG.gasCapGwei} gwei`); return { done: false, pending: p }; }
  const tx = { to: getAddress(p.to), data: p.data, value: BigInt(p.value), gas: BigInt(p.gas), nonce: p.nonce, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
  try { const hash = await walletClient().sendTransaction(tx); const next = { ...p, hashes: [...p.hashes, hash], maxFee: maxFee.toString(), tip: tip.toString(), sentAt: now, bumps: (p.bumps || 0) + 1 }; keep(next); log(`[gardener] ${p.label}: not in a block after ${Math.round((now - p.sentAt) / 1000)} s; sent again as ${hash} at ${describe(tx)} (bump ${next.bumps})`); return { done: false, pending: next }; }
  catch (e) { log(`[gardener] ${p.label}: still waiting (${p.hashes.at(-1)}); the bump was refused: ${reason(e)}`); return { done: false, pending: p }; }
}
/** Follow the pending transaction, if there is one. Returns what is still pending, or null. */
export const settle = opts => serial(async () => { const p = pendingTx(); if (!p) return null; const r = await check(p, opts); return r.done ? null : r.pending; });

/** Send `tx` from the gardener's wallet; a node that wants more for the nonce (a transaction waiting there) gets half as much again, a few times; a nonce that moved is read again. */
async function broadcast(w, pc, tx, from, { label, log }) {
  let t = { ...tx };
  for (let i = 0; i < 5; i++) {
    try { return { hash: await w.sendTransaction(t), tx: t }; } catch (e) {
      const m = errorText(e);
      if (/underpriced|replacement/.test(m) && t.maxFeePerGas !== undefined) { const cap = parseGwei(String(CONFIG.gasCapGwei)); let maxFee = t.maxFeePerGas * 3n / 2n + 1n; if (maxFee > cap) maxFee = cap; let tip = t.maxPriorityFeePerGas * 3n / 2n + 1n; if (tip > maxFee) tip = maxFee; if (maxFee <= t.maxFeePerGas) throw new Error(`${label}: a transaction waiting at nonce ${t.nonce} wants more than the gas cap to replace`); t = { ...t, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip }; log(`[gardener] ${label}: the node wants more than the transaction waiting at nonce ${t.nonce}; trying ${describe(t)}`); continue; }
      if (/nonce too low|nonce has already been used/.test(m)) { const nonce = await pc.getTransactionCount({ address: from, blockTag: 'latest' }); if (nonce === t.nonce) throw e; t = { ...t, nonce }; continue; }
      throw e;
    }
  }
  throw new Error(`${label}: not sent after five tries`);
}
/**
 * Send one gardener transaction and follow it for `waitMs`: { hash, receipt } once it is in a block (a reverted one throws); past the
 * wait, { hash, pending: true }, the transaction kept on disk for the next tick to follow. The gas limit is the estimate plus the buffer;
 * a call that reverts at estimation is refused with the reason; a transaction still pending from before is refused as busy.
 */
export async function sendGardener({ to, data, value = 0n }, { label = 'transaction', bufferPct = 25, waitMs = SENDER.waitMs, log = () => {} } = {}) {
  return serial(async () => {
    const pc = publicClient(); const w = walletClient(); const account = gardenerAccount(); const from = getAddress(gardenerAddress());
    const before = pendingTx(); if (before) { const r = await check(before, { log }); if (!r.done) throw new Error(`busy: ${before.label} is still pending (${r.pending.hashes.at(-1)}, nonce ${before.nonce})`); }
    let gas; try { gas = await pc.estimateGas({ account, to, data, value }); } catch (e) { throw new Error(`${label} would revert: ${reason(e)}`); }
    gas = gas + gas * BigInt(bufferPct) / 100n;
    const [latest, queued] = await Promise.all([pc.getTransactionCount({ address: from, blockTag: 'latest' }), pc.getTransactionCount({ address: from, blockTag: 'pending' })]);
    if (queued > latest) log(`[gardener] ${queued - latest} transaction${queued - latest > 1 ? 's' : ''} from the gardener wallet ${queued - latest > 1 ? 'are' : 'is'} waiting that this process did not send; ${label} takes nonce ${latest} and replaces the first`);
    const f = await feesNow(pc); const { hash, tx } = await broadcast(w, pc, { to: getAddress(to), data, value, gas, nonce: latest, ...feeFields(f) }, from, { label, log });
    const now = Date.now(); keep({ label, to: getAddress(to), data, value: value.toString(), gas: gas.toString(), nonce: tx.nonce, maxFee: tx.maxFeePerGas?.toString(), tip: tx.maxPriorityFeePerGas?.toString(), gasPrice: tx.gasPrice?.toString(), hashes: [hash], sentAt: now, firstAt: now, bumps: 0 });
    const until = now + waitMs;
    for (;;) {
      const r = await check(pendingTx(), { log }); if (r.done) { if (r.error) throw new Error(`${label} ${r.error}`); return { hash: r.receipt.transactionHash, receipt: r.receipt }; }
      const left = until - Date.now(); if (left <= 0) { log(`[gardener] ${label}: ${r.pending.hashes.at(-1)} is not in a block after ${Math.round(waitMs / 1000)} s; it stays pending and the next tick follows it`); return { hash: r.pending.hashes.at(-1), pending: true }; }
      await sleep(Math.min(SENDER.pollMs, left));
    }
  });
}
