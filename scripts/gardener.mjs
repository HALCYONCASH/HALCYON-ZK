// What the gardener is doing on the live site, from anywhere: reads the site's own /api/gardener (no key, no RPC needed here).
//   node scripts/gardener.mjs                      status: on or off, the transaction out right now if any, the last 20 ledger lines
//   node scripts/gardener.mjs plan                 every coin as the gardener sees it: module, holders, pool fees, pot, what is due, why it waits
//   node scripts/gardener.mjs log [50]             the last entries of the ledger
// --url https://host overrides the site (HALCYON_SITE_URL, https://halcyon.cash by default).
import fs from 'node:fs';
import { formatEther } from 'viem';
import { CONFIG } from '../eth/config.mjs';

const argv = process.argv.slice(2); const at = argv.indexOf('--url'); const words = argv.filter((a, i) => i !== at && i !== at + 1 && !a.startsWith('--')); const cmd = words.find(a => !/^\d+$/.test(a)) || 'status';
const out = m => fs.writeSync(1, `${m}\n`); const fail = m => { fs.writeSync(2, `${m}\n`); process.exit(2); };
const base = (at >= 0 ? argv[at + 1] || '' : process.env.HALCYON_SITE_URL || CONFIG.siteUrl || '').replace(/\/+$/, ''); if (!base) fail('no site: --url https://host, or HALCYON_SITE_URL');
const limit = Number(words.find(a => /^\d+$/.test(a)) || (cmd === 'log' ? 50 : 20));
const eth = v => { try { return `${Number(formatEther(BigInt(v))).toFixed(4)} ETH`; } catch { return String(v); } };
const when = t => (t ? new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19) : '');
const line = e => { const r = e.results ? ` ${e.results.length} batch${e.results.length > 1 ? 'es' : ''}${e.results.some(x => x.pending) ? ' (one pending)' : ''}${e.left ? `, ${e.left} left` : ''}` : ''; return `${when(e.at)}  ${e.dry ? 'dry  ' : e.error ? 'fail ' : e.pending ? 'out  ' : 'done '} ${e.label}${e.hash ? `  ${e.hash}` : ''}${r}${e.error ? `  ${e.error}` : ''}`; };

let r; try { r = await (await fetch(`${base}/api/gardener?${cmd === 'plan' ? 'plan=1&' : ''}limit=${limit}`)).json(); } catch (e) { fail(`${base}/api/gardener: ${e.message}`); }
if (r.error) fail(r.error);
if (cmd === 'status' || cmd === 'log') {
  if (cmd === 'status') { out(`gardener ${r.enabled ? 'on' : 'off'} at ${base}${r.demo ? ' (demo)' : ''}`); if (r.pending) out(`out now: ${r.pending.label}, nonce ${r.pending.nonce}, ${r.pending.hash}, sent ${when(r.pending.sentAt)}${r.pending.bumps ? `, bumped ${r.pending.bumps} time${r.pending.bumps > 1 ? 's' : ''}` : ''}`); }
  out(r.log.length ? r.log.slice(0, limit).map(line).join('\n') : 'the ledger is empty');
} else if (cmd === 'plan') {
  if (!r.plan) fail('the site has no chain behind it (demo, or no RPC)'); if (r.plan.error) fail(`the site could not plan: ${r.plan.error}`);
  const t = r.plan.thresholds; out(`at block ${r.plan.head}, gas ${r.plan.gasGwei ?? '?'} gwei: collect from ${t.collectMinEth} ETH of fees and pay a pot from ${t.payoutMinEth} ETH at once (shares from ${t.payoutMinShareEth} ETH); under that, every ${t.patienceMin ?? 15} min when worth ${Math.round(100 / (t.maxGasPct || 10))}x the gas; cap ${t.gasCapGwei} gwei`);
  for (const c of r.plan.coins) {
    out(`\n$${c.symbol}  ${c.name}  ${c.module} on ${c.pool === 1 ? 'v4 rules' : 'v3'}  ${c.holders} holders  fees ${eth(c.fees)}  pot ${eth(c.pot)}${BigInt(c.stockHeld || 0) > 0n ? `  stock held ${c.stockHeld}` : ''}  ${c.token}`);
    for (const d of c.due) out(`  due:     ${d}`); for (const w of c.waiting) out(`  waiting: ${w}`); if (c.error) out(`  error:   ${c.error}`);
  }
} else fail(`unknown command ${cmd}: status | plan | log [n]`);
