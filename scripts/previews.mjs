// The repository's previews, 21:9 at 2520x1080: the banner (the brand card with the way of a fee) and three screens of the demo site,
// written to docs/brand/. Needs a Chromium like the browser test does (CHROMIUM_PATH, Playwright's usual install, Chrome or Edge where
// they are normally installed) and a built site (npm run build); starts the demo server on a spare port and stops it.
//   node scripts/previews.mjs [--only banner,coin,coins,stats]
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)); const out = path.join(root, 'docs', 'brand'); fs.mkdirSync(out, { recursive: true });
const only = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? new Set(String(process.argv[i + 1] || '').split(',')) : null; })();
const want = name => !only || only.has(name);
const say = m => fs.writeSync(1, `${m}\n`); const fail = m => { fs.writeSync(2, `${m}\n`); process.exit(2); };

function findChromium() {
  const cands = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium'];
  for (const dir of [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache/ms-playwright'), path.join(os.homedir(), 'AppData/Local/ms-playwright')].filter(Boolean)) {
    try { for (const d of fs.readdirSync(dir)) { if (!/^chromium-\d+$/.test(d)) continue; for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-win/chrome.exe', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) cands.push(path.join(dir, d, rel)); } } catch {}
  }
  if (process.platform === 'win32') { const pf = process.env['ProgramFiles'] || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', local = process.env.LOCALAPPDATA || ''; for (const d of [pf, pf86, local]) cands.push(path.join(d, 'Google/Chrome/Application/chrome.exe'), path.join(d, 'Microsoft/Edge/Application/msedge.exe'), path.join(d, 'Chromium/Application/chrome.exe')); }
  else if (process.platform === 'darwin') cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  else for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) { try { cands.push(execSync(`which ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch {} }
  return cands.find(c => c && fs.existsSync(c) && fs.statSync(c).isFile());
}
const exe = findChromium(); if (!exe) fail('no Chromium found (set CHROMIUM_PATH)');
let chromium; try { ({ chromium } = await import('playwright-core')); } catch { fail('playwright-core is not installed (npm ci)'); }
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) fail('no dist/: npm run build first');

// --- the banner: the brand card, fonts from the packages the site serves ---
const F = pathToFileURL(path.join(root, 'node_modules')).href;
const css = `
@font-face { font-family: 'Fraunces'; src: url('${F}/@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2') format('woff2'); font-weight: 100 900; }
@font-face { font-family: 'DM Sans'; src: url('${F}/@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2') format('woff2'); font-weight: 100 1000; }
@font-face { font-family: 'Space Mono'; src: url('${F}/@fontsource/space-mono/files/space-mono-latin-400-normal.woff2') format('woff2'); font-weight: 400; }
@font-face { font-family: 'Space Mono'; src: url('${F}/@fontsource/space-mono/files/space-mono-latin-700-normal.woff2') format('woff2'); font-weight: 700; }
:root { --sky:#dcecf7; --sky-2:#f3dcea; --mint:#d3efe1; --lav:#dcd6f6; --peach:#fde3cc; --butter:#f9efc2; --ink:#2d3761; --ink-2:#5a6391; --ink-3:#8d93b6; --paper:#fbfaf6; --card:rgba(255,255,255,.82); --line:rgba(74,84,134,.22); }
* { box-sizing: border-box; } html, body { margin: 0; }
body { width: 1680px; height: 720px; overflow: hidden; font-family: 'DM Sans', sans-serif; color: var(--ink); background: var(--paper) linear-gradient(180deg, var(--sky) 0, #f6eef5 420px, var(--paper) 720px) no-repeat; }
.card { position: absolute; inset: 0; padding: 52px 64px 44px; display: grid; grid-template-columns: 600px 1fr; gap: 56px; align-items: center; }
.wordmark { display: inline-flex; align-items: center; gap: 12px; font-family: 'Space Mono', monospace; font-weight: 700; font-size: 32px; letter-spacing: -0.03em; }
.wordmark small { font-family: 'DM Sans', sans-serif; font-weight: 500; font-size: 19px; color: var(--ink-2); margin-left: -4px; }
h1 { font-family: 'Fraunces', Georgia, serif; font-weight: 500; letter-spacing: -0.014em; line-height: 1.04; margin: 30px 0 20px; font-size: 72px; font-variation-settings: 'SOFT' 80, 'WONK' 0, 'opsz' 72; }
h1 em { font-style: italic; font-variation-settings: 'SOFT' 100, 'WONK' 1, 'opsz' 72; }
p { margin: 0 0 10px; color: var(--ink-2); font-size: 23.5px; line-height: 1.42; } p b { color: var(--ink); font-weight: 600; }
.url { font-family: 'Space Mono', monospace; font-size: 20px; color: var(--ink); margin-top: 22px; line-height: 1.6; }
.flow { background: var(--card); border: 1.5px solid var(--line); border-radius: 24px; box-shadow: 0 14px 40px rgba(45,55,97,.10); padding: 28px 30px; height: 624px; display: flex; flex-direction: column; justify-content: space-between; }
.row { display: flex; align-items: center; gap: 14px; }
.step { background: #fff; border: 1.5px solid var(--line); border-radius: 16px; padding: 14px 18px; flex: 1; min-width: 0; } .step b { display: block; font-family: 'Fraunces', serif; font-weight: 500; font-size: 22px; margin-bottom: 3px; } .step span { font-size: 15px; color: var(--ink-2); line-height: 1.3; display: block; }
.arrow { font-family: 'Space Mono', monospace; font-size: 26px; color: var(--ink-3); flex: 0 0 auto; }
.split { display: grid; grid-template-columns: 1fr 3.4fr; gap: 14px; }
.pot { border-radius: 16px; padding: 14px 18px; border: 1.5px solid var(--line); } .pot b { font-family: 'Space Mono', monospace; font-size: 30px; font-weight: 700; letter-spacing: -0.02em; display: block; } .pot span { font-size: 15px; color: var(--ink-2); }
.pot.platform { background: var(--butter); } .pot.module { background: var(--mint); }
.mods { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.mod { background: #fff; border: 1.5px solid var(--line); border-radius: 14px; padding: 10px 12px; } .mod i { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; vertical-align: -1px; border: 1.5px solid var(--ink); } .mod b { font-size: 16px; } .mod span { display: block; font-size: 13px; color: var(--ink-2); margin-top: 3px; line-height: 1.25; }
.foot { display: flex; justify-content: space-between; align-items: center; font-family: 'Space Mono', monospace; font-size: 14.5px; color: var(--ink-2); } .foot b { color: var(--ink); font-weight: 700; }
.tag { display: inline-block; border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; background: var(--lav); margin-right: 6px; }
`;
const mark = (s = 42) => `<svg width="${s}" height="${s}" viewBox="0 0 40 40" aria-hidden="true"><defs><linearGradient id="mk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3d1"/><stop offset=".5" stop-color="#f6c9e0"/><stop offset="1" stop-color="#a9d4f3"/></linearGradient></defs><path d="M20 3 L33 18 L20 33 L7 18 Z" fill="url(#mk)" stroke="#2d3761" stroke-width="2" stroke-linejoin="round"/><path d="M20 3 L20 33 M7 18 L33 18" stroke="#2d3761" stroke-width="1" opacity=".5"/><path d="M6 37 q 7 -5 14 0 q 7 5 14 0" fill="none" stroke="#2d3761" stroke-width="2" stroke-linecap="round"/></svg>`;
const mods = [['#f9efc2', 'Roots', 'pushed to the creator'], ['#d3efe1', 'Rain', 'rained on holders in ETH'], ['#fde3cc', 'Prune', 'bought back and burned'], ['#dcd6f6', 'Harvest', 'stocks paid to holders'], ['#dcecf7', 'Branch', 'split up to eight ways'], ['#f3dcea', 'Clover', 'one holder a round, by block hash'], ['#2d3761', 'Rings', 'weighted by days held'], ['#ffffff', 'Mist', 'private notes, zero knowledge']];
const banner = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="card">
<div><span class="wordmark">${mark()}halcyon<small>eth</small></span>
<h1>The <em>calm</em> Ethereum launchpad.</h1>
<p>One transaction makes a coin and its locked Uniswap pool. Every trade pays the pool's 1%, and <b>the creator aims it</b>: to themselves, to holders, to a buyback, to a stock, to private notes proven in zero knowledge.</p>
<p>No owner, no mint, no pause. Eleven contracts, one circuit, one server, open source.</p>
<div class="url">halcyon.cash<br>github.com/HALCYONCASH/HALCYONZK</div></div>
<div class="flow">
  <div class="row"><div class="step"><b>launch</b><span>one transaction: the coin, 1B units, all of it in the pool at a cap in dollars (Chainlink)</span></div><span class="arrow">&#8594;</span><div class="step"><b>the pool</b><span>Uniswap v3, or v4 with the Halcyon hook's rules; the position locked forever</span></div><span class="arrow">&#8594;</span><div class="step"><b>1% on every trade</b><span>the whole fee is the coin's: the gardener collects it, every minute, in bounds</span></div></div>
  <div class="split"><div class="pot platform"><b>20%</b><span>the platform and the gardener's gas</span></div><div class="pot module"><b>80%</b><span>where the creator aimed it, switchable any time, through one of eight modules:</span></div></div>
  <div class="mods">${mods.map(([c, n, d]) => `<div class="mod"><i style="background:${c}"></i><b>${n}</b><span>${d}</span></div>`).join('')}</div>
  <div class="foot"><span><span class="tag">mainnet</span>since 5 Oct 2026 · launchpad <b>0x7B61…6ebC</b></span><span>$HALCYON <b>0x98ec…ce88</b></span></div>
</div></div></body></html>`;

// --- the demo server on a spare port, with an official coin and a hidden one like the browser test ---
const PORT = 4197; const base = `http://127.0.0.1:${PORT}`; const data = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-previews-'));
const server = spawn(process.execPath, ['server.mjs', '--demo'], { cwd: root, env: { ...process.env, PORT: String(PORT), HALCYON_NO_DOTENV: '1', DATA_DIR: data, HALCYON_PLATFORM_COIN: '0x3a228d5a2d4192cf790b735974f326e70e34a024', HALCYON_HIDDEN_COINS: '0x4b6e2812d6971133b1fc3bbc145b9791bc516059' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', d => { log += d; }); server.stderr.on('data', d => { log += d; });
const stop = () => { try { server.kill('SIGTERM'); } catch {} try { fs.rmSync(data, { recursive: true, force: true }); } catch {} };
process.on('exit', stop);
try {
  for (let i = 0; i < 100; i++) { try { await fetch(`${base}/healthz`); break; } catch { await new Promise(r => setTimeout(r, 300)); } if (i === 99) fail(`the demo server did not start:\n${log}`); }
  const { coins } = await (await fetch(`${base}/api/coins`)).json(); const tide = coins.find(c => c.symbol === 'TIDE') || coins[0];
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const pg = await (await browser.newContext({ viewport: { width: 1680, height: 720 }, deviceScaleFactor: 1.5 })).newPage();
  if (want('banner')) { const file = path.join(data, 'banner.html'); fs.writeFileSync(file, banner); await pg.goto(pathToFileURL(file).href); await pg.waitForTimeout(400); await pg.evaluate(() => document.fonts.ready); await pg.screenshot({ path: path.join(out, 'banner.png') }); say('docs/brand/banner.png'); }
  for (const [name, route] of [['coin', `/c/${tide.token}`], ['coins', '/coins'], ['stats', '/stats']]) {
    if (!want(name)) continue;
    await pg.goto(`${base}${route}`, { waitUntil: 'networkidle' }); await pg.waitForTimeout(1500); await pg.evaluate(() => document.fonts.ready);
    if (name === 'coin') { /* scrolled to the chart, under the sticky header */ await pg.waitForSelector('canvas', { timeout: 10_000 }).catch(() => {}); await pg.waitForTimeout(800); await pg.evaluate(() => { const c = document.querySelector('canvas'); const card = c && (c.closest('.card') || c.parentElement); const h = document.querySelector('header'); const top = h ? h.getBoundingClientRect().height : 72; if (card) window.scrollTo(0, card.getBoundingClientRect().top + window.scrollY - top - 18); }); await pg.waitForTimeout(600); }
    await pg.screenshot({ path: path.join(out, `${name}.png`) }); say(`docs/brand/${name}.png  (${route})`);
  }
  await browser.close();
} finally { stop(); }
