// The site in a real browser against the demo server: every page renders without a console error, the data shows, the launch form
// reacts, the mobile layout has no horizontal overflow. Needs a Chromium: CHROMIUM_PATH, Playwright's usual install, Chrome or Edge
// where they are normally installed, or a chromium on PATH. Without one the test says so and passes (the contracts, modules and deploy tests carry the logic).
process.env.HALCYON_NO_DOTENV = '1'; /* the tests never read a developer's .env */
import { spawn, spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 4198; const base = `http://127.0.0.1:${PORT}`;
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
const exe = findChromium();
if (!exe) { fs.writeSync(1, 'ui: no Chromium found (set CHROMIUM_PATH); skipped\n'); process.exit(0); }
let chromium; try { ({ chromium } = await import('playwright-core')); } catch { fs.writeSync(1, 'ui: playwright-core is not installed; skipped\n'); process.exit(0); }

/* the seed's routed stocks: the demo lists them as ready, and their number is the operator's (a `bake` adds the routes `catch` found) */
const SEED_ROWS = JSON.parse(fs.readFileSync(new URL('../eth/stocks-seed.json', import.meta.url), 'utf8'))['1'] || [];
const isRouted = r => (Array.isArray(r.path) && r.path.length >= 3) || (r.v4 && Array.isArray(r.v4.hops) && r.v4.hops.length > 0);
const READY = SEED_ROWS.filter(isRouted).length; /* the demo allows every routed stock (and three unrouted ones, which stay "no route yet") */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-ui-'));
/* the demo with Aurora Lamps as the platform's coin and Marmalade hidden by the operator (the demo's token addresses are fixed: keccak of halcyon-demo-token-<symbol>) */
const LAMP_TOKEN = '0x3a228d5a2d4192cf790b735974f326e70e34a024', MARM_TOKEN = '0x4b6e2812d6971133b1fc3bbc145b9791bc516059';
const server = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, HALCYON_DEMO: '1', PORT: String(PORT), DATA_DIR: tmp, HALCYON_PLATFORM_COIN: LAMP_TOKEN, HALCYON_HIDDEN_COINS: MARM_TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; server.stdout.on('data', d => { out += d; }); server.stderr.on('data', d => { out += d; });
let passed = 0; const ok = (cond, what) => { if (!cond) throw new Error(`FAILED: ${what}`); passed++; console.log(`ok ${what}`); };
let browser;
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); if (i === 59) throw new Error(`server did not start:\n${out}`); }
  if (!fs.existsSync(new URL('../dist/index.html', import.meta.url))) { console.log('ui: no dist/, building the site first'); const b = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), 'build'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 300_000 }); if (b.status !== 0) throw new Error(`vite build failed:\n${b.stdout}\n${b.stderr}`); }
  browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 900 } }); const page = await ctx.newPage();
  const errors = []; let expect404 = false; page.on('pageerror', e => errors.push(`pageerror ${e.message}`)); page.on('console', m => { if (m.type() === 'error' && !(expect404 && /404/.test(m.text())) && !/Failed to load resource: net::ERR_/.test(m.text())) errors.push(`console ${m.text()}`); }); /* a stock logo from the issuer's CDN may not load where there is no internet */
  const go = async p => { await page.goto(`${base}${p}`, { waitUntil: 'networkidle' }); await page.waitForTimeout(300); };
  const text = async sel => (await page.locator(sel).first().textContent()) || '';

  await go('/');
  ok((await page.title()).includes('Halcyon') && (await text('h1')).trim() === 'Halcyon' && /1% fee goes where you decide/.test(await text('.hero .tagline')) && (await page.locator('.hero p').count()) === 1, 'home: the hero is the mark, the name and one line');
  { const box = await page.locator('.hero').boundingBox(); ok(box && box.height < 480 && box.height > 300 && (await page.locator('.hero .inner .btn').count()) === 2, `home: the hero is slim (${Math.round(box?.height || 0)}px) with two buttons`); }
  ok((await page.locator('.kpi .k').count()) === 4 && !/skeleton/.test(await page.locator('.kpi').innerHTML()), 'home: the four KPIs are filled');
  ok((await page.locator('.modulecard').count()) === 0 && (await page.locator('h2').count()) === 1, 'home: no explanations, only the hero, the numbers and the coins');
  ok((await page.locator('a.coin').count()) === 6 && (await page.locator('a.coin img.avatar').count()) === 6, 'home: six demo coins with their pictures');
  ok(await page.locator('svg.scene').isVisible() && (await page.locator('svg.scene .cloud').count()) === 6, 'home: the scene is drawn');
  ok((await page.locator('footer a[href="https://halcyon.cash"]').count()) === 1 && (await page.locator('footer a[href="https://x.com/halcyoncash"]').count()) === 1, 'footer: halcyon.cash and @halcyoncash');

  await go('/coins');
  ok((await text('h1')) === 'Coins' && (await page.locator('a.coin').count()) === 9 && (await page.locator('.coinshead .field').count()) === 3 && (await page.locator('.pager').count()) === 0, 'coins: nine cards under a slim header, no pager for one page');
  ok((await page.locator('a.coin .pair').count()) === 9 && (await page.locator('a.coin .chip.new').count()) === 1 && (await page.locator('a.coin:has(.chip.new)').textContent()).includes('Paper Boat'), 'coins: every card wears its pair\'s mark, the coin launched minutes ago wears new');
  ok((await page.locator('a.coin').first().textContent()).includes('Aurora Lamps') && (await page.locator('a.coin').first().locator('.tag:has-text("official")').count()) === 1 && (await page.locator('a.coin .tag:has-text("official")').count()) === 1, 'coins: the platform\'s coin comes first and wears the official chip, alone');
  ok((await page.locator('a.coin .tag:has-text("v4 rules")').count()) === 5 && (await page.locator('a.coin .tag:has-text("opening")').count()) === 1 && (await page.locator('a.coin .tag:has-text("Mist")').count()) === 1, 'coins: the pool tags, one coin in its opening window, one in the mist');
  await page.fill('input[placeholder^="Search"]', 'king'); await page.waitForTimeout(200);
  ok((await page.locator('a.coin').count()) === 1 && (await text('a.coin')).includes('Kingfisher'), 'coins: search narrows to Kingfisher');
  await page.fill('input[placeholder^="Search"]', 'zzzz'); await page.waitForTimeout(200);
  ok((await page.locator('a.coin').count()) === 0 && (await page.locator('.empty').count()) === 1, 'coins: no match shows the empty state');

  const coins = (await (await fetch(`${base}/api/coins`)).json()).coins; const by = sym => coins.find(c => c.symbol === sym); const king = by('KING');
  await go(`/c/${king.token}`);
  ok((await text('h1')).includes('Kingfisher') && (await page.locator('text=Uniswap v4 · rules pool').count()) > 0, 'coin: a rules coin shows its v4 pool card');
  ok((await page.locator('text=Rain module').count()) > 0 && (await page.locator('text=/to \\d+ holders/').count()) >= 1, 'coin: the rain module lists its payouts');
  await page.click('.tab:has-text("Trades")'); await page.waitForTimeout(200); ok((await page.locator('.feed .t').count()) > 10 && (await page.locator('.feed .t:has-text("3% fee")').count()) > 0, 'coin: trades are listed under their tab, sells show their 3% fee'); await page.click('.tab:has-text("Rain")'); await page.waitForTimeout(200);
  ok(!(await page.content()).includes('e-5') && !(await page.content()).includes('e-6'), 'coin: no scientific notation on the page');
  ok((await page.locator('text=/\\$0\\.0[₀-₉]+\\d+/').count()) > 0, 'coin: a tiny price is shown with subscript zeros');
  ok((await page.locator('.chartbox canvas').count()) >= 1 && /O .* H .* L .* C .*Vol/.test(await page.locator('.legend').textContent()) && (await page.locator('.chip.on:has-text("5m")').count()) === 1, 'coin: the candle chart is drawn with its legend, five minutes by default');
  await page.click('.tfs .chip:has-text("1D")'); await page.waitForTimeout(500); ok((await page.locator('.chip.on:has-text("1D")').count()) === 1 && /1D/.test(await page.locator('.legend').textContent()), 'coin: the frame switches to days');
  await page.click('.tfs .chip:has-text("Price")'); await page.waitForTimeout(400); ok(/ETH/.test(await page.locator('.legend').textContent()) && !/\$/.test((await page.locator('.legend').textContent()).replace(/^\$[A-Z]+/, '')), 'coin: the price mode shows ETH a coin');
  await page.click('.tfs .chip:has-text("5m")'); await page.click('.tfs .chip:has-text("Market cap")'); await page.waitForTimeout(300);
  ok((await page.locator('.tabs .tab').count()) === 3 && (await page.locator('.tab.on:has-text("Rain")').count()) === 1 && (await page.locator('.tabpane table.tbl').count()) === 1, 'coin: the module, trades and burns share one card, the module first');
  await page.click('.tab:has-text("Trades")'); await page.waitForTimeout(200); ok((await page.locator('.tabpane .feed .t').count()) >= 10 && (await page.locator('.tabpane table.tbl').count()) === 0, 'coin: the trades tab shows the feed alone');
  await page.click('.tab:has-text("Burns")'); await page.waitForTimeout(200); ok(/Nothing burned yet|burned/.test(await page.locator('.tabpane').textContent()), 'coin: the burns tab');
  await go(`/c/${by('BOAT').token}`);
  ok((await page.locator('.opening').count()) === 1 && /Opening rules hold for \d+m/.test(await text('.opening')) && /buy fee now \d+/.test(await text('.opening')), 'coin: a coin in its window shows the opening countdown and the fee now');
  ok((await page.locator('button:has-text("Demo: trading is off")').count()) === 1, 'coin: the demo trade button');
  await page.fill('.trade .amount input', '0.01'); await page.waitForTimeout(600);
  ok(/You receive/.test(await text('.trade')) && /\(opening\)/.test(await text('.trade')), 'coin: a quote with the opening fee');
  await go(`/c/${by('BCG').token}`);
  ok((await page.locator('text=Harvest module').count()) > 0 && (await page.locator('text=NVDAon').count()) > 0, 'coin: the harvest module names its stock');
  await go(`/c/${by('LUCK').token}`);
  ok((await page.locator('text=A draw is open').count()) === 1 && (await page.locator('text=/drawn by block \\d+/').count()) >= 1, 'coin: the clover coin shows the open draw and past winners');
  await go(`/c/${by('TRIO').token}`);
  ok((await page.locator('.tbl tbody tr').count()) >= 3 && (await page.locator('text=50%').count()) >= 1, 'coin: the split lists its shares');
  await go(`/c/${by('GEM').token}`);
  ok((await page.locator('text=/held \\d+[dhm]/').count()) >= 1, 'coin: rings holders show how long they have held');
  const mist = by('MIST'); await go(`/c/${mist.token}`);
  ok((await text('h1')).includes('Lake Mist') && (await page.locator('.coinhead .tag:has-text("Mist")').count()) === 1 && (await page.locator('text=Mist module').count()) > 0, 'coin: a mist coin shows its tag and module');
  ok(/\d+ of \d+ holders carry a mist key/.test(await page.locator('.help').first().textContent()) && (await page.locator('text=/sown as \\d+ private notes/').count()) >= 3 && (await page.locator('text=/without a mist key, in the open/').count()) >= 3, 'coin: mist rounds are listed as notes, the keyless in the open');
  ok((await page.locator('table.tbl td:has-text("mist key")').count()) >= 2, 'coin: keyed holders are marked');
  expect404 = true; await go('/c/0x0000000000000000000000000000000000000001'); expect404 = false;
  ok((await page.locator('text=/No coin at that address/').count()) > 0, 'coin: an unknown address says so');

  await go(`/c/${MARM_TOKEN}`);
  ok((await text('h1')).includes('Marmalade') && (await page.locator('h1 .tag:has-text("hidden")').count()) === 1 && (await page.locator('.notice:has-text("kept out of the lists")').count()) === 1, 'coin: a hidden coin still has its page, with the notice');
  await go(`/c/${LAMP_TOKEN}`);
  ok((await page.locator('h1 .tag:has-text("official")').count()) === 1 && (await page.locator('.notice').count()) === 0, 'coin: the platform\'s coin wears the official chip');

  await go('/launch');
  ok((await text('h1')) === 'Launch a coin' && (await page.locator('text=Still needed').count()) === 1, 'launch: the summary asks for what is missing');
  await page.fill('input[placeholder="TICKER"]', 'LAMP'); await page.waitForTimeout(900);
  ok((await page.locator('.help.taken').count()) === 1 && /taken by Aurora Lamps, the platform's own coin/.test(await page.locator('.help.taken').textContent()), 'launch: a symbol the platform\'s coin wears is said to be taken');
  await page.fill('input[placeholder="TICKER"]', 'KING'); await page.waitForTimeout(900);
  ok(/taken by Kingfisher: yours would be a second one/.test(await page.locator('.help.taken').textContent()), 'launch: a symbol another coin wears is said to be taken');
  await page.fill('input[placeholder="TICKER"]', 'ZZQ'); await page.waitForTimeout(900);
  ok((await page.locator('.help.taken').count()) === 0, 'launch: a free symbol says nothing');
  await page.fill('input[placeholder="The coin\'s name"]', 'Test Coin'); await page.fill('input[placeholder="TICKER"]', 'TEST'); await page.waitForTimeout(200);
  ok((await page.locator('text=Still needed').count()) === 0 && (await page.locator('button:has-text("Demo: launching is off")').count()) === 1, 'launch: name and symbol satisfy the form; the demo refuses to launch');
  await page.click('button:has-text("$7,000")'); await page.waitForTimeout(100);
  ok((await page.locator('.summary').textContent()).includes('$7K'), 'launch: picking a cap updates the summary');
  ok((await page.locator('text=Opening fee on buys').count()) === 1, 'launch: the rules pool is the default and shows its rules');
  await page.click('button:has-text("Standard")'); await page.waitForTimeout(100); ok((await page.locator('text=Opening fee on buys').count()) === 0 && (await page.locator('.summary').textContent()).includes('(v3)'), 'launch: the standard pool hides the rules');
  await page.click('button:has-text("Rules")'); await page.click('button:has-text("80%")'); await page.waitForTimeout(100); ok((await page.locator('.summary').textContent()).includes('80% for'), 'launch: the opening fee is in the summary');
  await page.click('.choice.modules button:has-text("Harvest")'); await page.waitForTimeout(200);
  ok((await page.locator('.choice.stocks button').count()) === READY && (await page.locator('.choice.stocks button:has-text("NVDAon")').count()) === 1, `launch: the harvest module offers the ${READY} routed stocks`);
  await page.click('.choice.stocks button:has-text("NVDAon")'); await page.waitForTimeout(100); ok((await page.locator('text=Still needed').count()) === 0, 'launch: a picked stock satisfies the form');
  ok((await page.locator('.choice.modules button').count()) === 8, 'launch: eight modules to choose from');
  await page.click('.choice.modules button:has-text("Mist")'); await page.waitForTimeout(200); ok((await page.locator('text=Still needed').count()) === 0 && /Mist/.test(await text('.summary')), 'launch: the mist module needs nothing more');
  await page.click('.choice.modules button:has-text("Branch")'); await page.waitForTimeout(200);
  ok((await page.locator('text=Still needed').count()) === 1 && /Branch/.test(await text('.summary')), 'launch: the branch module asks for addresses');
  const inputs = page.locator('input[placeholder="0x…"]'); await inputs.nth(0).fill('0x1111111111111111111111111111111111111111'); await page.locator('input[placeholder="%"]').nth(0).fill('60'); await inputs.nth(1).fill('0x2222222222222222222222222222222222222222'); await page.locator('input[placeholder="%"]').nth(1).fill('40'); await page.waitForTimeout(200);
  ok((await page.locator('text=Still needed').count()) === 0 && (await page.locator('text=100% of 100').count()) === 1, 'launch: two addresses at 60/40 satisfy the branches');
  await page.fill('input[placeholder="0.0 ETH, optional"]', '0.1'); await page.waitForTimeout(200); ok(/of the supply/.test(await page.locator('.wizard').textContent()) && (await page.locator('.summary').textContent()).includes('0.1 ETH'), 'launch: the first buy is quoted');

  await go('/modules'); ok((await page.locator('section.modulecard').count()) === 8 && (await page.locator('h3:has-text("The opening fee")').count()) === 1 && /zero-knowledge proof/.test(await page.locator('section.modulecard').nth(7).textContent()) && (await page.locator('section.modulecard h2:has-text("Rings")').count()) === 1, 'modules: eight sections and the rules pool');
  await go('/stats');
  ok((await text('h1')) === 'All time' && (await page.locator('.kpi .k').count()) >= 16 && !/skeleton/.test(await page.locator('.kpi').first().innerHTML()) && /Since .* on Ethereum/.test(await page.locator('main > .row p').first().textContent()), 'stats: the all-time page with its tiles filled');
  ok((await page.locator('h2:has-text("Buybacks and burns")').count()) === 1 && (await page.locator('table.tbl tbody tr:has-text("Slow Tide")').count() ) === 1 && (await page.locator('h3:has-text("The latest burns")').count()) === 1 && (await page.locator('.feed .t:has-text("buyback by the gardener")').count()) >= 1 && (await page.locator('h2:has-text("Day by day")').count()) === 1 && (await page.locator('svg[aria-label="volume by day"] rect').count()) >= 5, 'stats: the burns table names the pruned coin, the latest burns are listed and the days are drawn');
  ok((await page.locator('.tag:has-text("prune · 1"), .tag:has-text("Prune · 1")').count()) === 1 && (await page.locator('text=/platform revenue/i').count()) === 1, 'stats: launches by module and the platform\'s share');
  await go('/'); ok(/all time/.test(await page.locator('.kpi').textContent()) && (await page.locator('a[href="/stats"]').count()) >= 2, 'home: the all-time volume beside the day\'s, and the way to the stats');
  await go('/stocks'); ok((await page.locator('table.tbl tbody tr').count()) >= 400 && (await page.locator('text=SPCXon').count()) > 0 && (await page.locator('.tag:has-text("ready")').count()) === READY && (await page.locator('.tag:has-text("waiting for a pool")').count()) >= SEED_ROWS.length - READY - 3, `stocks: the whole catalog, the ${READY} routed ones ready, the rest waiting for a pool`);
  await page.fill('input.field', 'gold'); await page.waitForTimeout(200); const goldRows = await page.locator('table.tbl tbody tr').count(); ok(goldRows >= 3 && goldRows < 20 && (await page.locator('text=GLDon').count()) === 1, `stocks: search narrows the list (${goldRows} for "gold")`);
  await page.fill('input.field', ''); await page.click('button:has-text("Commodities")'); await page.waitForTimeout(200); ok((await page.locator('table.tbl tbody tr').count()) === 14 && (await page.locator('.tag:has-text("commodity")').count()) === 14, 'stocks: the commodity filter shows the fourteen funds');
  await page.click('button:has-text("All")'); await page.click('button:has-text("ready to buy")'); await page.waitForTimeout(200); ok((await page.locator('table.tbl tbody tr').count()) === READY, `stocks: the ready filter shows the ${READY}`);
  await go('/docs'); ok((await text('h1')).includes('How Halcyon works') && (await page.locator('h2').count()) >= 7 && (await page.locator('text=Two pools').count()) === 1 && (await page.locator('h2#mist').count()) === 1 && (await page.locator('h2#gardener').count()) === 1, 'docs: the chapters, mist and the gardener among them');
  ok((await page.locator('text=This is the demo: sample coins').count()) === 1 && (await page.locator('h2#contracts').count()) === 1, 'docs: the demo says the live site lists the contracts');
  // a second server, not the demo: no RPC, but a deployment record for its chain, so the site knows the addresses and the docs list them with explorer links
  { const PORT2 = PORT + 1; const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-ui-live-')); fs.mkdirSync(path.join(tmp2, 'deployments'));
    const rec = { chainId: 1, chain: 'Ethereum', at: '2026-10-05T20:30:00.000Z', platform: '0x7dfa877468749898B9B8BA69FbB2BcaD68967304', launchpad: '0x7B618B3AE41E415cf4c5B16d16CCa53a39eb6ebC', fees: '0x5E2d61F8DF43c3822874265a5BA465bD9C817c0e', tokenImpl: '0x77CC56f66c6d9cDc4Cf99166b2843b0Bd51C4a15', locker: '0xC500AacF89e7b71603e548Ab30071b44D68b5F91', v4Locker: '0x971899de5a477d2454C182276d27c6ad4A428D65', hook: '0x313EA55aA2dF26138b1Df5CF04feF6Af030e98c0', swap: '0x0999bC1e733b6ED29d9b6372169168A000cd6F20', mist: '0x3720C2a9950Aefd5AaCCa9F1dA883CABda543E5b', poseidon: '0x1CF4111BD1cba48F5F30eFe566Bded99BdB294ff', verifier: '0x354B35ADA4E9D18077ab67b6c86bEDeeFf0DE15e', create2: '', deployBlock: 26128417, mistDenominations: ['10000000000000000', '100000000000000000', '1000000000000000000'] };
    fs.writeFileSync(path.join(tmp2, 'deployments', 'mainnet.json'), JSON.stringify(rec));
    const live = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, HALCYON_DEMO: '', HALCYON_NO_DOTENV: '1', ETH_RPC_URL: '', CHAIN_ID: '1', PORT: String(PORT2), DATA_DIR: tmp2, HALCYON_DEPLOYMENTS_DIR: path.join(tmp2, 'deployments') }, stdio: ['ignore', 'pipe', 'pipe'] }); let out2 = ''; live.stdout.on('data', d => { out2 += d; }); live.stderr.on('data', d => { out2 += d; });
    try {
      for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT2}/healthz`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 250)); if (i === 59) throw new Error(`live server did not start:\n${out2}`); }
      const cfg2 = await (await fetch(`http://127.0.0.1:${PORT2}/api/config`)).json();
      ok(cfg2.launchpad === rec.launchpad && cfg2.mist === rec.mist && cfg2.platform === rec.platform && cfg2.deployBlock === 26128417 && cfg2.deployment.verifier === rec.verifier && cfg2.ready === false && cfg2.demo === false, 'config: the addresses come from the deployment record when the environment does not set them');
      const page2 = await ctx.newPage(); await page2.goto(`http://127.0.0.1:${PORT2}/docs`, { waitUntil: 'networkidle' }); await page2.waitForTimeout(300);
      const rows = await page2.locator('h2#contracts ~ div table.tbl tbody tr').count(); const links = await page2.locator(`a[href="https://etherscan.io/address/${rec.fees}"]`).count();
      ok(rows === 10 && links === 1 && (await page2.locator('text=Deployed on Ethereum from block 26,128,417').count()) === 1 && (await page2.locator(`footer a[href="https://etherscan.io/address/${rec.launchpad}"]`).count()) === 1, `docs: the live site lists ten contracts with Etherscan links and the footer names the launchpad (${rows} rows, ${links} fees link)`);
      await page2.close();
    } finally { live.kill('SIGTERM'); fs.rmSync(tmp2, { recursive: true, force: true }); } }
  await go('/me'); ok((await page.locator('text=Connect a wallet to see').count()) === 1 && (await page.locator('text=create your mist key').count()) === 1, 'me: asks for a wallet, says what a mist key is for');
  await page.click('header button:has-text("Connect")'); await page.waitForTimeout(200);
  ok((await page.locator('.modal').count()) === 1 && (await page.locator('.modal').textContent()).includes('No wallet found'), 'wallet: the modal opens and says no wallet is installed');
  await page.click('.modal button:has-text("Close")');

  // a wallet that is hardhat's first published test account: it announces itself the EIP-6963 way and signs the mist sentence (the
  // signature is fixed, the demo's mist key derives from it), so the Me page can connect, unlock and find the demo's notes
  const { DEMO_MIST_SIGNATURE, DEMO_MIST_HOLDER } = await import('../eth/demo.mjs');
  const wctx = await browser.newContext({ viewport: { width: 1380, height: 900 } });
  await wctx.addInitScript(({ addr, sig }) => { const provider = { request: async ({ method }) => { if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr]; if (method === 'eth_chainId') return '0x1'; if (method === 'personal_sign') return sig; throw new Error(`fake wallet: ${method}`); }, on: () => {}, removeListener: () => {} }; const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'fake-1', name: 'Test wallet', icon: '', rdns: 'test.fake' }, provider } })); window.addEventListener('eip6963:requestProvider', announce); announce(); }, { addr: DEMO_MIST_HOLDER, sig: DEMO_MIST_SIGNATURE });
  const wp = await wctx.newPage(); const werrs = []; wp.on('pageerror', e => werrs.push(e.message)); wp.on('console', m => { if (m.type() === 'error' && !/503|Failed to load resource/.test(m.text())) werrs.push(m.text()); }); /* the demo has no chain: the relay answers 503 to balance reads, which the page takes as zero */
  await wp.goto(`${base}/me`, { waitUntil: 'networkidle' }); await wp.click('header button:has-text("Connect")'); await wp.waitForTimeout(200); await wp.click('.modal button:has-text("Test wallet")'); await wp.waitForTimeout(600);
  ok((await wp.locator('h1').textContent()).includes(DEMO_MIST_HOLDER.slice(0, 6)) && (await wp.locator('.mist .tag:has-text("key on chain")').count()) === 1 && (await wp.locator('.mist button:has-text("Unlock and find my notes")').count()) === 1, 'me: the test wallet connects, its mist key is on chain');
  ok((await wp.locator('text=$MIST').count()) >= 1, 'me: the wallet holds the mist coin');
  await wp.click('.mist button:has-text("Unlock and find my notes")'); await wp.waitForFunction(() => /notes are yours|No notes for you/.test(document.querySelector('.mist')?.textContent || ''), null, { timeout: 60_000 });
  const feed = (await (await fetch(`${base}/api/mist/notes`)).json()); const mistText = await wp.locator('.mist').textContent();
  ok(new RegExp(`${feed.total} notes are yours`).test(mistText) && (await wp.locator('.mist table tbody tr').count()) === Math.min(60, feed.total) && (await wp.locator('.mist table tbody tr button:has-text("Pick")').count()) === Math.min(60, feed.total), `me: the viewing key finds all ${feed.total} demo notes in the browser`);
  await wp.click('.mist table tbody tr button:has-text("Pick")'); await wp.waitForTimeout(200); ok((await wp.locator('.mist input[placeholder^="Send to"]').count()) === 1 && (await wp.locator('.mist button:has-text("Withdraw")').count()) === 1, 'me: a picked note asks where to send it');
  ok((await wp.locator('.mist button:has-text("Forget the keys in this tab")').count()) === 1, 'me: the keys can be forgotten');
  await wp.click('.mist button:has-text("Forget the keys in this tab")'); await wp.waitForTimeout(200); ok((await wp.locator('.mist button:has-text("Unlock and find my notes")').count()) === 1, 'me: forgotten keys ask for the signature again');
  ok(werrs.length === 0, `me: no page errors with the test wallet${werrs.length ? `: ${werrs.join(' | ')}` : ''}`);
  await wctx.close();
  // the same wallet on a phone: the header and the coupon table stay inside the screen
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mctx.addInitScript(({ addr, sig }) => { const provider = { request: async ({ method }) => { if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr]; if (method === 'eth_chainId') return '0x1'; if (method === 'personal_sign') return sig; throw new Error(`fake wallet: ${method}`); }, on: () => {}, removeListener: () => {} }; const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'fake-1', name: 'Test wallet', icon: '', rdns: 'test.fake' }, provider } })); window.addEventListener('eip6963:requestProvider', announce); announce(); }, { addr: DEMO_MIST_HOLDER, sig: DEMO_MIST_SIGNATURE });
  const mp = await mctx.newPage(); await mp.goto(`${base}/me`, { waitUntil: 'networkidle' }); await mp.click('header button:has-text("Connect")'); await mp.waitForTimeout(200); await mp.click('.modal button:has-text("Test wallet")'); await mp.waitForTimeout(600);
  await mp.click('.mist button:has-text("Unlock and find my notes")'); await mp.waitForFunction(() => /notes are yours/.test(document.querySelector('.mist')?.textContent || ''), null, { timeout: 60_000 });
  ok((await mp.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth))) <= 390, 'mobile /me with a wallet and the notes found: no horizontal overflow (390px)');
  await mctx.close();

  const mobile = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
  const merrs = []; mobile.on('pageerror', e => merrs.push(e.message));
  for (const p of ['/', '/coins', `/c/${king.token}`, `/c/${by('BOAT').token}`, `/c/${by('MIST').token}`, '/launch', '/stats', '/modules', '/stocks', '/me', '/docs']) { await mobile.goto(`${base}${p}`, { waitUntil: 'networkidle' }); await mobile.waitForTimeout(250); const w = await mobile.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)); ok(w <= 390 && merrs.length === 0, `mobile ${p}: no horizontal overflow (${w}px)`); }
  await mobile.goto(`${base}/`, { waitUntil: 'networkidle' }); ok(await mobile.locator('.burger').isVisible() && !(await mobile.locator('header nav').isVisible()), 'mobile: the menu is behind the burger'); await mobile.click('.burger'); ok(await mobile.locator('header nav.open').isVisible(), 'mobile: the burger opens the menu');

  ok(errors.length === 0, `no console or page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log(`\n${passed} ui checks passed`);
} catch (e) { console.error(e); process.exitCode = 1; } finally { try { await browser?.close(); } catch {} server.kill('SIGTERM'); fs.rmSync(tmp, { recursive: true, force: true }); }
