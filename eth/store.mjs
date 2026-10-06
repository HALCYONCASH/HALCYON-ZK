// The state on disk: one JSON file for what the indexer knows (coins, curves, trades, balances, payouts), one for the ledger of what the
// gardener did, one for coin metadata. Atomic writes, BigInt as strings, loaded once and kept in memory.
import fs from 'node:fs';
import path from 'node:path';
import { dataPath, ensureDataDir } from './config.mjs';

export function readJsonSafe(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
export function atomicWrite(file, text) { ensureDataDir(); fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
const bigintSafe = (k, v) => (typeof v === 'bigint' ? v.toString() : v);

export const EMPTY = () => ({ version: 6, checkpoint: 0, coins: {}, trades: {}, balances: {}, since: {}, payouts: [], stocks: {}, blocks: {}, v3Pools: {}, v4Pools: {}, mistKeys: {}, mist: { notes: [], batches: [], spent: 0, withdrawn: '0', withdrawals: [] }, days: {}, burns: [], platform: { withdrawn: '0', withdrawals: [] } });
let state = null;
export const stateFile = () => dataPath('halcyon-state.json');
/** The state on disk; one written by an older version of the indexer (its buckets missing) is set aside and the chain is read again from the deploy block. */
export function loadState() {
  if (!state) { const stored = readJsonSafe(stateFile(), {}); if (stored.checkpoint && Number(stored.version || 0) < EMPTY().version) { try { fs.copyFileSync(stateFile(), `${stateFile()}.v${stored.version || 0}`); } catch {} process.stdout.write(`[index] the state on disk is version ${stored.version || 0}; this is version ${EMPTY().version}: reading the chain again from the deploy block\n`); try { fs.rmSync(dataPath('candles'), { recursive: true, force: true }); } catch {} state = EMPTY(); } else state = { ...EMPTY(), ...stored }; }
  return state;
}
export function saveState() { if (state) atomicWrite(stateFile(), JSON.stringify(state, bigintSafe)); }
export function resetState(next = EMPTY()) { state = next; saveState(); return state; }

/** The ledger: every gardener action and every payout, appended, newest last; capped so it never grows past reason. */
export const ledgerFile = () => dataPath('halcyon-ledger.json');
let ledger = null;
export function loadLedger() { if (!ledger) ledger = readJsonSafe(ledgerFile(), []); return ledger; }
export function record(entry) { const l = loadLedger(); l.push({ at: Math.floor(Date.now() / 1000), ...entry }); if (l.length > 5000) l.splice(0, l.length - 5000); atomicWrite(ledgerFile(), JSON.stringify(l, bigintSafe)); return entry; }
/** What a pending transaction became: the entries (or the batch results inside them) that carry one of `hashes` take `patch`. Returns how many. */
export function settleLedger(hashes, patch) {
  const set = new Set(hashes.map(h => String(h).toLowerCase())); let n = 0; const l = loadLedger();
  for (const e of l) { if (e.hash && set.has(String(e.hash).toLowerCase())) { Object.assign(e, patch); n++; } for (const r of e.results || []) if (r.hash && set.has(String(r.hash).toLowerCase())) { Object.assign(r, patch); n++; } }
  if (n) atomicWrite(ledgerFile(), JSON.stringify(l, bigintSafe)); return n;
}

/** Coin metadata (name, description, image, links) keyed by the sha256 of its JSON: what a launch's `uri` points at when the site hosts it. */
export const metaFile = () => dataPath('halcyon-meta.json');
let meta = null;
export function loadMeta() { if (!meta) meta = readJsonSafe(metaFile(), {}); return meta; }
export function putMeta(key, value) { const m = loadMeta(); if (!m[key]) { m[key] = value; metaTimes()[key] = Math.floor(Date.now() / 1000); atomicWrite(metaFile(), JSON.stringify(m)); } return m[key]; }
/** Uploaded pictures by their key (sha256 of the bytes): the extension, and the IPFS cid when Pinata pinned them. */
export const imagesFile = () => dataPath('halcyon-images.json');
let images = null;
export function loadImages() { if (!images) images = readJsonSafe(imagesFile(), {}); return images; }
export function putImage(key, info) { const m = loadImages(); m[key] = { ...(m[key] || {}), ...info }; atomicWrite(imagesFile(), JSON.stringify(m)); return m[key]; }
/** When each metadata record was posted (kept apart from the content-addressed records themselves). */
export const metaTimesFile = () => dataPath('halcyon-meta-times.json');
let times = null;
export function metaTimes() { if (!times) times = readJsonSafe(metaTimesFile(), {}); return times; }
/**
 * Metadata that no coin references within a day of being posted was posted and never launched (or by someone who never meant to launch):
 * drop it, and any uploaded image nothing references any more. `referenced` is the set of metadata keys the indexed coins point at.
 */
export function sweep({ referenced, imageDir, maxAgeSec = 86_400, now = Math.floor(Date.now() / 1000) }) {
  const m = loadMeta(); const t = metaTimes(); let dropped = 0, images = 0;
  for (const key of Object.keys(m)) { if (referenced.has(key)) continue; const at = t[key] || 0; if (!at) { t[key] = now; continue; } /* an old record with no time: give it a day from now */ if (now - at > maxAgeSec) { delete m[key]; delete t[key]; dropped++; } }
  for (const key of Object.keys(t)) if (!m[key]) delete t[key];
  if (dropped) atomicWrite(metaFile(), JSON.stringify(m)); atomicWrite(metaTimesFile(), JSON.stringify(t));
  if (imageDir && fs.existsSync(imageDir)) {
    const imgs = loadImages(); const byCid = Object.fromEntries(Object.entries(imgs).filter(([, v]) => v?.cid).map(([k, v]) => [v.cid, `${k}.${v.ext}`]));
    const used = new Set(Object.values(m).map(r => { const img = String(r?.image || ''); return img.match(/^\/i\/([a-f0-9]{16,64}\.[a-z]+)$/i)?.[1] || (img.startsWith('ipfs://') ? byCid[img.replace(/^ipfs:\/\/(ipfs\/)?/, '').split('/')[0]] : ''); }).filter(Boolean));
    for (const f of fs.readdirSync(imageDir)) { if (used.has(f)) continue; try { const st = fs.statSync(path.join(imageDir, f)); if (now - Math.floor(st.mtimeMs / 1000) > maxAgeSec) { fs.unlinkSync(path.join(imageDir, f)); images++; } } catch {} }
  }
  return { dropped, images };
}
