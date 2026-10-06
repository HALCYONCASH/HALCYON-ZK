import { useParams, Link } from 'react-router-dom';
import { api, type Payout, type Coin } from '../lib/api';
import { useConfig, useFetch, useTitle } from '../lib/hooks';
import { eth, coins, usd, ago, short, pct, priceLine, countdown, duration } from '../lib/format';
import TradePanel from '../components/TradePanel';
import Candles from '../components/Candles';
import { Avatar, ModuleIcon, MODULE_TAG, PoolTag, StandingTag } from '../components/CoinCard';
import { useWallet, toast } from '../components/Shell';
import { tx, explainError, ZERO, type Addr } from '../lib/chain';
import { useEffect, useState } from 'react';

const payoutLine = (p: Payout, c: Coin) => {
  const sym = c.symbol; const stock = c.stockInfo?.symbol || 'stock';
  if (p.kind === 'rain') return `${eth(p.total)} ETH to ${p.count} holders${p.open ? ' without a mist key, in the open' : ''}`; if (p.kind === 'rings') return `${eth(p.total)} ETH to ${p.count} holders, by balance and time held`;
  if (p.kind === 'roots') return `${eth(p.total)} ETH to the creator`; if (p.kind === 'branch') return `${eth(p.total)} ETH to ${p.count} branches`;
  if (p.kind === 'prune') return `${eth(p.total)} ETH bought ${p.coins ? coins(p.coins) : ''} $${sym} and burned it`;
  if (p.kind === 'harvest') return `${eth(p.total)} ETH bought ${p.amount ? coins(p.amount) : ''} ${stock}`; if (p.kind === 'stockPaid') return `${coins(p.total)} ${stock} to ${p.count} holders${p.unclaimed && BigInt(p.unclaimed) > 0n ? ` (${coins(p.unclaimed)} waits as claimable)` : ''}`;
  if (p.kind === 'clover') return `${eth(p.total)} ETH to ${short(p.winner || '', 4)}, drawn by block ${p.drawBlock}`;
  if (p.kind === 'mist') return `${eth(p.total)} ETH sown as ${p.count} private note${p.count === 1 ? '' : 's'} (batch ${p.batch})`;
  return `${eth(p.total)} ETH`;
};
function OpeningBar({ c }: { c: Coin }) {
  const [, tick] = useState(0); useEffect(() => { const id = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(id); }, []);
  const r = c.rules; if (!r || !r.open) return null; const now = Math.floor(Date.now() / 1000); const left = Math.max(0, r.windowEndsAt - now); const elapsed = now - r.start; const feeNow = r.launchFee ? Math.max(10000, r.launchFee - (r.launchFee - 10000) * elapsed / r.window) : 10000;
  return <div className="opening"><div className="row between small"><b>Opening rules hold for {countdown(left)}</b><span className="muted">buy fee now {pct(feeNow / 1e6, 1)}{BigInt(r.maxSwap) > 0n ? ` · max ${coins(r.maxSwap)} per swap` : ''}</span></div><div className="progress" style={{ marginTop: 8 }}><i style={{ width: `${Math.min(100, (elapsed / r.window) * 100)}%` }} /></div></div>;
}

export default function CoinPage() {
  const { token = '' } = useParams(); const cfg = useConfig(); const w = useWallet(); const { data, error, reload } = useFetch(() => api.coin(token), [token], 8_000); const [busy, setBusy] = useState(false); const [tab, setTab] = useState<'module' | 'trades' | 'burns'>('module');
  const c = data?.coin; useTitle(c ? `$${c.symbol} ${c.name} · ${cfg?.siteName || 'Halcyon'}` : 'Coin');
  if (error) return <main className="wrap page"><div className="empty card">{error === 'no such coin' ? 'No coin at that address, or not indexed yet. Give the indexer a minute.' : error}</div></main>;
  if (!c || !cfg) return <main className="wrap page"><div className="card skeleton" style={{ minHeight: 320 }} /></main>;
  const ethUsd = cfg.ethUsd; const isCreator = w.account && w.account.toLowerCase() === c.creator; const v4 = c.pool === 1;
  const changeModule = async (m: number) => { if (!isCreator) return; setBusy(true); try { await tx.setModule(cfg, c.token as Addr, m, ZERO); toast('Module changed', 'ok'); reload(); } catch (e) { toast(explainError(e), 'bad'); } finally { setBusy(false); } };
  const uniswapUrl = v4 ? `https://app.uniswap.org/explore/pools/ethereum/${c.poolId}` : `https://app.uniswap.org/explore/pools/ethereum/${c.v3Pool}`;
  const sinceLine = (s: number) => (s ? `held ${ago(s).replace(' ago', '')}` : '');
  return (
    <main className="wrap page">
      <div className="coinhead">
        <Avatar coin={c} lg />
        <div style={{ minWidth: 0 }}><h1>{c.name} <span className="mono muted" style={{ fontSize: '0.6em' }}>${c.symbol}</span>{(c.official || c.lookalike || c.hidden) && <> <StandingTag c={c} /></>}</h1>
          <div className="row wrapRow small muted" style={{ marginTop: 6 }}><span className={`tag ${MODULE_TAG[c.module]}`}><ModuleIcon id={c.module} /> {c.moduleInfo.name}</span><PoolTag c={c} /><span>by {short(c.creator)}</span><span>launched {ago(c.createdAt)} at {usd(c.startCapUsd)}</span>{c.explorer && <a className="mono" href={c.explorer.tx} target="_blank" rel="noreferrer">{short(c.tx, 6)} ↗</a>}</div></div>
        <span className="spacer" style={{ flex: 1 }} />
        <div className="row wrapRow">{c.links?.x && <a className="btn sm" href={c.links.x} target="_blank" rel="noreferrer">X</a>}{c.links?.site && <a className="btn sm" href={c.links.site} target="_blank" rel="noreferrer">Site</a>}{c.links?.telegram && <a className="btn sm" href={c.links.telegram} target="_blank" rel="noreferrer">Telegram</a>}{(c.v3Pool || c.poolId) && !cfg.demo && <a className="btn sm" href={uniswapUrl} target="_blank" rel="noreferrer">Uniswap ↗</a>}</div>
      </div>
      {c.lookalike && <div className="help notice" style={{ marginTop: 14 }}>Not the platform's coin. This one only wears the official name or symbol; the official ${c.symbol} is <Link to={`/c/${c.officialToken}`} className="mono">{short(c.officialToken || '', 6)}</Link>. Anyone can launch a coin here under any name, so check the address before you trade.</div>}
      {c.hidden && <div className="help notice" style={{ marginTop: 14 }}>This coin is kept out of the lists, the search and the numbers by this site. Its pool, its holders and its module are on chain like any other's; the page stays so holders can trade and claim.</div>}
      {c.description && <p className="muted" style={{ maxWidth: 760, marginTop: 14 }}>{c.description}</p>}
      <div className="kpi" style={{ marginTop: 18 }}>
        <div className="k"><b>{priceLine(c.price, ethUsd)}</b><span>price</span></div>
        <div className="k"><b>{ethUsd ? usd(c.marketCapUsd) : `${eth(c.marketCapEth, 2)} ETH`}</b><span>market cap</span></div>
        <div className="k"><b>{eth(c.stats.volume24hEth, 3)} ETH</b><span>24h volume</span></div>
        <div className="k"><b>{eth(c.ethInPool, 3)} ETH</b><span>in the pool, locked</span></div>
        {c.stats.burned && BigInt(c.stats.burned) > 0n && <div className="k"><b>{coins(c.stats.burned)}</b><span>burned · {(Number(BigInt(c.stats.burned) * 1_000_000n / 10n ** 27n) / 10_000).toFixed(2)}% of supply</span></div>}
        <div className="k"><b>{data.holders.count}</b><span>holders</span></div>
        <div className="k"><b>{eth(c.fees.paid, 4)} ETH</b><span>paid by the module</span></div>
      </div>
      <div className="layout">
        <div className="stack">
          <div className="card">
            <div className="row between wrapRow"><b>{v4 ? 'Uniswap v4 · rules pool' : 'Uniswap v3 · 1% pool'}</b><span className="muted small">{pct(c.progress)} of the supply sold · {coins(c.coinsInPool)} ${c.symbol} and {eth(c.ethInPool, 3)} ETH in the pool</span></div>
            <div className="progress" style={{ margin: '10px 0 10px' }}><i style={{ width: `${Math.max(2, c.progress * 100)}%` }} /></div>
            <p className="small muted" style={{ margin: 0 }}>{v4 ? `Every fee this pool charges is the coin's: ${c.rules?.launchFee ? `an opening fee of ${pct(c.rules.launchFee / 1e6, 0)} that ${c.rules.open ? 'falls' : 'fell'} to 1% over ${duration(c.rules.window)}, ` : ''}1% on buys, ${pct((c.rules?.sellFee || 10000) / 1e6, 0)} on sells${c.rules && BigInt(c.rules.maxSwap) > 0n ? `, at most ${coins(c.rules.maxSwap)} per swap while the window ${c.rules.open ? 'is' : 'was'} open` : ''}. Only Halcyon's locker holds liquidity here.` : 'The whole supply went into one position of this pool at launch, locked forever. The 1% every trade pays is the position\'s, which is the coin\'s: the gardener collects it and 80% follows the module.'}</p>
            <OpeningBar c={c} />
            <div style={{ marginTop: 14 }}><Candles token={c.token} symbol={c.symbol} ethUsd={ethUsd} /></div>
          </div>
          <div className="card">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'module'} className={`tab ${tab === 'module' ? 'on' : ''}`} onClick={() => setTab('module')}><ModuleIcon id={c.module} /> {c.moduleInfo.name}</button>
              <button role="tab" aria-selected={tab === 'trades'} className={`tab ${tab === 'trades' ? 'on' : ''}`} onClick={() => setTab('trades')}>Trades <span className="count">{c.stats.trades}</span></button>
              <button role="tab" aria-selected={tab === 'burns'} className={`tab ${tab === 'burns' ? 'on' : ''}`} onClick={() => setTab('burns')}>Burns {c.stats.burned && BigInt(c.stats.burned) > 0n ? <span className="count">{coins(c.stats.burned)}</span> : null}</button>
            </div>
            {tab === 'module' && <div className="tabpane">
            <div className="row between wrapRow"><b><ModuleIcon id={c.module} /> {c.moduleInfo.name} module</b><span className="muted small">pot {eth(c.fees.pot, 4)} ETH · collected {eth(c.fees.received, 4)} ETH</span></div>
            <p className="small muted" style={{ margin: '6px 0 10px' }}>{c.moduleInfo.line}{c.module === 'harvest' && c.stock ? <> The stock: {c.stockInfo?.logo && <img src={c.stockInfo.logo} alt="" className="stocklogo sm" onError={e => { e.currentTarget.style.display = 'none'; }} />}<Link to="/stocks" className="mono" style={{ textDecoration: 'underline' }}>{c.stockInfo?.symbol || short(c.stock, 6)}</Link>{c.stockInfo?.name ? ` (${c.stockInfo.name})` : ''}.</> : ''}</p>
            {c.module === 'branch' && c.branches.length > 0 && <table className="tbl" style={{ marginBottom: 10 }}><tbody>{c.branches.map(s => <tr key={s.to}><td className="mono small">{short(s.to, 6)}</td><td className="num" style={{ textAlign: 'right' }}>{(s.bps / 100).toFixed(s.bps % 100 ? 1 : 0)}%</td></tr>)}</tbody></table>}
            {c.module === 'mist' && <div className="help" style={{ marginBottom: 10 }}>{data.holders.keyed} of {data.holders.count} holders carry a mist key. A round sows private notes into the mist pool: the chain shows the notes, not whose they are; each is spent with a zero-knowledge proof to any address. <Link to="/me" style={{ textDecoration: 'underline' }}>Set yours on your page.</Link></div>}
            {c.module === 'clover' && c.draw && <div className="help" style={{ marginBottom: 10 }}>A draw is open: block {c.draw.drawBlock} picks the winner of {eth(c.draw.pot, 4)} ETH, weighted by balance. Anyone can check it from that block's hash and the holders.</div>}
            {isCreator && !cfg.demo && <div className="row wrapRow small"><span className="muted">You created this coin. Change the module:</span>{(['roots', 'rain', 'prune', 'clover', 'rings', 'mist'] as const).map(id => <button key={id} className="btn sm" disabled={busy || c.module === id} onClick={() => changeModule(cfg.modules[id].id)}>{cfg.modules[id].name}</button>)}</div>}
            {data.payouts.length ? <table className="tbl" style={{ marginTop: 8 }}><thead><tr><th>When</th><th>What</th><th>Tx</th></tr></thead><tbody>{data.payouts.map(p => <tr key={p.tx + p.kind}><td className="muted">{ago(p.t)}</td><td>{payoutLine(p, c)}</td><td className="mono small">{c.explorer ? <a href={`${cfg.explorer}/tx/${p.tx}`} target="_blank" rel="noreferrer">{short(p.tx, 4)}</a> : short(p.tx, 4)}</td></tr>)}</tbody></table> : <p className="small faint" style={{ margin: 0 }}>Nothing paid yet. The gardener collects once the fees are worth the gas, and pays once the pot is.</p>}
            </div>}
            {tab === 'trades' && <div className="tabpane">
            <div className="feed" style={{ marginTop: 8 }}>{data.trades.length ? data.trades.slice(0, 40).map(t => <div className="t" key={t.tx + t.block + t.eth}><span className={t.buy ? 'buy' : 'sell'}><b>{t.buy ? 'Buy' : 'Sell'}</b></span><span className="mono small">{short(t.trader)}</span><span className="num">{eth(t.eth)} ETH · {coins(t.coins)}{t.feePips && t.feePips > 10000 ? <span className="faint"> · {pct(t.feePips / 1e6, 0)} fee</span> : null}</span><span className="faint small">{ago(t.t)}</span></div>) : <span className="muted small">No trades yet.</span>}</div>
            </div>}
            {tab === 'burns' && <div className="tabpane">
              <p className="small muted" style={{ margin: '0 0 8px' }}>Coins gone for good: the gardener's buybacks under Prune, and anyone's own burns (a transfer to the dead address). {c.stats.burned && BigInt(c.stats.burned) > 0n ? <b className="ink">{coins(c.stats.burned)} burned, {(Number(BigInt(c.stats.burned) * 1_000_000n / 10n ** 27n) / 10_000).toFixed(2)}% of the supply.</b> : 'Nothing burned yet.'}</p>
              {data.burns.length ? <div className="feed">{data.burns.map(b => <div className="t" key={b.tx + b.value}><span className="faint small">{ago(b.t)}</span><span className="small">{b.buyback ? <span className="tag peach" style={{ padding: '2px 8px', fontSize: '0.7rem' }}>buyback</span> : <span className="mono">{short(b.from)}</span>}</span><span className="num">{coins(b.value)} ${c.symbol}</span><span className="mono small">{cfg.explorer ? <a href={`${cfg.explorer}/tx/${b.tx}`} target="_blank" rel="noreferrer">{short(b.tx, 4)}</a> : short(b.tx, 4)}</span></div>)}</div> : null}
            </div>}
          </div>
        </div>
        <div className="stack">
          <TradePanel coin={c} cfg={cfg} onDone={reload} />
          <div className="card">
            <div className="row between"><b>Holders</b><span className="muted small">{data.holders.count}</span></div>
            <table className="tbl" style={{ marginTop: 6 }}><tbody>{data.holders.top.slice(0, 12).map((h, i) => <tr key={h.address}><td className="faint">{i + 1}</td><td className="mono small">{h.address === c.creator ? <span title="creator">★ </span> : ''}{short(h.address)}</td><td className="num small" style={{ textAlign: 'right' }}>{h.pct.toFixed(2)}%{c.module === 'rings' && h.since ? <span className="faint"> · {sinceLine(h.since)}</span> : null}{c.module === 'mist' && h.mist ? <span className="faint" title="has a mist key"> · mist key</span> : null}</td></tr>)}</tbody></table>
          </div>
          <div className="card small muted stack" style={{ gap: 6 }}><b className="ink">On chain</b><span>Token <span className="mono">{short(c.token, 6)}</span></span>{v4 ? <span>Pool id <span className="mono">{short(c.poolId, 6)}</span></span> : <span>Pool <span className="mono">{short(c.v3Pool, 6)}</span></span>}{!v4 && c.tokenId !== '0' && <span>Position #{c.tokenId}, held by the locker</span>}{v4 && <span>Position held by the v4 locker</span>}<span>Launchpad <span className="mono">{short(cfg.launchpad, 6)}</span></span><span>Fees <span className="mono">{short(cfg.fees, 6)}</span></span>{c.uri ? <span>Metadata {c.uri.startsWith('ipfs://') ? <>on IPFS, <a className="mono" href={c.metaUrl || c.uri} target="_blank" rel="noreferrer">{short(c.uri.slice(7), 6)} ↗</a></> : <a className="mono" href={c.metaUrl || c.uri} target="_blank" rel="noreferrer">{(c.uri || '').replace(/^https?:\/\//, '').slice(0, 28)}… ↗</a>}</span> : null}<Link to="/docs#contracts">What each does →</Link></div>
        </div>
      </div>
    </main>
  );
}
