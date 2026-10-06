import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Config, type Me as MeData, type MistNote } from '../lib/api';
import { useConfig, useFetch, useTitle } from '../lib/hooks';
import { useWallet, toast } from '../components/Shell';
import { ModuleIcon } from '../components/CoinCard';
import { tx, explainError, type Addr } from '../lib/chain';
import { eth, coins, ago, short } from '../lib/format';
import { unlock, mistKeys, forget, publicKeyOf, findMine, resolveTo, withdrawRelayed, withdrawSelf, type Found } from '../lib/mist';

/** The holder's mist: one key, derived from a signature and kept in this tab; the notes it finds; a withdrawal by proof to anywhere. */
function MistCard({ cfg, data, reload }: { cfg: Config; data: MeData | null; reload: () => void }) {
  const [, bump] = useState(0); const [busy, setBusy] = useState(''); const [found, setFound] = useState<Found[] | null>(null); const [all, setAll] = useState<MistNote[]>([]); const [progress, setProgress] = useState(''); const [step, setStep] = useState('');
  const [to, setTo] = useState(''); const [pick, setPick] = useState<Found | null>(null); const [self, setSelf] = useState(false); const [done, setDone] = useState<{ hash: string; denom: string; fee: bigint }[]>([]);
  const keys = mistKeys(); const onChain = (data?.mistKey || '').toLowerCase(); const mine = keys ? publicKeyOf(keys).toLowerCase() : ''; const matches = Boolean(keys && onChain && mine === onChain);
  useEffect(() => { if (keys && matches && found === null && !busy) { void scanNow(); } }, [keys, matches]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (what: string, fn: () => Promise<void>) => { setBusy(what); setStep(''); try { await fn(); } catch (e) { toast(explainError(e), 'bad'); } finally { setBusy(''); setStep(''); bump(x => x + 1); } };
  const scanNow = () => run('scan', async () => { const k = await unlock(cfg); const r = await findMine(cfg, k, (seen, total) => setProgress(total ? `${seen} of ${total}` : '')); setAll(r.all); setFound(r.mine); setPick(null); });
  const create = () => run('create', async () => { const k = await unlock(cfg); await tx.setMistKey(cfg, publicKeyOf(k)); toast('Your mist key is on chain', 'ok'); reload(); });
  const remove = () => run('remove', async () => { await tx.setMistKey(cfg, '0x'); toast('Mist key removed', 'ok'); setFound(null); reload(); });
  const withdraw = () => run('withdraw', async () => { if (!keys || !pick) return; const dest = await resolveTo(cfg, to); const r = self ? await withdrawSelf(cfg, keys, pick, all, dest, setStep) : await withdrawRelayed(cfg, keys, pick, all, dest, setStep); setDone(d => [{ hash: r.hash, denom: pick.denom, fee: r.fee }, ...d]); toast(`Withdrawn ${eth(pick.denom, 3)} ETH`, 'ok'); setPick(null); await scanNow(); });
  const unspent = (found || []).filter(f => !f.spent); const total = unspent.reduce((a, f) => a + BigInt(f.denom), 0n);
  return (
    <div className="card pad mist" style={{ marginBottom: 18 }}>
      <div className="row between wrapRow"><b><ModuleIcon id="mist" /> Mist</b>{onChain ? <span className="tag mint">key on chain</span> : <span className="tag">no key yet</span>}</div>
      <p className="small muted" style={{ margin: '6px 0 12px', maxWidth: 680 }}>Coins on the Mist module pay their holders as private notes in Halcyon's mist pool. With a mist key, yours are sown for you alone: this page finds them with your viewing key, proves one in zero knowledge and sends it wherever you say, through a relayer that pays the gas, never through your wallet. The keys come from one signature and stay in this tab.</p>
      {!onChain && <div className="row wrapRow"><button className="btn primary" disabled={Boolean(busy) || cfg.demo} onClick={create}>{busy === 'create' ? 'Signing…' : 'Create my mist key'}</button><span className="small muted">One signature to derive it, one transaction to register it.</span></div>}
      {onChain && !keys && <div className="row wrapRow"><button className="btn primary" disabled={Boolean(busy)} onClick={scanNow}>{busy === 'scan' ? 'Signing…' : 'Unlock and find my notes'}</button><span className="small muted">Sign the same sentence again; nothing is sent.</span></div>}
      {onChain && keys && !matches && <div className="help" style={{ color: 'var(--warn)' }}>The key on chain is not the one this wallet derives (set from another wallet, or an older version). <button className="btn sm" disabled={Boolean(busy)} onClick={create}>Replace it with this wallet's key</button></div>}
      {matches && (
        <div className="stack" style={{ gap: 10, marginTop: 4 }}>
          {found === null ? <p className="small muted" style={{ margin: 0 }}>Scanning the notes{progress ? ` (${progress})` : ''}…</p> : found.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No notes for you yet. They appear here after a Mist coin you hold pays a round.</p> : (
            <>
              <div className="row between wrapRow"><b className="small">{found.length} note{found.length === 1 ? '' : 's'} are yours · {unspent.length} unspent, {eth(total.toString(), 3)} ETH</b><button className="btn sm" disabled={Boolean(busy)} onClick={scanNow}>Rescan</button></div>
              <div className="scroll-x"><table className="tbl"><thead><tr><th>Coin</th><th>Note</th><th>Sown</th><th style={{ textAlign: 'right' }}>Spend</th></tr></thead><tbody>{found.slice(0, 60).map(f => <tr key={`${f.batch}:${f.index}`}><td><Link to={`/c/${f.token}`}><b>{f.symbol ? `$${f.symbol}` : short(f.token, 4)}</b></Link></td><td className="num small">{eth(f.denom, 3)} ETH <span className="faint">#{f.leafIndex}</span></td><td className="muted small">{ago(f.t)}</td><td style={{ textAlign: 'right' }}>{f.spent ? <span className="faint small">spent</span> : <button className={`btn sm ${pick?.leafIndex === f.leafIndex ? 'primary' : ''}`} disabled={Boolean(busy)} onClick={() => setPick(pick?.leafIndex === f.leafIndex ? null : f)}>{pick?.leafIndex === f.leafIndex ? 'Picked' : 'Pick'}</button>}</td></tr>)}</tbody></table></div>
              {pick && (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="row wrapRow"><input className="field" style={{ maxWidth: 420 }} placeholder="Send to: an address, or an ENS name" value={to} onChange={e => setTo(e.target.value)} /><button className="btn primary" disabled={Boolean(busy) || !to.trim()} onClick={withdraw}>{busy === 'withdraw' ? `${step || 'working'}…` : `Withdraw ${eth(pick.denom, 3)} ETH`}</button></div>
                  <label className="small muted row" style={{ gap: 8 }}><input type="checkbox" checked={self} onChange={e => setSelf(e.target.checked)} /> Pay the gas from this wallet instead of the relayer (no fee; the transaction will come from this wallet, which links it to the note's destination, not to the note)</label>
                  <p className="tiny faint" style={{ margin: 0 }}>The proof is made in this tab and names the destination, the relayer and the fee; nobody can change them. The relayer takes its gas plus a margin from the note and sees only what the chain will show. Send to a fresh address and nothing ties the note to this wallet.</p>
                </div>
              )}
              {done.length > 0 && <p className="tiny muted" style={{ margin: 0 }}>Withdrawn: {done.map(d => <span key={d.hash} className="mono">{cfg.explorer ? <a href={`${cfg.explorer}/tx/${d.hash}`} target="_blank" rel="noreferrer">{short(d.hash, 4)}</a> : short(d.hash, 4)} ({eth(d.denom, 3)} ETH{d.fee > 0n ? `, fee ${eth(d.fee.toString(), 5)}` : ''}) </span>)}</p>}
            </>
          )}
        </div>
      )}
      {onChain && <div className="row wrapRow" style={{ marginTop: 12 }}>{keys && <button className="btn sm ghost" disabled={Boolean(busy)} onClick={() => { forget(); setFound(null); setPick(null); bump(x => x + 1); }}>Forget the keys in this tab</button>}<button className="btn sm ghost" disabled={Boolean(busy) || cfg.demo} onClick={remove}>Remove my mist key</button></div>}
    </div>
  );
}

export default function Me() {
  const cfg = useConfig(); const w = useWallet(); useTitle(`Your wallet · ${cfg?.siteName || 'Halcyon'}`); const a = w.account.toLowerCase(); const { data, reload } = useFetch(() => (a ? api.me(a) : Promise.resolve(null)), [a], 15_000); const [busy, setBusy] = useState(false);
  if (!w.account) return <main className="wrap page"><div className="empty card">Connect a wallet to see what it holds, what it launched and what it may claim.</div><div className="card pad" style={{ marginTop: 18 }}><b><ModuleIcon id="mist" /> Mist</b><p className="small muted" style={{ margin: '6px 0 0', maxWidth: 680 }}>Coins on the Mist module pay their holders as private notes, spent with a zero-knowledge proof to any address. Connect a wallet to create your mist key; from then on this page finds your notes and withdraws them wherever you say.</p></div></main>;
  const claim = async () => { if (!cfg) return; setBusy(true); try { await tx.claim(cfg); toast('Claimed', 'ok'); reload(); } catch (e) { toast(explainError(e), 'bad'); } finally { setBusy(false); } };
  const claimStock = async (stock: string) => { if (!cfg) return; setBusy(true); try { await tx.claimStock(cfg, stock as Addr); toast('Claimed', 'ok'); reload(); } catch (e) { toast(explainError(e), 'bad'); } finally { setBusy(false); } };
  const payoutLine = (p: { kind: string; total: string; count: number; winner?: string; open?: boolean }) => p.kind === 'clover' ? `${eth(p.total)} ETH to ${short(p.winner || '', 4)}` : p.kind === 'stockPaid' ? `${coins(p.total)} stock to ${p.count} holders` : p.kind === 'mist' ? `${eth(p.total)} ETH sown as ${p.count} private notes` : `${eth(p.total)} ETH to ${p.count} holders${p.kind === 'rings' ? ' (rings)' : p.open ? ' (no mist key)' : ''}`;
  return (
    <main className="wrap page">
      <h1 style={{ fontSize: '2.4rem' }}>{short(w.account, 6)}</h1><p className="muted" style={{ margin: '6px 0 22px' }}>{w.name} · {cfg?.chainName}</p>
      {data && BigInt(data.claimable) > 0n && <div className="card pad row between wrapRow" style={{ marginBottom: 18 }}><span><b>{eth(data.claimable)} ETH</b> <span className="muted">waits for you in the fees contract (a payout that could not be pushed to this address).</span></span><button className="btn primary" disabled={busy || cfg?.demo} onClick={claim}>Claim</button></div>}
      {data?.claimableStock?.map(s => <div key={s.stock} className="card pad row between wrapRow" style={{ marginBottom: 18 }}><span><b>{coins(s.amount)} {s.symbol}</b> <span className="muted">waits for you (the issuer refused the transfer at the time; claim once your address may receive it).</span></span><button className="btn primary" disabled={busy || cfg?.demo} onClick={() => claimStock(s.stock)}>Claim</button></div>)}
      {cfg && <MistCard cfg={cfg} data={data} reload={reload} />}
      <div className="grid cols-2">
        <div className="card"><b>Holdings</b>{data ? data.held.length ? <table className="tbl" style={{ marginTop: 8 }}><tbody>{data.held.map(h => <tr key={h.token}><td><Link to={`/c/${h.token}`}><b>${h.symbol}</b> <span className="muted small">{h.name}</span></Link></td><td className="num small" style={{ textAlign: 'right' }}>{coins(h.balance)} · {h.pct.toFixed(2)}%{h.since ? <span className="faint"> · since {ago(h.since).replace(' ago', '')}</span> : null}</td></tr>)}</tbody></table> : <p className="muted small">No Halcyon coins in this wallet (as far as the index has seen).</p> : <div className="skeleton" style={{ minHeight: 60 }} />}</div>
        <div className="card"><b>Launched by you</b>{data ? data.created.length ? <table className="tbl" style={{ marginTop: 8 }}><tbody>{data.created.map(c => <tr key={c.token}><td><Link to={`/c/${c.token}`}><b>${c.symbol}</b> <span className="muted small">{c.name}</span></Link></td><td className="small muted" style={{ textAlign: 'right' }}>{c.module} · {c.pool === 1 ? 'v4 rules' : 'v3'}</td></tr>)}</tbody></table> : <p className="muted small">Nothing yet. <Link to="/launch">Launch a coin →</Link></p> : <div className="skeleton" style={{ minHeight: 60 }} />}</div>
      </div>
      <div className="card" style={{ marginTop: 18 }}><b>Recent payouts, across the launchpad</b>{data?.recentPayouts.length ? <table className="tbl" style={{ marginTop: 8 }}><tbody>{data.recentPayouts.map(p => <tr key={p.tx + p.kind}><td className="muted">{ago(p.t)}</td><td><Link to={`/c/${p.token}`}>{short(p.token)}</Link></td><td>{payoutLine(p)}</td></tr>)}</tbody></table> : <p className="muted small" style={{ marginTop: 8 }}>None yet.</p>}</div>
    </main>
  );
}
