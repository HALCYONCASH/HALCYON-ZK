import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useConfig, useFetch, useTitle } from '../lib/hooks';
import { short } from '../lib/format';

type Cat = 'all' | 'stock' | 'etf' | 'commodity';
const CAT: Record<Cat, string> = { all: 'All', stock: 'Stocks', etf: 'ETFs', commodity: 'Commodities' };

export default function Stocks() {
  const cfg = useConfig(); useTitle(`Stocks · ${cfg?.siteName || 'Halcyon'}`); const { data } = useFetch(() => api.stocks(), []);
  const [q, setQ] = useState(''); const [cat, setCat] = useState<Cat>('all'); const [onlyReady, setOnlyReady] = useState(false);
  const rows = useMemo(() => { const list = data || []; const needle = q.trim().toLowerCase(); return list.filter(s => (cat === 'all' || (s.category || 'stock') === cat) && (!onlyReady || (s.allowed && s.routed)) && (!needle || s.symbol.toLowerCase().includes(needle) || (s.name || '').toLowerCase().includes(needle) || s.address.includes(needle))); }, [data, q, cat, onlyReady]);
  const ready = (data || []).filter(s => s.allowed && s.routed).length; const counts = (data || []).reduce((a, s) => { a[s.category || 'stock'] = (a[s.category || 'stock'] || 0) + 1; return a; }, {} as Record<string, number>);
  return (
    <main className="wrap page">
      <h1 style={{ fontSize: '2.4rem' }}>Stocks</h1><p className="muted" style={{ margin: '6px 0 18px', maxWidth: 680 }}>The tokenized stocks a coin's Harvest module may buy for its holders: ERC-20s on Ethereum issued against real shares, allowed by the platform on chain and routed through a Uniswap pool, v3 or v4. A stock on the list without a route waits until there is a pool to buy it through.</p>
      {data && <div className="row wrapRow" style={{ gap: 10, marginBottom: 14 }}>
        <input className="field" style={{ maxWidth: 320 }} placeholder={`Search ${data.length} stocks and funds`} value={q} onChange={e => setQ(e.target.value)} />
        <div className="row wrapRow" style={{ gap: 6 }}>{(Object.keys(CAT) as Cat[]).map(c => <button key={c} className={`btn sm ${cat === c ? 'primary' : 'ghost'}`} onClick={() => setCat(c)}>{CAT[c]}{c !== 'all' && counts[c] ? ` ${counts[c]}` : ''}</button>)}</div>
        <button className={`btn sm ${onlyReady ? 'soft' : 'ghost'}`} onClick={() => setOnlyReady(x => !x)}>{ready} ready to buy</button>
        <span className="small muted">{rows.length === data.length ? `${data.length} on the list` : `${rows.length} of ${data.length}`}</span>
      </div>}
      <div className="card scroll-x">{data ? rows.length ? <table className="tbl stocks"><thead><tr><th>Stock</th><th>Issuer</th><th>Address</th><th>Status</th></tr></thead><tbody>{rows.slice(0, 500).map(s => <tr key={s.address}><td><span className="row" style={{ gap: 10 }}>{s.logo ? <img src={s.logo} alt="" className="stocklogo" loading="lazy" onError={e => { e.currentTarget.style.visibility = 'hidden'; }} /> : <span className="stocklogo ph" />}<span><b className="mono">{s.symbol || short(s.address)}</b> <span className="muted">{(s.name || '').replace(/ \(Ondo Tokenized\)$/, '')}</span>{s.category && s.category !== 'stock' && <span className="tag sky" style={{ marginLeft: 8 }}>{s.category}</span>}</span></span></td><td className="muted">{s.issuer || ''}</td><td className="mono small">{cfg?.explorer ? <a href={`${cfg.explorer}/token/${s.address}`} target="_blank" rel="noreferrer">{short(s.address, 6)}</a> : short(s.address, 6)}</td><td>{s.allowed && s.routed ? <span className="tag mint" title={s.note || ''}>ready{s.via ? ` on ${s.via}` : ''}</span> : s.allowed ? <span className="tag butter">no route yet</span> : s.routed ? <span className="tag peach">routed, not allowed yet</span> : <span className="tag">waiting for a pool</span>}</td></tr>)}</tbody></table> : <div className="empty">{data.length ? 'Nothing matches.' : 'No stocks on the list yet.'}</div> : <div className="skeleton" style={{ minHeight: 120 }} />}</div>
      <p className="small muted" style={{ marginTop: 14, maxWidth: 760 }}>The list is the issuer's whole catalog on Ethereum mainnet ({data ? data.length : '…'} Ondo Stocks tokens); only the ones with a real Uniswap pool, v3 or v4, can be bought, and the gardener never buys a stock without a route. Tokenized stocks are issued by third parties under their own terms and jurisdictions; the issuer bars US persons and some other jurisdictions from holding them. Halcyon routes a purchase and hands the tokens to holders; it does not issue, custody or redeem them. A holder the issuer blocks keeps a claimable balance in the fees contract. Check the issuer before you choose one for a coin.</p>
    </main>
  );
}
