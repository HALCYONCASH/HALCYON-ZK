// The all-time bookkeeping the kept trades cannot give (a coin keeps its last 600 trades): one row per day for the whole site (volume,
// trades, fees, the platform's share, what was paid, what was burned, launches) and one row per hour for each coin over the last two days
// (the 24h figures). The indexer adds to them as events arrive; `rebuild` recomputes them from what the state keeps (the demo, and tests).
import * as P from '../shared/pool.mjs';

export const HOURS_KEPT = 48;
const add = (a, b) => (BigInt(a || 0) + BigInt(b || 0)).toString();
/** The day of a unix time, as YYYY-MM-DD (UTC). */
export const dayOf = t => new Date(Number(t) * 1000).toISOString().slice(0, 10);
export const hourOf = t => Math.floor(Number(t) / 3600) * 3600;
export const emptyDay = () => ({ volume: '0', trades: 0, buys: 0, sells: 0, fees: '0', platform: '0', paid: '0', burned: '0', burnedCoins: '0', launches: 0 });
export const BURNS_KEPT = 300;
export function day(s, t) { s.days = s.days || {}; const k = dayOf(t); return (s.days[k] = s.days[k] || emptyDay()); }

/** A trade: the coin's hour bucket and the day's volume. */
export function noteTrade(s, c, trade) {
  const d = day(s, trade.t); d.volume = add(d.volume, trade.eth); d.trades++; if (trade.buy) d.buys++; else d.sells++;
  const hours = (c.stats.hours = c.stats.hours || {}); const h = String(hourOf(trade.t)); hours[h] = add(hours[h], trade.eth);
  const keys = Object.keys(hours); if (keys.length > HOURS_KEPT) for (const k of keys.sort((a, b) => Number(a) - Number(b)).slice(0, keys.length - HOURS_KEPT)) delete hours[k];
}
/** A fee landing in HalcyonFees: the day's fees and the platform's share. */
export function noteDeposit(s, t, amount, platformShare) { const d = day(s, t); d.fees = add(d.fees, amount); d.platform = add(d.platform, platformShare); }
/** A payout of any kind (what left the pot or was pushed): the day's paid; a prune also the day's burned. */
export function notePayout(s, t, kind, total) { if (kind === 'stockPaid') return; /* stock handed out, not ETH */ const d = day(s, t); d.paid = add(d.paid, total); if (kind === 'prune') d.burned = add(d.burned, total); }
/** Coins gone for good: a transfer to the zero address (the coin's own burn, which the buyback uses) or to 0x…dEaD (a holder's or a creator's). The coin's tally, the day's, and a list of the latest. */
export function noteBurn(s, c, { t, from, value, tx, buyback }) {
  c.stats.burned = add(c.stats.burned, value); if (buyback) c.stats.burnedByBuybacks = add(c.stats.burnedByBuybacks, value);
  day(s, t).burnedCoins = add(day(s, t).burnedCoins, value);
  s.burns = s.burns || []; s.burns.push({ t, token: c.token, from, value: String(value), tx, buyback: Boolean(buyback) }); if (s.burns.length > BURNS_KEPT) s.burns.splice(0, s.burns.length - BURNS_KEPT);
}
export function noteLaunch(s, t) { day(s, t).launches++; }
/** A platform withdrawal, remembered for the all-time view. */
export function noteWithdrawal(s, t, to, amount, tx) { s.platform = s.platform || { withdrawn: '0', withdrawals: [] }; s.platform.withdrawn = add(s.platform.withdrawn, amount); s.platform.withdrawals.push({ t, to, amount: String(amount), tx }); if (s.platform.withdrawals.length > 500) s.platform.withdrawals.splice(0, s.platform.withdrawals.length - 500); }

/** A coin's volume over the last 24 hours, from its hour buckets (the current hour included). */
export function volume24h(c, now = Math.floor(Date.now() / 1000)) { const since = hourOf(now) - 23 * 3600; let v = 0n; for (const [h, eth] of Object.entries(c.stats?.hours || {})) if (Number(h) >= since) v += BigInt(eth); return v; }

/**
 * Recompute every bucket from what the state keeps: the kept trades (exact when a coin never passed 600 trades, as in the demo and the
 * tests), the payouts, the launches, and the fees as the 1% of each day's volume plus the opening fees a payout implies. The real indexer
 * keeps the buckets as it goes and never needs this; the demo builds its state at once and calls it at the end.
 */
export function rebuild(s) {
  s.days = {}; for (const c of Object.values(s.coins)) { c.stats.hours = {}; for (const tr of s.trades[c.token] || []) noteTrade(s, c, tr); if (c.createdAt) noteLaunch(s, c.createdAt); }
  for (const c of Object.values(s.coins)) { c.stats.burned = '0'; c.stats.burnedByBuybacks = '0'; } s.burns = [];
  for (const p of s.payouts || []) { notePayout(s, p.t, p.kind, p.total || 0); if (p.kind === 'prune' && s.coins[p.token]) noteBurn(s, s.coins[p.token], { t: p.t, from: '', value: p.coins || 0, tx: p.tx, buyback: true }); /* a state without transfer logs (the demo) knows its burns from the buybacks */ }
  for (const [k, d] of Object.entries(s.days)) { const fees = BigInt(d.volume) * P.FEE_PIPS / P.PIPS; const sp = P.splitFee(fees); s.days[k].fees = fees.toString(); s.days[k].platform = sp.platform.toString(); }
  return s;
}
