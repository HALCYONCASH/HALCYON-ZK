// Verify the deployed contracts on Etherscan from deployments/<chain>.json: each contract's standard-input JSON (the exact compiler
// input, every imported source inlined, written by contracts/compile.mjs next to the artifact), its constructor arguments rebuilt from
// the record and ABI-encoded, submitted to Etherscan's API and polled until Etherscan says Pass. A contract already verified is left alone.
//   ETHERSCAN_API_KEY=… CHAIN_ID=1 node scripts/verify.mjs [--only HalcyonFees,Halcyon] [--dry] [--file deployments/mainnet.json]
// --dry prints what would be submitted. ETHERSCAN_API_URL overrides the endpoint (https://api.etherscan.io/v2/api, which takes a
// chainid, serves Sepolia too). The hook was deployed through the Create2Deployer; Etherscan verifies it like any other contract.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, getAddress } from 'viem';
import { CONFIG, CHAINS } from '../eth/config.mjs';

const say = s => fs.writeSync(1, `${s}\n`); const err = s => fs.writeSync(2, `${s}\n`);
const argv = process.argv.slice(2); const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : ''; }; const dry = argv.includes('--dry');
const chainId = CONFIG.chainId; const chain = CHAINS[chainId]; if (!chain) { err(`CHAIN_ID ${chainId} is not configured`); process.exit(2); }
const file = opt('file') || (process.env.HALCYON_DEPLOYMENTS_DIR ? path.join(path.resolve(process.env.HALCYON_DEPLOYMENTS_DIR), `${chain.short}.json`) : fileURLToPath(new URL(`../deployments/${chain.short}.json`, import.meta.url)));
if (!fs.existsSync(file)) { err(`no deployment record at ${file} (scripts/deploy.mjs --go writes it)`); process.exit(2); }
const rec = JSON.parse(fs.readFileSync(file, 'utf8')); if (Number(rec.chainId) !== chainId) { err(`${file} is a chain ${rec.chainId} record, CHAIN_ID says ${chainId}`); process.exit(2); }
const apiKey = String(process.env.ETHERSCAN_API_KEY || '').trim(); if (!apiKey && !dry) { err('ETHERSCAN_API_KEY is required (a free key from etherscan.io/apidashboard)'); process.exit(2); }
const api = process.env.ETHERSCAN_API_URL || 'https://api.etherscan.io/v2/api';
const artDir = fileURLToPath(new URL('../contracts/artifacts/', import.meta.url));
const art = name => JSON.parse(fs.readFileSync(path.join(artDir, `${name}.json`), 'utf8'));
const ZERO = '0x0000000000000000000000000000000000000000'; const u = rec.uniswap || chain.uniswap;
const ctorArgs = (name, args) => { const ctor = art(name).abi.find(f => f.type === 'constructor'); if (!ctor || !ctor.inputs.length) return ''; return encodeAbiParameters(ctor.inputs, args).slice(2); };

/** Every contract of the record with its address and constructor arguments, in the deploy order. */
const list = [
  ['HalcyonToken', rec.tokenImpl, []],
  ['HalcyonSwap', rec.swap, [u.poolManager]],
  ['HalcyonFees', rec.fees, [rec.platform, rec.gardener, u.weth, u.swapRouter02, rec.swap]],
  ['HalcyonLocker', rec.locker, [rec.fees, u.nfpm, u.swapRouter02, u.weth]],
  ['PoseidonT3', rec.poseidon, []],
  ['MistVerifier', rec.verifier, []],
  ['HalcyonMist', rec.mist, [rec.poseidon, rec.verifier, rec.fees, (rec.mistDenominations || []).map(x => BigInt(x))]],
  ['HalcyonV4Locker', rec.v4Locker, [u.poolManager, rec.fees]],
  ['Create2Deployer', rec.create2, []],
  ['HalcyonHook', rec.hook, [u.poolManager, rec.fees, rec.v4Locker]],
  ['Halcyon', rec.launchpad, [rec.config]],
].filter(([, address]) => address && address !== ZERO);
const only = opt('only') ? opt('only').split(',').map(s => s.trim()) : null;
const todo = list.filter(([name]) => !only || only.includes(name)); if (!todo.length) { err('nothing to verify (check --only)'); process.exit(2); }

const form = o => { const f = new URLSearchParams(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
async function submit(name, address, args) {
  const input = fs.readFileSync(path.join(artDir, `${name}.standard-input.json`), 'utf8'); const a = art(name);
  const fields = { chainid: String(chainId), module: 'contract', action: 'verifysourcecode', apikey: apiKey, codeformat: 'solidity-standard-json-input', sourceCode: input, contractaddress: getAddress(address), contractname: `${name}.sol:${name}`, compilerversion: `v${String(a.compiler).replace(/^solc /, '')}`, constructorArguements: ctorArgs(name, args) };
  if (dry) { say(`${name} at ${address}: ${fields.compilerversion}, ${input.length} bytes of standard input, constructor args ${fields.constructorArguements || '(none)'}`); return; }
  const r = await fetch(`${api}?chainid=${chainId}`, { method: 'POST', body: form(fields) }); const j = await r.json().catch(() => ({ status: '0', result: `${r.status} ${r.statusText}` }));
  if (j.status !== '1') { if (/already verified/i.test(String(j.result))) { say(`${name} at ${address}: already verified`); return; } err(`${name} at ${address}: Etherscan refused: ${j.result}`); return; }
  const guid = j.result;
  for (let i = 0; i < 30; i++) {
    await new Promise(res => setTimeout(res, 5000));
    const s = await (await fetch(`${api}?${form({ chainid: String(chainId), module: 'contract', action: 'checkverifystatus', guid, apikey: apiKey })}`)).json().catch(() => ({ result: 'no answer' }));
    const t = String(s.result || ''); if (/pending|queue/i.test(t)) continue;
    say(`${name} at ${address}: ${t}`); return;
  }
  say(`${name} at ${address}: still pending after a while (guid ${guid}); check it on the explorer later`);
}
say(`verifying ${todo.length} contract${todo.length > 1 ? 's' : ''} of ${file} on ${chain.name}${dry ? ' (dry)' : ''}`);
for (const [name, address, args] of todo) { try { await submit(name, address, args); } catch (e) { err(`${name} at ${address}: ${String(e.message || e).split('\n')[0]}`); } }
