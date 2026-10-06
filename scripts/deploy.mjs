// Deploy Halcyon to the chain in CHAIN_ID over ETH_RPC_URL. Dry by default: it checks the Uniswap addresses and the feed, prints every
// deployment with its gas, and sends nothing. With --go it deploys the contracts in order (the hook at a mined address whose
// low bits spell its permissions; the mist pool with its Poseidon and its verifier), wires the fees contract, points it at the pool,
// writes deployments/<chain>.json and prints the env lines the server needs.
//   HALCYON_DEPLOYER_KEY=0x… HALCYON_PLATFORM=0x… HALCYON_GARDENER=0x… CHAIN_ID=1 ETH_RPC_URL=https://… node scripts/deploy.mjs [--go] [--no-v4] [--fresh]
//   HALCYON_DEPLOY_MAX_GWEI=3 refuses to send (or estimate) above that gas price; the whole deploy is about 21 million gas.
// A --go run writes deployments/<chain>.partial.json as it goes (each transaction's hash as it is sent, each address as it is mined), and a
// later --go with that file present resumes: every contract already there is checked (code at the address, its constructor's values read
// back) and kept, a transaction still pending is waited for, only what is missing is sent. --fresh ignores the partial record.
// The deployer pays the gas and may wire the fees contract once; the platform address owns the fees contract (it withdraws the platform
// pot, rotates the gardener, allows stocks) and should be a wallet you keep; the gardener address is the server's key (HALCYON_GARDENER_KEY).
// Verify on Etherscan with the standard-input JSON next to each artifact (contracts/artifacts/*.standard-input.json) and the constructor
// arguments printed here. --no-v4 deploys without the v4 side (no rules pools) on a chain without a PoolManager.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseAbi, getAddress, keccak256, encodeDeployData, formatEther, formatGwei, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CONFIG, CHAINS } from '../eth/config.mjs';
import { viemChain } from '../eth/chain.mjs';
import { hookInitCode, mineHookSalt, hasFlags } from '../eth/hookmine.mjs';

const go = process.argv.includes('--go'); const noV4 = process.argv.includes('--no-v4'); const allowDevZk = process.argv.includes('--allow-dev-zk'); const fresh = process.argv.includes('--fresh');
// synchronous writes: on Windows a console write to a pipe is asynchronous and process.exit() would drop it
const say = s => fs.writeSync(1, `${s}\n`); const err = s => fs.writeSync(2, `${s}\n`);
const art = name => JSON.parse(fs.readFileSync(new URL(`../contracts/artifacts/${name}.json`, import.meta.url), 'utf8'));
const chainId = CONFIG.chainId; const chain = CHAINS[chainId]; if (!chain) { err(`CHAIN_ID ${chainId} is not configured (eth/config.mjs)`); process.exit(2); }
const rpc = CONFIG.rpcUrls[0]; if (!rpc) { err('ETH_RPC_URL missing'); process.exit(2); }
const key = String(process.env.HALCYON_DEPLOYER_KEY || '').trim(); const platform = String(process.env.HALCYON_PLATFORM || '').trim(); const gardener = String(process.env.HALCYON_GARDENER || '').trim();
if (!platform || !gardener) { err('HALCYON_PLATFORM and HALCYON_GARDENER (addresses) are required'); process.exit(2); }
const pc = createPublicClient({ chain: viemChain(), transport: http(rpc) });
const account = key ? privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`) : null;
const wc = account ? createWalletClient({ chain: viemChain(), transport: http(rpc), account }) : null;
const u = chain.uniswap; const ZERO = '0x0000000000000000000000000000000000000000';
const NFPM = parseAbi(['function factory() view returns (address)', 'function WETH9() view returns (address)']); const ROUTER = parseAbi(['function WETH9() view returns (address)', 'function factory() view returns (address)', 'function positionManager() view returns (address)']); const FEED = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)', 'function decimals() view returns (uint8)']);
const log = (...a) => say(a.join(' '));

// the mist pool: its circuit's setup must be a real one on a real chain (zk/build.mjs --ptau <the public powers of tau>), its denominations in ETH
const zkSetup = JSON.parse(fs.readFileSync(new URL('../zk/setup.json', import.meta.url), 'utf8'));
if (zkSetup.dev && chainId === 1 && !allowDevZk) {
  const setupsDir = fileURLToPath(new URL('../zk/setups/', import.meta.url)); const kept = fs.existsSync(setupsDir) ? fs.readdirSync(setupsDir).filter(d => fs.existsSync(path.join(setupsDir, d, 'setup.json'))).sort() : [];
  err(`zk/setup.json is a DEVELOPMENT setup (a powers of tau made on one machine): ${kept.length ? `a kept setup sits in zk/setups/${kept[kept.length - 1]}; \`node zk/build.mjs --restore zk/setups/${kept[kept.length - 1]}\` puts it back (a zip or a --dev build replaced it), else ` : ''}run \`node zk/build.mjs --ptau <a public powers of tau prepared for phase 2, ppot_0080_14.ptau say>\` before a mainnet deploy, or pass --allow-dev-zk if you really mean it`); process.exit(2); }
const mistDenoms = String(process.env.HALCYON_MIST_DENOMS || '0.01,0.1,1').split(',').map(x => x.trim()).filter(Boolean).map(x => parseEther(x)); if (!mistDenoms.length || mistDenoms.length > 8) { err('HALCYON_MIST_DENOMS: one to eight amounts in ETH, like 0.01,0.1,1'); process.exit(2); }
log(`mist pool denominations: ${mistDenoms.map(x => formatEther(x)).join(', ')} ETH; circuit setup: ${zkSetup.dev ? 'DEVELOPMENT' : zkSetup.ptau.file} (${zkSetup.constraints} constraints)`);
const maskRpc = u => { try { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname.length > 1 ? '/…' : ''}`; } catch { return '…'; } }; /* the key in a provider URL is a secret: never printed */
log(`Halcyon deploy on ${chain.name} (${chainId}) via ${maskRpc(rpc)} ${go ? 'SENDING' : 'dry run'}`);
const liveId = await pc.getChainId(); if (liveId !== chainId) { err(`the RPC serves chain ${liveId}, CHAIN_ID says ${chainId}`); process.exit(1); }
for (const k of ['weth', 'v3Factory', 'nfpm', 'swapRouter02']) if (!u[k]) { err(`no Uniswap ${k} for chain ${chainId}: set HALCYON_UNISWAP_${k.toUpperCase()}`); process.exit(2); }
if (!chain.ethUsdFeed) { err('no ETH/USD feed for this chain: set HALCYON_ETH_USD_FEED'); process.exit(2); }
const v4 = !noV4 && Boolean(u.poolManager); if (!v4) log('no v4 PoolManager (or --no-v4): deploying without rules pools');
// 1. the Uniswap addresses must agree with each other, the PoolManager must have code, the feed must answer
const [nfpmFactory, nfpmWeth, routerWeth, routerFactory, routerNfpm] = await Promise.all([pc.readContract({ address: u.nfpm, abi: NFPM, functionName: 'factory' }), pc.readContract({ address: u.nfpm, abi: NFPM, functionName: 'WETH9' }), pc.readContract({ address: u.swapRouter02, abi: ROUTER, functionName: 'WETH9' }), pc.readContract({ address: u.swapRouter02, abi: ROUTER, functionName: 'factory' }), pc.readContract({ address: u.swapRouter02, abi: ROUTER, functionName: 'positionManager' })]);
const same = (a, b) => getAddress(a) === getAddress(b);
if (!same(nfpmFactory, u.v3Factory) || !same(nfpmWeth, u.weth) || !same(routerWeth, u.weth) || !same(routerFactory, u.v3Factory) || !same(routerNfpm, u.nfpm)) { err(`the Uniswap v3 addresses disagree: nfpm.factory ${nfpmFactory}, nfpm.WETH9 ${nfpmWeth}, router.WETH9 ${routerWeth}, router.factory ${routerFactory}, router.positionManager ${routerNfpm}`); process.exit(1); }
log('Uniswap v3: the position manager and SwapRouter02 agree on the factory and WETH');
if (v4) { const code = await pc.getCode({ address: u.poolManager }); if (!code || code.length < 10) { err(`no code at the PoolManager ${u.poolManager}`); process.exit(1); } log(`Uniswap v4: PoolManager ${u.poolManager} has code`);
  for (const [name, address] of [['state view', u.stateView], ['v4 quoter', u.v4Quoter]]) { const c = address ? await pc.getCode({ address }) : ''; if (!c || c.length < 10) log(`  no ${name} on this chain: stocks.mjs catch and discover cannot find v4 pools here (the gardener's v4 routes still work)`); } }
const [, answer, , updatedAt] = await pc.readContract({ address: chain.ethUsdFeed, abi: FEED, functionName: 'latestRoundData' }); const feedDec = await pc.readContract({ address: chain.ethUsdFeed, abi: FEED, functionName: 'decimals' });
const age = Math.floor(Date.now() / 1000) - Number(updatedAt); if (answer <= 0n || age > 3 * 3600) { err(`the ETH/USD feed answers ${answer} from ${age}s ago`); process.exit(1); } log(`ETH/USD feed: ${Number(answer) / 10 ** Number(feedDec)} (${age}s old)`);
if (!account) { log('no HALCYON_DEPLOYER_KEY: nothing to estimate from; set it to see the gas, add --go to deploy'); process.exit(0); }
const gasPrice = await pc.getGasPrice(); log(`gas price ${formatGwei(gasPrice)} gwei`);
const maxGwei = Number(process.env.HALCYON_DEPLOY_MAX_GWEI || 0); if (maxGwei > 0 && Number(formatGwei(gasPrice)) > maxGwei) { err(`the gas price is ${formatGwei(gasPrice)} gwei, over HALCYON_DEPLOY_MAX_GWEI=${maxGwei}: wait for a quieter hour (the whole deploy is about 21 million gas)`); process.exit(3); }
const balance = await pc.getBalance({ address: account.address }); log(`deployer ${account.address} holds ${formatEther(balance)} ETH`);
if (platform.toLowerCase() === account.address.toLowerCase() || gardener.toLowerCase() === account.address.toLowerCase()) log('note: the deployer is also the platform or the gardener; a deployer key is best used once and forgotten, the platform wallet kept cold');
if (platform.toLowerCase() === gardener.toLowerCase()) { err('HALCYON_PLATFORM and HALCYON_GARDENER are the same address: the gardener is the server\'s hot key, the platform wallet owns the fees; keep them apart'); process.exit(2); }

const out = {}; let total = 0n;
const place = (artifactName, k) => `0x${(k * 0x1111111111111111111111111111111111111111n).toString(16).padStart(40, '0').slice(-40)}`; /* dry run placeholders */
// the partial record: what a --go run has sent and mined so far, so a run cut short (a receipt that took too long, a closed laptop) resumes
const dir = process.env.HALCYON_DEPLOYMENTS_DIR ? path.resolve(process.env.HALCYON_DEPLOYMENTS_DIR) : fileURLToPath(new URL('../deployments/', import.meta.url));
const partialFile = path.join(dir, `${chain.short}.partial.json`);
let partial = { chainId, deployer: account.address, platform, gardener, contracts: {}, txs: {} };
if (go && !fresh && fs.existsSync(partialFile)) {
  const p = JSON.parse(fs.readFileSync(partialFile, 'utf8')); const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  if (Number(p.chainId) !== chainId || !same(p.deployer, account.address) || !same(p.platform, platform) || !same(p.gardener, gardener)) { err(`${partialFile} was made by another run (chain ${p.chainId}, deployer ${p.deployer}, platform ${p.platform}, gardener ${p.gardener}); pass --fresh to ignore it, or set the same addresses to resume it`); process.exit(2); }
  partial = { ...partial, ...p, contracts: p.contracts || {}, txs: p.txs || {} }; log(`resuming from ${partialFile}: ${Object.keys(partial.contracts).length} contract${Object.keys(partial.contracts).length === 1 ? '' : 's'} already deployed`);
  if (partial.deployBlock) out.deployBlock = partial.deployBlock;
}
const savePartial = () => { if (!go) return; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(partialFile, JSON.stringify({ ...partial, deployBlock: out.deployBlock, at: new Date().toISOString() }, null, 1)); };
const stopAfter = process.env.HALCYON_DEPLOY_STOP_AFTER || ''; /* tests: stop once this contract is deployed, as a cut-short run would */
/** Wait for a receipt as long as it takes (a low gas price can mean minutes between blocks), saying so once a minute. */
async function receipt(hash, what) {
  const started = Date.now(); const tick = setInterval(() => log(`  still waiting for ${what} (${hash}, ${Math.round((Date.now() - started) / 1000)} s); the partial record keeps the hash, a later --go resumes from it`), 60_000);
  try { return await pc.waitForTransactionReceipt({ hash, timeout: 60 * 60_000, pollingInterval: 4_000 }); }
  catch (e) { err(`${what}: ${hash} is still not mined (${String(e.shortMessage || e.message || e).split('\n')[0]}). If the network dropped it, remove it from the txs of ${partialFile} and run --go again; if it is only slow, run --go again and the wait resumes`); process.exit(1); }
  finally { clearInterval(tick); }
}
/** The values a deployed contract's getters must return for it to be the one the arguments describe. */
async function checkDeployed(name, artifactName, address, checks, { sameCode = false } = {}) {
  const code = await pc.getCode({ address }); if (!code || code.length < 10) { err(`${name}: no code at ${address} (from the partial record); pass --fresh to deploy anew`); process.exit(1); }
  /* a contract without immutables runs exactly the bytes the artifact holds: the verifier on chain must be the one compiled from the circuit setup in place now */
  if (sameCode) { const want = String(art(artifactName).deployedBytecode || '').toLowerCase().replace(/^0x/, ''); if (want && code.toLowerCase().replace(/^0x/, '') !== want) { err(`${name} at ${address} (from the partial record) does not run the bytecode compiled here${artifactName === 'MistVerifier' ? ': the circuit setup in place is not the one it was deployed from. Restore the kept setup (node zk/build.mjs --restore zk/setups/<dir>) and run again' : '; the contracts changed since that run. Pass --fresh to deploy anew'}`); process.exit(1); } }
  for (const [fn, want] of checks) { const got = await pc.readContract({ address, abi: art(artifactName).abi, functionName: fn }); const norm = v => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : typeof x === 'string' ? x.toLowerCase() : x)); if (norm(got) !== norm(want)) { err(`${name} at ${address} (from the partial record) answers ${fn}() = ${norm(got)}, the deploy wants ${norm(want)}: not the same deployment; pass --fresh to deploy anew`); process.exit(1); } }
}
async function deploy(name, artifactName, args, { dryGas = 0n, key = artifactName, checks = [], sameCode = false } = {}) {
  const a = art(artifactName);
  if (go && partial.contracts[key]) { const address = getAddress(partial.contracts[key]); await checkDeployed(name, artifactName, address, checks, { sameCode }); log(`${name}: already deployed at ${address} (partial record, checked)`); return address; }
  const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args });
  let hash = go ? partial.txs[key] : '';
  if (!hash) {
    /* a contract whose constructor calls another one cannot be estimated against the dry run's placeholder addresses: a measured figure stands in */
    const gas = !go && dryGas ? dryGas : await pc.estimateGas({ account: account.address, data }); total += gas; log(`${name}: ${gas} gas (${formatEther(gas * gasPrice)} ETH) args ${JSON.stringify(args, (k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (!go) return place(artifactName, BigInt(Object.keys(out).length + 1));
    hash = await wc.deployContract({ abi: a.abi, bytecode: a.bytecode, args, gas: gas + gas / 5n }); partial.txs[key] = hash; savePartial(); log(`  sent ${hash}`);
  } else log(`${name}: transaction ${hash} was sent by the run before; waiting for it`);
  const rc = await receipt(hash, name); if (rc.status !== 'success') { err(`${name} reverted (${hash}); remove it from ${partialFile} to send it again`); process.exit(1); }
  const address = getAddress(rc.contractAddress); log(`  deployed at ${address} in block ${rc.blockNumber} (${hash})`); if (!out.deployBlock) out.deployBlock = Number(rc.blockNumber);
  partial.contracts[key] = address; savePartial();
  if (stopAfter === key) { log(`stopped after ${key} (HALCYON_DEPLOY_STOP_AFTER); the partial record is in ${partialFile}`); process.exit(0); }
  return address;
}
out.impl = await deploy('HalcyonToken (implementation)', 'HalcyonToken', [], { key: 'impl', checks: [['launchpad', account.address]], sameCode: true });
out.swap = v4 ? await deploy('HalcyonSwap', 'HalcyonSwap', [u.poolManager], { key: 'swap', checks: [['manager', u.poolManager]] }) : ZERO;
out.fees = await deploy('HalcyonFees', 'HalcyonFees', [platform, gardener, u.weth, u.swapRouter02, out.swap], { key: 'fees', checks: [['platform', platform], ['gardener', gardener], ['weth', u.weth], ['swapRouter', u.swapRouter02], ['v4Swap', out.swap]] });
out.locker = await deploy('HalcyonLocker (v3)', 'HalcyonLocker', [out.fees, u.nfpm, u.swapRouter02, u.weth], { key: 'locker', checks: [['fees', out.fees], ['nfpm', u.nfpm], ['router', u.swapRouter02], ['weth', u.weth]] });
out.poseidon = await deploy('PoseidonT3', 'PoseidonT3', [], { key: 'poseidon', sameCode: true });
out.verifier = await deploy('MistVerifier', 'MistVerifier', [], { key: 'verifier', sameCode: true });
out.mist = await deploy('HalcyonMist', 'HalcyonMist', [out.poseidon, out.verifier, out.fees, mistDenoms], { dryGas: 2_700_000n, key: 'mist', checks: [['poseidon', out.poseidon], ['verifier', out.verifier], ['fees', out.fees], ['denominationList', mistDenoms]] });
out.v4Locker = v4 ? await deploy('HalcyonV4Locker', 'HalcyonV4Locker', [u.poolManager, out.fees], { key: 'v4Locker', checks: [['manager', u.poolManager], ['fees', out.fees]] }) : ZERO;
if (v4) {
  out.create2 = await deploy('Create2Deployer', 'Create2Deployer', [], { key: 'create2', sameCode: true });
  const initCode = hookInitCode(art('HalcyonHook').bytecode, { manager: u.poolManager, fees: out.fees, locker: out.v4Locker }); const mined = mineHookSalt(out.create2, keccak256(initCode));
  if (go && partial.contracts.hook) {
    out.hook = getAddress(partial.contracts.hook); if (out.hook.toLowerCase() !== mined.address.toLowerCase()) { err(`the hook in the partial record (${out.hook}) is not where this deploy's salt puts it (${mined.address}); pass --fresh to deploy anew`); process.exit(1); }
    await checkDeployed('HalcyonHook', 'HalcyonHook', out.hook, [['manager', u.poolManager], ['fees', out.fees], ['locker', out.v4Locker]]); log(`HalcyonHook: already deployed at ${out.hook} (partial record, checked)`);
  } else {
    log(`HalcyonHook: salt ${mined.salt} puts it at ${mined.address} (${mined.tries} tries)`);
    const C2 = art('Create2Deployer').abi; const data = (await import('viem')).encodeFunctionData({ abi: C2, functionName: 'deploy', args: [mined.salt, initCode] });
    let hash = go ? partial.txs.hook : '';
    if (!hash) { const gas = await pc.estimateGas({ account: account.address, to: out.create2, data }).catch(() => 2_000_000n); total += gas; log(`HalcyonHook (via Create2Deployer): ${gas} gas`); if (go) { hash = await wc.writeContract({ address: out.create2, abi: C2, functionName: 'deploy', args: [mined.salt, initCode], gas: gas + gas / 5n }); partial.txs.hook = hash; savePartial(); log(`  sent ${hash}`); } }
    else log(`HalcyonHook: transaction ${hash} was sent by the run before; waiting for it`);
    if (go) { const rc = await receipt(hash, 'HalcyonHook'); if (rc.status !== 'success') { err(`hook deploy reverted (${hash}); remove it from ${partialFile} to send it again`); process.exit(1); } const code = await pc.getCode({ address: mined.address }); if (!code || code.length < 10 || !hasFlags(mined.address)) { err('the hook is not where the salt said'); process.exit(1); } log(`  deployed at ${mined.address} (${hash})`); partial.contracts.hook = mined.address; savePartial(); if (stopAfter === 'hook') { log(`stopped after hook (HALCYON_DEPLOY_STOP_AFTER); the partial record is in ${partialFile}`); process.exit(0); } }
    out.hook = mined.address;
  }
} else { out.hook = ZERO; }
const config = { implementation: out.impl, fees: out.fees, locker: out.locker, v4Locker: out.v4Locker, hook: out.hook, swap: out.swap, v3Factory: u.v3Factory, nfpm: u.nfpm, swapRouter: u.swapRouter02, weth: u.weth, poolManager: v4 ? u.poolManager : ZERO, ethUsdFeed: chain.ethUsdFeed };
out.launchpad = await deploy('Halcyon (launchpad)', 'Halcyon', [config], { key: 'launchpad', checks: [['implementation', out.impl], ['fees', out.fees], ['locker', out.locker], ['v4Locker', out.v4Locker], ['hook', out.hook], ['swap', out.swap]] });
log(`total ${total} gas, about ${formatEther(total * gasPrice)} ETH at the current price`);
if (balance < total * gasPrice * 3n / 2n) log(`note: the deployer holds ${formatEther(balance)} ETH, less than one and a half times that; fund it before --go, a price rise mid-way would strand the deploy`);
if (!go) { log('dry run: add --go to deploy'); process.exit(0); }
const FEES = art('HalcyonFees').abi;
if ((await pc.readContract({ address: out.fees, abi: FEES, functionName: 'launchpad' })).toLowerCase() === out.launchpad.toLowerCase()) log('fees.wire: already done');
else { const hash = await wc.writeContract({ address: out.fees, abi: FEES, functionName: 'wire', args: [out.launchpad, out.locker, out.v4Locker, out.hook] }); partial.txs.wire = hash; savePartial(); const rc = await receipt(hash, 'fees.wire'); if (rc.status !== 'success') { err(`fees.wire reverted (${hash})`); process.exit(1); } log(`fees.wire(${out.launchpad}, ${out.locker}, ${out.v4Locker}, ${out.hook}) ${hash}`); }
if ((await pc.readContract({ address: out.fees, abi: FEES, functionName: 'mist' })).toLowerCase() === out.mist.toLowerCase()) log('fees.setMist: already done');
else { const h2 = await wc.writeContract({ address: out.fees, abi: FEES, functionName: 'setMist', args: [out.mist] }); partial.txs.setMist = h2; savePartial(); const rc = await receipt(h2, 'fees.setMist'); if (rc.status !== 'success') { err(`fees.setMist reverted (${h2})`); process.exit(1); } log(`fees.setMist(${out.mist}) ${h2}`); }
const record = { chainId, chain: chain.name, at: new Date().toISOString(), deployer: account.address, platform, gardener, tokenImpl: out.impl, fees: out.fees, locker: out.locker, v4Locker: out.v4Locker, hook: out.hook, swap: out.swap, create2: out.create2 || '', launchpad: out.launchpad, deployBlock: out.deployBlock, config, uniswap: u, ethUsdFeed: chain.ethUsdFeed, poseidon: out.poseidon, verifier: out.verifier, mist: out.mist, mistDenominations: mistDenoms.map(String), zk: zkSetup, txs: partial.txs };
fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, `${chain.short}.json`); fs.writeFileSync(file, JSON.stringify(record, null, 1)); try { fs.unlinkSync(partialFile); } catch {}
log(`\nwritten ${file}. Server env:\nCHAIN_ID=${chainId}\nHALCYON_LAUNCHPAD=${out.launchpad}\nHALCYON_FEES=${out.fees}\nHALCYON_TOKEN_IMPL=${out.impl}\nHALCYON_LOCKER=${out.locker}\nHALCYON_V4_LOCKER=${out.v4Locker}\nHALCYON_HOOK=${out.hook}\nHALCYON_SWAP=${out.swap}\nHALCYON_MIST=${out.mist}\nHALCYON_DEPLOY_BLOCK=${out.deployBlock}\nHALCYON_PLATFORM=${platform}\nHALCYON_GARDENER_KEY=<the gardener's private key, ${gardener}>`);
