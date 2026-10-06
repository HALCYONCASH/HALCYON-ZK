// Candles for the charts: one minute, five minutes, an hour and a day, per coin, built from the trades as the indexer reads them (a coin
// keeps its last 600 trades, the candles go further back). Price is ETH a coin; volume is ETH traded. Each coin's candles live in their own
// file under DATA_DIR/candles, read when first asked for and written after each indexing pass that touched them, so the main state stays
// small whatever the number of coins. The demo and the tests rebuild them from the kept trades.
import fs from 'node:fs';
import path from 'node:path';
import { dataPath } from './config.mjs';
import { atomicWrite, readJsonSafe } from './store.mjs';

export const FRAMES = { m1: 60, m5: 300, h1: 3600, d1: 86_400 };
export const KEEP = { m1: 2 * 1440, m5: 7 * 288, h1: 90 * 24, d1: 3650 };
const cache = new Map(); const dirty = new Set();
const dir = () => dataPath('candles');
const file = token => path.join(dir(), `${String(token).toLowerCase()}.json`);
const empty = () => ({ m1: [], m5: [], h1: [], d1: [] });

/** A coin's candles, from memory or its file; empty when it has none yet. */
export function candlesOf(token) {
  const k = String(token).toLowerCase(); if (cache.has(k)) return cache.get(k);
  const c = { ...empty(), ...readJsonSafe(file(k), {}) }; cache.set(k, c); return c;
}
/** ETH a coin as a number, from the indexer's price (ETH a coin, times 1e18). */
export const priceNumber = price => Number(BigInt(price)) / 1e18;
/**
 * One trade (or the launch, with no volume) into every frame: a new candle opens at the last close, so the line is continuous; a trade older
 * than the candle in progress is ignored (logs come in order; a reindex starts clean).
 */
export function noteCandle(token, { t, price, eth = 0n }) {
  const c = candlesOf(token); const p = typeof price === 'number' ? price : priceNumber(price); const v = typeof eth === 'number' ? eth : Number(BigInt(eth)) / 1e18; if (!(p > 0) || !(t > 0)) return;
  for (const [f, size] of Object.entries(FRAMES)) {
    const arr = c[f]; const t0 = Math.floor(t / size) * size; let last = arr[arr.length - 1];
    if (!last || last.t < t0) { const o = last ? last.c : p; last = { t: t0, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: 0 }; arr.push(last); if (arr.length > KEEP[f]) arr.splice(0, arr.length - KEEP[f]); }
    else if (last.t > t0) continue;
    last.h = Math.max(last.h, p); last.l = Math.min(last.l, p); last.c = p; last.v += v;
  }
  dirty.add(String(token).toLowerCase());
}
/** Write every coin's candles that changed since the last save. */
export function saveCandles() { if (!dirty.size) return 0; fs.mkdirSync(dir(), { recursive: true }); let n = 0; for (const k of dirty) { const c = cache.get(k); if (c) { atomicWrite(file(k), JSON.stringify(c)); n++; } } dirty.clear(); return n; }
/** Forget everything (a fresh index): memory and the files. */
export function resetCandles() { cache.clear(); dirty.clear(); try { fs.rmSync(dir(), { recursive: true, force: true }); } catch {} }
/** Candles of one frame from `since` (a unix time), as rows [t, o, h, l, c, v]; `limit` of the latest when `since` is 0. */
export function candleRows(token, frame = 'm5', { since = 0, limit = 2000 } = {}) {
  const arr = candlesOf(token)[FRAMES[frame] ? frame : 'm5'] || []; const rows = since ? arr.filter(x => x.t >= since) : arr.slice(-limit);
  return rows.map(x => [x.t, x.o, x.h, x.l, x.c, x.v]);
}
/** Rebuild every coin's candles from the trades the state keeps (the demo, the tests): the launch first, at the coin's starting price. */
export function rebuildCandles(s, startPrice) {
  cache.clear(); dirty.clear();
  for (const c of Object.values(s.coins)) { cache.set(c.token, empty()); if (c.createdAt && startPrice) { const p = startPrice(c); if (p) noteCandle(c.token, { t: c.createdAt, price: p, eth: 0n }); } for (const tr of s.trades[c.token] || []) noteCandle(c.token, { t: tr.t, price: tr.price, eth: tr.eth }); }
}
