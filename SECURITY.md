# Security

Halcyon holds other people's liquidity in contracts that cannot give it back. Found a way around that, or anything else that would cost a holder, a creator or the platform money? Please tell us first and give us time to act.

## Reporting

- Write to the project privately through GitHub: **Security → Report a vulnerability** on this repository (a private advisory; only the maintainers see it).
- Or by direct message to [@halcyoncash](https://x.com/halcyoncash) on X, asking for a private channel. Do not put the details in a public post, an issue or a pull request.

Say what you found, where (contract, server, site, circuit), how to reproduce it, and what it lets an attacker do. A proof of concept against a local `hardhat node` (see `tests/deploy.test.mjs` for how the tests stand one up) is the fastest way to be understood. We answer within three days and keep you informed until it is fixed; we credit you in the changelog if you want to be credited.

Do not test against the mainnet contracts with other people's funds, and do not run a found exploit on mainnet "to prove it": the local chain proves it as well.

## What is in scope

- The contracts in `contracts/` as deployed on mainnet (`deployments/mainnet.json`): anything that moves liquidity out of a locker, pays a pot to the wrong party, lets a coin be minted, paused or taxed, breaks a rules pool's rules, or spends a mist note twice or without the key.
- The circuit in `zk/circuits/withdraw.circom` and its setup: a proof for a note that is not in the tree, a nullifier that does not bind, a way to learn which note is whose from what is public.
- The server (`server.mjs`, `eth/`): the gardener doing something the contract allows but the ledger does not say, the RPC proxy or the relayer being used for something other than their purpose, anything that leaks the gardener's key.
- The site (`src/`): a trade or a launch signed for something other than what the screen said; a mist key leaving the browser.

Out of scope: Uniswap, Chainlink and the issuers of tokenized stocks (report those to them); rate limits on the public API; the demo mode; typos.

## What we do on our side

- No admin key can touch a coin or a pool: there is no owner, mint, pause, blacklist or fee switch, and the lockers have no way to move liquidity. The platform wallet can only withdraw the platform's own pot, rotate the gardener, allow stocks and hand itself over. A stolen gardener key can only move a coin's pot to that coin's holders, buyback, allowed stock, or into mist notes of the pool's denominations.
- Keys live in the environment of the machine that needs them (`.env`, which `.gitignore` keeps out, or the host's dashboard), never in the repository, the site, a log or a chat. `node scripts/publish-check.mjs` reads the tree for the shapes of keys and tokens before a push; the CI runs it on every commit.
- The money scripts are dry by default and send only with `--go`; the tests never read a developer's `.env`; the deploy script refuses a development circuit setup on a real chain.
- The contracts are tested against the real Uniswap v3 and v4 bytecode on a local EVM (`npm run check`), and the circuit's setup is recorded so anyone can rebuild the verifier and compare it with the one on chain (`node scripts/mist.mjs check`). **They have not been audited.** Treat Halcyon as new code on mainnet, because it is.
