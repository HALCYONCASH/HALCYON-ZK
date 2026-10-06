// Halcyon's configuration: every knob is an environment variable, read once. Addresses are the deployment's (scripts/deploy.mjs prints
// them); the gardener key is env only and never leaves this process. Nothing here touches the network.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const env = (k, d = '') => { const v = process.env[k]; return v === undefined || v === null || String(v).trim() === '' ? d : String(v).trim(); };
const flag = (k, d = false) => { const v = env(k, d ? '1' : '0').toLowerCase(); return v === '1' || v === 'true' || v === 'yes' || v === 'on'; };
/**
 * `.env` in the project root is read when it exists, so the server and the scripts see the same settings on a laptop as on a host
 * that sets them in its dashboard. A key already in the environment wins; HALCYON_NO_DOTENV=1 skips the file (the tests set it).
 */
(function loadDotenv() {
  if (flag('HALCYON_NO_DOTENV')) return;
  let text; try { text = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); if (!m) continue;
    let v = m[2]; if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1); else { const i = v.search(/\s#/); if (i >= 0) v = v.slice(0, i); v = v.trim(); }
    if (process.env[m[1]] === undefined || String(process.env[m[1]]).trim() === '') process.env[m[1]] = v;
  }
})();

/**
 * The chains Halcyon knows, with Uniswap's own deployments (from Uniswap's sdk-core address book) and Chainlink's ETH/USD feed.
 * The launchpad is one deployment per chain; `CHAIN_ID` picks it. Sepolia's v4 addresses are the ones the SDK lists today; Uniswap has
 * said it may redeploy v4 there, so check them against docs.uniswap.org before a Sepolia deploy.
 */
export const CHAINS = {
  1: { id: 1, name: 'Ethereum', short: 'mainnet', explorer: 'https://etherscan.io', blockSeconds: 12, ethUsdFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', v4FromBlock: 21_600_000, /* the PoolManager went live in late January 2025; a scan of its Initialize log starts here */
    uniswap: { weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', v3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', nfpm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88', swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90', universalRouter: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af', stateView: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227', v4Quoter: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203', usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' } },
  11155111: { id: 11155111, name: 'Sepolia', short: 'sepolia', explorer: 'https://sepolia.etherscan.io', blockSeconds: 12, ethUsdFeed: '0x694AA1769357215DE4FAC081bf1f309aDC325306', v4FromBlock: 7_000_000,
    uniswap: { weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', v3Factory: '0x0227628f3F023bb0B980b67D528571c95c6DaC1c', nfpm: '0x1238536071E1c677A632429e3655c799b22cDA52', swapRouter02: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E', quoterV2: '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3', poolManager: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543', universalRouter: '0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b', stateView: '0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c', v4Quoter: '0x61b3f2011a92d183c7dbadbda940a7555ccf9227', usdc: '' } },
  31337: { id: 31337, name: 'Local', short: 'local', explorer: '', blockSeconds: 1, ethUsdFeed: '', v4FromBlock: 0, uniswap: { weth: '', v3Factory: '', nfpm: '', swapRouter02: '', quoterV2: '', poolManager: '', universalRouter: '', stateView: '', v4Quoter: '', usdc: '' } },
};
// A chain's addresses can be overridden from the environment (a local chain, or a testnet whose addresses moved): the override wins.
{
  const id = Number(env('CHAIN_ID', '1'));
  for (const [k, key] of [['HALCYON_UNISWAP_WETH', 'weth'], ['HALCYON_UNISWAP_V3_FACTORY', 'v3Factory'], ['HALCYON_UNISWAP_NFPM', 'nfpm'], ['HALCYON_UNISWAP_SWAPROUTER02', 'swapRouter02'], ['HALCYON_UNISWAP_QUOTERV2', 'quoterV2'], ['HALCYON_UNISWAP_POOLMANAGER', 'poolManager'], ['HALCYON_UNISWAP_UNIVERSALROUTER', 'universalRouter'], ['HALCYON_UNISWAP_STATEVIEW', 'stateView'], ['HALCYON_UNISWAP_V4QUOTER', 'v4Quoter'], ['HALCYON_USDC', 'usdc']]) {
    const v = env(k); if (!v) continue; if (!CHAINS[id]) CHAINS[id] = { id, name: `chain ${id}`, short: String(id), explorer: '', blockSeconds: 12, ethUsdFeed: '', uniswap: { weth: '', v3Factory: '', nfpm: '', swapRouter02: '', quoterV2: '', poolManager: '', universalRouter: '', stateView: '', v4Quoter: '', usdc: '' } }; CHAINS[id].uniswap[key] = v;
  }
  if (env('HALCYON_ETH_USD_FEED') && CHAINS[id]) CHAINS[id].ethUsdFeed = env('HALCYON_ETH_USD_FEED');
  if (env('HALCYON_V4_FROM_BLOCK') && CHAINS[id]) CHAINS[id].v4FromBlock = Number(env('HALCYON_V4_FROM_BLOCK'));
}

export const CONFIG = {
  demo: flag('HALCYON_DEMO') || process.argv.includes('--demo'),
  port: Number(env('PORT', '4180')),
  publicBase: env('PUBLIC_BASE_URL', ''),
  dataDir: path.resolve(env('DATA_DIR', '.data')),
  chainId: Number(env('CHAIN_ID', '1')),
  rpcUrls: env('ETH_RPC_URL').split(',').map(s => s.trim()).filter(Boolean),
  launchpad: env('HALCYON_LAUNCHPAD'),
  fees: env('HALCYON_FEES'),
  tokenImpl: env('HALCYON_TOKEN_IMPL'),
  locker: env('HALCYON_LOCKER'),
  v4Locker: env('HALCYON_V4_LOCKER'),
  hook: env('HALCYON_HOOK'),
  swap: env('HALCYON_SWAP'),
  mist: env('HALCYON_MIST'),
  deployBlock: Number(env('HALCYON_DEPLOY_BLOCK', '0')),
  platform: env('HALCYON_PLATFORM'),
  gardenerKey: env('HALCYON_GARDENER_KEY'),
  gardenerEnabled: flag('HALCYON_GARDENER_ENABLED'),
  gardenerIntervalMs: Number(env('HALCYON_GARDENER_INTERVAL_MS', '60000')),
  indexIntervalMs: Number(env('HALCYON_INDEX_INTERVAL_MS', '8000')),
  confirmations: Number(env('HALCYON_CONFIRMATIONS', '2')),
  /** the gardener's thresholds: collect a coin's fees when they are worth at least this much ETH; pay a pot when it holds at least this much */
  collectMinEth: env('HALCYON_COLLECT_MIN_ETH', '0.02'),
  payoutMinEth: env('HALCYON_PAYOUT_MIN_ETH', '0.05'),
  payoutMinShareEth: env('HALCYON_PAYOUT_MIN_SHARE_ETH', '0.0003'),
  payoutBatch: Number(env('HALCYON_PAYOUT_BATCH', '120')),
  stockMaxBuyEth: env('HALCYON_STOCK_MAX_BUY_ETH', '1'),
  /** Mist: at most this many notes in a round (the pool takes 64 a batch); the relayer's fee over its gas, in percent */
  mistMaxNotes: Number(env('HALCYON_MIST_MAX_NOTES', '64')),
  mistRelayMarginPct: Number(env('HALCYON_MIST_RELAY_MARGIN_PCT', '20')),
  slippageBps: Number(env('HALCYON_GARDENER_SLIPPAGE_BPS', '150')),
  gasCapGwei: Number(env('HALCYON_GAS_CAP_GWEI', '30')),
  /** the least priority fee the gardener's transactions carry, in gwei (the node's estimate when it is higher) */
  gardenerTipGwei: env('HALCYON_GARDENER_TIP_GWEI', '0.1'),
  /** the platform's own coin, by token address: shown as official, first in the lists; a coin with its name or its symbol is marked a lookalike */
  platformCoin: env('HALCYON_PLATFORM_COIN').toLowerCase(),
  /** coins the operator keeps out of the lists, the search and the numbers (token addresses, comma separated); their pages still open, with a notice */
  hiddenCoins: env('HALCYON_HIDDEN_COINS').split(/[\s,]+/).map(a => a.toLowerCase()).filter(a => /^0x[0-9a-f]{40}$/.test(a)),
  siteName: env('HALCYON_SITE_NAME', 'Halcyon'),
  siteUrl: env('HALCYON_SITE_URL', 'https://halcyon.cash'),
  xHandle: env('HALCYON_X', 'halcyoncash'),
  sourceUrl: env('HALCYON_SOURCE_URL', 'https://github.com/HALCYONCASH/HALCYONZK'), /* the footer's Source link; a fork sets its own */
};
export const chainInfo = () => CHAINS[CONFIG.chainId] || { ...CHAINS[1], id: CONFIG.chainId, name: `chain ${CONFIG.chainId}`, short: String(CONFIG.chainId) };
/**
 * The deployment record scripts/deploy.mjs wrote for this chain (deployments/<chain>.json, or under HALCYON_DEPLOYMENTS_DIR), when there is
 * one: the addresses the environment does not set come from it, so a host needs only the RPC and the gardener's key. The demo takes nothing
 * from it. Null when there is no record.
 */
export const DEPLOYMENT = (() => {
  if (CONFIG.demo) return null;
  const short = (CHAINS[CONFIG.chainId] || {}).short || String(CONFIG.chainId);
  const file = env('HALCYON_DEPLOYMENTS_DIR') ? path.join(path.resolve(env('HALCYON_DEPLOYMENTS_DIR')), `${short}.json`) : fileURLToPath(new URL(`../deployments/${short}.json`, import.meta.url));
  try { const rec = JSON.parse(fs.readFileSync(file, 'utf8')); if (Number(rec.chainId) !== CONFIG.chainId) return null; return { ...rec, file }; } catch { return null; }
})();
if (DEPLOYMENT) {
  for (const [key, field] of [['launchpad', 'launchpad'], ['fees', 'fees'], ['tokenImpl', 'tokenImpl'], ['locker', 'locker'], ['v4Locker', 'v4Locker'], ['hook', 'hook'], ['swap', 'swap'], ['mist', 'mist'], ['platform', 'platform']]) if (!CONFIG[key] && DEPLOYMENT[field]) CONFIG[key] = String(DEPLOYMENT[field]);
  if (!CONFIG.deployBlock && DEPLOYMENT.deployBlock) CONFIG.deployBlock = Number(DEPLOYMENT.deployBlock);
}
/** Is the chain side configured at all (addresses and an RPC)? Without it the server serves the site and the demo only. */
export const chainReady = () => Boolean(CONFIG.rpcUrls.length && CONFIG.launchpad && CONFIG.fees && CONFIG.locker);
export const dataPath = name => path.join(CONFIG.dataDir, name);
export function ensureDataDir() { fs.mkdirSync(CONFIG.dataDir, { recursive: true }); }
/** What the site may know: public addresses and chain facts, never a key. */
export function publicConfig() {
  const c = chainInfo();
  const d = DEPLOYMENT; let zk = null; try { const setup = JSON.parse(fs.readFileSync(new URL('../zk/setup.json', import.meta.url), 'utf8')); zk = { dev: Boolean(setup.dev), constraints: Number(setup.constraints || 0), ptau: setup.dev ? '' : String(setup.ptau?.file || '') }; } catch {}
  return { siteName: CONFIG.siteName, siteUrl: CONFIG.siteUrl, xHandle: CONFIG.xHandle, sourceUrl: CONFIG.sourceUrl, demo: CONFIG.demo, chainId: c.id, chainName: c.name, explorer: c.explorer, launchpad: CONFIG.launchpad, fees: CONFIG.fees, tokenImpl: CONFIG.tokenImpl, locker: CONFIG.locker, v4Locker: CONFIG.v4Locker, hook: CONFIG.hook, swap: CONFIG.swap, mist: CONFIG.mist, platform: CONFIG.platform, platformCoin: CONFIG.platformCoin, deployBlock: CONFIG.deployBlock, uniswap: c.uniswap, gardener: CONFIG.gardenerEnabled, ready: chainReady(), pinning: Boolean(String(process.env.PINATA_JWT || '').trim()),
    deployment: d ? { at: d.at || '', poseidon: d.poseidon || '', verifier: d.verifier || '', create2: d.create2 || '', mistDenominations: d.mistDenominations || [] } : null, zk };
}
