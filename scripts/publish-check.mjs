// Before a push: what would go public? Walks the folder the way git would (the .gitignore rules; node_modules, dist, .data and
// the like stay out) and reads every file that would be pushed for what must never leave the machine:
//   an environment file (.env, .env.render; .env.example is fine), a key or certificate file, a private key on a line that calls
//   it one, an API token by its shape (Alchemy, a provider URL with a key in it, a JWT like Pinata's, GitHub, AWS, Slack, Stripe),
//   a seed phrase in a string, a zip or a ceremony file (.ptau) that has no place in a repository, a file GitHub refuses (100 MB).
//   node scripts/publish-check.mjs [dir] [--quiet]     reads only; exits 1 when something must not be pushed, 0 when the tree is clean
// It reads for shapes, so it cannot know every secret: a key pasted as a plain number passes it. Read your diff as well.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2); const quiet = argv.includes('--quiet');
const root = path.resolve(argv.find(a => !a.startsWith('--')) || fileURLToPath(new URL('..', import.meta.url)));
const out = m => { if (!quiet) fs.writeSync(1, `${m}\n`); }; const say = m => fs.writeSync(1, `${m}\n`);

// --- which files would be pushed: git's own answer when the folder is a repository, the .gitignore rules otherwise ---
const git = (...args) => { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); return r.status === 0 ? r.stdout : null; };
const toRegex = glob => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*')}$`);
function ignoreRules() {
  const rules = [{ neg: false, dir: true, anchored: false, re: toRegex('.git') }];
  let text = ''; try { text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); } catch {}
  for (let line of text.split('\n')) {
    line = line.trim(); if (!line || line.startsWith('#')) continue;
    const neg = line.startsWith('!'); if (neg) line = line.slice(1);
    const dir = line.endsWith('/'); if (dir) line = line.slice(0, -1);
    const anchored = line.includes('/'); if (line.startsWith('/')) line = line.slice(1);
    rules.push({ neg, dir, anchored, re: toRegex(line) });
  }
  return rules;
}
function ignored(rel, isDir, rules) {
  let ig = false; const base = path.posix.basename(rel);
  for (const r of rules) { if (r.dir && !isDir) continue; const hit = r.anchored ? r.re.test(rel) : r.re.test(base); if (hit) ig = !r.neg; }
  return ig;
}
function walk(rules) {
  const files = [], kept = [];
  const visit = dir => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (ignored(rel, e.isDirectory(), rules)) { kept.push(rel + (e.isDirectory() ? '/' : '')); continue; }
      if (e.isDirectory()) visit(rel); else if (e.isFile()) files.push(rel);
    }
  };
  visit(''); return { files, kept };
}
let files, kept, how;
const tracked = git('ls-files', '--cached', '--others', '--exclude-standard', '-z');
if (tracked !== null) { files = tracked.split('\0').filter(Boolean).filter(f => fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile()); kept = (git('ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z') || '').split('\0').filter(Boolean); how = 'as git lists them'; }
else { ({ files, kept } = walk(ignoreRules())); how = 'by the .gitignore rules (not a git repository yet)'; }

// --- the shapes ---
const BINARY = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|wasm|zkey|ptau|r1cs|sym|zip|gz|tgz|pdf|bin|mp4|mov|map)$/i;
const SECRET_FILE = [[/^\.env(\..+)?$/, 'an environment file'], [/\.(pem|key|p12|pfx|keystore|jks)$/i, 'a key or certificate file'], [/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, 'an SSH key'], [/keypair.*\.json$/i, 'a keypair file'], [/^\.npmrc$/, 'an npm config (it can hold a token)'], [/\.ptau$/, 'a ceremony file: too big for a repository, downloaded by whoever builds'], [/\.zip$/i, 'a zip']];
const FINE_FILE = [/^\.env\.example$/];
const SHAPES = [
  ['an Alchemy key', /\balch_[A-Za-z0-9]{20,}/g],
  ['a provider URL with a key in it', /https?:\/\/[^\s'"`<>]*?(alchemy|infura|quiknode|quicknode|getblock|helius|ankr|chainstack|blastapi|drpc|moralis)[^\s'"`<>]*\/(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}/gi],
  ['a key in a URL query', /[?&]api[-_]?key=(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{16,}/gi],
  ['a JWT (Pinata hands these out)', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['an AWS key id', /\bAKIA[0-9A-Z]{16}\b/g],
  ['a Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['a Stripe key', /\b[sr]k_live_[A-Za-z0-9]{16,}/g],
];
const PHRASE = /["'`]((?:[a-z]{3,8} ){11,23}[a-z]{3,8})["'`]/g; let bip39 = null; try { bip39 = new Set((await import('@scure/bip39/wordlists/english')).wordlist); } catch {} /* viem brings the wordlist; without it, any twelve short words in a string are reported */
const seedPhrase = s => { const words = s.split(' '); return (words.length === 12 || words.length === 15 || words.length === 18 || words.length === 21 || words.length === 24) && (!bip39 || words.every(w => bip39.has(w))); };
const KEYWORD = /private|secret|mnemonic|_KEY\b|\bkey\s*[:=]|privateKey|PRIVATE_KEY|signer|wallet/i; const HEX64 = /\b(?:0x)?[0-9a-fA-F]{64}\b/g;
const KNOWN_HEX = /^(tests|contracts)\//; /* hardhat's published accounts live in the tests (the same for every hardhat node, never funds on a real chain); the contracts and their artifacts hold constants and bytecode */
const mask = s => (s.length <= 12 ? s.replace(/./g, '•') : `${s.slice(0, 4)}…${s.slice(-4)} (${s.length} chars)`);

const problems = [], warnings = []; let looked = 0, bytes = 0;
const copies = new Set(files.map(f => f.split('/')[0]).filter(d => /^halcyon-\d+\.\d+\.\d+/.test(d))); for (const d of copies) problems.push(`${d}/: a copy of the project inside the project (an unpacked zip); move it out`);
for (const rel of files) {
  const abs = path.join(root, rel); const base = path.basename(rel); const size = fs.statSync(abs).size; looked++; bytes += size;
  if (!FINE_FILE.some(re => re.test(base))) for (const [re, what] of SECRET_FILE) if (re.test(base)) problems.push(`${rel}: ${what}`);
  if (size > 100 * 1024 * 1024) problems.push(`${rel}: ${(size / 1048576).toFixed(0)} MB, which GitHub refuses (100 MB)`); else if (size > 50 * 1024 * 1024) warnings.push(`${rel}: ${(size / 1048576).toFixed(0)} MB, which GitHub warns about (50 MB)`);
  if (BINARY.test(base) || size > 20 * 1024 * 1024) continue;
  let text; try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; } if (text.includes('\0')) continue;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [what, re] of SHAPES) for (const m of line.matchAll(re)) problems.push(`${rel}:${i + 1}: ${what}: ${mask(m[0])}`);
    if (!KNOWN_HEX.test(rel)) for (const m of line.matchAll(PHRASE)) if (seedPhrase(m[1])) problems.push(`${rel}:${i + 1}: a seed phrase in a string: ${mask(m[1])}`);
    if (!KNOWN_HEX.test(rel) && KEYWORD.test(line)) for (const m of line.matchAll(HEX64)) problems.push(`${rel}:${i + 1}: a 32-byte hex next to a word like key or secret: ${mask(m[0])}`);
  }
}
const keptSecrets = kept.filter(k => /(^|\/)\.env(\..+)?$|\.zip$|\.ptau$|(^|\/)\.data|\.hardhat|deployments\/.*partial/.test(k) && !/\.env\.example$/.test(k));
out(`${looked} files, ${(bytes / 1048576).toFixed(1)} MB would be pushed from ${root} (${how})`);
if (keptSecrets.length) out(`kept out by .gitignore: ${keptSecrets.slice(0, 12).join(', ')}${keptSecrets.length > 12 ? ` and ${keptSecrets.length - 12} more` : ''}`);
for (const w of warnings) say(`warning  ${w}`);
for (const p of problems) say(`STOP     ${p}`);
if (problems.length) { say(`\n${problems.length} thing${problems.length > 1 ? 's' : ''} must not be pushed. Remove or ignore ${problems.length > 1 ? 'them' : 'it'} and run this again; if a real key was ever committed, rotate it (a force push does not unpublish it).`); process.exit(1); }
say(`${warnings.length ? `${warnings.length} warning${warnings.length > 1 ? 's' : ''}, ` : ''}nothing that must not be pushed`);
