# The gardener

The gardener is the one hot key the platform runs. It pays the gas nobody else should: it collects every coin's pool fees as ETH and pays the modules. It is funded from the platform's 20%, which is what the 20% is for. It lives in the server process (`eth/gardener.mjs`) next to the indexer and runs a tick every `HALCYON_GARDENER_INTERVAL_MS` (a minute by default).

## What a tick does

For every indexed coin, in order:

1. **collect**: the gardener simulates the locker's `collect` to see what the position has earned; when it is worth at least `HALCYON_COLLECT_MIN_ETH` it sends it. The locker gathers the fees, sells the coin side for ETH in the same pool (minimum out: the simulated figure minus `HALCYON_GARDENER_SLIPPAGE_BPS`) and deposits the ETH, 80% to the coin's pot, 20% to the platform.
2. **the module**, in the next tick, when the pot holds at least `HALCYON_PAYOUT_MIN_ETH`:
   - Rain: pro-rata shares from the indexer's balances, those below `HALCYON_PAYOUT_MIN_SHARE_ETH` left in the pot, paid in batches of `HALCYON_PAYOUT_BATCH`. Before each batch the gardener estimates its gas; a batch whose gas would exceed `HALCYON_PAYOUT_MAX_GAS_PCT` of what it pays waits for a bigger pot.
   - Rings: the same, each holder weighted by balance times days held (one to thirty).
   - Prune: buys the coin back with the whole pot through its own pool and burns it (`burn` on the coin: the supply falls). On a rules pool the pot waits for the opening window to end first, since a buy inside it would pay the opening fee and meet the max per swap.
   - Harvest: buys the coin's stock along the registered route (`buyStock` through Uniswap v3, or `buyStockV4` through Uniswap v4 hops), at most `HALCYON_STOCK_MAX_BUY_ETH` per buy, minimum out from the matching quoter; stock already held is paid out to holders of at least 10,000 coins.
   - Clover: opens a draw when none is open; pays the drawn holder once the draw block is in; opens a new one when a draw expired.
   - Mist: the keyed holders' shares as notes of the pool's denominations (largest first, the remainder rounded by lot with the latest block hash; at most `HALCYON_MIST_MAX_NOTES` a round, the rest waits), each note a fresh commitment for its holder's mist key, shuffled, sown through `payMist`; the keyless holders' exact shares through `payHolders`. The ledger entry names counts and denominations, never a holder; nothing that links a note to a holder is written anywhere. The gardener's key is also the relayer's: `/api/mist/relay` verifies a holder's proof and sends the withdrawal, for the fee the proof fixed.
   - Roots and Branch: nothing, the fees contract pushed those at deposit.
3. At most `maxTxPerTick` (6) transactions per tick, and no tick at all while the gas price is above `HALCYON_GAS_CAP_GWEI`.
4. **Patience.** The thresholds say when a coin is tended at once. Under them a coin is still tended every `HALCYON_GARDENER_PATIENCE_MIN` minutes (fifteen), as long as what is due is worth ten times its gas (`HALCYON_PAYOUT_MAX_GAS_PCT`, the share of a payout its gas may take) at the gas price of the moment: a small coin sees its fees collected and its module paid at a steady rhythm instead of waiting for a pot it may never fill, and the gas never eats more than a tenth of anything. The plan (`/api/gardener?plan=1`, `node scripts/gardener.mjs plan`) says for each coin whether it waits for the threshold, for the patience to run, or for the sum to be worth its gas.

Every action, sent or dry, becomes a ledger entry (`DATA_DIR/halcyon-ledger.json`, capped at 5,000 entries) and the site shows the ledger on `/api/gardener`.

## Sending

The gardener sends one transaction at a time (`eth/sender.mjs`), and each goes out with fees of its own: twice the base fee of the moment plus a tip (the node's estimate, or `HALCYON_GARDENER_TIP_GWEI`, 0.1 gwei, when that is lower), the whole under `HALCYON_GAS_CAP_GWEI`. Only the base fee of the block it lands in is paid, so the headroom costs nothing in the usual case and keeps the transaction mineable through the next rise; a transaction priced at the base fee of the moment, the default of most libraries, is stranded by the first full blocks after it. Its nonce is read from the chain when it is sent.

A transaction that is not in a block after two minutes is not a failure. It is kept on disk (`DATA_DIR/halcyon-pending.json`) as pending, its ledger entry says `pending`, and every tick (and the first tick after a restart) follows it: in a block, the entry is settled with the hash that went in, its block and its gas; waiting longer than two and a half minutes since it was last sent, it is sent again at the same nonce with fees fifteen percent higher, and at least the fees of now (a bump that would pass the gas cap waits for gas to fall); its nonce used by a transaction that is none of its own, it is given up and the entry says so, because that means the key was used somewhere else. Nothing else goes out while one is pending: behind a stuck transaction everything is stuck, and a second collect of the same coin would only pay gas for nothing. The tick logs `waiting for …` and `/api/gardener` shows `pending` (the label, the nonce, the hashes, when it went out, the bumps). A payout of several batches waits ten minutes for each batch, and leaves the rest for a later tick if one stays out that long.

A transaction waiting at the gardener's nonce that this process never sent (one from before an update, or from a wallet that shares the key, which it must not) is replaced by the next one sent, with fees raised until the node accepts the replacement, since anything behind it would wait as long as it does.

## Watching it

`/api/gardener` says whether the gardener is on, what transaction is out right now (label, nonce, hashes, when it went out, bumps) and the last ledger lines; `/api/gardener?plan=1` adds the plan: every coin as the gardener sees it this minute (module, holders, the fees a collect would bring, the pot, the stock held) with what is due (the same actions a tick would send) and, when nothing is, why it waits (fees under the collect threshold, a pot under the payout threshold, a module the fees contract pays at deposit, a draw block not yet mined, no holder big enough for a stock payout). `node scripts/gardener.mjs [status | plan | log]` prints both from anywhere (`--url` picks the site).

## Modes

- **off** (`HALCYON_GARDENER_ENABLED` unset, no `HALCYON_GARDENER_DRY`): the indexer runs, the gardener does not; fees keep accruing to the positions until it is turned on.
- **dry** (`HALCYON_GARDENER_DRY=1`): every action is computed and recorded as `dry`; nothing is sent. Run this first on mainnet and read the ledger.
- **on** (`HALCYON_GARDENER_ENABLED=1` and `HALCYON_GARDENER_KEY` set): the actions are sent.

The key never leaves the process: it is read from the environment, never logged, never served. The address that goes with it is what you give `scripts/deploy.mjs` as `HALCYON_GARDENER` (the platform wallet can rotate it later with `HalcyonFees.setGardener`).

## Funding

The gardener pays gas from its own balance, so it needs ETH. Fund it from the platform pot: the platform wallet calls `withdrawPlatform(gardener, amount)`, or sends from anywhere. The thresholds above are what keep the gardener's spend proportionate: a payout is skipped when the gas would eat more than a tenth of it, a collect waits until the tax is worth collecting, and nothing is sent above the gas cap.

A rough budget at 2 gwei: a v3 collect costs about 0.0008 ETH, a v4 collect 0.0005, a 120-holder payout 0.0025, a buyback 0.0004, a clover draw 0.0002, a mist round of a few notes about 0.003 (Poseidon in the EVM is the cost: about 55k gas a note), a relayed withdrawal 0.0007 (paid back by the fee). Watch `/api/gardener` and the gardener's balance in the logs; the server logs a line per tick when it does anything.

## What it cannot do

The contract bounds the gardener: a coin's pot can only go to that coin's holders (each checked to hold the coin), that coin's buyback or that coin's allowed stock, or under Mist to notes of the pool's denominations (the one place the chain cannot check the recipient, so there a stolen key could sow a round to keys of its own); the platform pot is the platform wallet's alone; modules, branches and creators are the creator's alone; the liquidity is nobody's to move; the mist pool pays nothing without a proof. A stolen gardener key can waste the gardener's own gas, collect with a poor minimum out, pay pots out early or in odd batches (a clover draw to a holder of its choosing, a mist round to itself, are the worst of it), nothing more; rotate it with `setGardener` from the platform wallet.

## The numbers

`/api/stats` is the home page's four tiles (the day's volume from each coin's hour buckets, and the all-time volume beside it); `/api/alltime` is the Stats page: launches by pool and module, volume and trades, the fees and where every part went (the platform's 20%, what creators and holders received by module, the pots waiting), the platform's share with the pot read from the chain and its withdrawals, the buybacks and burns coin by coin with the share of supply burned (every burn counts: the gardener's buybacks and anyone's transfer to the dead address, the launchpad's launch dust aside), the holders, the mist, and one row per day. A coin keeps its last 600 trades, so the indexer keeps the day rows and the hour buckets as events arrive (`eth/series.mjs`), and the charts' candles (one minute for two days, five minutes for a week, an hour for ninety days, a day for ten years; `eth/candles.mjs`, a file per coin under `DATA_DIR/candles`, served at `/api/coin/<token>/candles?tf=m1|m5|h1|d1`); hidden coins are left out, as everywhere on the site. The indexer looks for new blocks every `HALCYON_INDEX_INTERVAL_MS` (eight seconds), two confirmations behind the head, so a chart moves about half a minute after a trade.

## The indexer

The gardener reads balances from the indexer (`eth/indexer.mjs`), which follows the launchpad, the fees contract, the lockers, every coin's transfers, every v3 pool's swaps and the PoolManager's swaps for every v4 pool from `HALCYON_DEPLOY_BLOCK`, `HALCYON_CONFIRMATIONS` blocks behind the head, in ranges of 2,000 blocks, and keeps the state in `DATA_DIR/halcyon-state.json`. Deleting that file makes it reindex from the deploy block on the next start (minutes for a young deployment). The state, the ledger, the metadata, the stock registry and the uploaded images all live in `DATA_DIR`; on Render that is the persistent disk.
