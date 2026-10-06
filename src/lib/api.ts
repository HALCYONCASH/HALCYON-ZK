// The server's API, typed. Numbers that are wei or coin units arrive as strings and stay strings until they are formatted or turned into BigInt.
export type ModuleId = 'roots' | 'rain' | 'prune' | 'harvest' | 'branch' | 'clover' | 'rings' | 'mist';
export type PoolId = 0 | 1;
export interface ModuleInfo { id: number; name: string; line: string }
export interface PoolInfo { id: number; name: string; line: string }
export interface Uniswap { weth: string; v3Factory: string; nfpm: string; swapRouter02: string; quoterV2: string; poolManager: string; universalRouter: string; stateView: string; v4Quoter: string; usdc: string }
export interface Deployment { at: string; poseidon: string; verifier: string; create2: string; mistDenominations: string[] }
export interface ZkSetup { dev: boolean; constraints: number; ptau: string }
export interface Config { siteName: string; siteUrl: string; xHandle: string; sourceUrl: string; demo: boolean; chainId: number; chainName: string; explorer: string; launchpad: string; fees: string; tokenImpl: string; locker: string; v4Locker: string; hook: string; swap: string; mist: string; platform?: string; platformCoin?: string; deployBlock?: number; deployment?: Deployment | null; zk?: ZkSetup | null; uniswap: Uniswap; gardener: boolean; ready: boolean; pinning?: boolean; ethUsd: number; model: { supply: string; feePips: number; platformBps: number; minCapUsd: number; maxCapUsd: number; capPresets: number[]; tickSpacing: number; tickEdge: number }; modules: Record<ModuleId, ModuleInfo>; pools: Record<string, PoolInfo> }
export interface Rules { launchFee: number; sellFee: number; window: number; start: number; maxSwap: string; feeNow: number; windowEndsAt: number; open: boolean }
export interface StockInfo { address: string; symbol: string; name: string; decimals: number; issuer: string; logo: string }
export interface Draw { drawBlock: number; pot: string; committedAt: number; tx: string }
export interface Coin {
  token: string; name: string; symbol: string; creator: string; uri: string; metaUrl?: string; image: string; description: string; links: Record<string, string>;
  /** the platform's own coin; a coin wearing its name or symbol; one the operator keeps out of the lists; the official coin's token */
  official?: boolean; lookalike?: boolean; hidden?: boolean; officialToken?: string;
  module: ModuleId; moduleInfo: ModuleInfo; stock: string; stockInfo: StockInfo | null; branches: { to: string; bps: number }[]; draw: Draw | null;
  pool: PoolId; poolInfo: PoolInfo; v3Pool: string; poolId: string; tokenId: string; tickLower: number; tickUpper: number; startTick: number; startCapUsd: number; liquidity: string; rules: Rules | null;
  createdAt: number; block: number; tx: string; progress: number; ethInPool: string; coinsInPool: string; price: string; priceUsd: number; marketCapEth: string; marketCapUsd: number;
  stats: { trades: number; buys: number; sells: number; volumeEth: string; lastPrice: string; lastTradeAt: number; holders: number; volume24hEth: string; founderEth: string; founderCoins: string; burned?: string; burnedByBuybacks?: string };
  fees: { received: string; pot: string; paid: string; platform: string; stockHeld: string; collected: string }; explorer: { token: string; pool: string; tx: string } | null; route: string;
}
export interface Trade { t: number; block: number; tx: string; trader: string; buy: boolean; eth: string; coins: string; fee: string; feePips?: number; price: string; sqrtP: string; tick: number }
export interface Holder { address: string; balance: string; pct: number; since: number; mist?: boolean }
export interface Payout { t: number; block: number; tx: string; token: string; kind: 'roots' | 'rain' | 'prune' | 'harvest' | 'stockPaid' | 'branch' | 'clover' | 'rings' | 'mist'; total: string; count: number; coins?: string; stock?: string; amount?: string; unclaimed?: string; winner?: string; drawBlock?: number; seed?: string; batch?: number; open?: boolean }
export interface Stock { address: string; symbol: string; name: string; decimals: number; issuer: string; category: string; logo: string; note?: string; routed: boolean; via?: '' | 'v3' | 'v4'; allowed: boolean }
export interface Burn { t: number; token: string; from: string; value: string; tx: string; buyback: boolean }
export type CandleFrame = 'm1' | 'm5' | 'h1' | 'd1';
export type CandleRow = [number, number, number, number, number, number];
export interface DayRow { day: string; volume: string; trades: number; buys: number; sells: number; fees: string; platform: string; paid: string; burned: string; burnedCoins: string; launches: number }
export interface PayoutKind { count: number; eth: string; coins: string }
export interface AllTime {
  since: number; now: number; ethUsd: number; chain: string; checkpoint: number;
  coins: { total: number; v3: number; v4: number; byModule: Record<string, number>; withTrades: number };
  volume: { eth: string; usd: number; eth24h: string; trades: number; buys: number; sells: number };
  fees: { received: string; receivedUsd: number; platform: string; platformUsd: number; paid: string; creators: string; holders: string; burned: string; stock: string; pots: string; collected: string };
  platform: { received: string; withdrawn: string; pot: string; potFromChain: boolean; withdrawals: { t: number; to: string; amount: string; tx: string }[] };
  burns: { count: number; eth: string; coins: string; byBuybacks: string; byCoin: { token: string; symbol: string; name: string; count: number; eth: string; coins: string; byBuybacks: string; supplyPct: number }[]; recent: { t: number; token: string; symbol: string; from: string; value: string; tx: string; buyback: boolean }[] };
  payouts: Record<string, PayoutKind>; holders: number; mist: { notes: number; batches: number; spent: number; sownEth: string; withdrawnEth: string; byDenom: Record<string, number>; keyed: number }; days: DayRow[];
}
export interface Stats { coins: number; v4: number; volume24hEth: string; volumeEth?: string; feesEth: string; paidEth: string; lockedEth: string; ethUsd: number; checkpoint: number; chain: string; gardener: boolean }
export interface Me { address: string; held: { token: string; symbol: string; name: string; balance: string; pct: number; since: number }[]; created: { token: string; symbol: string; name: string; module: ModuleId; pool: PoolId }[]; recentPayouts: Payout[]; claimable: string; claimableStock: { stock: string; symbol: string; amount: string }[]; mistKey: string }
/** One Mist note as sown: public, like the event it comes from. Only a viewing key tells whose it is. */
export interface MistNote { t: number; block: number; tx: string; batch: number; index: number; token: string; symbol: string; commit: string; denom: string; ephemeral: string; viewTag: number }
export interface MistInfo { notes: number; batches: number; spent: number; sownEth: string; withdrawnEth: string; byDenom: Record<string, number>; keyed: number; recent: { t: number; denom: string; fee: string }[]; pool: string; denominations: string[]; relayer: string; zk: { dev: boolean; constraints: number; zkey: string; verifier: string } | null }
export interface Quote { side: 'buy' | 'sell'; feePips: number; out: string; fee: string; used: string; refund: string; priceAfter: string; maxSwap: string; overMax: boolean }

async function get<T>(path: string): Promise<T> { const r = await fetch(path, { headers: { accept: 'application/json' } }); if (!r.ok) { let m = `${r.status}`; try { m = (await r.json()).error || m; } catch {} throw new Error(m); } return r.json(); }
export const api = {
  config: () => get<Config>('/api/config'),
  stats: () => get<Stats>('/api/stats'),
  allTime: () => get<AllTime>('/api/alltime'),
  coins: () => get<{ coins: Coin[] }>('/api/coins').then(r => r.coins),
  taken: (symbol: string) => get<{ taken: { symbol: string; name: string; token: string; official: boolean } | null }>(`/api/taken?symbol=${encodeURIComponent(symbol)}`).then(r => r.taken),
  coin: (key: string) => get<{ coin: Coin; trades: Trade[]; holders: { count: number; held: string; keyed: number; top: Holder[] }; payouts: Payout[]; burns: Burn[] }>(`/api/coin/${encodeURIComponent(key)}`),
  /** candles of one frame (m1, m5, h1, d1), as rows [t, open, high, low, close, volume in ETH], ETH a coin; `since` for the tail only */
  candles: (key: string, tf: CandleFrame, since = 0) => get<{ token: string; tf: CandleFrame; candles: CandleRow[]; price: string; at: number }>(`/api/coin/${encodeURIComponent(key)}/candles?tf=${tf}${since ? `&since=${since}` : ''}`),
  quote: (token: string, side: 'buy' | 'sell', amount: bigint) => get<Quote>(`/api/quote?token=${token}&side=${side}&amount=${amount}`),
  stocks: () => get<{ stocks: Stock[] }>('/api/stocks').then(r => r.stocks),
  me: (address: string) => get<Me>(`/api/me/${address}`),
  mist: () => get<MistInfo>('/api/mist'),
  mistNotes: (since = 0, limit = 2000) => get<{ total: number; since: number; notes: MistNote[] }>(`/api/mist/notes?since=${since}&limit=${limit}`),
  mistQuote: (denom: string) => get<{ relayer: string; fee: string; gasPrice: string; gas: string }>(`/api/mist/quote?denom=${denom}`),
  mistRelay: (body: { proof: unknown; publicSignals: string[] }) => fetch('/api/mist/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'relay'); return j as { hash: string; block: number; recipient: string; denom: string; fee: string }; }),
  payouts: (token = '') => get<{ payouts: Payout[] }>(`/api/payouts?token=${token}`).then(r => r.payouts),
  meta: (body: { name: string; symbol: string; description: string; image: string; links: Record<string, string> }) => fetch('/api/meta', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'metadata'); return j as { key: string; uri: string; pinned: boolean; gateway?: string }; }),
  image: (file: File) => fetch('/api/image', { method: 'POST', headers: { 'content-type': file.type }, body: file }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.error || 'image'); return j as { url: string; ipfs: string; pinned: boolean }; }),
};
