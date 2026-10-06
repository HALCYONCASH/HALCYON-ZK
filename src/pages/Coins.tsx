import { useEffect, useMemo, useRef, useState } from 'react';
import CoinCard from '../components/CoinCard';
import { api, type Coin } from '../lib/api';
import { useConfig, useFetch, useTitle } from '../lib/hooks';

type Sort = 'mcap' | 'recent' | 'volume' | 'progress' | 'paid' | 'newest'; const PER_PAGE = 24; const FRESH_MS = 30_000;
export default function Coins() {
  const cfg = useConfig(); useTitle(`Coins · ${cfg?.siteName || 'Halcyon'}`); const { data, error } = useFetch(() => api.coins(), [], 10_000);
  const [q, setQ] = useState(''); const [sort, setSort] = useState<Sort>('mcap'); const [only, setOnly] = useState<'all' | 'v3' | 'v4' | 'opening' | 'new'>('all'); const [page, setPage] = useState(1);
  /* a coin that arrives while the page is open sits at the top, sparkling, for half a minute, then takes its place in the order */
  const seen = useRef<Set<string> | null>(null); const [fresh, setFresh] = useState<Record<string, number>>({});
  useEffect(() => { if (!data) return; if (!seen.current) { seen.current = new Set(data.map(c => c.token)); return; } const now = Date.now(); const arrived: Record<string, number> = {}; for (const c of data) if (!seen.current.has(c.token)) { seen.current.add(c.token); arrived[c.token] = now; } if (Object.keys(arrived).length) setFresh(f => ({ ...f, ...arrived })); }, [data]);
  useEffect(() => { const keys = Object.keys(fresh); if (!keys.length) return; const id = setTimeout(() => setFresh(f => Object.fromEntries(Object.entries(f).filter(([, t]) => Date.now() - t < FRESH_MS))), FRESH_MS + 50); return () => clearTimeout(id); }, [fresh]);
  const list = useMemo(() => {
    let l = (data || []).slice(); const now = Math.floor(Date.now() / 1000);
    if (only === 'v3') l = l.filter(c => c.pool === 0); if (only === 'v4') l = l.filter(c => c.pool === 1); if (only === 'opening') l = l.filter(c => c.rules?.open); if (only === 'new') l = l.filter(c => now - c.createdAt < 86_400);
    const s = q.trim().toLowerCase(); if (s) l = l.filter(c => c.name.toLowerCase().includes(s) || c.symbol.toLowerCase().includes(s) || c.token.includes(s));
    const key: Record<Sort, (c: Coin) => number> = { mcap: c => Number(BigInt(c.marketCapEth)), recent: c => c.stats.lastTradeAt || c.createdAt, volume: c => Number(BigInt(c.stats.volume24hEth)), progress: c => c.progress, paid: c => Number(BigInt(c.fees.paid)), newest: c => c.createdAt };
    /* the platform's coin first, then the coins that just arrived, then the sort */
    return l.sort((a, b) => Number(Boolean(b.official)) - Number(Boolean(a.official)) || Number(Boolean(fresh[b.token])) - Number(Boolean(fresh[a.token])) || key[sort](b) - key[sort](a));
  }, [data, q, sort, only, fresh]);
  useEffect(() => { setPage(1); }, [q, sort, only]);
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE)); const cur = Math.min(page, pages); const shown = list.slice((cur - 1) * PER_PAGE, cur * PER_PAGE);
  const pager = pages > 1 && <div className="pager"><button className="btn sm" disabled={cur <= 1} onClick={() => setPage(cur - 1)}>Previous</button>{Array.from({ length: pages }, (_, i) => i + 1).filter(n => n === 1 || n === pages || Math.abs(n - cur) <= 2).map((n, i, arr) => <span key={n} className="row" style={{ gap: 6 }}>{i > 0 && arr[i - 1] !== n - 1 && <span className="pg">…</span>}<button className={`btn sm ${n === cur ? 'primary' : ''}`} onClick={() => setPage(n)}>{n}</button></span>)}<button className="btn sm" disabled={cur >= pages} onClick={() => setPage(cur + 1)}>Next</button></div>;
  return (
    <main className="wrap page">
      <div className="coinshead">
        <div className="row wrapRow" style={{ gap: 12, alignItems: 'baseline' }}><h1>Coins</h1><span className="sub">{data ? `${data.length} launched · ${data.filter(c => c.pool === 1).length} on rules pools · ${data.filter(c => c.rules?.open).length} opening now` : ''}</span></div>
        <div className="row wrapRow" style={{ gap: 8 }}><input className="field" style={{ width: 200 }} placeholder="Search name, symbol, address" value={q} onChange={e => setQ(e.target.value)} />
          <select className="field" style={{ width: 'auto' }} value={only} onChange={e => setOnly(e.target.value as typeof only)}><option value="all">All</option><option value="new">New today</option><option value="v3">Standard (v3)</option><option value="v4">Rules (v4)</option><option value="opening">Opening window</option></select>
          <select className="field" style={{ width: 'auto' }} value={sort} onChange={e => setSort(e.target.value as Sort)}><option value="mcap">Market cap</option><option value="recent">Last trade</option><option value="volume">24h volume</option><option value="newest">Newest</option><option value="progress">Supply sold</option><option value="paid">Paid out</option></select></div>
      </div>
      {error && <p className="err">{error}</p>}
      <div className="grid coins" style={{ marginTop: 14 }}>{data ? shown.length ? shown.map(c => <CoinCard key={c.token} c={c} ethUsd={cfg?.ethUsd || 0} fresh={Boolean(fresh[c.token])} />) : <div className="empty card">Nothing matches.</div> : [0, 1, 2, 3, 4, 5, 6, 7].map(i => <div key={i} className="card skeleton" style={{ minHeight: 150 }} />)}</div>
      {pager}
    </main>
  );
}
