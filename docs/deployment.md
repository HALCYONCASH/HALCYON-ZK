# The mainnet deployment

Halcyon is live on Ethereum mainnet since 5 October 2026. Everything below is public; the server reads the same facts from `deployments/mainnet.json`, the record `scripts/deploy.mjs` wrote, so the site, the gardener and the scripts need no address in their environment, only the RPC and the gardener's key.

## Contracts

| Contract | Role | Address |
| --- | --- | --- |
| Halcyon | the launchpad: a coin and its locked pool in one transaction; no privileged function | [`0x7B618B3AE41E415cf4c5B16d16CCa53a39eb6ebC`](https://etherscan.io/address/0x7B618B3AE41E415cf4c5B16d16CCa53a39eb6ebC) |
| HalcyonFees | every fee lands here; the 80/20; the pots and the eight modules under the gardener's bounds | [`0x5E2d61F8DF43c3822874265a5BA465bD9C817c0e`](https://etherscan.io/address/0x5E2d61F8DF43c3822874265a5BA465bD9C817c0e) |
| HalcyonLocker | holds every Uniswap v3 position forever; collects for the gardener | [`0xC500AacF89e7b71603e548Ab30071b44D68b5F91`](https://etherscan.io/address/0xC500AacF89e7b71603e548Ab30071b44D68b5F91) |
| HalcyonV4Locker | the same for Uniswap v4 positions | [`0x971899de5a477d2454C182276d27c6ad4A428D65`](https://etherscan.io/address/0x971899de5a477d2454C182276d27c6ad4A428D65) |
| HalcyonHook | the rules of every v4 pool (opening fee, max per swap, sell fee, one liquidity provider); at an address whose low bits spell its permissions | [`0x313EA55aA2dF26138b1Df5CF04feF6Af030e98c0`](https://etherscan.io/address/0x313EA55aA2dF26138b1Df5CF04feF6Af030e98c0) |
| HalcyonSwap | the simplest router for v4 pools, and the multi-hop path Harvest buys stocks through; anyone may use it | [`0x0999bC1e733b6ED29d9b6372169168A000cd6F20`](https://etherscan.io/address/0x0999bC1e733b6ED29d9b6372169168A000cd6F20) |
| HalcyonToken | the coin: every coin is an EIP-1167 clone of this implementation, which is locked and never a coin itself | [`0x77CC56f66c6d9cDc4Cf99166b2843b0Bd51C4a15`](https://etherscan.io/address/0x77CC56f66c6d9cDc4Cf99166b2843b0Bd51C4a15) |
| HalcyonMist | the pool of private notes (denominations 0.01, 0.1 and 1 ETH) | [`0x3720C2a9950Aefd5AaCCa9F1dA883CABda543E5b`](https://etherscan.io/address/0x3720C2a9950Aefd5AaCCa9F1dA883CABda543E5b) |
| PoseidonT3 | the hash of the mist tree | [`0x1CF4111BD1cba48F5F30eFe566Bded99BdB294ff`](https://etherscan.io/address/0x1CF4111BD1cba48F5F30eFe566Bded99BdB294ff) |
| MistVerifier | the Groth16 verifier of the withdraw circuit | [`0x354B35ADA4E9D18077ab67b6c86bEDeeFf0DE15e`](https://etherscan.io/address/0x354B35ADA4E9D18077ab67b6c86bEDeeFf0DE15e) |

The CREATE2 deployer that placed the hook, and every deployment transaction's hash, are in `deployments/mainnet.json`. The first contract went in at block 26,128,417, which is where the indexer starts (`HALCYON_DEPLOY_BLOCK`).

## Wallets

- **Platform wallet** `0x7dfa877468749898B9B8BA69FbB2BcaD68967304`: owns HalcyonFees. It can withdraw the platform pot, rotate the gardener, allow stocks and hand itself over, nothing else. Its actions come as calldata from `node scripts/admin.mjs` and `node scripts/stocks.mjs calldata`, to send from a browser wallet or from Etherscan's Write Contract form; with its key in `.env` as `HALCYON_PLATFORM_KEY`, `node scripts/stocks.mjs allow --routed --go` and `node scripts/admin.mjs … --go` send them from the script (dry without `--go`, refused when the key is not the platform the contract names).
- **Deployer** `0x6b83F38bC718F30370Dc1Cf8eb3A72FFAec24c32` (halcyoncash.eth): paid the deployment, wired the fees contract once and set the mist pool once; it has no power over the contracts now.
- **Gardener**: the server's hot key, bounded by the contract to a coin's own holders, buyback, stock or mist notes. The deployment set it to the deployer's address; the platform wallet rotates it to a fresh key with `setGardener` before the server runs with a key (`node scripts/admin.mjs set-gardener 0xNEW`), and that fresh key is what `HALCYON_GARDENER_KEY` holds.

## Uniswap and Chainlink

The launchpad builds on Uniswap's own contracts: v3 factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`, NonfungiblePositionManager `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`, SwapRouter02 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, QuoterV2 `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`, the v4 PoolManager `0x000000000004444c5dc75cB358380D2e3dE08A90`, its StateView `0x7ffe42c4a5deea5b0fec41c94c136cf115597227` and V4Quoter `0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203`, WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`; and on Chainlink's ETH/USD feed `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` for the dollar cap every launch starts at.

## The mist circuit

`zk/circuits/withdraw.circom`, 7,106 constraints, Groth16 over BN254. The setup was built on `ppot_0080_14.ptau`, the Ethereum Foundation PSE's Perpetual Powers of Tau (contribution 80, with a randao beacon) prepared for phase 2, with one Halcyon contribution whose entropy was random and never written down; `zk/setup.json` records the ptau's sha256 and the hashes of the zkey, the wasm, the verifier and the verification key, and `zk/setups/ppot_0080_14-2026-10-05T1953/` keeps a copy of the five files. The verifier on chain was compiled from that setup, and the server refuses to serve a prover that does not match it (`/api/mist` reports `zk.ok`). A holder who wants to trust nobody can rebuild the verifier from the kept zkey (`snarkjs zkey export solidityverifier`) and compare it with the verified source on Etherscan.

## Verification

`ETHERSCAN_API_KEY=… node scripts/verify.mjs` submits every contract's standard-input JSON with the constructor arguments rebuilt from the record (compiler 0.8.28, via IR, optimizer 2000 runs, EVM cancun). The same JSON files (`contracts/artifacts/<Name>.standard-input.json`) verify by hand in the explorer's form.

## Running it

- **Host.** `render.yaml` describes the service; the repository carries the deployment record, the circuit and the stock seed, so the dashboard needs `ETH_RPC_URL` and `HALCYON_GARDENER_KEY`. Start with `HALCYON_GARDENER_ENABLED=0` (the site and the indexer run, the gardener only reports at `/api/gardener`), fund the gardener, then set it to 1. `HALCYON_SOURCE_URL` puts a source link in the footer.
- **Metadata.** With `PINATA_JWT` set (and `PINATA_GATEWAY_URL` naming your gateway), a launch's picture and metadata record are pinned to IPFS and the coin's uri on chain is `ipfs://<cid>`; the site keeps a copy of both and serves them itself, and reads the records of coins launched elsewhere from their uri. Without the JWT the site hosts the metadata at `/m/<key>.json`, content-addressed and immutable.
- **Stocks.** The seed carries every Ondo Stocks token on mainnet with the routes `catch` found; a seed that gains routes later (another `bake`, a new version) reaches a running server's registry at its next start: new stocks are added, missing routes taken, the operator's own rows kept; the platform wallet allows the routed ones in one transaction with the calldata from `node scripts/stocks.mjs calldata --routed`, once the issuer's terms have had a legal look (Ondo bars US persons). `node scripts/stocks.mjs catch --all --quiet --go` finds new pools later; `bake` puts them into the seed for the next deploy of the site.
- **The platform's coin.** `HALCYON_PLATFORM_COIN=0x…` (its token address) once it is launched: the site shows it as official and first, and marks every other coin wearing its name or its symbol as a lookalike, with a link to the real one on its page. Anyone can launch under any name; the launchpad has no say in that, so the mark is the defence.
- **Hidden coins.** `HALCYON_HIDDEN_COINS=0x…,0x…` keeps coins out of the lists, the search and the numbers. Their pages, pools and modules stay (the chain does not forget them, and holders must be able to trade and claim); the page says the site keeps them out of the lists. The gardener tends hidden coins like any other.
- **Watching the gardener.** `node scripts/gardener.mjs` (status, the transaction out right now, the ledger) and `node scripts/gardener.mjs plan` (every coin: module, holders, pool fees, pot, what is due, why it waits) read the site's `/api/gardener`; nothing to configure.
- **Keys.** A provider key or a wallet key that was ever pasted into a chat, a screenshot or a commit is burned: rotate it. The gardener's key lives on the host and nowhere else, and is used by nothing else: the gardener sends one transaction at a time at its own nonce, follows it until it is in a block, and replaces anything else it finds waiting at that nonce (`docs/gardener.md`, Sending).
