// Mist: the notes behind Halcyon's private payouts. A holder's mist key is two Baby Jubjub key pairs (the curve the circuit speaks):
// spending and viewing, derived in the browser from one wallet signature. For every note the gardener draws an ephemeral key, shares a
// secret with the viewing key (never with the spending one) and sows a commitment into the pool's Merkle tree; the holder's browser finds
// its notes with the viewing key and spends each with a zero-knowledge proof that only the spending key can make. Poseidon hashes, the
// tree the pool keeps, the witness of a withdrawal. Plain BigInt, runs in Node and in the browser; nothing here touches the network.
import { poseidon2 } from 'poseidon-lite/poseidon2';
import { poseidon3 } from 'poseidon-lite/poseidon3';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';

export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n; // BN254's scalar field, Baby Jubjub's base field
export const L = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;  // the order of Baby Jubjub's prime subgroup
const A = 168700n, D = 168696n;
export const BASE8 = [5299619240641551281634865583518297030282874472190772894086521144482721001553n, 16950150798460657717958625567821834550301663161624707787222815936182638968203n];
export const DEPTH = 22, BATCH_DEPTH = 6, BATCH = 64;
const mod = (a, m = P) => ((a % m) + m) % m;
function invert(a) { a = mod(a); if (a === 0n) throw new Error('inverse of zero'); let [old_r, r] = [a, P]; let [old_s, s] = [1n, 0n]; while (r !== 0n) { const q = old_r / r; [old_r, r] = [r, old_r - q * r]; [old_s, s] = [s, old_s - q * s]; } return mod(old_s); }
// extended twisted Edwards coordinates (X, Y, Z, T), the general-a formulas
const ext = ([x, y]) => [x, y, 1n, mod(x * y)];
const affine = ([X, Y, Z]) => { const zi = invert(Z); return [mod(X * zi), mod(Y * zi)]; };
function add([X1, Y1, Z1, T1], [X2, Y2, Z2, T2]) {
  const a = mod(X1 * X2), b = mod(Y1 * Y2), c = mod(D * T1 * T2), d = mod(Z1 * Z2), e = mod((X1 + Y1) * (X2 + Y2) - a - b), f = mod(d - c), g = mod(d + c), h = mod(b - A * a);
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}
function dbl([X1, Y1, Z1]) {
  const a = mod(X1 * X1), b = mod(Y1 * Y1), c = mod(2n * Z1 * Z1), d = mod(A * a), e = mod((X1 + Y1) * (X1 + Y1) - a - b), g = mod(d + b), f = mod(g - c), h = mod(d - b);
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}
/** k times an affine point, affine. */
export function mul(point, k) { let r = [0n, 1n, 1n, 0n]; let q = ext(point); let n = mod(k, L); while (n > 0n) { if (n & 1n) r = add(r, q); q = dbl(q); n >>= 1n; } return affine(r); }
export const onCurve = ([x, y]) => mod(A * x * x + y * y) === mod(1n + D * x * x * y * y);
/** circomlibjs's packing: y little-endian, the top bit of the last byte set when x is in the upper half of the field. */
export function pack([x, y]) { const b = new Uint8Array(32); let v = y; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } if (x > (P - 1n) / 2n) b[31] |= 0x80; return `0x${bytesToHex(b)}`; }
export function unpack(hex) {
  const b = hexToBytes(String(hex).replace(/^0x/, '')); if (b.length !== 32) return null; const sign = (b[31] & 0x80) !== 0; const yb = Uint8Array.from(b); yb[31] &= 0x7f; let y = 0n; for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(yb[i]); if (y >= P) return null;
  // x^2 = (1 - y^2) / (a - d y^2)
  const y2 = mod(y * y); const num = mod(1n - y2); const den = mod(A - D * y2); if (den === 0n) return null; const x2 = mod(num * invert(den)); let x = sqrt(x2); if (x === null) return null; if ((x > (P - 1n) / 2n) !== sign) x = mod(-x); if (sign && x === 0n) return null; const pt = [x, y]; return onCurve(pt) ? pt : null;
}
/** Square root in the field (p = 1 mod 4: Tonelli-Shanks). */
function sqrt(n) { n = mod(n); if (n === 0n) return 0n; if (pow(n, (P - 1n) / 2n) !== 1n) return null; let q = P - 1n, s = 0n; while ((q & 1n) === 0n) { q >>= 1n; s++; } let z = 2n; while (pow(z, (P - 1n) / 2n) !== P - 1n) z++; let m = s, c = pow(z, q), t = pow(n, q), r = pow(n, (q + 1n) / 2n); while (t !== 1n) { let i = 0n, tt = t; while (tt !== 1n) { tt = mod(tt * tt); i++; } let b = c; for (let j = 0n; j < m - i - 1n; j++) b = mod(b * b); m = i; c = mod(b * b); t = mod(t * c); r = mod(r * b); } return r; }
function pow(b, e) { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = mod(r * b); b = mod(b * b); e >>= 1n; } return r; }
const toBig = b => BigInt(`0x${bytesToHex(b)}`);
const utf8 = s => new TextEncoder().encode(s);
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
const scalar = seed => { const k = mod(toBig(keccak_256(seed)), L); return k === 0n ? 1n : k; };

export const SIGN_MESSAGE = 'Halcyon mist key v1\n\nSigning this derives the keys that find and spend your private payouts. It costs nothing, sends nothing and never leaves your browser.\n\nSign it only on Halcyon.';
/** @typedef {{ spend: bigint, view: bigint, spendPub: bigint[], viewPub: bigint[] }} MistKeys */
export function keysFromScalars(spend, view) { return { spend, view, spendPub: mul(BASE8, spend), viewPub: mul(BASE8, view) }; }
export function keysFromSignature(signature) { const sig = hexToBytes(String(signature).replace(/^0x/, '')); if (sig.length !== 65) throw new Error('a 65-byte signature'); const root = keccak_256(sig); return keysFromScalars(scalar(cat(root, utf8('halcyon:mist:spend'))), scalar(cat(root, utf8('halcyon:mist:view')))); }
export function randomKeys() { return keysFromScalars(scalar(randomBytes(32)), scalar(randomBytes(32))); }
/** The public half, 64 bytes: the spending public key packed, then the viewing one. */
export const publicKey = keys => `${pack(keys.spendPub)}${pack(keys.viewPub).slice(2)}`;
export function parsePublicKey(hex) { const h = String(hex || '').replace(/^0x/, ''); if (h.length !== 128) return null; const spendPub = unpack(h.slice(0, 64)); const viewPub = unpack(h.slice(64)); return spendPub && viewPub ? { spendPub, viewPub } : null; }
export const isPublicKey = hex => parsePublicKey(hex) !== null;

export const commitOf = (spendPub, sh) => poseidon2([poseidon2([spendPub[0], spendPub[1]]), sh]);
export const leafOf = (commit, denom) => poseidon2([commit, denom]);
/** A note for a holder: a fresh ephemeral key, the shared secret, the commitment the pool stores. The ephemeral key is dropped. */
export function note(pub, denom, ephemeral = scalar(randomBytes(32))) {
  const k = typeof pub === 'string' ? parsePublicKey(pub) : pub; if (!k) throw new Error('not a mist key');
  const R = mul(BASE8, ephemeral); const S = mul(k.viewPub, ephemeral); const sh = poseidon2([S[0], S[1]]);
  return { commit: commitOf(k.spendPub, sh), denom: BigInt(denom), ephemeral: pack(R), viewTag: Number(sh & 0xffn) };
}
/** Is this note mine? The shared secret when it is (one multiplication and two hashes), null when it is not. */
export function check(keys, n) {
  const R = unpack(n.ephemeral); if (!R) return null; const S = mul(R, keys.view); const sh = poseidon2([S[0], S[1]]);
  if (n.viewTag !== undefined && n.viewTag !== null && Number(n.viewTag) !== Number(sh & 0xffn)) return null;
  return commitOf(keys.spendPub, sh) === BigInt(n.commit) ? sh : null;
}
export function scan(keys, notes) { const mine = []; for (const n of notes) { const sh = check(keys, n); if (sh !== null) mine.push({ ...n, sh }); } return mine; }
export const nullifierOf = (spend, sh, index) => poseidon3([spend, sh, BigInt(index)]);

/** The zero hashes of the tree: Z[0] = 0 (an empty leaf), Z[i + 1] = Poseidon(Z[i], Z[i]). */
export const ZEROS = (() => { const z = [0n]; for (let i = 0; i < DEPTH; i++) z.push(poseidon2([z[i], z[i]])); return z; })();
/** The root of one batch's subtree (up to 64 leaves, zero-padded), as the pool computes it. */
export function batchRoot(leaves) { let level = leaves.slice(0, BATCH).map(BigInt); for (let d = 0; d < BATCH_DEPTH; d++) { const next = []; for (let i = 0; i < level.length; i += 2) { const l = level[i]; const r = i + 1 < level.length ? level[i + 1] : ZEROS[d]; next.push(l === ZEROS[d] && r === ZEROS[d] ? ZEROS[d + 1] : poseidon2([l, r])); } level = next.length ? next : [ZEROS[d + 1]]; } return level[0]; }
/**
 * The whole tree from the leaves in order (batch b holds leaves b*64 .. b*64+63; a batch may be short). Returns the root and a path
 * function. The pool keeps the same tree incrementally; this one is rebuilt from the events, by the indexer and by the holder's browser.
 */
export function tree(batches) {
  const levels = []; let level = []; for (const b of batches) { const padded = b.slice(0, BATCH).map(BigInt); while (padded.length < BATCH) padded.push(0n); level.push(...padded); }
  if (!level.length) level.push(0n); levels.push(level);
  for (let d = 0; d < DEPTH; d++) { const next = []; for (let i = 0; i < level.length; i += 2) { const l = level[i]; const r = i + 1 < level.length ? level[i + 1] : ZEROS[d]; next.push(l === ZEROS[d] && r === ZEROS[d] ? ZEROS[d + 1] : poseidon2([l, r])); } levels.push(next); level = next; }
  const root = level[0];
  const path = index => { const elements = [], indices = []; let i = index; for (let d = 0; d < DEPTH; d++) { const sib = i ^ 1; elements.push(sib < levels[d].length ? levels[d][sib] : ZEROS[d]); indices.push(i & 1); i >>= 1; } return { elements, indices }; };
  return { root, path, levels };
}
/** The witness of a withdrawal, ready for the prover. */
export function witness({ keys, sh, denom, index, path, root, recipient, relayer, fee }) {
  const str = v => BigInt(v).toString();
  return { root: str(root), nullifierHash: str(nullifierOf(keys.spend, sh, index)), denom: str(denom), recipient: str(BigInt(recipient)), relayer: str(BigInt(relayer)), fee: str(fee), spend: str(keys.spend), sh: str(sh), pathElements: path.elements.map(str), pathIndices: path.indices.map(str) };
}
