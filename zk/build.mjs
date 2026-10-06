// Builds the Mist circuit: compiles zk/circuits/withdraw.circom (circom, the wasm build), runs the Groth16 setup on a powers-of-tau
// file, exports the verification key, the Solidity verifier (contracts/MistVerifier.sol) and the browser artifacts (public/zk/).
//   node zk/build.mjs --ptau ppot_0080_14.ptau                   a public ceremony file prepared for phase 2 (power 14 or more): what a deploy needs
//                                                                 (PSE's Perpetual Powers of Tau, pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_14.ptau, or Hermez's powersOfTau28_hez_final_14.ptau)
//   node zk/build.mjs --dev                                       a powers of tau made here and now, by this machine alone: tests and demos only
// The setup's phase 2 takes a contribution with fresh entropy here; add more with `snarkjs zkey contribute` before a mainnet deploy.
// zk/setup.json records what was built; the deploy script refuses a dev setup on a real chain.
//   node zk/build.mjs --restore zk/setups/<dir>                   put a kept setup back (after an unzip or a --dev build replaced it) and recompile the contracts
// A build on a public ceremony keeps a copy of its five files in zk/setups/<ptau>-<time>/ (nothing an unzip would overwrite): that copy is the
// mainnet circuit, the verifier to deploy and the prover the site serves, and belongs in the repository.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)); const build = path.join(root, 'zk', 'build'); fs.mkdirSync(build, { recursive: true });
const args = process.argv.slice(2); const flag = f => args.includes(f); const opt = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : ''; };
const say = s => fs.writeSync(1, `${s}\n`); const fail = s => { fs.writeSync(2, `${s}\n`); process.exit(1); };
const run = (bin, a, what, { cwd = root, timeout = 0 } = {}) => { const r = spawnSync(process.execPath, [bin, ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: timeout || undefined }); if (r.error && r.error.code === 'ETIMEDOUT') fail(`${what} did not finish in ${timeout / 1000} s:\n${r.stdout}\n${r.stderr}`); if (r.status !== 0) fail(`${what} failed:\n${r.stdout}\n${r.stderr}`); return r.stdout; };
const snark = path.join(root, 'node_modules', 'snarkjs', 'build', 'cli.cjs'); const circom = path.join(root, 'node_modules', 'circom2', 'cli.js');
/**
 * The circuit and every file it includes, copied flat into one directory with the includes rewritten to bare names, so the compiler (a
 * wasm with a unix filesystem, fed host paths by circom2's command line) never sees a directory separator: on Windows a path with
 * backslashes is one file name to it, and includes that climb to node_modules do not resolve the same way everywhere. Returns the directory.
 */
function flatten(entry) {
  const dir = path.join(build, 'src'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const seen = new Map(); const queue = [path.resolve(entry)];
  while (queue.length) {
    const file = queue.shift(); const name = path.basename(file); if (seen.has(name)) { if (seen.get(name) !== file) fail(`two included files share the name ${name}: ${seen.get(name)} and ${file}`); continue; } seen.set(name, file);
    const text = fs.readFileSync(file, 'utf8');
    const out = text.replace(/^(\s*include\s+")([^"]+)(";)/gm, (m, a, inc, z) => { const target = path.resolve(path.dirname(file), inc); if (!fs.existsSync(target)) fail(`${file} includes ${inc}, which is not there`); queue.push(target); return `${a}${path.basename(target)}${z}`; });
    fs.writeFileSync(path.join(dir, name), out);
  }
  return dir;
}
/** The five files a setup is made of, as (where they live, their name in a kept copy). */
const SETUP_FILES = [[path.join(root, 'contracts', 'MistVerifier.sol'), 'MistVerifier.sol'], [path.join(root, 'zk', 'setup.json'), 'setup.json'], [path.join(root, 'zk', 'verification_key.json'), 'verification_key.json'], [path.join(root, 'public', 'zk', 'withdraw.wasm'), 'withdraw.wasm'], [path.join(root, 'public', 'zk', 'withdraw.zkey'), 'withdraw.zkey']];
if (flag('--restore')) {
  const from = path.resolve(opt('--restore') || ''); if (!from || !fs.existsSync(path.join(from, 'setup.json'))) fail('--restore needs a kept setup directory (zk/setups/<dir>, with setup.json in it)');
  const kept = JSON.parse(fs.readFileSync(path.join(from, 'setup.json'), 'utf8'));
  for (const [dest, name] of SETUP_FILES) { if (!fs.existsSync(path.join(from, name))) fail(`${from} has no ${name}`); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(from, name), dest); }
  say(`restored the setup ${kept.dev ? '(DEVELOPMENT)' : 'on ' + kept.ptau.file} from ${path.relative(root, from)}; compiling the contracts so the verifier's artifact matches`);
  const r = spawnSync(process.execPath, [path.join(root, 'contracts', 'compile.mjs')], { cwd: root, stdio: 'inherit' }); if (r.status !== 0) fail('the contracts did not compile');
  say('done: the restored setup is in place'); process.exit(0);
}
const dev = flag('--dev'); let ptau = opt('--ptau'); if (!dev && !ptau) fail('give --ptau <file> (the public powers of tau), --dev (a local one, for tests only), or --restore <dir>');
/** A powers of tau file starts with the four bytes "ptau" and weighs megabytes; an error page saved under its name does neither. */
function checkPtau(file) {
  if (!fs.existsSync(file)) fail(`no such file: ${file}`);
  const size = fs.statSync(file).size; const head = Buffer.alloc(4); const fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
  if (head.toString('latin1') !== 'ptau' || size < 1_000_000) fail(`${file} is not a powers of tau file (${size} bytes, starting ${JSON.stringify(fs.readFileSync(file, 'latin1').slice(0, 120))}): the download gave an error page, not the file. Working sources (October 2026): the Ethereum Foundation PSE's Perpetual Powers of Tau, prepared for phase 2, https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_14.ptau (power 14; 13, 15 and 16 at the same place, see github.com/privacy-ethereum/perpetualpowersoftau); the Hermez files snarkjs's README names (storage.googleapis.com/zkevm/ptau/… and hermez.s3-eu-west-1.amazonaws.com/…) have been answering AccessDenied (iden3/snarkjs issue 636).`);
}

if (!dev) { ptau = path.resolve(ptau); checkPtau(ptau); }
// 1. compile: in a flat copy of the sources, with bare names only (the file, the output directory), nothing for a path separator to break
const src = flatten(path.join(root, 'zk', 'circuits', 'withdraw.circom')); fs.mkdirSync(path.join(src, 'out'), { recursive: true }); say(`compiling withdraw.circom (${fs.readdirSync(src).length} files, flat in zk/build/src; a minute or two, silent)`);
const out = run(circom, ['withdraw.circom', '--r1cs', '--wasm', '--sym', '--O2', '-o', 'out'], 'circom', { cwd: src, timeout: 15 * 60 * 1000 });
const constraints = Number((out.match(/non-linear constraints: (\d+)/) || [])[1] || 0); say(`  ${constraints} constraints`);
fs.mkdirSync(path.join(build, 'withdraw_js'), { recursive: true });
for (const [from, to] of [['withdraw.r1cs', 'withdraw.r1cs'], ['withdraw.sym', 'withdraw.sym'], [path.join('withdraw_js', 'withdraw.wasm'), path.join('withdraw_js', 'withdraw.wasm')]]) { const f = path.join(src, 'out', from); if (!fs.existsSync(f)) fail(`circom wrote no ${from}:\n${out}`); fs.copyFileSync(f, path.join(build, to)); }
// 2. the powers of tau
if (dev) {
  ptau = path.join(build, 'pot14_dev.ptau');
  if (!fs.existsSync(ptau)) { say('making a development powers of tau (power 14, a few minutes)'); run(snark, ['powersoftau', 'new', 'bn128', '14', path.join(build, 'pot14_0.ptau')], 'ptau new'); run(snark, ['powersoftau', 'contribute', path.join(build, 'pot14_0.ptau'), path.join(build, 'pot14_1.ptau'), '--name=dev', `-e=${crypto.randomBytes(32).toString('hex')}`], 'ptau contribute'); run(snark, ['powersoftau', 'prepare', 'phase2', path.join(build, 'pot14_1.ptau'), ptau], 'ptau prepare'); }
}
// 3. the circuit's setup
say('groth16 setup'); run(snark, ['groth16', 'setup', path.join(build, 'withdraw.r1cs'), ptau, path.join(build, 'withdraw_0.zkey')], 'setup');
run(snark, ['zkey', 'contribute', path.join(build, 'withdraw_0.zkey'), path.join(build, 'withdraw.zkey'), '--name=halcyon', `-e=${crypto.randomBytes(32).toString('hex')}`], 'zkey contribute');
run(snark, ['zkey', 'verify', path.join(build, 'withdraw.r1cs'), ptau, path.join(build, 'withdraw.zkey')], 'zkey verify');
// 4. the outputs
run(snark, ['zkey', 'export', 'verificationkey', path.join(build, 'withdraw.zkey'), path.join(root, 'zk', 'verification_key.json')], 'export vk');
run(snark, ['zkey', 'export', 'solidityverifier', path.join(build, 'withdraw.zkey'), path.join(build, 'Verifier.sol')], 'export verifier');
let sol = fs.readFileSync(path.join(build, 'Verifier.sol'), 'utf8');
sol = sol.replace(/pragma solidity [^;]+;/, 'pragma solidity ^0.8.28;').replace('contract Groth16Verifier', '/// @title MistVerifier: the Groth16 verifier of the Mist withdraw circuit, generated by snarkjs from zk/build/withdraw.zkey.\ncontract MistVerifier');
fs.writeFileSync(path.join(root, 'contracts', 'MistVerifier.sol'), sol);
fs.mkdirSync(path.join(root, 'public', 'zk'), { recursive: true });
fs.copyFileSync(path.join(build, 'withdraw_js', 'withdraw.wasm'), path.join(root, 'public', 'zk', 'withdraw.wasm')); fs.copyFileSync(path.join(build, 'withdraw.zkey'), path.join(root, 'public', 'zk', 'withdraw.zkey'));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const setup = { dev, at: new Date().toISOString(), constraints, ptau: { file: path.basename(ptau), sha256: sha(ptau) }, zkey: sha(path.join(build, 'withdraw.zkey')), wasm: sha(path.join(build, 'withdraw_js', 'withdraw.wasm')), verifier: sha(path.join(root, 'contracts', 'MistVerifier.sol')), vk: sha(path.join(root, 'zk', 'verification_key.json')) };
fs.writeFileSync(path.join(root, 'zk', 'setup.json'), JSON.stringify(setup, null, 1));
say(`done: ${dev ? 'DEVELOPMENT setup (never deploy this to a real chain)' : 'setup on ' + path.basename(ptau)}; contracts/MistVerifier.sol, zk/verification_key.json, public/zk/withdraw.{wasm,zkey}`);
if (!dev) {
  // a copy nothing overwrites: an unzip or a --dev build replaces the five files in place, `--restore` brings these back
  const keep = path.join(root, 'zk', 'setups', `${path.basename(ptau, '.ptau')}-${setup.at.replace(/[:.]/g, '').slice(0, 15)}`); fs.mkdirSync(keep, { recursive: true });
  for (const [src, name] of SETUP_FILES) fs.copyFileSync(src, path.join(keep, name));
  say(`kept a copy in ${path.relative(root, keep)}: the mainnet circuit (commit it); \`node zk/build.mjs --restore ${path.relative(root, keep).split(path.sep).join('/')}\` puts it back if a zip or a --dev build ever replaces it`);
}
