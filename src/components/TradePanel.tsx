// Buy and sell straight in the coin's pool: a v3 coin through Uniswap's SwapRouter02, a v4 coin through HalcyonSwap. The quote comes
// from the server's pool math (the same math the contracts run), including a v4 pool's opening fee and max per swap; the
// transaction carries a minimum at 1% below it.
import { useEffect, useState } from 'react';
import type { Coin, Config, Quote } from '../lib/api';
import { api } from '../lib/api';
import { eth, coins, parseEthInput, WEI, pct } from '../lib/format';
import { useWallet, toast } from './Shell';
import { tx, reads, explainError, type Addr } from '../lib/chain';

const SLIPPAGE_BPS = 100n;
const minus = (x: bigint, bps: bigint) => x - x * bps / 10_000n;

export default function TradePanel({ coin, cfg, onDone }: { coin: Coin; cfg: Config; onDone: () => void }) {
  const w = useWallet(); const [side, setSide] = useState<'buy' | 'sell'>('buy'); const [amount, setAmount] = useState(''); const [busy, setBusy] = useState(''); const [bal, setBal] = useState<{ eth: bigint; coin: bigint } | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null); const [quoteErr, setQuoteErr] = useState('');
  const token = coin.token as Addr; const connected = Boolean(w.account) && w.chainId === cfg.chainId && !cfg.demo; const v4 = coin.pool === 1;
  useEffect(() => { if (!connected) { setBal(null); return; } let alive = true; Promise.all([reads.ethBalance(cfg, w.account as Addr), reads.balance(cfg, token, w.account as Addr)]).then(([e, c]) => { if (alive) setBal({ eth: e, coin: c }); }).catch(() => {}); return () => { alive = false; }; }, [connected, w.account, token, cfg, busy]);
  const inWei = side === 'buy' ? parseEthInput(amount) : (() => { const t = amount.trim(); if (!/^\d*(\.\d*)?$/.test(t) || !t) return null; const [a, b = ''] = t.split('.'); return BigInt(a || '0') * WEI + BigInt((b + '0'.repeat(18)).slice(0, 18)); })();
  useEffect(() => {
    if (!inWei || inWei <= 0n) { setQuote(null); setQuoteErr(''); return; } let alive = true; const id = setTimeout(() => { api.quote(coin.token, side, inWei).then(q => { if (alive) { setQuote(q); setQuoteErr(''); } }).catch(e => { if (alive) { setQuote(null); setQuoteErr(String(e.message || e)); } }); }, 150);
    return () => { alive = false; clearTimeout(id); };
  }, [coin.token, side, inWei]); // eslint-disable-line react-hooks/exhaustive-deps

  async function go() {
    if (!inWei || !quote) return; setBusy('checking');
    try {
      const out = BigInt(quote.out); const minOut = minus(out, SLIPPAGE_BPS);
      if (side === 'buy') { setBusy('sending'); if (v4) await tx.buyV4(cfg, token, minOut, inWei); else await tx.buyV3(cfg, token, minOut, inWei); toast(`Bought about ${coins(out)} $${coin.symbol}`, 'ok'); }
      else {
        const spender = (v4 ? cfg.swap : cfg.uniswap.swapRouter02) as Addr; const allowance = await reads.allowance(cfg, token, w.account as Addr, spender);
        if (allowance < inWei) { setBusy('approving'); await tx.approve(cfg, token, spender, inWei); }
        setBusy('sending'); if (v4) await tx.sellV4(cfg, token, inWei, minOut); else await tx.sellV3(cfg, token, inWei, minOut); toast(`Sold for about ${eth(out)} ETH`, 'ok');
      }
      setAmount(''); onDone();
    } catch (e) { toast(explainError(e), 'bad'); } finally { setBusy(''); }
  }
  const quick = side === 'buy' ? ['0.05', '0.1', '0.5', '1'] : ['25%', '50%', '75%', '100%'];
  const setQuick = (q: string) => { if (side === 'buy') setAmount(q); else if (bal) { const p = BigInt(parseInt(q)); setAmount((Number(bal.coin * p / 100n) / 1e18).toString()); } };
  const feePct = quote ? pct(quote.feePips / 1_000_000, quote.feePips % 10000 ? 1 : 0) : '1%';
  const rules = coin.rules;
  return (
    <div className="card trade stack">
      <div className="tabs"><button className={side === 'buy' ? 'on' : ''} onClick={() => { setSide('buy'); setAmount(''); }}>Buy</button><button className={side === 'sell' ? 'on' : ''} onClick={() => { setSide('sell'); setAmount(''); }}>Sell</button></div>
      <div className="amount"><input inputMode="decimal" placeholder="0.0" value={amount} onChange={e => setAmount(e.target.value)} /><span className="unit">{side === 'buy' ? 'ETH' : `$${coin.symbol}`}</span></div>
      <div className="quick">{quick.map(q => <button key={q} onClick={() => setQuick(q)}>{q}</button>)}</div>
      {bal && <div className="out"><span>Balance</span><span className="num">{side === 'buy' ? `${eth(bal.eth)} ETH` : `${coins(bal.coin)} $${coin.symbol}`}</span></div>}
      {quote && <div className="out"><span>You receive</span><b className="num">{side === 'buy' ? `${coins(quote.out)} $${coin.symbol}` : `${eth(quote.out)} ETH`}</b></div>}
      {quote && <div className="out"><span>{feePct} fee{rules?.open && side === 'buy' ? ' (opening)' : ''}</span><span className="num">{side === 'buy' ? `${eth(quote.fee)} ETH` : `${coins(quote.fee)} $${coin.symbol}`}</span></div>}
      {quote && BigInt(quote.refund) > 0n && <div className="help">The pool cannot take all of it; {side === 'buy' ? `${eth(quote.refund)} ETH` : `${coins(quote.refund)} coins`} would come back.</div>}
      {quote?.overMax && <div className="err">Over the max per swap while the opening rules hold ({coins(quote.maxSwap)} $${coin.symbol}). Buy less, or wait for the window to close.</div>}
      {quoteErr && <div className="err">{quoteErr}</div>}
      {cfg.demo ? <button className="btn primary lg" disabled>Demo: trading is off</button> : !w.account ? <p className="help">Connect a wallet to trade.</p> : w.chainId !== cfg.chainId ? <p className="help">Switch your wallet to {cfg.chainName}.</p> : <button className="btn primary lg" disabled={!quote || Boolean(busy) || quote.overMax} onClick={go}>{busy ? `${busy}…` : side === 'buy' ? `Buy $${coin.symbol}` : `Sell $${coin.symbol}`}</button>}
      <p className="tiny faint" style={{ margin: 0 }}>{v4 ? `Trades go through the coin's Uniswap v4 pool. Buys pay ${rules?.open ? `the opening fee (${pct((rules?.feeNow || 10000) / 1_000_000, 0)} right now, falling to 1%)` : '1%'}, sells pay ${pct((rules?.sellFee || 10000) / 1_000_000, 0)}; every fee is the coin's.` : 'Trades go through the coin\'s Uniswap v3 pool and pay 1%, all of it to the locked position, which is the coin\'s.'} Set slippage to 2% or more in any other terminal.</p>
    </div>
  );
}
