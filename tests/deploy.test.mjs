// The deploy and stock scripts against a real JSON-RPC node (hardhat node on a spare port): the dry run sends nothing, --go deploys
// the trio, wires fees to the launchpad and writes the deployment record; the stock script registers a route and prints the calldata.
process.env.HALCYON_NO_DOTENV = '1'; /* the tests never read a developer's .env */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, getAddress, parseEther, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hardhat } from 'viem/chains';
import { uniswapBuild, peripheryBuild, artifact, NFPM_ABI, WETH_ABI, V3_FACTORY_ABI, POOL_MANAGER_ABI, LP_TEST_ABI, bigintSqrt, v4Pool, ZERO_ADDRESS } from './helpers/evm.mjs';
import { hasFlags } from '../eth/hookmine.mjs';
const SETUP = JSON.parse(fs.readFileSync(new URL('../zk/setup.json', import.meta.url), 'utf8')); /* the circuit setup the build left: development, or a public ceremony's */

const PORT = 8547; const RPC = `http://127.0.0.1:${PORT}`;
// Hardhat's published test accounts (the same for every hardhat node; never funds on a real chain)
const KEYS = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'];
const deployer = privateKeyToAccount(KEYS[0]); const platform = privateKeyToAccount(KEYS[1]); const gardener = privateKeyToAccount(KEYS[2]);
let passed = 0; const ok = (cond, what) => { if (!cond) throw new Error(`FAILED: ${what}`); passed++; console.log(`ok ${what}`); };

// hardhat is started through node itself (no npx, no shell), so the child is the node we stop at the end, on every platform
const hardhatBin = fileURLToPath(new URL('../node_modules/hardhat/internal/cli/bootstrap.js', import.meta.url));
const node = spawn(process.execPath, [hardhatBin, 'node', '--port', String(PORT), '--hostname', '127.0.0.1'], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
let nodeOut = ''; node.stdout.on('data', d => { nodeOut += d; }); node.stderr.on('data', d => { nodeOut += d; });
const stop = () => { try { node.kill('SIGTERM'); } catch {} };
process.on('exit', stop);
try {
  const pc = createPublicClient({ chain: hardhat, transport: http(RPC) });
  for (let i = 0; i < 120; i++) { try { await pc.getChainId(); break; } catch { await new Promise(r => setTimeout(r, 500)); } if (i === 119) throw new Error(`hardhat node did not start:\n${nodeOut}`); }
  const wc = createWalletClient({ chain: hardhat, transport: http(RPC), account: deployer });
  const deploy = async (b, args = []) => { const hash = await wc.deployContract({ abi: b.abi, bytecode: b.bytecode, args }); const rc = await pc.waitForTransactionReceipt({ hash }); return getAddress(rc.contractAddress); };
  const weth = await deploy(uniswapBuild('WETH9')); const factory = await deploy(uniswapBuild('UniswapV3Factory')); const nfpm = await deploy(uniswapBuild('NonfungiblePositionManager'), [factory, weth, '0x0000000000000000000000000000000000000000']);
  const router = await deploy(uniswapBuild('SwapRouter02'), ['0x0000000000000000000000000000000000000000', factory, nfpm, weth]); const quoter = await deploy(uniswapBuild('QuoterV2'), [factory, weth]); const poolManager = await deploy(uniswapBuild('PoolManager'), [deployer.address]);
  const v4Quoter = await deploy(peripheryBuild('V4Quoter'), [poolManager]); const stateView = await deploy(peripheryBuild('StateView'), [poolManager]); const lpTest = await deploy(uniswapBuild('PoolModifyLiquidityTest'), [poolManager]);
  const feed = await deploy(artifact('MockFeed'), [3000n * 10n ** 8n]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-deploy-'));
  const env = { ...process.env, CHAIN_ID: '31337', ETH_RPC_URL: RPC, HALCYON_UNISWAP_WETH: weth, HALCYON_UNISWAP_V3_FACTORY: factory, HALCYON_UNISWAP_NFPM: nfpm, HALCYON_UNISWAP_SWAPROUTER02: router, HALCYON_UNISWAP_QUOTERV2: quoter, HALCYON_UNISWAP_POOLMANAGER: poolManager, HALCYON_UNISWAP_V4QUOTER: v4Quoter, HALCYON_UNISWAP_STATEVIEW: stateView, HALCYON_ETH_USD_FEED: feed, HALCYON_PLATFORM: platform.address, HALCYON_GARDENER: gardener.address, HALCYON_DEPLOYMENTS_DIR: tmp, DATA_DIR: tmp };
  const run = (script, args, extra = {}) => spawnSync(process.execPath, [script, ...args], { cwd: new URL('..', import.meta.url), env: { ...env, ...extra }, encoding: 'utf8', timeout: 180_000 });

  // 1. without a key: the checks run, nothing is estimated or sent
  let r = run('scripts/deploy.mjs', []);
  ok(r.status === 0 && /agree on the factory and WETH/.test(r.stdout) && /PoolManager .* has code/.test(r.stdout) && /ETH\/USD feed: 3000/.test(r.stdout) && /no HALCYON_DEPLOYER_KEY/.test(r.stdout), `deploy without a key only checks (${r.stdout.trim().split('\n').pop()})`);
  // 2. Uniswap addresses that disagree are caught before anything is sent
  r = run('scripts/deploy.mjs', [], { HALCYON_UNISWAP_WETH: '0x' + '12'.repeat(20) });
  ok(r.status === 1 && /addresses disagree/.test(r.stderr), 'Uniswap addresses that disagree stop the deploy');
  // 3. the chain id must match
  r = run('scripts/deploy.mjs', [], { CHAIN_ID: '11155111', HALCYON_UNISWAP_WETH: '', HALCYON_UNISWAP_V3_FACTORY: '', HALCYON_UNISWAP_NFPM: '', HALCYON_UNISWAP_SWAPROUTER02: '', HALCYON_UNISWAP_QUOTERV2: '', HALCYON_UNISWAP_POOLMANAGER: '', HALCYON_ETH_USD_FEED: '' });
  ok(r.status === 1 && /serves chain 31337/.test(r.stderr), 'a CHAIN_ID that is not the RPC\'s stops the deploy');
  // 4. dry run with a key: gas is estimated, nothing deployed
  const blockBefore = await pc.getBlockNumber();
  r = run('scripts/deploy.mjs', [], { HALCYON_DEPLOYER_KEY: KEYS[0] });
  ok(r.status === 0 && /dry run: add --go/.test(r.stdout) && /Halcyon \(launchpad\): \d+ gas/.test(r.stdout) && /HalcyonHook: salt 0x/.test(r.stdout) && (await pc.getBlockNumber()) === blockBefore && !fs.existsSync(path.join(tmp, 'local.json')), 'the dry run estimates every contract and sends nothing');
  // 5. --go deploys and wires
  r = run('scripts/deploy.mjs', ['--go'], { HALCYON_DEPLOYER_KEY: KEYS[0] });
  if (r.status !== 0) throw new Error(`deploy --go failed:\n${r.stdout}\n${r.stderr}`);
  const rec = JSON.parse(fs.readFileSync(path.join(tmp, 'local.json'), 'utf8'));
  const FEES = artifact('HalcyonFees').abi; const PAD = artifact('Halcyon').abi; const HOOK = artifact('HalcyonHook').abi;
  const [lp, lk, v4lk, hk, pf, kp, impl, fe, ready, hookLocker] = await Promise.all([
    pc.readContract({ address: rec.fees, abi: FEES, functionName: 'launchpad' }), pc.readContract({ address: rec.fees, abi: FEES, functionName: 'locker' }), pc.readContract({ address: rec.fees, abi: FEES, functionName: 'v4Locker' }), pc.readContract({ address: rec.fees, abi: FEES, functionName: 'hook' }), pc.readContract({ address: rec.fees, abi: FEES, functionName: 'platform' }), pc.readContract({ address: rec.fees, abi: FEES, functionName: 'gardener' }),
    pc.readContract({ address: rec.launchpad, abi: PAD, functionName: 'implementation' }), pc.readContract({ address: rec.launchpad, abi: PAD, functionName: 'fees' }), pc.readContract({ address: rec.launchpad, abi: PAD, functionName: 'v4Ready' }), pc.readContract({ address: rec.hook, abi: HOOK, functionName: 'locker' })]);
  ok(getAddress(lp) === rec.launchpad && getAddress(lk) === rec.locker && getAddress(v4lk) === rec.v4Locker && getAddress(hk) === rec.hook && getAddress(pf) === platform.address && getAddress(kp) === gardener.address && getAddress(impl) === rec.tokenImpl && getAddress(fe) === rec.fees && ready === true && getAddress(hookLocker) === rec.v4Locker && hasFlags(rec.hook), '--go deploys the seven, wires fees and records it; the hook sits at a flagged address');
  ok(new RegExp(`HALCYON_LAUNCHPAD=${rec.launchpad}`).test(r.stdout) && new RegExp(`HALCYON_HOOK=${rec.hook}`).test(r.stdout) && /HALCYON_GARDENER_KEY=<the gardener's private key/.test(r.stdout) && !r.stdout.includes(KEYS[0].slice(2, 20)), 'the env lines are printed and the deployer key is not');
  const MIST = artifact('HalcyonMist').abi; const [mistOnFees, mistFees, denomsOnChain] = await Promise.all([pc.readContract({ address: rec.fees, abi: FEES, functionName: 'mist' }), pc.readContract({ address: rec.mist, abi: MIST, functionName: 'fees' }), pc.readContract({ address: rec.mist, abi: MIST, functionName: 'denominationList' })]);
  ok(getAddress(mistOnFees) === rec.mist && getAddress(mistFees) === rec.fees && denomsOnChain.map(String).join(',') === '10000000000000000,100000000000000000,1000000000000000000' && rec.mistDenominations.length === 3 && rec.zk.dev === SETUP.dev && rec.zk.zkey === SETUP.zkey && /mist pool denominations: 0.01, 0.1, 1 ETH/.test(r.stdout) && new RegExp(`fees.setMist\\(${rec.mist}\\)`).test(r.stdout) && new RegExp(`HALCYON_MIST=${rec.mist}`).test(r.stdout), 'the mist pool is deployed with its Poseidon and verifier, the default denominations, and pointed at from fees');
  // a development circuit setup is refused on mainnet (the chain id check comes later, so the refusal is what stops this run)
  r = run('scripts/deploy.mjs', [], { CHAIN_ID: '1', HALCYON_UNISWAP_WETH: '', HALCYON_UNISWAP_V3_FACTORY: '', HALCYON_UNISWAP_NFPM: '', HALCYON_UNISWAP_SWAPROUTER02: '', HALCYON_UNISWAP_QUOTERV2: '', HALCYON_UNISWAP_POOLMANAGER: '', HALCYON_ETH_USD_FEED: '' });
  if (SETUP.dev) ok(r.status === 2 && /DEVELOPMENT setup/.test(r.stderr), 'a development circuit setup is refused on mainnet');
  else ok(r.status === 1 && /serves chain 31337/.test(r.stderr) && r.stdout.includes(`circuit setup: ${SETUP.ptau.file}`), `the circuit setup on ${SETUP.ptau.file} passes the mainnet check (the chain id stops this run)`);
  r = run('scripts/deploy.mjs', [], { HALCYON_MIST_DENOMS: '0.5,abc' }); ok(r.status !== 0, 'bad denominations stop the deploy');
  r = run('scripts/deploy.mjs', [], { HALCYON_DEPLOYER_KEY: KEYS[0], HALCYON_DEPLOY_MAX_GWEI: '0.000001' }); ok(r.status === 3 && /over HALCYON_DEPLOY_MAX_GWEI/.test(r.stderr), 'a gas price over the cap stops the deploy');
  r = run('scripts/deploy.mjs', [], { HALCYON_DEPLOYER_KEY: KEYS[0], HALCYON_GARDENER: platform.address }); ok(r.status === 2 && /the same address/.test(r.stderr), 'the platform and the gardener must differ');
  // 5a. verify --dry rebuilds every constructor's arguments from the record
  r = run('scripts/verify.mjs', ['--dry', '--file', path.join(tmp, 'local.json')], {});
  const vlines = r.stdout.trim().split('\n'); const mistLine = vlines.find(l => l.startsWith('HalcyonMist ')) || ''; const padLine = vlines.find(l => l.startsWith('Halcyon ')) || '';
  ok(r.status === 0 && /verifying 11 contracts/.test(r.stdout) && vlines.filter(l => / at 0x/.test(l)).length === 11 && /v0\.8\.28\+commit\.7893614a/.test(mistLine) && mistLine.includes(rec.fees.slice(2).toLowerCase()) && mistLine.endsWith('0000000000000000000000000000000000000000000000000de0b6b3a7640000') && padLine.includes(rec.hook.slice(2).toLowerCase()) && /HalcyonToken .* constructor args \(none\)/.test(r.stdout), 'verify --dry lists the eleven contracts with their compiler version and constructor arguments');
  // 5a2. a run cut short resumes: stop after the mist pool as a lost receipt would, then --go again keeps the seven and deploys the rest
  const resumeDir = path.join(tmp, 'resume');
  r = run('scripts/deploy.mjs', ['--go'], { HALCYON_DEPLOYER_KEY: KEYS[0], HALCYON_DEPLOYMENTS_DIR: resumeDir, HALCYON_DEPLOY_STOP_AFTER: 'mist' });
  const partial = JSON.parse(fs.readFileSync(path.join(resumeDir, 'local.partial.json'), 'utf8'));
  ok(r.status === 0 && /stopped after mist/.test(r.stdout) && Object.keys(partial.contracts).length === 7 && partial.txs.mist && !fs.existsSync(path.join(resumeDir, 'local.json')), 'a --go run writes the partial record as it goes and can stop after the mist pool');
  r = run('scripts/deploy.mjs', ['--go'], { HALCYON_DEPLOYER_KEY: KEYS[0], HALCYON_DEPLOYMENTS_DIR: resumeDir });
  const resumed = JSON.parse(fs.readFileSync(path.join(resumeDir, 'local.json'), 'utf8'));
  ok(r.status === 0 && /resuming from .*local.partial.json: 7 contracts already deployed/.test(r.stdout) && /HalcyonMist: already deployed at .* \(partial record, checked\)/.test(r.stdout) && /HalcyonV4Locker: \d+ gas/.test(r.stdout) && resumed.mist === partial.contracts.mist && resumed.fees === partial.contracts.fees && resumed.tokenImpl === partial.contracts.impl && resumed.launchpad && !fs.existsSync(path.join(resumeDir, 'local.partial.json')) && resumed.txs.wire && resumed.txs.setMist, 'the next --go resumes from the partial record, checks the seven, deploys the rest, wires, and writes the full record');
  ok((await pc.readContract({ address: resumed.fees, abi: FEES, functionName: 'launchpad' })) === resumed.launchpad && (await pc.readContract({ address: resumed.fees, abi: FEES, functionName: 'mist' })) === resumed.mist, 'the resumed deployment is wired');
  r = run('scripts/deploy.mjs', ['--go'], { HALCYON_DEPLOYER_KEY: KEYS[0], HALCYON_DEPLOYMENTS_DIR: resumeDir, HALCYON_DEPLOY_STOP_AFTER: 'impl' });
  fs.writeFileSync(path.join(resumeDir, 'local.partial.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(resumeDir, 'local.partial.json'), 'utf8')), platform: gardener.address }));
  r = run('scripts/deploy.mjs', ['--go'], { HALCYON_DEPLOYER_KEY: KEYS[0], HALCYON_DEPLOYMENTS_DIR: resumeDir });
  ok(r.status === 2 && /was made by another run/.test(r.stderr), 'a partial record made with other addresses is refused');
  r = run('scripts/deploy.mjs', [], { HALCYON_DEPLOYER_KEY: KEYS[0] });
  ok(r.status === 0 && !/alch|v2\//.test(r.stdout) && /via http:\/\/127\.0\.0\.1:8547 dry run/.test(r.stdout), 'the RPC is printed as host only');
  // 5a3. the admin script: the platform wallet's calldata and a status read against the deployment
  r = run('scripts/admin.mjs', ['status'], {});
  ok(r.status === 0 && r.stdout.includes(rec.fees) && new RegExp(`gardener +${gardener.address}`).test(r.stdout) && new RegExp(`mist +${rec.mist}`).test(r.stdout) && /platform pot 0 ETH/.test(r.stdout), 'admin status reads the fees contract from the deployment record');
  r = run('scripts/admin.mjs', ['set-gardener', platform.address], { ETH_RPC_URL: '' });
  ok(r.status === 0 && r.stdout.includes(rec.fees) && r.stdout.includes(encodeFunctionData({ abi: FEES, functionName: 'setGardener', args: [platform.address] })), 'admin set-gardener prints the calldata for the platform wallet');
  r = run('scripts/admin.mjs', ['withdraw-platform', platform.address], {});
  ok(r.status === 2 && /pot is empty/.test(r.stderr), 'admin withdraw-platform with no amount reads the pot and refuses an empty one');
  // 5a4. the mist script: the pool against this folder's setup, a proof made here and judged by the verifier on the node, the trail and the spends
  r = run('scripts/mist.mjs', ['check'], {});
  ok(r.status === 0 && r.stdout.includes(rec.mist) && /IS the MistVerifier compiled in this folder/.test(r.stdout) && /denominations 0\.01 ETH, 0\.1 ETH, 1 ETH/.test(r.stdout) && /batches sown {2}0/.test(r.stdout), `mist check: the pool, and the verifier's code is this folder's (${r.stdout.split('\n')[6] || r.stderr.slice(0, 100)})`);
  r = run('scripts/mist.mjs', ['prove'], {});
  ok(r.status === 0 && /verified here with zk\/verification_key\.json: true/.test(r.stdout) && /\(eth_call\): true/.test(r.stdout) && /root known to the pool false/.test(r.stdout) && /nullifier already spent false/.test(r.stdout), `mist prove: a proof made here passes the verifier on the node; the pool would still refuse its unknown root (${r.status} ${r.signal} ${r.error ? r.error.message : ''} ${String(r.stdout).slice(-400)} ${String(r.stderr).slice(0, 300)})`);
  r = run('scripts/mist.mjs', ['spends'], {});
  ok(r.status === 0 && /^0 notes spent from/.test(r.stdout), 'mist spends: none yet');
  r = run('scripts/mist.mjs', ['trail', rec.fees], { HALCYON_SITE_URL: 'http://127.0.0.1:9' });
  ok(r.status === 0 && /keys: 0 holders/.test(r.stdout) && /rounds: 0 sown/.test(r.stdout) && /in the open: 0 payments/.test(r.stdout) && r.stdout.includes(rec.mist), 'mist trail: an empty trail for a token with no rounds, the site unreachable');
  // 5b. --no-v4 deploys without the v4 side
  r = run('scripts/deploy.mjs', ['--go', '--no-v4'], { HALCYON_DEPLOYER_KEY: KEYS[0], HALCYON_DEPLOYMENTS_DIR: path.join(tmp, 'nov4') });
  const rec2 = JSON.parse(fs.readFileSync(path.join(tmp, 'nov4', 'local.json'), 'utf8')); ok(r.status === 0 && rec2.hook === '0x0000000000000000000000000000000000000000' && (await pc.readContract({ address: rec2.launchpad, abi: PAD, functionName: 'v4Ready' })) === false, '--no-v4 deploys a launchpad without rules pools');
  // 6. the stock script: a route is registered and the allow calldata printed
  const stock = '0x' + '77'.repeat(20);
  r = run('scripts/stocks.mjs', ['add', stock, '--path', `${weth},3000,${stock}`, '--symbol', 'dTEST', '--name', 'Test stock', '--decimals', '18', '--logo', 'https://example.invalid/dtest.png', '--category', 'etf'], { HALCYON_FEES: rec.fees, HALCYON_PLATFORM: platform.address, ETH_RPC_URL: '' });
  const reg = JSON.parse(fs.readFileSync(path.join(tmp, 'halcyon-stocks.json'), 'utf8')); const row = reg.find(x => x.address === stock.toLowerCase());
  ok(r.status === 0 && row && row.symbol === 'dTEST' && row.path.length === 3 && row.logo.endsWith('dtest.png') && row.category === 'etf' && /with a logo/.test(r.stdout) && /data: 0x/.test(r.stdout) && r.stdout.includes(rec.fees), `stocks add registers the route, the logo and the calldata (local chain: no seed, ${reg.length} in the registry)`);
  r = run('scripts/stocks.mjs', ['add', stock, '--path', `${stock},3000,${weth}`, '--symbol', 'x'], { ETH_RPC_URL: '' });
  ok(r.status === 2 && /must start at WETH/.test(r.stderr), 'a path that does not start at WETH is refused');
  r = run('scripts/stocks.mjs', ['list'], { ETH_RPC_URL: '' });
  ok(r.status === 0 && /pending  v3 +0x7777/.test(r.stdout), 'stocks list shows it pending on chain with a v3 route');
  r = run('scripts/stocks.mjs', ['calldata', stock], { ETH_RPC_URL: '', HALCYON_FEES: '', HALCYON_PLATFORM: '' });
  ok(r.status === 0 && r.stdout.includes(`to:   ${rec.fees}`) && r.stdout.includes(platform.address), 'the fees address and the platform come from the deployment record when the environment leaves them out');
  // 7. import: the issuer's list (a token-list JSON, or a catalog CSV) fills the registry without routes; routes already there are kept
  const csv = path.join(tmp, 'catalog.csv'); fs.writeFileSync(csv, 'chain_id,symbol,underlying_name_short,address,decimals,logo_url\n31337,AAPLon,Apple,0x14c3abF95Cb9C93a8b82C1CdCB76D72Cb87b2d4c,18,https://cdn.ondo.finance/tokens/logos/aaplon_160x160.png\n31337,GLDon,SPDR Gold Shares,0x2222222222222222222222222222222222222222,18,\n31337,dTEST,Test again,' + stock + ',18,\n8453,MSFTon,Microsoft,0x3333333333333333333333333333333333333333,18,\n');
  r = run('scripts/stocks.mjs', ['import', '--file', csv], { ETH_RPC_URL: '' }); /* a catalog for this chain; the row for another chain is left out */
  const reg2 = JSON.parse(fs.readFileSync(path.join(tmp, 'halcyon-stocks.json'), 'utf8')); const gld = reg2.find(x => x.symbol === 'GLDon'); const again = reg2.find(x => x.address === stock.toLowerCase());
  ok(r.status === 0 && /3 stock tokens in the list: 2 added, 1 already/.test(r.stdout) && gld && gld.category === 'commodity' && gld.logo.endsWith('gldon_160x160.png') && !gld.path && again.path.length === 3 && again.symbol === 'dTEST' && !reg2.some(x => x.symbol === 'MSFTon'), 'stocks import takes the issuer\'s list for this chain, keeps the routes it had');
  // 8. discover: a real v3 pool for a stock on this chain, found through the indexer's pairs (a file here), its fee tier confirmed by the factory, quoted by QuoterV2
  const mock = await deploy(artifact('MockStock')); const amount = parseEther('100000'), wethIn = parseEther('10');
  const send = async (address, abi, functionName, args, value = 0n) => { const hash = await wc.writeContract({ address, abi, functionName, args, value }); return pc.waitForTransactionReceipt({ hash }); };
  await send(mock, artifact('MockStock').abi, 'mint', [deployer.address, amount]); await send(weth, WETH_ABI, 'deposit', [], wethIn); await send(mock, artifact('MockStock').abi, 'approve', [nfpm, amount]); await send(weth, WETH_ABI, 'approve', [nfpm, wethIn]);
  const [t0, t1] = mock.toLowerCase() < weth.toLowerCase() ? [mock, weth] : [weth, mock]; const is0 = t0 === mock; const price = is0 ? wethIn * 2n ** 192n / amount : amount * 2n ** 192n / wethIn;
  await send(nfpm, NFPM_ABI, 'createAndInitializePoolIfNecessary', [t0, t1, 3000, bigintSqrt(price)]);
  await send(nfpm, NFPM_ABI, 'mint', [{ token0: t0, token1: t1, fee: 3000, tickLower: -887220, tickUpper: 887220, amount0Desired: is0 ? amount : wethIn, amount1Desired: is0 ? wethIn : amount, amount0Min: 0n, amount1Min: 0n, recipient: deployer.address, deadline: 2n ** 40n }]);
  const pool = await pc.readContract({ address: factory, abi: V3_FACTORY_ABI, functionName: 'getPool', args: [mock, weth, 3000] });
  const pairs = path.join(tmp, 'pairs.json'); fs.writeFileSync(pairs, JSON.stringify([{ chainId: 'ethereum', dexId: 'uniswap', labels: ['v3'], pairAddress: pool, baseToken: { address: mock, symbol: 'mSTK' }, quoteToken: { address: weth, symbol: 'WETH' }, liquidity: { usd: 120000 } }, { chainId: 'ethereum', dexId: 'uniswap', labels: ['v2'], pairAddress: '0x' + '44'.repeat(20), baseToken: { address: mock }, quoteToken: { address: weth }, liquidity: { usd: 900000 } }]));
  r = run('scripts/stocks.mjs', ['discover', mock, '--from', pairs, '--probe', '0.01'], {});
  ok(r.status === 0 && /v3 WETH 0\.3% pool, about \$120K TVL/.test(r.stdout) && /0\.01 ETH buys about/.test(r.stdout) && /add --go to record/.test(r.stdout) && !JSON.parse(fs.readFileSync(path.join(tmp, 'halcyon-stocks.json'), 'utf8')).some(x => x.address === mock.toLowerCase() && x.path), 'stocks discover finds the v3 pool, confirms its fee tier and quotes it, recording nothing without --go');
  r = run('scripts/stocks.mjs', ['discover', mock, '--from', pairs, '--probe', '0.01', '--go'], { HALCYON_FEES: rec.fees });
  const found = JSON.parse(fs.readFileSync(path.join(tmp, 'halcyon-stocks.json'), 'utf8')).find(x => x.address === mock.toLowerCase());
  ok(r.status === 0 && found && found.path.length === 3 && found.path[1] === 3000 && getAddress(found.path[0]) === weth && getAddress(found.path[2]) === mock && /recorded; allow it on chain/.test(r.stdout) && r.stdout.includes(rec.fees), 'stocks discover --go records the route and prints the allow calldata');
  r = run('scripts/stocks.mjs', ['discover', mock, '--from', pairs, '--min-usd', '500000'], {});
  ok(r.status === 0 && /under the \$500,000 floor/.test(r.stdout) && /0 of 1 with a usable pool/.test(r.stdout), 'stocks discover refuses a pool under the liquidity floor');
  const empty = path.join(tmp, 'pairs-empty.json'); fs.writeFileSync(empty, '[]'); r = run('scripts/stocks.mjs', ['discover', '0x' + '55'.repeat(20), '--from', empty], {});
  ok(r.status === 0 && /no pairs on any DEX/.test(r.stdout) && /1 with no pairs on any DEX/.test(r.stdout), 'stocks discover says when the indexer lists nothing at all');
  const v4 = path.join(tmp, 'pairs-v4.json'); fs.writeFileSync(v4, JSON.stringify([{ chainId: 'ethereum', dexId: 'uniswap', labels: ['v4'], pairAddress: '0x' + '66'.repeat(32), baseToken: { address: '0x' + '55'.repeat(20), symbol: 'XXXon' }, quoteToken: { address: weth, symbol: 'WETH' }, liquidity: { usd: 500000 } }]));
  r = run('scripts/stocks.mjs', ['discover', '0x' + '55'.repeat(20), '--from', v4], {});
  ok(r.status === 0 && /1 Uniswap pool over the floor but no route from ETH through any \(the v4 pool 0x6666.* has a key this chain cannot name/.test(r.stdout) && /1 with pairs but no Uniswap way from ETH/.test(r.stdout), 'stocks discover says when a v4 pool the indexer lists is one the chain never opened');
  // 9. v4: the same stock gets a plain v4 pool against ETH; discover finds it from a v4 pair (the key from the usual tiers), catch finds it from the PoolManager's own log
  const mini = { write: async (from, c, fn, args, value = 0n) => send(c.address, c.abi, fn, args, value), poolManager: { address: poolManager, abi: POOL_MANAGER_ABI }, lpTest: { address: lpTest, abi: LP_TEST_ABI } };
  await send(mock, artifact('MockStock').abi, 'mint', [deployer.address, amount]);
  const ethPool = await v4Pool(mini, { currency0: ZERO_ADDRESS, currency1: mock, fee: 3000, tickSpacing: 60, amount0: wethIn, amount1: amount, from: deployer.address });
  const pairs4 = path.join(tmp, 'pairs-both.json'); fs.writeFileSync(pairs4, JSON.stringify([{ chainId: 'ethereum', dexId: 'uniswap', labels: ['v4'], pairAddress: ethPool.id, baseToken: { address: mock, symbol: 'mSTK' }, quoteToken: { address: ZERO_ADDRESS, symbol: 'ETH' }, liquidity: { usd: 150000 } }, { chainId: 'ethereum', dexId: 'uniswap', labels: ['v3'], pairAddress: pool, baseToken: { address: mock, symbol: 'mSTK' }, quoteToken: { address: weth, symbol: 'WETH' }, liquidity: { usd: 120000 } }]));
  r = run('scripts/stocks.mjs', ['discover', mock, '--from', pairs4, '--probe', '0.01'], {});
  ok(r.status === 0 && /v4 ETH 0\.3% pool, about \$150K TVL, from ETH via ETH, \d+\.\d% impact/.test(r.stdout) && /through ETH > mSTK \(0\.3%\)/.test(r.stdout), 'stocks discover takes the deeper v4 pool and names its key from the usual tiers');
  r = run('scripts/stocks.mjs', ['catch', mock, '--probe', '0.01', '--go'], { HALCYON_FEES: rec.fees });
  const caught = JSON.parse(fs.readFileSync(path.join(tmp, 'halcyon-stocks.json'), 'utf8')).find(x => x.address === mock.toLowerCase());
  ok(r.status === 0 && /pools seen: v3 WETH 0\.3%, v4 ETH 0\.3%/.test(r.stdout) && /1 of 1 with a pool a route can buy through, recorded/.test(r.stdout) && /\(PoolManager \d{4}-\d{2}-\d{2}\)/.test(caught.note) && ((caught.v4 && caught.v4.hops.length === 1 && !caught.path) || (caught.path && !caught.v4)), `stocks catch asks the factory and the PoolManager's log, sees both pools and records the better route (${caught.note})`);
  r = run('scripts/stocks.mjs', ['quote', mock, '0.01'], {});
  ok(r.status === 0 && /0\.01 ETH buys about \d+/.test(r.stdout) && /through Uniswap v[34]:/.test(r.stdout), 'stocks quote answers through the recorded route, v3 or v4');
  r = run('scripts/stocks.mjs', ['catch', '0x' + '55'.repeat(20), '--probe', '0.01'], {});
  ok(r.status === 0 && /no pool on Uniswap v3 \(against WETH, USDC or USDT\) and none ever opened on v4/.test(r.stdout) && /0 of 1 with a pool/.test(r.stdout), 'stocks catch says when the chain has no pool at all for a token');
  r = run('scripts/stocks.mjs', ['add', mock, '--v4', `weth,${mock}:3000:60`, '--symbol', 'mSTK'], { ETH_RPC_URL: '' });
  const manual = JSON.parse(fs.readFileSync(path.join(tmp, 'halcyon-stocks.json'), 'utf8')).find(x => x.address === mock.toLowerCase());
  ok(r.status === 0 && /with a 1-hop v4 route from WETH: WETH > mSTK \(0\.3%\)/.test(r.stdout) && manual.v4.from.toLowerCase() === weth.toLowerCase() && manual.v4.hops.length === 1 && !manual.path, 'stocks add --v4 registers a route of v4 hops in place of the v3 path');
  r = run('scripts/stocks.mjs', ['add', mock, '--v4', `eth,${weth}:500:10`, '--symbol', 'mSTK'], { ETH_RPC_URL: '' });
  ok(r.status === 2 && /must end at the stock/.test(r.stderr), 'a v4 route that does not end at the stock is refused');
  r = run('scripts/stocks.mjs', ['list'], { ETH_RPC_URL: '' });
  ok(r.status === 0 && new RegExp(`pending  v4 +${mock.toLowerCase().slice(0, 10)}`).test(r.stdout), 'stocks list says which Uniswap a route goes through');
  { const seedFile = fileURLToPath(new URL('../eth/stocks-seed.json', import.meta.url)); const before = fs.readFileSync(seedFile, 'utf8');
    try { r = run('scripts/stocks.mjs', ['bake'], { ETH_RPC_URL: '' }); const baked = JSON.parse(fs.readFileSync(seedFile, 'utf8')); const rows = baked['31337'] || [];
      ok(r.status === 0 && /stocks baked into eth\/stocks-seed.json for chain 31337, 2 with a route/.test(r.stdout) && rows.length === JSON.parse(fs.readFileSync(path.join(tmp, 'halcyon-stocks.json'), 'utf8')).length && (rows[0].path || rows[0].v4) && (rows[1].path || rows[1].v4) && !rows[2].path && !rows[2].v4 && rows.every(x => !x.imported && !x.seeded) && baked['1'].length === JSON.parse(before)['1'].length, 'stocks bake writes the registry into the seed for this chain, routed first, mainnet\'s untouched'); }
    finally { fs.writeFileSync(seedFile, before); } }
  r = run('scripts/stocks.mjs', ['calldata', '--routed'], { ETH_RPC_URL: '', HALCYON_FEES: rec.fees });
  ok(r.status === 0 && /setStocksAllowed\(\[2 stocks\], true\) from the platform wallet, one transaction: dTEST, mSTK/.test(r.stdout) && /data: 0x[0-9a-f]{8}0+40/.test(r.stdout) && r.stdout.includes(rec.fees), 'stocks calldata --routed packs every routed stock into one setStocksAllowed');
  // 9b. sending as the platform from a key in .env: dry by default, refused with the wrong key, sent with --go
  r = run('scripts/stocks.mjs', ['allow', '--routed'], { HALCYON_PLATFORM_KEY: KEYS[1] });
  ok(r.status === 0 && /setStocksAllowed\(2 stocks, true\): dTEST, mSTK/.test(r.stdout) && /dry run: add --go to send/.test(r.stdout) && !r.stdout.includes(KEYS[1].slice(2, 12)) && (await pc.readContract({ address: rec.fees, abi: FEES, functionName: 'stockAllowed', args: [mock] })) === false, 'stocks allow is dry by default and prints the estimate, not the key');
  r = run('scripts/stocks.mjs', ['allow', '--routed', '--go'], { HALCYON_PLATFORM_KEY: KEYS[2] });
  ok(r.status === 2 && /not the same wallet, nothing sent/.test(r.stderr) && (await pc.readContract({ address: rec.fees, abi: FEES, functionName: 'stockAllowed', args: [mock] })) === false, 'a key that is not the platform is refused');
  r = run('scripts/stocks.mjs', ['allow', '--routed', '--go'], { HALCYON_PLATFORM_KEY: KEYS[1] });
  ok(r.status === 0 && /mined in block/.test(r.stdout) && /2 stocks allowed on chain/.test(r.stdout) && (await pc.readContract({ address: rec.fees, abi: FEES, functionName: 'stockAllowed', args: [mock] })) === true && (await pc.readContract({ address: rec.fees, abi: FEES, functionName: 'stockAllowed', args: [stock] })) === true, 'stocks allow --go sends setStocksAllowed as the platform');
  r = run('scripts/stocks.mjs', ['allow', mock, '--deny', '--go'], { HALCYON_PLATFORM_KEY: KEYS[1] });
  ok(r.status === 0 && (await pc.readContract({ address: rec.fees, abi: FEES, functionName: 'stockAllowed', args: [mock] })) === false && (await pc.readContract({ address: rec.fees, abi: FEES, functionName: 'stockAllowed', args: [stock] })) === true, 'stocks allow --deny takes one back');
  r = run('scripts/admin.mjs', ['set-gardener', deployer.address, '--go'], { HALCYON_PLATFORM_KEY: KEYS[1] });
  ok(r.status === 0 && /mined in block/.test(r.stdout) && (await pc.readContract({ address: rec.fees, abi: FEES, functionName: 'gardener' })) === deployer.address, 'admin set-gardener --go rotates the gardener from the platform key');
  r = run('scripts/admin.mjs', ['set-gardener', gardener.address, '--go'], { HALCYON_PLATFORM_KEY: KEYS[1] }); ok(r.status === 0 && (await pc.readContract({ address: rec.fees, abi: FEES, functionName: 'gardener' })) === gardener.address, 'and back');
  r = run('scripts/stocks.mjs', ['allow', '--routed'], { HALCYON_PLATFORM_KEY: '' });
  ok(r.status === 2 && /HALCYON_PLATFORM_KEY is not set/.test(r.stderr), 'stocks allow without the key says what to do instead');
  // 7. the publish check: this tree is clean; a planted key and a provider URL are caught and masked, an ignored .env is reported as kept out
  r = run('scripts/publish-check.mjs', ['--quiet'], {});
  ok(r.status === 0 && /nothing that must not be pushed/.test(r.stdout), 'publish-check: nothing in this tree must not be pushed');
  const planted = path.join(tmp, 'planted'); fs.mkdirSync(planted, { recursive: true }); fs.writeFileSync(path.join(planted, '.gitignore'), '.env\n'); fs.writeFileSync(path.join(planted, '.env'), `HALCYON_GARDENER_KEY=${KEYS[2]}\n`); fs.writeFileSync(path.join(planted, 'notes.md'), `the key: ${KEYS[2]}\nurl https://eth-mainnet.g.alchemy.com/v2/${'abc123DEF456ghi789JKL0'}\n`); /* the fake key is spliced in so this file does not match the shape itself */
  r = run('scripts/publish-check.mjs', [planted], {});
  ok(r.status === 1 && /notes\.md:1: a 32-byte hex/.test(r.stdout) && /notes\.md:2: a provider URL/.test(r.stdout) && !r.stdout.includes(KEYS[2]) && /kept out by \.gitignore: \.env/.test(r.stdout), 'publish-check: a planted key and a provider URL are caught and masked, the ignored .env is kept out');
  console.log(`\n${passed} deploy checks passed`);
} catch (e) { console.error(e); process.exitCode = 1; } finally { stop(); setTimeout(() => process.exit(process.exitCode || 0), 8000).unref(); /* the loop ends when the hardhat child is gone; this is only a fallback */ }
