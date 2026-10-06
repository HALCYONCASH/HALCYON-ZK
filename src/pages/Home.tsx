import { Link } from 'react-router-dom';
import Hero from '../components/Hero';
import CoinCard from '../components/CoinCard';
import { Mark } from '../components/Shell';
import { api } from '../lib/api';
import { useConfig, useFetch, useTitle } from '../lib/hooks';
import { eth, usd } from '../lib/format';

export default function Home() {
  const cfg = useConfig(); useTitle(`${cfg?.siteName || 'Halcyon'} · the calm Ethereum launchpad`);
  const coins = useFetch(() => api.coins(), [], 15_000); const stats = useFetch(() => api.stats(), [], 30_000);
  const live = (coins.data || []).slice(0, 6); const s = stats.data; const ethUsd = cfg?.ethUsd || 0;
  return (
    <main className="wrap page">
      <section className="hero">
        <Hero />
        <div className="inner">
          <span className="mark bob"><Mark size={84} /></span>
          <h1>{cfg?.siteName || 'Halcyon'}</h1>
          <p className="tagline">Launch a coin into a locked Uniswap pool. Its 1% fee goes where you decide.</p>
          <div className="row"><Link to="/launch" className="btn primary">Launch a coin</Link><Link to="/coins" className="btn">See the coins</Link></div>
        </div>
      </section>

      <section className="section">
        <div className="kpi">
          <div className="k"><b>{s ? s.coins : <span className="skeleton" />}</b><span>coins launched</span></div>
          <div className="k"><b>{s ? `${eth(s.volume24hEth, 2)} ETH` : <span className="skeleton" />}</b><span>24h volume{s?.volumeEth ? ` · ${eth(s.volumeEth, 1)} all time` : ''}</span></div>
          <div className="k"><b>{s ? `${eth(s.lockedEth, 2)} ETH` : <span className="skeleton" />}</b><span>locked in pools</span></div>
          <div className="k"><b>{s ? (ethUsd ? usd(Number(BigInt(s.paidEth)) / 1e18 * ethUsd) : `${eth(s.paidEth, 3)} ETH`) : <span className="skeleton" />}</b><span>paid to creators and holders</span></div>
        </div>
      </section>

      <section className="section">
        <div className="row between wrapRow"><h2>Trading now</h2><div className="row"><Link to="/stats" className="btn">All-time stats</Link><Link to="/coins" className="btn">All coins</Link></div></div>
        <div className="grid cols-3" style={{ marginTop: 18 }}>
          {coins.data ? live.length ? live.map(c => <CoinCard key={c.token} c={c} ethUsd={ethUsd} />) : <div className="empty card">No coins yet. Yours could be the first.</div> : [0, 1, 2].map(i => <div key={i} className="card skeleton" style={{ minHeight: 170 }} />)}
        </div>
      </section>
    </main>
  );
}
