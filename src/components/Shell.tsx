// The frame around every page: the wordmark and the mark, the navigation, the wallet button and its modal, the toasts, the footer.
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { wallet, subscribe, discover, connect, disconnect, resume, switchChain, type WalletInfo } from '../lib/wallet';
import { useConfig } from '../lib/hooks';
import { short } from '../lib/format';

export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs><linearGradient id="mk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff3d1" /><stop offset=".5" stopColor="#f6c9e0" /><stop offset="1" stopColor="#a9d4f3" /></linearGradient></defs>
      <path d="M20 3 L33 18 L20 33 L7 18 Z" fill="url(#mk)" stroke="#2d3761" strokeWidth="2" strokeLinejoin="round" />
      <path d="M20 3 L20 33 M7 18 L33 18" stroke="#2d3761" strokeWidth="1" opacity=".5" />
      <path d="M6 37 q 7 -5 14 0 q 7 5 14 0" fill="none" stroke="#2d3761" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
export function Wordmark() { const cfg = useConfig(); return <Link to="/" className="wordmark"><Mark />{(cfg?.siteName || 'halcyon').toLowerCase()}<small>eth</small></Link>; }

let toastId = 0; const toastListeners = new Set<(t: { id: number; text: string; kind: string }) => void>();
export function toast(text: string, kind: 'ok' | 'bad' | '' = '') { const t = { id: ++toastId, text, kind }; toastListeners.forEach(l => l(t)); }
function Toasts() {
  const [list, setList] = useState<{ id: number; text: string; kind: string }[]>([]);
  useEffect(() => { const l = (t: { id: number; text: string; kind: string }) => { setList(x => [...x, t]); setTimeout(() => setList(x => x.filter(y => y.id !== t.id)), 6000); }; toastListeners.add(l); return () => { toastListeners.delete(l); }; }, []);
  return <div className="toasts">{list.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>;
}

export function useWallet() { const [, tick] = useState(0); useEffect(() => subscribe(() => tick(x => x + 1)), []); return wallet; }
function WalletModal({ onClose, chainId }: { onClose: () => void; chainId: number }) {
  const w = useWallet(); const pick = async (x: WalletInfo) => { try { await connect(x, chainId); toast(`Connected to ${x.name}`, 'ok'); onClose(); } catch (e) { toast(String((e as Error).message || e).slice(0, 120), 'bad'); } };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>Connect a wallet</h3>
        <p className="muted small">Halcyon never asks for a signature it does not need: a launch, a trade, a claim. Nothing else.</p>
        <div className="wallets">
          {w.wallets.length ? w.wallets.map(x => <button key={x.uuid} onClick={() => pick(x)} disabled={w.busy}>{x.icon ? <img src={x.icon} alt="" /> : <Mark size={28} />}<b>{x.name}</b></button>) : <p className="muted small">No wallet found in this browser. Install MetaMask, Rabby or Coinbase Wallet, or open this page inside your wallet's browser.</p>}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}><button className="btn ghost sm" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
export function WalletButton() {
  const w = useWallet(); const cfg = useConfig(); const [open, setOpen] = useState(false); const wrong = Boolean(w.account && cfg && w.chainId !== cfg.chainId);
  if (!w.account) return <><button className="btn primary" onClick={() => setOpen(true)}>Connect</button>{open && <WalletModal onClose={() => setOpen(false)} chainId={cfg?.chainId || 1} />}</>;
  if (wrong) return <button className="btn rose" onClick={() => switchChain(cfg!.chainId).catch(e => toast(String(e.message || e), 'bad'))}>Switch to {cfg?.chainName}</button>;
  return <span className="row"><Link to="/me" className="pill"><span className="dot" />{short(w.account)}</Link><button className="btn ghost sm" onClick={disconnect} title="Disconnect">×</button></span>;
}

export default function Shell({ children }: { children: ReactNode }) {
  const cfg = useConfig(); const [open, setOpen] = useState(false);
  useEffect(() => { discover(); }, []); useEffect(() => { if (cfg) resume(cfg.chainId); }, [cfg]);
  return (
    <>
      <header className="hdr"><div className="wrap">
        <Wordmark />
        <nav className={open ? 'open' : ''} onClick={() => setOpen(false)}>
          <NavLink to="/coins">Coins</NavLink><NavLink to="/launch">Launch</NavLink><NavLink to="/modules">Modules</NavLink><NavLink to="/stocks">Stocks</NavLink><NavLink to="/stats">Stats</NavLink><NavLink to="/docs">Docs</NavLink>
        </nav>
        <span className="spacer" />
        {cfg?.demo && <span className="tag butter" title="Sample coins, no chain behind them">demo</span>}
        <WalletButton />
        <button className="btn ghost sm burger" onClick={() => setOpen(x => !x)} aria-label="Menu">☰</button>
      </div></header>
      {children}
      <footer className="ftr"><div className="wrap">
        <span className="row"><Mark size={22} /><span>© {cfg?.siteName || 'Halcyon'} {new Date().getFullYear()} · <a href={cfg?.siteUrl || 'https://halcyon.cash'}>{(cfg?.siteUrl || 'https://halcyon.cash').replace(/^https?:\/\//, '')}</a>{cfg?.launchpad && !cfg.demo ? <> · {cfg.chainName} · <a className="mono" href={cfg.explorer ? `${cfg.explorer}/address/${cfg.launchpad}` : '#'} target="_blank" rel="noreferrer" title="the launchpad contract">{short(cfg.launchpad, 4)}</a></> : null}</span></span>
        <nav><Link to="/docs">How it works</Link><Link to="/docs#contracts">Contracts</Link><Link to="/modules">Modules</Link><a href={`https://x.com/${cfg?.xHandle || 'halcyoncash'}`} target="_blank" rel="noreferrer">@{cfg?.xHandle || 'halcyoncash'}</a>{cfg?.sourceUrl && <a href={cfg.sourceUrl} target="_blank" rel="noreferrer">Source</a>}</nav>
      </div></footer>
      <Toasts />
    </>
  );
}
