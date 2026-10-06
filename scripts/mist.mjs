// Mist, checked from a terminal: the pool and its verifier on chain against the circuit setup in this folder, a proof made here and judged
// by the verifier on mainnet, and the trail a coin's private payouts leave on chain, with every transaction. Reads only, no key.
//   node scripts/mist.mjs check                the pool (verifier, Poseidon, denominations, batches, root), the verifier's code against this folder's, the setup
//   node scripts/mist.mjs prove                a withdraw proof for a note made here, verified here, then sent to the verifier on chain (eth_call): true;
//                                              and the pool's two further checks that would stop it (an unknown root, an unspent nullifier)
//   node scripts/mist.mjs trail 0xTOKEN        a coin's mist trail: holders' keys (their transactions), rounds sown, notes, payments in the open
//   node scripts/mist.mjs spends [n]           the latest notes spent from the pool: proofs the verifier accepted, with their transactions
// ETH_RPC_URL from .env (or --rpc https://…); the addresses from the deployment record (HALCYON_FEES, HALCYON_MIST win when set).
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createPublicClient, http, getAddress, formatEther, parseAbiItem } from 'viem';
import * as snarkjs from 'snarkjs';
import { CONFIG, chainInfo } from '../eth/config.mjs';
import { ABI } from '../eth/contracts.mjs';
import * as M from '../shared/mist.mjs';

const argv = process.argv.slice(2); const flag = (name, dflt = '') => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] || dflt : dflt; }; const words = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const cmd = words[0] || 'check'; const out = m => fs.writeSync(1, `${m}\n`); const fail = m => { fs.writeSync(2, `${m}\n`); process.exit(2); };
const rpc = flag('--rpc') || CONFIG.rpcUrls[0]; const explorer = chainInfo().explorer || 'https://etherscan.io'; const tx = h => `${explorer}/tx/${h}`;
const pc = rpc ? createPublicClient({ transport: http(rpc, { timeout: 60_000 }) }) : null;
const art = name => JSON.parse(fs.readFileSync(new URL(`../contracts/artifacts/${name}.json`, import.meta.url), 'utf8'));
const setup = (() => { try { return JSON.parse(fs.readFileSync(new URL('../zk/setup.json', import.meta.url), 'utf8')); } catch { return null; } })();
const VERIFIER_ABI = [{ type: 'function', name: 'verifyProof', stateMutability: 'view', inputs: [{ name: 'a', type: 'uint256[2]' }, { name: 'b', type: 'uint256[2][2]' }, { name: 'c', type: 'uint256[2]' }, { name: 'input', type: 'uint256[6]' }], outputs: [{ type: 'bool' }] }];
const sha = file => { try { return createHash('sha256').update(fs.readFileSync(new URL(`../${file}`, import.meta.url))).digest('hex'); } catch { return ''; } };
const mistAddr = () => { if (!CONFIG.mist) fail('no mist pool address: HALCYON_MIST, or deployments/<chain>.json'); return getAddress(CONFIG.mist); };
const read = (address, abi, functionName, args = []) => pc.readContract({ address, abi, functionName, args });
/** Logs of one event over the whole life of the deployment, in chunks a provider accepts. */
async function logs(address, event, args, { from = CONFIG.deployBlock || 1, step = 50_000 } = {}) {
  const head = Number(await pc.getBlockNumber()); const all = [];
  for (let a = from; a <= head; a += step) { const b = Math.min(a + step - 1, head); all.push(...await pc.getLogs({ address, event, args, fromBlock: BigInt(a), toBlock: BigInt(b) })); }
  return all;
}
const block = async n => Number((await pc.getBlock({ blockNumber: BigInt(n) })).timestamp); const when = t => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16);

if (cmd === 'check') {
  if (!pc) fail('ETH_RPC_URL is needed (or --rpc)'); const pool = mistAddr();
  const [verifier, poseidon, fees, batches, root, denoms] = await Promise.all(['verifier', 'poseidon', 'fees', 'batches', 'root', 'denominationList'].map(f => read(pool, ABI.mist, f)));
  out(`HalcyonMist ${pool} on ${chainInfo().name}\n  verifier      ${verifier}\n  poseidon      ${poseidon}\n  fees          ${fees}\n  denominations ${denoms.map(d => `${formatEther(d)} ETH`).join(', ')}\n  batches sown  ${batches}\n  root          ${root}`);
  const code = String(await pc.getCode({ address: verifier }) || '0x').toLowerCase(); const want = String(art('MistVerifier').deployedBytecode || '').toLowerCase();
  out(`\nthe verifier's code on chain ${code.length > 2 ? `(${(code.length - 2) / 2} bytes)` : '(none!)'} ${want && code === want ? 'IS the MistVerifier compiled in this folder, byte for byte' : 'is NOT the MistVerifier compiled in this folder'}`);
  if (setup) out(`this folder's setup: ${setup.dev ? 'a DEVELOPMENT setup (not the one on mainnet)' : `${setup.ptau?.file || 'a ceremony ptau'}${setup.ptau?.sha256 ? ` (sha256 ${String(setup.ptau.sha256).slice(0, 16)}…)` : ''}`}, ${setup.constraints} constraints\n  zkey     ${setup.zkey}\n  wasm     ${setup.wasm}\n  verifier ${setup.verifier}\n  on disk now: zkey ${sha('public/zk/withdraw.zkey').slice(0, 16) || '(missing)'}…  wasm ${sha('public/zk/withdraw.wasm').slice(0, 16) || '(missing)'}…  ${sha('public/zk/withdraw.zkey') === setup.zkey && sha('public/zk/withdraw.wasm') === setup.wasm ? '(both match the setup)' : '(a file differs from the setup!)'}`);
  out(`\nhow to read it: a note is a Poseidon commitment in the pool's tree; spending one is a Groth16 proof that the verifier checks on chain, then the pool checks the root is one it sowed and the nullifier is new. Run \`node scripts/mist.mjs prove\` to make and submit a proof yourself.`);
} else if (cmd === 'prove') {
  if (!fs.existsSync(new URL('../public/zk/withdraw.wasm', import.meta.url))) fail('public/zk/withdraw.wasm is missing: build the circuit first (node zk/build.mjs)');
  const keys = M.randomKeys(); const denom = 10n ** 16n; const n = M.note(M.publicKey(keys), denom); const leaf = M.leafOf(n.commit, denom); const T = M.tree([[leaf]]); const sh = M.check(keys, n); if (sh === null) fail('the note does not scan with its own keys');
  const recipient = '0x000000000000000000000000000000000000bEEF'; const relayer = '0x0000000000000000000000000000000000000000';
  const w = M.witness({ keys, sh, denom, index: 0, path: T.path(0), root: T.root, recipient, relayer, fee: 0n });
  out(`a note made here: ${formatEther(denom)} ETH, commitment ${String(n.commit).slice(0, 18)}…, alone in a tree whose root is ${String(T.root).slice(0, 18)}…\nproving the withdrawal in this terminal (Groth16, ${setup?.constraints || 7106} constraints)…`);
  const t0 = Date.now(); const { proof, publicSignals } = await snarkjs.groth16.fullProve(w, new URL('../public/zk/withdraw.wasm', import.meta.url).pathname, new URL('../public/zk/withdraw.zkey', import.meta.url).pathname); const ms = Date.now() - t0;
  const vk = JSON.parse(fs.readFileSync(new URL('../zk/verification_key.json', import.meta.url), 'utf8')); const okLocal = await snarkjs.groth16.verify(vk, publicSignals, proof);
  out(`proved in ${ms} ms; public signals: root, nullifier hash, denomination, recipient, relayer, fee\n  ${publicSignals.map(x => String(x).slice(0, 24) + (String(x).length > 24 ? '…' : '')).join('\n  ')}\nverified here with zk/verification_key.json: ${okLocal}`);
  if (!pc) { out('no ETH_RPC_URL: the on-chain verifier was not asked'); } else {
  const pool = mistAddr(); const verifier = await read(pool, ABI.mist, 'verifier'); const cd = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`);
  const onChain = await read(verifier, VERIFIER_ABI, 'verifyProof', [cd[0].map(BigInt), cd[1].map(r => r.map(BigInt)), cd[2].map(BigInt), cd[3].map(BigInt)]);
  out(`asked the verifier on ${chainInfo().name} at ${verifier} (eth_call): ${onChain}`);
  const known = await read(pool, ABI.mist, 'isKnownRoot', [BigInt(publicSignals[0])]); const spent = await read(pool, ABI.mist, 'spent', [BigInt(publicSignals[1])]);
  out(`the pool's own checks on this proof: root known to the pool ${known} (this tree was made here, so the pool would refuse the withdrawal), nullifier already spent ${spent}\n${onChain ? 'the proof is sound and the pool is strict: the math on chain is the math in this folder' : 'the verifier on chain disagrees with this folder: the setup here is not the one deployed'}`);
  if (okLocal && !onChain) process.exit(1); }
} else if (cmd === 'trail') {
  if (!pc) fail('ETH_RPC_URL is needed (or --rpc)'); const token = words[1]; if (!/^0x[0-9a-fA-F]{40}$/.test(token || '')) fail('trail needs the coin\'s token address'); const T = getAddress(token); const pool = mistAddr(); const fees = getAddress(CONFIG.fees || await read(pool, ABI.mist, 'fees'));
  const sown = await logs(pool, parseAbiItem('event Sown(uint32 indexed batch, address indexed token, uint32 count, uint256 total, uint256 root)'), { token: T });
  const paidOpen = await logs(fees, parseAbiItem('event PaidHolders(address indexed token, uint256 total, uint256 count)'), { token: T }).catch(() => []);
  const keysSet = await logs(fees, parseAbiItem('event MistKeySet(address indexed holder, bytes key)'), {});
  const spentAll = await logs(pool, parseAbiItem('event Spent(uint256 indexed nullifierHash, address indexed recipient, uint256 denom, uint256 fee, address relayer)'), {});
  const site = (flag('--url') || process.env.HALCYON_SITE_URL || CONFIG.siteUrl || '').replace(/\/+$/, ''); let holders = null; try { holders = (await (await fetch(`${site}/api/coin/${T}/holders?limit=500`)).json()).top.map(h => h.address.toLowerCase()); } catch {}
  const latestKey = new Map(); for (const l of keysSet) latestKey.set(String(l.args.holder).toLowerCase(), l); const keyed = [...latestKey.values()].filter(l => String(l.args.key || '0x').length > 2 && (!holders || holders.includes(String(l.args.holder).toLowerCase())));
  out(`the mist trail of ${T} on ${chainInfo().name}\n\nkeys: ${keyed.length} holder${keyed.length === 1 ? '' : 's'} of this coin ${holders ? '' : '(holders unknown without the site: every key on the fees contract) '}carr${keyed.length === 1 ? 'ies' : 'y'} a mist key (two public keys, derived in the browser from one signature, set once with setMistKey)`);
  for (const l of keyed.slice(0, 50)) out(`  ${String(l.args.holder).toLowerCase()}  block ${l.blockNumber}  ${tx(l.transactionHash)}`);
  out(`\nrounds: ${sown.length} sown into the pool for this coin (payMist by the gardener: each note a Poseidon commitment only its holder can find)`);
  for (const l of sown) out(`  ${when(await block(l.blockNumber))}  batch ${l.args.batch}: ${l.args.count} note${Number(l.args.count) === 1 ? '' : 's'}, ${formatEther(l.args.total)} ETH, root ${String(l.args.root).slice(0, 14)}…  ${tx(l.transactionHash)}`);
  out(`\nin the open: ${paidOpen.length} payment${paidOpen.length === 1 ? '' : 's'} to holders without a key (payHolders, in plain ETH)`);
  for (const l of paidOpen.slice(-20)) out(`  ${when(await block(l.blockNumber))}  ${formatEther(l.args.total)} ETH to ${l.args.count} holders  ${tx(l.transactionHash)}`);
  out(`\nspends from the pool, all coins (the pool cannot tell which coin a note came from, which is the point): ${spentAll.length}${spentAll.length ? `; the latest ${Math.min(5, spentAll.length)}:` : ''}`);
  for (const l of spentAll.slice(-5)) out(`  ${when(await block(l.blockNumber))}  ${formatEther(l.args.denom)} ETH to ${l.args.recipient} (fee ${formatEther(l.args.fee)} to the relayer)  ${tx(l.transactionHash)}`);
  out(`\npool ${pool}  verifier ${await read(pool, ABI.mist, 'verifier')}  fees ${fees}`);
} else if (cmd === 'spends') {
  if (!pc) fail('ETH_RPC_URL is needed (or --rpc)'); const pool = mistAddr(); const n = Number(words[1] || 20);
  const spent = await logs(pool, parseAbiItem('event Spent(uint256 indexed nullifierHash, address indexed recipient, uint256 denom, uint256 fee, address relayer)'), {});
  out(`${spent.length} note${spent.length === 1 ? '' : 's'} spent from ${pool}: each a Groth16 proof the verifier accepted on chain, paying the recipient without saying which note or whose it was`);
  for (const l of spent.slice(-n)) out(`  ${when(await block(l.blockNumber))}  ${formatEther(l.args.denom)} ETH to ${l.args.recipient}, fee ${formatEther(l.args.fee)} ETH to ${l.args.relayer}, nullifier ${String(l.args.nullifierHash).slice(0, 14)}…  ${tx(l.transactionHash)}`);
} else fail(`unknown command ${cmd}: check | prove | trail 0xTOKEN | spends [n]`);
process.exit(0); /* snarkjs keeps worker threads alive; the work is done */
