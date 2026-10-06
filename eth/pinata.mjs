// Pinning to IPFS through Pinata, when PINATA_JWT is set: a coin's picture and its metadata record go to IPFS at launch, so the coin's
// uri on chain (ipfs://<cid>) names content nobody can change or take down, and the site is one gateway among many for it. Without a
// JWT nothing is pinned and the site hosts the metadata itself (/m/<key>.json), as before. Pinata's current upload API is tried first
// (uploads.pinata.cloud/v3/files, public network); the older pinning API (api.pinata.cloud/pinning/…) is the fallback for keys made for it.
import { CONFIG } from './config.mjs';

const env = k => String(process.env[k] || '').trim();
/** The settings, read from the environment when asked (so a test, or a later `.env`, is seen). */
export const PINATA = {
  get jwt() { return env('PINATA_JWT'); },
  /** where the site reads ipfs:// content from: a dedicated gateway (https://<yours>.mypinata.cloud/ipfs) or a public one */
  get gateway() { return (env('PINATA_GATEWAY_URL') || env('PINATA_PUBLIC_GATEWAY_URL') || 'https://gateway.pinata.cloud/ipfs').replace(/\/+$/, '').replace(/\/ipfs$/, '') + '/ipfs'; },
  get uploads() { return env('PINATA_UPLOAD_URL') || 'https://uploads.pinata.cloud/v3/files'; },
  get legacy() { return (env('PINATA_API_URL') || 'https://api.pinata.cloud').replace(/\/+$/, ''); },
  get group() { return env('PINATA_GROUP_ID'); },
  timeoutMs: 30_000,
};
export const pinningEnabled = () => Boolean(PINATA.jwt);
/** An http URL for an ipfs:// uri (or any cid), through the configured gateway; other URLs pass through. Pure. */
export function gatewayUrl(uri) { const s = String(uri || ''); const m = s.match(/^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]+)(\/.*)?$/); if (m) return `${PINATA.gateway}/${m[1]}${m[2] || ''}`; if (/^[A-Za-z0-9]{46,}$/.test(s)) return `${PINATA.gateway}/${s}`; return s; }
/** The cid of an ipfs:// uri, or ''. Pure. */
export const cidOf = uri => String(uri || '').match(/^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]+)/)?.[1] || '';

async function post(url, body, headers = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), PINATA.timeoutMs);
  try { const r = await fetch(url, { method: 'POST', body, headers: { authorization: `Bearer ${PINATA.jwt}`, ...headers }, signal: ctl.signal }); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {} return { ok: r.ok, status: r.status, json: j, text }; }
  finally { clearTimeout(t); }
}
/**
 * Pin bytes as a file: returns the cid. The v3 upload first; on a 401/403/404 there (a key for the old API, a plan without it) the old
 * pinFileToIPFS. Throws with Pinata's answer when neither takes it.
 */
export async function pinFile(bytes, name, contentType = 'application/octet-stream') {
  if (!pinningEnabled()) throw new Error('PINATA_JWT is not set');
  const blob = new Blob([bytes], { type: contentType });
  const form = new FormData(); form.append('file', blob, name); form.append('network', 'public'); form.append('name', name); if (PINATA.group) form.append('group_id', PINATA.group);
  const v3 = await post(PINATA.uploads, form);
  if (v3.ok && v3.json?.data?.cid) return String(v3.json.data.cid);
  if (![401, 403, 404, 405].includes(v3.status)) throw new Error(`Pinata upload answered ${v3.status}: ${(v3.text || '').slice(0, 200)}`);
  const legacy = new FormData(); legacy.append('file', blob, name); legacy.append('pinataMetadata', JSON.stringify({ name })); legacy.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
  const old = await post(`${PINATA.legacy}/pinning/pinFileToIPFS`, legacy);
  if (old.ok && old.json?.IpfsHash) return String(old.json.IpfsHash);
  throw new Error(`Pinata refused the file (upload API ${v3.status}, pinning API ${old.status}: ${(old.text || v3.text || '').slice(0, 200)})`);
}
/** Pin a JSON record as <name>.json: returns the cid. */
export async function pinJson(record, name = 'metadata') {
  return pinFile(Buffer.from(JSON.stringify(record)), `${name}.json`, 'application/json');
}
/** Read a small JSON document from IPFS through the gateway (metadata of a coin launched through another front end), or null. */
export async function fetchIpfsJson(uri, { maxBytes = 20_000, timeoutMs = 10_000 } = {}) {
  const url = gatewayUrl(uri); if (!/^https?:\/\//.test(url)) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } }); if (!r.ok) return null; const text = await r.text(); if (text.length > maxBytes) return null; return JSON.parse(text); } catch { return null; } finally { clearTimeout(t); }
}
export const configSummary = () => (pinningEnabled() ? `pinning to IPFS through Pinata, gateway ${PINATA.gateway}` : `not pinning (no PINATA_JWT): the site hosts coin metadata itself${CONFIG.publicBase ? ` at ${CONFIG.publicBase}/m/` : ''}`);
