# Contributing

Thank you. Halcyon is small on purpose: one server file, a handful of modules, eleven contracts, one circuit. A good change keeps it that way.

## Setting up

```sh
git clone https://github.com/HALCYONCASH/HALCYONZK.git && cd HALCYONZK
npm ci
npm run build
npm run start:demo        # http://localhost:4180, the site on ten sample coins, no chain and no keys needed
npm run dev               # the site with hot reload (Vite) against the demo server
```

Node 22 or later. The contracts compile with `npm run contracts:compile` (solc-js, nothing to install); the circuit builds with `node zk/build.mjs --dev` (circom2 and snarkjs, both in `devDependencies`), which takes a few minutes the first time and makes a development setup the deploy script will refuse on a real chain. The build you clone already has the files the tests need.

## Before a pull request

```sh
npm run check             # tsc, 20 contract checks, 15 server checks, 53 deploy checks, 90 browser checks; about five minutes
node scripts/publish-check.mjs
```

`npm run check` is what the CI runs. The browser checks need a Chromium: the test finds Google Chrome, Chromium or Edge where they usually are, or a Playwright one in `~/.cache/ms-playwright` (`npx playwright-core install chromium`), and skips itself otherwise. `npm run build` must come before the browser checks, since they serve `dist/`.

A change to a contract comes with a contract test; a change to the gardener with a server test; a change to a page with a browser test. The tests derive what they assert from the chain or the demo rather than from numbers typed in, so they keep passing when the demo changes.

## The house style

- Plain words. Comments and docs say what a thing does and why, in sentences, without jargon the next reader would have to look up. Names are nouns for things and verbs for actions.
- No em dashes anywhere: in code, comments, docs, commit messages. A comma, a colon, a semicolon or a full stop does the job.
- One file per idea, lines as long as they need to be; the repository has no formatter, so match the file you are in.
- Nothing that sends money moves without `--go`; nothing reads a developer's `.env` in a test; no key, token or URL with a key in it goes into a file that git tracks, a screenshot or a chat. `node scripts/publish-check.mjs` stops the obvious cases; your eyes stop the rest.
- Every release note is a line in `CHANGELOG.md` that a creator or a holder could read.

## What we would love help with

- An audit, or any reading of the contracts and the circuit with an adversarial eye (see [`SECURITY.md`](SECURITY.md) for how to report what you find).
- Running Halcyon on another chain where Uniswap v3 and v4 and a Chainlink ETH/USD feed exist: `eth/config.mjs` holds the chain table, `scripts/deploy.mjs` the rest.
- Translations of the Docs page.

## Where things are

`README.md` has the map; `docs/model.md`, `docs/modules.md`, `docs/gardener.md` and `docs/deployment.md` go deeper, and the Docs page of the site (`src/pages/Docs.tsx`) is what a creator reads.
