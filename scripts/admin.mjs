// The platform wallet's few actions on HalcyonFees, as calldata to send from that wallet (this script never holds a key), and a status read.
//   node scripts/admin.mjs status                         what the fees contract says: platform, gardener, launchpad, mist, the platform pot
//   node scripts/admin.mjs set-gardener 0xNEW             rotate the gardener (the server's hot key) to a new address
//   node scripts/admin.mjs set-platform 0xNEW             hand the platform wallet over (the new one owns the fees contract from then on; be sure)
//   node scripts/admin.mjs withdraw-platform 0xTO [0.5]   take 0.5 ETH of the platform pot to an address (no amount: the whole pot as the chain reports it now)
// Each prints the calldata; with --send it also runs a dry send from HALCYON_PLATFORM_KEY (the estimate, nothing sent), with --go it sends.
// Stocks are allowed with scripts/stocks.mjs calldata | allow. HALCYON_FEES comes from .env (or deployments/<chain>.json when it is not set).
import fs from 'node:fs';
import { encodeFunctionData, formatEther, getAddress, parseEther } from 'viem';
import { CONFIG, chainInfo } from '../eth/config.mjs';
import { ABI } from '../eth/contracts.mjs';
import { isAddress } from '../eth/chain.mjs';

const argv = process.argv.slice(2); const cmd = argv[0] || 'status';
const out = m => fs.writeSync(1, `${m}\n`); const fail = m => { fs.writeSync(2, `${m}\n`); process.exit(2); };
let fees = CONFIG.fees; let platform = CONFIG.platform;
const recordFile = process.env.HALCYON_DEPLOYMENTS_DIR ? `${process.env.HALCYON_DEPLOYMENTS_DIR}/${chainInfo().short}.json` : new URL(`../deployments/${chainInfo().short}.json`, import.meta.url);
if (!fees) { try { const rec = JSON.parse(fs.readFileSync(recordFile, 'utf8')); fees = rec.fees; platform = platform || rec.platform; } catch {} }
if (!fees) fail('HALCYON_FEES is not set and there is no deployment record for this chain');
const go = argv.includes('--go'); const sendable = argv.includes('--send') || go;
/** The calldata for the platform wallet; with --send (dry) or --go (sent) the script sends it itself from HALCYON_PLATFORM_KEY. */
async function print(what, data) {
  out(`${what}, from the platform wallet ${platform || '(HALCYON_PLATFORM)'}:\n  to:   ${fees}\n  data: ${data}`);
  if (!sendable) return;
  if (!CONFIG.rpcUrls.length) fail('ETH_RPC_URL is needed to send');
  const { sendAsPlatform } = await import('../eth/platform.mjs');
  try { await sendAsPlatform({ to: fees, data, label: what, go, log: out }); } catch (e) { fail(String(e.message || e)); }
}

if (cmd === 'status') {
  if (!CONFIG.rpcUrls.length) fail('ETH_RPC_URL is needed for status');
  const { publicClient } = await import('../eth/chain.mjs'); const pc = publicClient(); const read = fn => pc.readContract({ address: getAddress(fees), abi: ABI.fees, functionName: fn });
  const [p, g, l, m, pot, lk, v4l, hook] = await Promise.all(['platform', 'gardener', 'launchpad', 'mist', 'platformPot', 'locker', 'v4Locker', 'hook'].map(read));
  out(`HalcyonFees ${fees} on ${chainInfo().name}\n  platform   ${p}\n  gardener   ${g}\n  launchpad  ${l}\n  lockers    ${lk} (v3), ${v4l} (v4)\n  hook       ${hook}\n  mist       ${m}\n  platform pot ${formatEther(pot)} ETH`);
} else if (cmd === 'set-gardener') {
  const next = argv[1]; if (!isAddress(next)) fail('set-gardener needs the new gardener address');
  await print(`setGardener(${getAddress(next)})`, encodeFunctionData({ abi: ABI.fees, functionName: 'setGardener', args: [getAddress(next)] }));
} else if (cmd === 'set-platform') {
  const next = argv[1]; if (!isAddress(next)) fail('set-platform needs the new platform address');
  out('this hands the fees contract over for good: the new address alone can withdraw the platform pot, rotate the gardener and allow stocks from then on');
  await print(`setPlatform(${getAddress(next)})`, encodeFunctionData({ abi: ABI.fees, functionName: 'setPlatform', args: [getAddress(next)] }));
} else if (cmd === 'withdraw-platform') {
  const to = argv[1]; if (!isAddress(to)) fail('withdraw-platform needs the address the ETH goes to'); let amount = argv[2] ? parseEther(argv[2]) : 0n;
  if (!amount) { if (!CONFIG.rpcUrls.length) fail('give the amount in ETH, or set ETH_RPC_URL so the whole pot can be read'); const { publicClient } = await import('../eth/chain.mjs'); amount = await publicClient().readContract({ address: getAddress(fees), abi: ABI.fees, functionName: 'platformPot' }); if (!amount) fail('the platform pot is empty'); }
  await print(`withdrawPlatform(${getAddress(to)}, ${formatEther(amount)} ETH)`, encodeFunctionData({ abi: ABI.fees, functionName: 'withdrawPlatform', args: [getAddress(to), amount] }));
} else fail(`unknown command ${cmd}: status | set-gardener | set-platform | withdraw-platform`);
