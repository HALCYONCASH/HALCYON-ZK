// Compile contracts/*.sol with solc-js 0.8.28 into contracts/artifacts/<Name>.json (abi, bytecode, deployed bytecode, metadata) and
// <Name>.standard-input.json (the exact solc input with every imported source inlined, for Etherscan / Sourcify verification).
//   npm run contracts:compile
// Imports resolve from contracts/ (./Interfaces.sol) and from node_modules (@uniswap/v4-core/src/...), so an artifact's standard
// input is self-contained: verification needs nothing but that file and the constructor arguments.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const solc = require('solc');
export const NAMES = ['PoseidonT3', 'MistVerifier', 'HalcyonMist', 'HalcyonToken', 'HalcyonFees', 'HalcyonLocker', 'HalcyonV4Locker', 'HalcyonHook', 'HalcyonSwap', 'Halcyon', 'Create2Deployer', 'MockStock', 'MockFeed', 'Refuser'];
export const SETTINGS = { optimizer: { enabled: true, runs: 2000 }, evmVersion: 'cancun', viaIR: true, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } } };
/** PoseidonT3 is one block of assembly: the legacy pipeline with few runs keeps it under the size limit (the IR pipeline inflates it). */
export const OVERRIDES = { PoseidonT3: { optimizer: { enabled: true, runs: 1 }, viaIR: false } };
export const settingsFor = name => ({ ...SETTINGS, ...(OVERRIDES[name] || {}) });
const here = path.dirname(fileURLToPath(import.meta.url)); const nodeModules = path.join(here, '..', 'node_modules');
const dir = new URL('./artifacts/', import.meta.url); fs.mkdirSync(dir, { recursive: true });

/** Resolve an import path to its source text: a sibling contract, or a package file under node_modules. */
function findImports(p) {
  const local = path.join(here, p); if (fs.existsSync(local)) return { contents: fs.readFileSync(local, 'utf8') };
  const pkg = path.join(nodeModules, p); if (fs.existsSync(pkg)) return { contents: fs.readFileSync(pkg, 'utf8') };
  return { error: `not found: ${p}` };
}
/** Every source the compiler touched, inlined, so the standard input verifies on its own. */
function collectSources(entry, text) {
  const sources = { [entry]: { content: text } }; const seen = new Set([entry]); const queue = [[entry, text]];
  while (queue.length) {
    const [from, src] = queue.shift();
    for (const m of src.matchAll(/import\s+(?:[^;'"]*from\s+)?["']([^"']+)["']/g)) {
      let target = m[1];
      if (target.startsWith('.')) target = path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
      if (seen.has(target)) continue; seen.add(target);
      const r = findImports(target); if (r.error) throw new Error(`${from}: ${r.error}`);
      sources[target] = { content: r.contents }; queue.push([target, r.contents]);
    }
  }
  return sources;
}

let failed = false;
for (const name of NAMES) {
  const src = fs.readFileSync(new URL(`./${name}.sol`, import.meta.url), 'utf8');
  const sources = collectSources(`${name}.sol`, src);
  const settings = settingsFor(name); const input = { language: 'Solidity', sources, settings };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors || []).filter(e => e.severity === 'error'); const warnings = (out.errors || []).filter(e => e.severity !== 'error' && !/node_modules|@uniswap/.test(e.formattedMessage));
  for (const w of warnings) console.warn(`${name}: ${w.formattedMessage.trim().split('\n')[0]}`);
  if (errors.length) { failed = true; for (const e of errors) console.error(e.formattedMessage); continue; }
  const c = out.contracts[`${name}.sol`][name]; const meta = JSON.parse(c.metadata);
  const art = { contract: name, source: `contracts/${name}.sol`, compiler: `solc ${meta.compiler.version}`, evmVersion: settings.evmVersion, optimizer: settings.optimizer, viaIR: settings.viaIR, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object };
  fs.writeFileSync(new URL(`./artifacts/${name}.json`, import.meta.url), JSON.stringify(art, null, 1));
  fs.writeFileSync(new URL(`./artifacts/${name}.standard-input.json`, import.meta.url), JSON.stringify({ language: 'Solidity', sources, settings: { optimizer: settings.optimizer, evmVersion: settings.evmVersion, viaIR: settings.viaIR, outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } } } }, null, 1));
  console.log(`ok ${name}: ${meta.compiler.version}, ${c.evm.deployedBytecode.object.length / 2} bytes deployed, ${c.abi.filter(x => x.type === 'function').length} functions, ${Object.keys(sources).length} sources`);
}
if (failed) process.exit(1);
