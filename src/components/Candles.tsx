// The coin's chart: TradingView's Lightweight Charts over the indexer's candles, in the site's colours. Price in ETH a coin or the market
// cap in dollars, six frames (the 15m and 4h folded from the 5m and the hour), the volume underneath, and the tail refreshed every few
// seconds so the last candle moves as trades land. The legend reads the candle under the pointer, or the latest.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, ColorType, CrosshairMode, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { api, type CandleFrame, type CandleRow } from '../lib/api';
import { tiny, usd } from '../lib/format';

type Tf = '1m' | '5m' | '15m' | '1h' | '4h' | '1D'; type Mode = 'mcap' | 'price';
const FRAME: Record<Tf, { tf: CandleFrame; fold: number; seconds: number }> = { '1m': { tf: 'm1', fold: 1, seconds: 60 }, '5m': { tf: 'm5', fold: 1, seconds: 300 }, '15m': { tf: 'm5', fold: 3, seconds: 900 }, '1h': { tf: 'h1', fold: 1, seconds: 3600 }, '4h': { tf: 'h1', fold: 4, seconds: 14_400 }, '1D': { tf: 'd1', fold: 1, seconds: 86_400 } };
const SUPPLY = 1e9; const UP = '#3fae7a', DOWN = '#e8738f';
type Candle = { time: UTCTimestamp; open: number; high: number; low: number; close: number; volume: number };

/** Fold n candles of a frame into one (the 15m from the 5m, the 4h from the hour), aligned to the wider frame. */
function fold(rows: CandleRow[], n: number, seconds: number): CandleRow[] {
  if (n === 1) return rows; const out: CandleRow[] = []; let cur: CandleRow | null = null;
  for (const r of rows) { const t0 = Math.floor(r[0] / seconds) * seconds; if (!cur || cur[0] !== t0) { cur = [t0, r[1], r[2], r[3], r[4], r[5]]; out.push(cur); } else { cur[2] = Math.max(cur[2], r[2]); cur[3] = Math.min(cur[3], r[3]); cur[4] = r[4]; cur[5] += r[5]; } }
  return out;
}
const toCandle = (r: CandleRow, k: number): Candle => ({ time: r[0] as UTCTimestamp, open: r[1] * k, high: r[2] * k, low: r[3] * k, close: r[4] * k, volume: r[5] });
const fmtEth = (v: number) => (v <= 0 ? '0' : v >= 0.001 ? v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : tiny(v, 4));
const fmtVol = (v: number) => (v >= 1 ? `${v.toFixed(2)} ETH` : v >= 0.001 ? `${v.toFixed(3)} ETH` : `${v.toFixed(5)} ETH`);

export default function Candles({ token, symbol, ethUsd }: { token: string; symbol: string; ethUsd: number }) {
  const [tf, setTf] = useState<Tf>(() => { try { return (localStorage.getItem('halcyon.tf') as Tf) || '5m'; } catch { return '5m'; } });
  const [mode, setMode] = useState<Mode>(() => { try { return (localStorage.getItem('halcyon.chart') as Mode) || (ethUsd ? 'mcap' : 'price'); } catch { return 'mcap'; } });
  const box = useRef<HTMLDivElement>(null); const chart = useRef<IChartApi | null>(null); const series = useRef<ISeriesApi<'Candlestick'> | null>(null); const vol = useRef<ISeriesApi<'Histogram'> | null>(null);
  const rows = useRef<CandleRow[]>([]); const [legend, setLegend] = useState<Candle | null>(null); const [count, setCount] = useState(-1); const hover = useRef<Candle | null>(null);
  const k = useMemo(() => (mode === 'mcap' && ethUsd ? SUPPLY * ethUsd : 1), [mode, ethUsd]);
  const format = useMemo(() => (mode === 'mcap' && ethUsd ? (v: number) => (v > 0 ? usd(v) : '$0') : (v: number) => `${fmtEth(v)} ETH`), [mode, ethUsd]);
  useEffect(() => { try { localStorage.setItem('halcyon.tf', tf); localStorage.setItem('halcyon.chart', mode); } catch {} }, [tf, mode]);

  /* the chart itself, once; its series take new data as the frame or the mode change */
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ch = createChart(el, { autoSize: true, layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#5a6391', fontFamily: "'DM Sans Variable', system-ui, sans-serif", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: 'rgba(45, 55, 97, 0.07)' }, horzLines: { color: 'rgba(45, 55, 97, 0.07)' } }, rightPriceScale: { borderColor: 'rgba(45, 55, 97, 0.16)', scaleMargins: { top: 0.08, bottom: 0.06 } },
      timeScale: { borderColor: 'rgba(45, 55, 97, 0.16)', timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 8 }, crosshair: { mode: CrosshairMode.Normal, vertLine: { color: 'rgba(45, 55, 97, 0.35)', labelBackgroundColor: '#2d3761' }, horzLine: { color: 'rgba(45, 55, 97, 0.35)', labelBackgroundColor: '#2d3761' } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false }, handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true } });
    const s = ch.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN, priceFormat: { type: 'custom', formatter: (v: number) => format(v), minMove: 1e-12 } });
    /* the volume in a pane of its own under the candles, so the price scale never counts below zero */
    const v = ch.addSeries(HistogramSeries, { priceFormat: { type: 'custom', formatter: (x: number) => (x > 0 ? `${fmtEth(x)} Ξ` : '0'), minMove: 1e-6 }, color: 'rgba(165, 150, 232, 0.55)', lastValueVisible: false, priceLineVisible: false }, 1);
    ch.applyOptions({ layout: { panes: { separatorColor: 'rgba(45, 55, 97, 0.12)', separatorHoverColor: 'rgba(45, 55, 97, 0.12)', enableResize: false } } });
    const panes = ch.panes(); if (panes[1]) { panes[0].setStretchFactor(4); panes[1].setStretchFactor(1); }
    ch.subscribeCrosshairMove(p => { const d = p.time ? (p.seriesData.get(s) as Candle | undefined) : undefined; if (d) { const r = rows.current.find(x => x[0] === (p.time as number)); hover.current = { ...d, volume: r ? r[5] : 0 }; setLegend(hover.current); } else { hover.current = null; setLegend(null); } });
    chart.current = ch; series.current = s; vol.current = v;
    return () => { ch.remove(); chart.current = null; series.current = null; vol.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* the formatter follows the mode */
  useEffect(() => { series.current?.applyOptions({ priceFormat: { type: 'custom', formatter: (v: number) => format(v), minMove: mode === 'mcap' && ethUsd ? 0.01 : 1e-12 } }); }, [format, mode, ethUsd]);

  /* data: the whole frame when it changes, then the tail every few seconds */
  useEffect(() => {
    let alive = true; const f = FRAME[tf]; let lastT = 0;
    const paint = (all: CandleRow[]) => { rows.current = fold(all, f.fold, f.seconds); const cs = rows.current.map(r => toCandle(r, k)); series.current?.setData(cs); vol.current?.setData(cs.map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(63, 174, 122, 0.45)' : 'rgba(232, 115, 143, 0.45)' }))); setCount(cs.length); if (!hover.current) setLegend(cs[cs.length - 1] || null); chart.current?.timeScale().fitContent(); };
    let raw: CandleRow[] = [];
    const load = async () => { try { const r = await api.candles(token, f.tf); if (!alive) return; raw = r.candles; lastT = raw.length ? raw[raw.length - 1][0] : 0; paint(raw); } catch { if (alive) setCount(0); } };
    const tail = async () => { try { const r = await api.candles(token, f.tf, lastT || 0); if (!alive || !r.candles.length) return; const byT = new Map(raw.map(x => [x[0], x] as const)); for (const row of r.candles) byT.set(row[0], row); raw = [...byT.values()].sort((a, b) => a[0] - b[0]); lastT = raw[raw.length - 1][0];
      const folded = fold(raw, f.fold, f.seconds); const changed = folded.slice(-2); rows.current = folded; for (const row of changed) { const c = toCandle(row, k); series.current?.update(c); vol.current?.update({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(63, 174, 122, 0.45)' : 'rgba(232, 115, 143, 0.45)' }); } setCount(folded.length); if (!hover.current) setLegend(toCandle(folded[folded.length - 1], k)); } catch {} };
    load(); const id = setInterval(tail, 5000); return () => { alive = false; clearInterval(id); };
  }, [token, tf, k]);

  const l = legend; const change = l && l.open > 0 ? (l.close - l.open) / l.open : 0;
  return (
    <div className="chartwrap">
      <div className="row between wrapRow chartbar">
        <div className="row tfs">{(Object.keys(FRAME) as Tf[]).map(x => <button key={x} className={`chip ${tf === x ? 'on' : ''}`} onClick={() => setTf(x)}>{x}</button>)}</div>
        <div className="row tfs">{ethUsd ? <button className={`chip ${mode === 'mcap' ? 'on' : ''}`} onClick={() => setMode('mcap')}>Market cap</button> : null}<button className={`chip ${mode === 'price' || !ethUsd ? 'on' : ''}`} onClick={() => setMode('price')}>Price</button></div>
      </div>
      <div className="legend mono small">
        {l ? <><b>${symbol}</b> · {tf} <span className="muted">O</span> {format(l.open)} <span className="muted">H</span> {format(l.high)} <span className="muted">L</span> {format(l.low)} <span className="muted">C</span> {format(l.close)} <span className={change >= 0 ? 'buy' : 'sell'}>{change >= 0 ? '+' : ''}{(change * 100).toFixed(2)}%</span> <span className="muted">Vol</span> {fmtVol(l.volume)}</> : count === 0 ? <span className="muted">No candles yet: the chart starts with the first trade.</span> : <span className="muted">loading the chart</span>}
      </div>
      <div ref={box} className="chartbox" />
    </div>
  );
}
