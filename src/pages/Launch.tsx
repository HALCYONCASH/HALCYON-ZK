import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type ModuleId } from '../lib/api';
import { useConfig, useFetch, useTitle } from '../lib/hooks';
import { useWallet, toast } from '../components/Shell';
import { ModuleIcon } from '../components/CoinCard';
import { launchCoin, explainError, mineV3Salt, randomSalt, ZERO, type Addr } from '../lib/chain';
import { parseEthInput, eth, coins, usd, pct } from '../lib/format';
import * as P from '../../shared/pool.mjs';

const OPENING_FEES = [{ v: 0, n: 'None', s: '1% from the first block' }, { v: 300000, n: '30%', s: 'falling to 1%' }, { v: 500000, n: '50%', s: 'falling to 1%' }, { v: 800000, n: '80%', s: 'falling to 1%' }];
const WINDOWS = [{ v: 300, n: '5 min' }, { v: 900, n: '15 min' }, { v: 1800, n: '30 min' }, { v: 3600, n: '1 hour' }];
const MAX_SWAPS = [{ v: 0, n: 'None', s: 'any size' }, { v: 100, n: '1%', s: 'of the supply per swap' }, { v: 200, n: '2%', s: 'of the supply per swap' }, { v: 500, n: '5%', s: 'of the supply per swap' }];
const SELL_FEES = [{ v: 10000, n: '1%', s: 'same as buys' }, { v: 20000, n: '2%', s: 'on every sell' }, { v: 30000, n: '3%', s: 'on every sell' }, { v: 50000, n: '5%', s: 'on every sell' }];
const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

export default function Launch() {
  const cfg = useConfig(); const w = useWallet(); const nav = useNavigate(); useTitle(`Launch · ${cfg?.siteName || 'Halcyon'}`);
  const stocks = useFetch(() => api.stocks(), []); const usable = (stocks.data || []).filter(s => s.allowed && s.routed);
  const [f, setF] = useState({ name: '', symbol: '', description: '', image: '', x: '', site: '', telegram: '', cap: 5000, customCap: '', pool: 1, launchFee: 500000, window: 900, maxSwapBps: 200, sellFee: 10000, module: 'rain' as ModuleId, stock: '', split: [{ to: '', bps: '' }, { to: '', bps: '' }], founder: '' });
  const [busy, setBusy] = useState(''); const [uploading, setUploading] = useState(false);
  /* a symbol another coin wears already: said under the field (the launch goes through all the same; a second coin under the platform's symbol is marked a lookalike) */
  const [taken, setTaken] = useState<{ symbol: string; name: string; official: boolean; token: string } | null>(null);
  useEffect(() => { const sym = f.symbol.trim().toUpperCase(); if (!/^[A-Z0-9]{2,12}$/.test(sym)) { setTaken(null); return; } let live = true; const t = setTimeout(() => api.taken(sym).then(r => { if (live) setTaken(r ? { symbol: sym, name: r.name, official: r.official, token: r.token } : null); }).catch(() => { if (live) setTaken(null); }), 400); return () => { live = false; clearTimeout(t); }; }, [f.symbol]);
  const set = (k: keyof typeof f, v: unknown) => setF(x => ({ ...x, [k]: v }));
  const capUsd = useMemo(() => { const c = f.customCap.trim() ? Number(f.customCap) : f.cap; return Number.isFinite(c) ? Math.floor(c) : 0; }, [f.cap, f.customCap]);
  const ethUsd = cfg?.ethUsd || 0; const answer = ethUsd ? BigInt(Math.round(ethUsd * 1e8)) : 0n;
  const fresh = useMemo(() => (answer > 0n && capUsd >= P.MIN_CAP_USD && capUsd <= P.MAX_CAP_USD ? P.freshPool(f.pool, capUsd, answer) : null), [f.pool, capUsd, answer]);
  const founderWei = parseEthInput(f.founder || '0') || 0n; const founderQuote = fresh && founderWei > 0n ? P.quoteBuy(fresh, founderWei) : null;
  const splitRows = f.split.filter(r => r.to.trim() || r.bps.trim()); const splitSum = splitRows.reduce((a, r) => a + (Number(r.bps) || 0), 0);
  const errors: string[] = [];
  if (!f.name.trim()) errors.push('a name'); if (!/^[A-Za-z0-9]{2,12}$/.test(f.symbol.trim())) errors.push('a symbol of 2 to 12 letters or digits');
  if (cfg && (capUsd < P.MIN_CAP_USD || capUsd > P.MAX_CAP_USD)) errors.push(`a starting cap between $${P.MIN_CAP_USD.toLocaleString()} and $${P.MAX_CAP_USD.toLocaleString()}`);
  if (f.module === 'harvest' && !isAddr(f.stock)) errors.push('a stock');
  if (f.module === 'branch') { if (!splitRows.length) errors.push('at least one branch address'); else if (splitRows.some(r => !isAddr(r.to))) errors.push('valid split addresses'); else if (splitSum !== 100) errors.push('split shares that add up to 100%'); if (splitRows.length > 8) errors.push('at most eight split addresses'); }
  if (f.pool === 1 && f.launchFee > 0 && !f.window) errors.push('a window for the opening fee');
  if (f.founder && founderWei === 0n) errors.push('a valid first buy');
  if (founderQuote && f.pool === 1 && f.maxSwapBps > 0 && founderQuote.coinsOut > P.SUPPLY * BigInt(f.maxSwapBps) / 10_000n) errors.push('a first buy within your own max per swap');
  async function upload(file: File) { setUploading(true); try { const r = await api.image(file); set('image', r.url); if (r.pinned) toast('Picture pinned on IPFS', 'ok'); } catch (e) { toast(String((e as Error).message), 'bad'); } finally { setUploading(false); } }
  async function go() {
    if (!cfg || errors.length) return; setBusy('metadata');
    try {
      const meta = await api.meta({ name: f.name.trim(), symbol: f.symbol.trim().toUpperCase(), description: f.description.trim(), image: f.image.trim(), links: { x: f.x.trim(), site: f.site.trim(), telegram: f.telegram.trim() } });
      setBusy('salt'); const salt = f.pool === 0 ? mineV3Salt(cfg, w.account as Addr) : randomSalt();
      setBusy('wallet'); const minOut = founderQuote ? founderQuote.coinsOut - founderQuote.coinsOut / 50n : 0n;
      const r = await launchCoin(cfg, { name: f.name.trim(), symbol: f.symbol.trim().toUpperCase(), uri: meta.uri, pool: f.pool, startCapUsd: capUsd, module: cfg.modules[f.module].id, stock: (f.module === 'harvest' ? f.stock.trim() : ZERO) as Addr, salt,
        splitTo: f.module === 'branch' ? splitRows.map(r => r.to.trim() as Addr) : [], splitBps: f.module === 'branch' ? splitRows.map(r => Math.round(Number(r.bps) * 100)) : [],
        launchFee: f.pool === 1 ? f.launchFee : 0, sellFee: f.pool === 1 ? f.sellFee : 10000, window: f.pool === 1 && (f.launchFee || f.maxSwapBps) ? f.window : 0, maxSwapBps: f.pool === 1 ? f.maxSwapBps : 0, minOut }, founderWei);
      toast(meta.pinned ? `Launched $${f.symbol.toUpperCase()}; its metadata is pinned on IPFS` : `Launched $${f.symbol.toUpperCase()}`, 'ok'); nav(r.token ? `/c/${r.token}` : '/coins');
    } catch (e) { toast(explainError(e), 'bad'); } finally { setBusy(''); }
  }
  if (!cfg) return <main className="wrap page"><div className="card skeleton" style={{ minHeight: 300 }} /></main>;
  const capLine = (c: number) => (ethUsd ? `${(c / ethUsd).toFixed(3)} ETH of liquidity at the start` : '');
  const reach = (target: number) => (capUsd ? P.ethToReachCap(capUsd, target) : 0);
  return (
    <main className="wrap page">
      <h1 style={{ fontSize: '2.4rem' }}>Launch a coin</h1><p className="muted" style={{ margin: '6px 0 22px', maxWidth: 640 }}>One transaction on {cfg.chainName}: the coin, its Uniswap pool, the liquidity locked. You pay the gas of the launch (and your first buy, if you make one); the gardener pays everything after.</p>
      <div className="wizard">
        <div className="stack">
          <section className="card pad stack">
            <h3>1 · The coin</h3>
            <div className="grid cols-2"><div><label className="lbl">Name</label><input className="field" maxLength={48} value={f.name} onChange={e => set('name', e.target.value)} placeholder="The coin's name" /></div><div><label className="lbl">Symbol</label><input className="field" maxLength={12} value={f.symbol} onChange={e => set('symbol', e.target.value.toUpperCase())} placeholder="TICKER" />{taken && <div className="help taken">${taken.symbol} is taken by {taken.name}{taken.official ? ', the platform\'s own coin: yours would be marked a lookalike' : ': yours would be a second one'}.</div>}</div></div>
            <div><label className="lbl">Description</label><textarea className="field" maxLength={1000} value={f.description} onChange={e => set('description', e.target.value)} placeholder="What it is, in a few lines." /></div>
            <div className="grid cols-2"><div><label className="lbl">Picture</label><div className="row"><input className="field" value={f.image} onChange={e => set('image', e.target.value)} placeholder="https://… or upload" /><label className="btn sm" style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>{uploading ? 'Uploading…' : 'Upload'}<input type="file" accept="image/*" hidden onChange={e => e.target.files?.[0] && upload(e.target.files[0])} /></label></div><div className="help">PNG, JPG, WebP, GIF or SVG, up to 1 MB. Square looks best.{cfg?.pinning ? ' Pinned to IPFS with the coin.' : ''}</div></div>
              <div><label className="lbl">Links</label><div className="stack" style={{ gap: 8 }}><input className="field" value={f.x} onChange={e => set('x', e.target.value)} placeholder="https://x.com/…" /><input className="field" value={f.site} onChange={e => set('site', e.target.value)} placeholder="https://… (site)" /><input className="field" value={f.telegram} onChange={e => set('telegram', e.target.value)} placeholder="https://t.me/…" /></div></div></div>
          </section>
          <section className="card pad stack">
            <h3>2 · The pool</h3>
            <div><label className="lbl">Starting market cap: what the first buyer pays for the whole supply</label><div className="choice">{cfg.model.capPresets.map(c => <button key={c} className={!f.customCap && f.cap === c ? 'on' : ''} onClick={() => { set('cap', c); set('customCap', ''); }}><b>${c.toLocaleString()}</b><span>{capLine(c)}</span></button>)}<div><input className="field" placeholder="custom $" inputMode="numeric" value={f.customCap} onChange={e => set('customCap', e.target.value.replace(/[^\d]/g, ''))} /></div></div>
              <div className="help">Read from Chainlink at the moment of the launch. Every coin is in the pool from the start; buys walk the price up, sells walk it back. From ${capUsd.toLocaleString() || '…'}: about {reach(100_000).toLocaleString(undefined, { maximumFractionDigits: 0 })} dollars of buys reach a $100K cap, {reach(1_000_000).toLocaleString(undefined, { maximumFractionDigits: 0 })} reach $1M.</div></div>
            <div><label className="lbl">Which Uniswap</label><div className="choice">{Object.values(cfg.pools).map(p => <button key={p.id} className={f.pool === p.id ? 'on' : ''} onClick={() => set('pool', p.id)}><b>{p.name}</b><span>{p.line}</span></button>)}</div></div>
            {f.pool === 1 && <>
              <div><label className="lbl">Opening fee on buys</label><div className="choice">{OPENING_FEES.map(o => <button key={o.v} className={f.launchFee === o.v ? 'on' : ''} onClick={() => set('launchFee', o.v)}><b>{o.n}</b><span>{o.s}</span></button>)}</div><div className="help">A sniper in the first block pays this much of the buy to the pool. The pool's fees are the coin's: snipers pay the holders. It falls in a straight line to 1% over the window.</div></div>
              <div className="grid cols-2"><div><label className="lbl">The window</label><div className="choice">{WINDOWS.map(o => <button key={o.v} className={f.window === o.v ? 'on' : ''} onClick={() => set('window', o.v)}><b>{o.n}</b></button>)}</div></div>
                <div><label className="lbl">Max per swap during the window</label><div className="choice">{MAX_SWAPS.map(o => <button key={o.v} className={f.maxSwapBps === o.v ? 'on' : ''} onClick={() => set('maxSwapBps', o.v)}><b>{o.n}</b><span>{o.s}</span></button>)}</div></div></div>
              <div><label className="lbl">Fee on sells, forever</label><div className="choice">{SELL_FEES.map(o => <button key={o.v} className={f.sellFee === o.v ? 'on' : ''} onClick={() => set('sellFee', o.v)}><b>{o.n}</b><span>{o.s}</span></button>)}</div><div className="help">Buys pay 1% after the window. Sells can pay more; the extra is the coin's too. Uniswap enforces all of this on every swap, whoever routes it.</div></div>
            </>}
          </section>
          <section className="card pad stack">
            <h3>3 · The module: where the 80% goes</h3>
            <div className="choice modules">{(Object.keys(cfg.modules) as ModuleId[]).map(id => <button key={id} className={f.module === id ? 'on' : ''} onClick={() => set('module', id)}><b><ModuleIcon id={id} /> {cfg.modules[id].name}</b><span>{cfg.modules[id].line}</span></button>)}</div>
            {f.module === 'harvest' && <div><label className="lbl">The stock</label>{usable.length ? <div className="choice stocks">{usable.map(s => <button key={s.address} className={f.stock === s.address ? 'on' : ''} onClick={() => set('stock', s.address)}>{s.logo && <img src={s.logo} alt="" className="stocklogo" onError={e => { e.currentTarget.style.visibility = 'hidden'; }} />}<b>{s.symbol}</b><span>{s.name}</span></button>)}</div> : <div className="help">No stock has a route yet. The platform adds them on the Stocks page.</div>}<div className="help">Tokenized stocks are issued by third parties under their own terms; the issuer may bar some jurisdictions from holding them. Holders those issuers block get a claimable balance instead.</div></div>}
            {f.module === 'branch' && <div><label className="lbl">The branches: addresses and shares, in percent, adding up to 100</label><div className="stack" style={{ gap: 8 }}>{f.split.map((r, i) => <div className="row" key={i}><input className="field" placeholder="0x…" value={r.to} onChange={e => set('split', f.split.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} /><input className="field" style={{ maxWidth: 110 }} inputMode="decimal" placeholder="%" value={r.bps} onChange={e => set('split', f.split.map((x, j) => (j === i ? { ...x, bps: e.target.value } : x)))} /><button className="btn ghost sm" onClick={() => set('split', f.split.filter((_, j) => j !== i))} disabled={f.split.length <= 1}>×</button></div>)}</div><div className="row" style={{ marginTop: 8 }}><button className="btn sm" onClick={() => set('split', [...f.split, { to: '', bps: '' }])} disabled={f.split.length >= 8}>Add an address</button><span className="help" style={{ margin: 0 }}>{splitSum}% of 100</span></div></div>}
            <div className="help">You can change the module later from the coin's page, as its creator.</div>
          </section>
          <section className="card pad stack">
            <h3>4 · Your first buy</h3>
            <div className="row"><input className="field" style={{ maxWidth: 220 }} inputMode="decimal" placeholder="0.0 ETH, optional" value={f.founder} onChange={e => set('founder', e.target.value)} />{founderQuote && <span className="muted small">about {coins(founderQuote.coinsOut)} ${f.symbol || 'coins'} ({pct(Number(founderQuote.coinsOut) / Number(P.SUPPLY), 2)} of the supply)</span>}</div>
            <div className="help">Carried by the same transaction, at the opening price, 1% fee included (no opening fee for you, but your own max per swap holds).</div>
          </section>
        </div>
        <aside className="stack">
          <div className="card summary stack" style={{ position: 'sticky', top: 84 }}>
            <h3>Summary</h3>
            <dl><dt>Supply</dt><dd>1,000,000,000</dd><dt>In the pool</dt><dd>all of it, locked</dd><dt>Pool</dt><dd>{cfg.pools[f.pool]?.name} ({f.pool === 1 ? 'v4' : 'v3'})</dd><dt>Starting cap</dt><dd>{capUsd ? usd(capUsd) : '…'}</dd><dt>Starts at</dt><dd>{fresh ? `${eth(P.price(fresh), 10)} ETH` : '…'}</dd><dt>Fee</dt><dd>1% every trade{f.pool === 1 && f.sellFee > 10000 ? `, ${pct(f.sellFee / 1e6, 0)} on sells` : ''}</dd>{f.pool === 1 && f.launchFee > 0 && <><dt>Opening</dt><dd>{pct(f.launchFee / 1e6, 0)} for {WINDOWS.find(x => x.v === f.window)?.n}</dd></>}{f.pool === 1 && f.maxSwapBps > 0 && <><dt>Max per swap</dt><dd>{pct(f.maxSwapBps / 10000, 0)} of supply</dd></>}<dt>Module</dt><dd>{cfg.modules[f.module].name}</dd><dt>Your buy</dt><dd>{founderWei > 0n ? `${eth(founderWei)} ETH` : 'none'}</dd></dl>
            <div className="hr" style={{ margin: '4px 0' }} />
            {errors.length > 0 && <p className="small muted" style={{ margin: 0 }}>Still needed: {errors.join(', ')}.</p>}
            {cfg.demo ? <button className="btn primary lg" disabled>Demo: launching is off</button> : !w.account ? <p className="help">Connect a wallet to launch.</p> : w.chainId !== cfg.chainId ? <p className="help">Switch your wallet to {cfg.chainName}.</p> : <button className="btn primary lg" disabled={errors.length > 0 || Boolean(busy)} onClick={go}>{busy ? `${busy}…` : 'Launch'}</button>}
            <p className="tiny faint" style={{ margin: 0 }}>Launching clones the verified coin contract, creates the pool and puts the supply in it as a position the Halcyon locker holds forever ({f.pool === 1 ? 'about 760k gas on v4' : 'about 5.6M gas on v3: the pool contract is the dear part'}). Nothing can be changed afterwards except the module, by you.</p>
          </div>
        </aside>
      </div>
    </main>
  );
}
