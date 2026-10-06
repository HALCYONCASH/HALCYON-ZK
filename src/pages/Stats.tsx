// Everything since the first launch: launches, volume, the fees and where every part went, the buybacks and burns, the holders, the mist,
// the platform's share, and the days one by one. All of it from the index; the platform pot from the chain.
import { Link } from 'react-router-dom';
import { api, type AllTime, type DayRow } from '../lib/api';
import { useConfig, useFetch, useTitle } from '../lib/hooks';
import { eth, usd, coins, short, ago } from '../lib/format';
import { ModuleIcon, MODULE_TAG } from '../components/CoinCard';

const MODULES: [string, string][] = [['roots', 'Roots'], ['rain', 'Rain'], ['prune', 'Prune'], ['harvest', 'Harvest'], ['branch', 'Branch'], ['clover', 'Clover'], ['rings', 'Rings'], ['mist', 'Mist']];
const KINDS: [string, string][] = [['roots', 'pushed to creators (Roots)'], ['branch', 'pushed to branches (Branch)'], ['rain', 'rained on holders (Rain)'], ['rings', 'paid by rings (Rings)'], ['clover', 'won in draws (Clover)'], ['mist', 'sown as mist notes (Mist)'], ['prune', 'bought back and burned (Prune)'], ['harvest', 'spent on stock (Harvest)']];
const money = (wei: string, ethUsd: number, d = 3) => (ethUsd ? `${usd(Number(BigInt(wei)) / 1e18 * ethUsd)}` : `${eth(wei, d)} ETH`);
const dateOf = (t: number) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

/** Bars for the last days: volume (and the fees over it), drawn in the brand's two tones. */
function Days({ days, ethUsd }: { days: DayRow[]; ethUsd: number }) {
  const rows = days.slice(-30); if (!rows.length) return <div className="muted small">No days yet.</div>;
  const w = 720, h = 170, pad = 28, gap = 4; const bw = (w - pad * 2) / rows.length - gap; const max = rows.reduce((a, d) => Math.max(a, Number(BigInt(d.volume)) / 1e18), 0) || 1;
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h + 24}`} width="100%" preserveAspectRatio="none" aria-label="volume by day" style={{ display: 'block' }}>
        {rows.map((d, i) => { const v = Number(BigInt(d.volume)) / 1e18; const bh = Math.max(2, v / max * h); const x = pad + i * (bw + gap); return <g key={d.day}><title>{`${d.day}: ${v.toFixed(3)} ETH in ${d.trades} trades, ${eth(d.fees, 4)} ETH of fees, ${d.launches} launched`}</title><rect x={x} y={h - bh} width={bw} height={bh} rx={3} fill="var(--violet)" opacity={0.75} /></g>; })}
        <line x1={pad} x2={w - pad} y1={h + 0.5} y2={h + 0.5} stroke="var(--line)" />
        <text x={pad} y={h + 18} fontSize="11" fill="var(--ink-2)" fontFamily="var(--mono)">{rows[0].day}</text><text x={w - pad} y={h + 18} fontSize="11" fill="var(--ink-2)" fontFamily="var(--mono)" textAnchor="end">{rows[rows.length - 1].day}</text>
      </svg>
      <div className="row wrapRow small muted" style={{ gap: 14 }}><span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: 'var(--violet)', opacity: 0.75, marginRight: 6 }} />volume a day, in ETH, the last {rows.length} days{ethUsd ? ` (${usd(Number(BigInt(rows[rows.length - 1].volume)) / 1e18 * ethUsd)} today)` : ''}</span></div>
    </div>
  );
}

export default function Stats() {
  const cfg = useConfig(); useTitle(`Stats · ${cfg?.siteName || 'Halcyon'}`);
  const q = useFetch(() => api.allTime(), [], 30_000); const a = q.data as AllTime | undefined; const ethUsd = cfg?.ethUsd || 0;
  if (!a) return <main className="wrap page"><h1>All time</h1><div className="kpi" style={{ marginTop: 18 }}>{[0, 1, 2, 3].map(i => <div key={i} className="k"><b><span className="skeleton" /></b><span>&nbsp;</span></div>)}</div></main>;
  const pk = (k: string) => a.payouts[k] || { count: 0, eth: '0', coins: '0' };
  const toCreatorsAndHolders = BigInt(a.fees.creators) + BigInt(a.fees.holders);
  return (
    <main className="wrap page">
      <div className="row between wrapRow"><div><h1>All time</h1><p className="muted" style={{ marginTop: 6 }}>{a.since ? `Since ${dateOf(a.since)} on ${a.chain}.` : `Nothing launched yet on ${a.chain}.`} Every number from the chain, indexed to block {a.checkpoint.toLocaleString()}.</p></div><Link to="/coins" className="btn">The coins</Link></div>

      <section className="section">
        <div className="kpi">
          <div className="k"><b>{a.coins.total}</b><span>coins launched</span></div>
          <div className="k"><b>{eth(a.volume.eth, 2)} ETH</b><span>volume, all time{ethUsd ? ` (${usd(a.volume.usd)})` : ''}</span></div>
          <div className="k"><b>{a.volume.trades.toLocaleString()}</b><span>trades · {a.volume.buys.toLocaleString()} buys, {a.volume.sells.toLocaleString()} sells</span></div>
          <div className="k"><b>{a.holders.toLocaleString()}</b><span>holders, across every coin</span></div>
        </div>
      </section>

      <section className="section">
        <h2>Fees and revenue</h2>
        <p className="muted small" style={{ marginTop: 6 }}>Every trade pays its pool's fee; the gardener collects it into the fees contract, where 20% is the platform's and 80% follows the coin's module.</p>
        <div className="kpi" style={{ marginTop: 14 }}>
          <div className="k"><b>{eth(a.fees.received, 3)} ETH</b><span>fees collected{ethUsd ? ` (${usd(a.fees.receivedUsd)})` : ''}</span></div>
          <div className="k"><b>{eth(a.fees.platform, 3)} ETH</b><span>platform revenue, the 20%{ethUsd ? ` (${usd(a.fees.platformUsd)})` : ''}</span></div>
          <div className="k"><b>{eth(toCreatorsAndHolders.toString(), 3)} ETH</b><span>to creators and holders</span></div>
          <div className="k"><b>{eth(a.fees.pots, 3)} ETH</b><span>waiting in pots</span></div>
        </div>
        <div className="grid cols-2" style={{ marginTop: 14 }}>
          <div className="card pad">
            <h3>Where the 80% went</h3>
            <div style={{ overflowX: 'auto', marginTop: 8 }}><table className="tbl"><tbody>
              {KINDS.map(([k, label]) => <tr key={k}><td><span className={`tag ${MODULE_TAG[k]}`}><ModuleIcon id={k} /> {k}</span><div className="muted small" style={{ marginTop: 4 }}>{label}</div></td><td className="num" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{eth(pk(k).eth, 4)} ETH<div className="muted small">{pk(k).count ? `${pk(k).count} payout${pk(k).count > 1 ? 's' : ''}` : 'none yet'}</div></td></tr>)}
            </tbody></table></div>
          </div>
          <div className="card pad">
            <h3>The platform's share</h3>
            <table className="tbl" style={{ marginTop: 8 }}><tbody>
              <tr><td>received, all time</td><td className="num" style={{ textAlign: 'right' }}>{eth(a.platform.received, 4)} ETH</td></tr>
              <tr><td>in the pot now{a.platform.potFromChain ? '' : ' (from the index)'}</td><td className="num" style={{ textAlign: 'right' }}>{eth(a.platform.pot, 4)} ETH</td></tr>
              <tr><td>withdrawn</td><td className="num" style={{ textAlign: 'right' }}>{eth(a.platform.withdrawn, 4)} ETH</td></tr>
            </tbody></table>
            {a.platform.withdrawals.length > 0 && <div className="feed" style={{ marginTop: 10 }}>{a.platform.withdrawals.map(w => <div className="t" key={w.tx}><span className="faint small">{ago(w.t)}</span><span className="mono small">to {short(w.to)}</span><span className="num">{eth(w.amount, 4)} ETH</span>{cfg?.explorer ? <a className="mono small" href={`${cfg.explorer}/tx/${w.tx}`} target="_blank" rel="noreferrer">tx ↗</a> : <span />}</div>)}</div>}
            <p className="help">The platform's 20% funds the gardener's gas; what is left is the platform's to withdraw. {cfg?.platform ? <span className="mono">{short(cfg.platform, 6)}</span> : null}</p>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Buybacks and burns</h2>
        <p className="muted small" style={{ marginTop: 6 }}>A coin on Prune buys itself back with its fees and burns what it bought; anyone can burn a coin by sending it to the dead address. Both count here, from the chain.</p>
        <div className="kpi" style={{ marginTop: 14 }}>
          <div className="k"><b>{a.burns.count}</b><span>buybacks by the gardener</span></div>
          <div className="k"><b>{eth(a.burns.eth, 4)} ETH</b><span>spent buying back{ethUsd && BigInt(a.burns.eth) > 0n ? ` (${money(a.burns.eth, ethUsd)})` : ''}</span></div>
          <div className="k"><b>{coins(a.burns.coins)}</b><span>coins burned, every way</span></div>
          <div className="k"><b>{coins(a.burns.byBuybacks)}</b><span>of them by buybacks</span></div>
        </div>
        {a.burns.byCoin.length ? <div className="card pad" style={{ marginTop: 14, overflowX: 'auto' }}><table className="tbl"><thead><tr><th>coin</th><th style={{ textAlign: 'right' }}>burned</th><th style={{ textAlign: 'right' }}>of supply</th><th style={{ textAlign: 'right' }}>buybacks</th><th style={{ textAlign: 'right' }}>ETH spent</th><th style={{ textAlign: 'right' }}>by buybacks</th></tr></thead><tbody>
          {a.burns.byCoin.map(b => <tr key={b.token}><td><Link to={`/c/${b.token}`}><b>{b.name}</b> <span className="mono muted">${b.symbol}</span></Link></td><td className="num" style={{ textAlign: 'right' }}>{coins(b.coins)}</td><td className="num" style={{ textAlign: 'right' }}>{b.supplyPct.toFixed(3)}%</td><td className="num" style={{ textAlign: 'right' }}>{b.count}</td><td className="num" style={{ textAlign: 'right' }}>{eth(b.eth, 4)}</td><td className="num" style={{ textAlign: 'right' }}>{coins(b.byBuybacks)}</td></tr>)}
        </tbody></table></div> : <p className="muted small" style={{ marginTop: 10 }}>Nothing burned yet: a coin on the Prune module burns once its pot holds enough, and anyone can send a coin to the dead address.</p>}
        {a.burns.recent.length > 0 && <div className="card pad" style={{ marginTop: 14 }}><h3>The latest burns</h3><div className="feed" style={{ marginTop: 8 }}>{a.burns.recent.map(b => <div className="t" key={b.tx + b.value}><span className="faint small">{ago(b.t)}</span><span><Link to={`/c/${b.token}`} className="mono">${b.symbol}</Link> <span className="muted small">{b.buyback ? 'buyback by the gardener' : `by ${short(b.from)}`}</span></span><span className="num">{coins(b.value)}</span>{cfg?.explorer ? <a className="mono small" href={`${cfg.explorer}/tx/${b.tx}`} target="_blank" rel="noreferrer">tx ↗</a> : <span />}</div>)}</div></div>}
      </section>

      <section className="section">
        <h2>Launches</h2>
        <div className="kpi" style={{ marginTop: 14 }}>
          <div className="k"><b>{a.coins.total}</b><span>coins</span></div>
          <div className="k"><b>{a.coins.v4}</b><span>on rules pools (v4)</span></div>
          <div className="k"><b>{a.coins.v3}</b><span>on standard pools (v3)</span></div>
          <div className="k"><b>{a.coins.withTrades}</b><span>with at least one trade</span></div>
        </div>
        <div className="card pad" style={{ marginTop: 14 }}>
          <h3>By module</h3>
          <div className="row wrapRow" style={{ marginTop: 10, gap: 10 }}>{MODULES.map(([id, name]) => <span key={id} className={`tag ${MODULE_TAG[id]}`} title={`${a.coins.byModule[id] || 0} coins on ${name} now`}><ModuleIcon id={id} /> {name} · {a.coins.byModule[id] || 0}</span>)}</div>
          <p className="help">What each coin runs now; a creator can switch at any time.</p>
        </div>
      </section>

      <section className="section">
        <h2>Mist</h2>
        <div className="kpi" style={{ marginTop: 14 }}>
          <div className="k"><b>{a.mist.notes.toLocaleString()}</b><span>notes sown, in {a.mist.batches} rounds</span></div>
          <div className="k"><b>{eth(a.mist.sownEth, 3)} ETH</b><span>sown into the mist</span></div>
          <div className="k"><b>{a.mist.spent.toLocaleString()}</b><span>notes spent · {eth(a.mist.withdrawnEth, 3)} ETH withdrawn</span></div>
          <div className="k"><b>{a.mist.keyed.toLocaleString()}</b><span>holders with a mist key</span></div>
        </div>
      </section>

      <section className="section">
        <h2>Day by day</h2>
        <div className="card pad" style={{ marginTop: 14 }}><Days days={a.days} ethUsd={ethUsd} /></div>
        {a.days.length > 0 && <div className="card pad" style={{ marginTop: 14, overflowX: 'auto' }}><table className="tbl"><thead><tr><th>day</th><th style={{ textAlign: 'right' }}>volume</th><th style={{ textAlign: 'right' }}>trades</th><th style={{ textAlign: 'right' }}>fees</th><th style={{ textAlign: 'right' }}>platform</th><th style={{ textAlign: 'right' }}>paid out</th><th style={{ textAlign: 'right' }}>burned</th><th style={{ textAlign: 'right' }}>launched</th></tr></thead><tbody>
          {[...a.days].reverse().slice(0, 31).map(d => <tr key={d.day}><td className="mono">{d.day}</td><td className="num" style={{ textAlign: 'right' }}>{eth(d.volume, 3)}</td><td className="num" style={{ textAlign: 'right' }}>{d.trades}</td><td className="num" style={{ textAlign: 'right' }}>{eth(d.fees, 4)}</td><td className="num" style={{ textAlign: 'right' }}>{eth(d.platform, 4)}</td><td className="num" style={{ textAlign: 'right' }}>{eth(d.paid, 4)}</td><td className="num" style={{ textAlign: 'right' }}>{BigInt(d.burned) > 0n ? `${eth(d.burned, 4)} (${coins(d.burnedCoins)})` : '0'}</td><td className="num" style={{ textAlign: 'right' }}>{d.launches}</td></tr>)}
        </tbody></table></div>}
      </section>
    </main>
  );
}
