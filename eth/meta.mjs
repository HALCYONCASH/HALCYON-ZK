// A coin's metadata: the record a launch's uri points at (name, symbol, description, picture, links). The site hosts every record it
// made (/m/<key>.json, content-addressed) and, when Pinata is configured, pins the record and the picture to IPFS so the uri on chain
// is ipfs://<cid>. Records of coins launched through other front ends are fetched from their uri once and kept.
import { createHash } from 'node:crypto';
import { loadMeta, putMeta, loadImages } from './store.mjs';
import { cidOf, gatewayUrl, fetchIpfsJson } from './pinata.mjs';

/** The key a record is hosted under: 32 hex characters of its sha256. Pure. */
export function metaKey(record) { return createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 32); }
/** A clean record from what a launch form (or a foreign uri) gives: lengths bounded, only https links, a picture that is https, ipfs or one of ours. Pure. */
export function cleanMeta(body) {
  const s = (v, n) => String(v || '').trim().slice(0, n); const link = v => { const u = s(v, 200); return /^https:\/\/[^\s]+$/i.test(u) ? u : ''; };
  const rec = { name: s(body?.name, 48), symbol: s(body?.symbol, 12).toUpperCase(), description: s(body?.description, 1000), image: (() => { const u = s(body?.image, 300); return /^(https:\/\/[^\s]+|ipfs:\/\/[A-Za-z0-9/._-]+|\/i\/[a-f0-9]{16,64}\.(png|jpe?g|webp|gif|svg))$/i.test(u) ? u : ''; })(), links: { x: link(body?.links?.x), site: link(body?.links?.site), telegram: link(body?.links?.telegram), discord: link(body?.links?.discord) } };
  if (!rec.name || !rec.symbol) throw new Error('name and symbol');
  return rec;
}
/** The store key a uri names: our hosted key (/m/<key>.json or meta:<key>), or the cid of an ipfs:// uri. Pure. */
export function keyOfUri(uri) { const u = String(uri || ''); return u.match(/\/m\/([a-f0-9]{16,64})\.json$/i)?.[1] || (u.startsWith('meta:') ? u.slice(5) : '') || cidOf(u); }
/** The picture's URL for the site: our own copy when we have it (fast, same origin), the gateway for ipfs://, the URL as given otherwise. */
export function imageUrl(image) {
  const img = String(image || ''); if (!img) return '';
  if (img.startsWith('ipfs://')) { const cid = cidOf(img); const own = Object.entries(loadImages()).find(([, v]) => v && v.cid === cid); return own ? `/i/${own[0]}.${own[1].ext}` : gatewayUrl(img); }
  return img;
}
/** The record for a coin's uri as the site knows it, or null. */
export function recordOf(uri) { const key = keyOfUri(uri); return key ? loadMeta()[key] || null : null; }

const pending = new Set(); const tried = new Map(); const RETRY_SEC = 6 * 3600;
/**
 * Fetch and keep the record of a uri the site does not have yet (a coin launched elsewhere): ipfs:// through the gateway, https:// directly
 * (small, JSON, cleaned like our own). Once per uri per six hours; never throws.
 */
export async function fetchMeta(uri, { log = () => {} } = {}) {
  const u = String(uri || ''); const key = keyOfUri(u); if (!key || loadMeta()[key] || pending.has(u)) return null;
  const last = tried.get(u) || 0; if (Date.now() / 1000 - last < RETRY_SEC) return null; tried.set(u, Math.floor(Date.now() / 1000)); pending.add(u);
  try {
    let body = null;
    if (u.startsWith('ipfs://')) body = await fetchIpfsJson(u);
    else if (/^https:\/\//.test(u)) { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10_000); try { const r = await fetch(u, { signal: ctl.signal, headers: { accept: 'application/json' } }); const text = r.ok ? await r.text() : ''; if (text && text.length <= 20_000) body = JSON.parse(text); } catch {} finally { clearTimeout(t); } }
    if (!body) return null;
    const rec = cleanMeta(body); putMeta(key, rec); log(`[halcyon] metadata of ${u.slice(0, 60)} fetched and kept`); return rec;
  } catch { return null; } finally { pending.delete(u); }
}
