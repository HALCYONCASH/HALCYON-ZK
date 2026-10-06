# The Halcyon model

Halcyon is a launchpad on Ethereum mainnet. One transaction makes a coin and its Uniswap pool, with every coin of the supply in the pool from the first block and the liquidity locked forever. The pool is the curve. Every trade pays the pool's 1%, and because Halcyon holds all of the pool's liquidity the whole 1% is the coin's: the gardener collects it, 20% keeps the platform and the gardener running, 80% goes where the creator aimed it. Nobody but the launcher ever pays gas for a coin's housekeeping.

## Supply

Every coin has 1,000,000,000 units with 18 decimals, minted once to the launchpad when it is launched and put, all of it, into the pool. There is no mint function, no owner, no pause, no blacklist, no tax and no max wallet. Dust the position math cannot take is burned at launch, so the supply is exactly what the pool holds.

## The pool is the curve

The launch creates a Uniswap pool at the 1% fee tier and mints one single-sided position into it: all the coins, from the starting price up to the top of the range, no ETH. The starting price comes from the market cap the creator chose in dollars ($4K, $5K, $7K, $10K, or any figure from $1,000 to $1,000,000), read from Chainlink's ETH/USD feed at that moment and rounded to the pool's tick spacing (at most 2% below the figure). The feed must be fresh (three hours at most) or the launch reverts.

A single position is a constant-product curve. With `M₀` the starting cap and `M` a later one, the ETH it takes to get there is

    y = √(M₀ × M) − M₀      (before fees)

From $5K: about $17.4K of buys reach a $100K cap, $66K reach $1M, $219K reach $10M. Every ETH paid in stays in the pool as the curve's reserve, so every coin can always be sold back into it; a sell walks the price back down the same line.

Two layouts, one curve:

- **v3**: the coin is token0 (its address is chosen through the launch's salt to sort below WETH), price is WETH per coin, the position is `[startTick, 887200]`, buys push the price up the range. Liquidity `L = S × √Pa × √Pb / (√Pb − √Pa)`.
- **v4**: native ETH is currency0 and the coin currency1, price is coins per ETH, the position is `[−887200, startTick]`, buys push the price down the range. `L = S × 2⁹⁶ / (√Pb − √Pa)`.

`shared/pool.mjs` holds this math in BigInt, mirrored from Uniswap's own, and the tests check the chain against it to one part in a billion.

## Locked

The v3 position is minted to `HalcyonLocker`, which owns the NFT and has no function that transfers it or decreases its liquidity. The v4 position is held by `HalcyonV4Locker`, which adds liquidity in its own unlock callback and has no function that removes it. Neither Halcyon nor anyone else can pull the pool. The one thing the lockers do is `collect`: gather the fees the position earned, sell the coin side for ETH through the same pool, and deposit the ETH in `HalcyonFees`.

## Two pools

**Standard** is a Uniswap v3 pool against WETH. Every router, aggregator and screener knows it; the position is one of millions. Launching one costs about 5.6M gas, most of it the pool contract v3 deploys per pair.

**Rules** is a Uniswap v4 pool against native ETH with the Halcyon hook. Launching one costs about 760k gas (v4 is a singleton). The creator sets rules at launch, fixed from then on, and the hook enforces them on every swap through Uniswap itself, whoever routes it:

| rule | what | bounds |
|---|---|---|
| opening fee | buys in the first minutes pay a fee that starts high and falls in a straight line to 1% over the window | up to 90%, window up to a day |
| max per swap | during the window no single swap may take more than this share of the supply | 0.25% and up, or none |
| sell fee | sells pay this forever | 1% to 5% |
| one liquidity provider | only the Halcyon locker may add liquidity, so every fee the pool charges is the coin's | always |

None of the rules needs to know who is trading, so they hold for aggregators, bots and contracts alike, and a buy split across many transactions pays the opening fee on each. The founder's own buy in the launch transaction pays the base 1% instead of the opening fee, and must respect the max per swap. The hook refuses to initialize any pool the launchpad did not prepare, so it serves Halcyon coins only.

## Fees

Every trade pays the pool's fee to the position: 1% on a v3 pool; on a v4 pool the opening fee during the window and 1% after on buys, the sell fee on sells. Wallet-to-wallet transfers are free. Nothing is taken at launch.

The gardener collects when the fees are worth the gas (`HALCYON_COLLECT_MIN_ETH`): the coin side is sold for ETH in the same pool with a minimum out, and the ETH is deposited in `HalcyonFees`, where 20% goes to the platform pot and 80% to the coin, by its module (`docs/modules.md`).

## Numbers

Gas on the local EVM with the real Uniswap v3 and v4 bytecode (mainnet will be the same within a few percent):

| action | gas |
|---|---|
| launch on v3 (pool contract, position, locker) | 5,585,061 |
| launch on v4 (pool init, position, hook) | 756,563 |
| buy on v3 (SwapRouter02) | 163,444 |
| sell on v3 (SwapRouter02, unwrap) | 145,671 |
| buy on v4 (HalcyonSwap) | 173,739 |
| sell on v4 | 134,501 |
| collect, v3 | 380,069 |
| collect, v4 | 232,528 |
| payHolders, 4 holders | 137,374 (about 10k per extra holder) |
| buyback and burn | 180,346 (v3), 161,360 (v4) |
| buyStock | 227,276 |
| deploy: token impl, fees, launchpad, locker, v4 locker, swap, hook | 739,832 + 3,418,469 + 3,085,943 + 888,542 + 1,646,164 + 1,003,248 + about 1,300,000 |
