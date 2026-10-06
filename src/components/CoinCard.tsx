// A coin in a list: avatar, name, where it is, its numbers, its module and its pool.
import { Link } from 'react-router-dom';
import type { Coin } from '../lib/api';
import { eth, usd, ago, pct } from '../lib/format';

/** Line-art module icons in the brand's outline style (currentColor, so they take the text colour of wherever they sit). */
export function ModuleIcon({ id, size = 16 }: { id: string; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, style: { verticalAlign: '-0.15em', flex: 'none' } };
  if (id === 'roots') return <svg {...p}><path d="M12 3v7" /><path d="M12 10c-3 1-5 4-6 8M12 10c3 1 5 4 6 8M12 10c-1 3-1 6 0 10M9 14c-2 1-3 3-4 5M15 14c2 1 3 3 4 5" /></svg>;
  if (id === 'rain') return <svg {...p}><path d="M7.5 13a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.5 1.5A3.3 3.3 0 0 1 17 13H7.5z" /><path d="M8 16.5l-1 3M12 16.5l-1 3M16 16.5l-1 3" /></svg>;
  if (id === 'prune') return <svg {...p}><path d="M4 20l6-6M14 10l6-6" /><circle cx="7.5" cy="16.5" r="1.5" /><path d="M9 15l5-5" /><path d="M14 10l2-2M12 8l2 2" /><path d="M19 11c-1 2-3 3-5 3" /></svg>;
  if (id === 'harvest') return <svg {...p}><path d="M4 20h16" /><path d="M12 20V9" /><path d="M12 13c-3 0-5-2-5-5 3 0 5 2 5 5zM12 11c3 0 5-2 5-5-3 0-5 2-5 5zM12 17c-2.5 0-4-1.5-4-4 2.5 0 4 1.5 4 4z" /></svg>;
  if (id === 'branch') return <svg {...p}><path d="M12 21V11" /><path d="M12 11c-4 0-6-3-6-6 4 0 6 3 6 6zM12 15c4 0 6-3 6-6-4 0-6 3-6 6zM12 19c-3 0-5-2-5-5 3 0 5 2 5 5z" /></svg>;
  if (id === 'clover') return <svg {...p}><path d="M12 12c-3-4-7-2-6 1s4 2 6-1zM12 12c4-3 2-7-1-6s-2 4 1 6zM12 12c3 4 7 2 6-1s-4-2-6 1zM12 12c-4 3-2 7 1 6s2-4-1-6z" /><path d="M12 12l-2 8" /></svg>;
  if (id === 'rings') return <svg {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5.5" /><circle cx="12" cy="12" r="2" /></svg>;
  if (id === 'mist') return <svg {...p}><path d="M3 9c3-3 6-3 9 0s6 3 9 0" /><path d="M3 14c3-3 6-3 9 0s6 3 9 0" /><path d="M3 19c3-3 6-3 9 0s6 3 9 0" /><circle cx="18" cy="5" r="1.4" /></svg>;
  return <svg {...p}><path d="M3 20h18M3 20V5" /><path d="M6 15l4-5 3 3 6-7" /><path d="M15.5 6H19v3.5" /></svg>;
}
export const MODULE_TAG: Record<string, string> = { roots: 'butter', rain: 'mint', prune: 'peach', harvest: '', branch: 'sky', clover: 'rose', rings: 'ink', mist: 'lav' };
export function Avatar({ coin, lg = false }: { coin: Pick<Coin, 'image' | 'symbol'>; lg?: boolean }) { return coin.image ? <img className={`avatar ${lg ? 'lg' : ''}`} src={coin.image} alt="" /> : <span className={`avatar ph ${lg ? 'lg' : ''}`}>{coin.symbol.slice(0, 2)}</span>; }
/** The platform's own coin wears a check; a coin wearing the official name or symbol is marked so nobody takes it for the real one. */
export function StandingTag({ c }: { c: Pick<Coin, 'official' | 'lookalike' | 'hidden'> }) {
  if (c.official) return <span className="tag mint" title="the platform's own coin"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5" /></svg> official</span>;
  if (c.lookalike) return <span className="tag rose" title="not the platform's coin: it only wears its name or symbol">lookalike</span>;
  if (c.hidden) return <span className="tag" title="kept out of the lists by this site">hidden</span>;
  return null;
}
export function PoolTag({ c }: { c: Coin }) { return c.pool === 1 ? <span className={`tag ${c.rules?.open ? 'rose' : 'lav'}`} title={c.rules?.open ? 'the opening rules still hold' : 'Uniswap v4 with the Halcyon hook'}>v4 rules{c.rules?.open ? ' · opening' : ''}</span> : <span className="tag sky" title="Uniswap v3, 1% tier">v3</span>; }

/** The pair's mark, faint in the card's corner: the stock a Harvest coin pays in, otherwise the ether every pool is paired with. */
export function PairMark({ c }: { c: Coin }) {
  if (c.module === 'harvest' && c.stockInfo?.logo) return <span className="pair" aria-hidden="true"><img src={c.stockInfo.logo} alt="" onError={e => { e.currentTarget.style.display = 'none'; }} /></span>;
  return <span className="pair" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none" stroke="#2d3761" strokeWidth="2.2" strokeLinejoin="round"><path d="M32 6 L50 33 L32 44 L14 33 Z" fill="#dcd6f6" /><path d="M32 6 L32 44 M14 33 L32 25 L50 33" opacity=".6" /><path d="M14 38 L32 58 L50 38 L32 49 Z" fill="#dcecf7" /></svg></span>;
}
/** Launched within the last ten minutes. */
export const isNew = (c: Pick<Coin, 'createdAt'>, now = Math.floor(Date.now() / 1000)) => Boolean(c.createdAt && now - c.createdAt < 600);

export default function CoinCard({ c, ethUsd, fresh = false }: { c: Coin; ethUsd: number; fresh?: boolean }) {
  return (
    <Link to={c.route} className={`coin ${fresh ? 'fresh' : ''}`}>
      <PairMark c={c} />
      <div className="top"><Avatar coin={c} /><div style={{ minWidth: 0 }}><b>{c.name} <span className="mono muted">${c.symbol}</span>{(c.official || c.lookalike) && <StandingTag c={c} />}{isNew(c) && <span className="chip new" title={`launched ${ago(c.createdAt)}`}>new</span>}</b><span>{pct(c.progress, 0)} sold · {c.stats.holders} holders{c.stats.lastTradeAt ? ` · ${ago(c.stats.lastTradeAt)}` : ''}</span></div></div>
      <div className="progress"><i style={{ width: `${Math.max(2, c.progress * 100)}%` }} /></div>
      <div className="nums">
        <div><span>Market cap</span><b>{ethUsd ? usd(c.marketCapUsd) : `${eth(c.marketCapEth, 2)} ETH`}</b></div>
        <div><span>24h volume</span><b>{eth(c.stats.volume24hEth, 3)} ETH</b></div>
        <div><span>Paid out</span><b>{eth(c.fees.paid, 4)} ETH</b></div>
      </div>
      <div className="foot"><span className={`tag ${MODULE_TAG[c.module]}`}><ModuleIcon id={c.module} /> {c.moduleInfo.name}</span><PoolTag c={c} /></div>
    </Link>
  );
}
