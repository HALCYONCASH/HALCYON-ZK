// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHalcyonTokenMin, IERC20Min, IHalcyonFeesMin, IUniswapV3FactoryMin, IUniswapV3PoolMin, INonfungiblePositionManagerMin, ISwapRouter02Min, IAggregatorV3Min} from "./Interfaces.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

interface IHalcyonLockerMin {
    function lock(address token, uint256 tokenId) external;
}
interface IHalcyonV4LockerMin {
    function seed(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint256 amount) external returns (uint128);
}
interface IHalcyonHookMin {
    function prepare(PoolKey calldata key, uint24 launchFee, uint24 sellFee, uint32 window, uint128 maxSwap) external;
    function setExempt(PoolKey calldata key, bool on) external;
}
interface IHalcyonSwapMin {
    function buy(PoolKey calldata key, uint256 minOut, address to, uint256 deadline) external payable returns (uint256 out);
}
interface IHalcyonFeesKey {
    function poolKey(address token) external view returns (PoolKey memory);
}

/// @title Halcyon: the launchpad. One transaction makes a coin and its Uniswap pool, with the pool as the curve.
/// A launch clones the coin, mints its 1,000,000,000 units, and puts every one of them in a Uniswap pool at the 1% fee tier as
/// a single-sided position that starts at the market cap the creator chose (in dollars, read from Chainlink at that moment) and
/// runs up from there. Buys walk the price up the range, sells walk it back down: a constant-product curve, inside Uniswap,
/// tradable from the first block by every router and aggregator. The liquidity is held by a Halcyon locker that can never
/// withdraw it. The 1% every trade pays is the position's, which is the coin's: the gardener collects it and HalcyonFees splits it.
/// Two pools to choose from: Uniswap v3 (the coin against WETH, no rules, everything standard) or Uniswap v4 with the Halcyon
/// hook (the coin against ETH, with the opening fee, the max per swap, the sell fee and one liquidity provider, enforced on-chain).
contract Halcyon {
    using PoolIdLibrary for PoolKey;

    uint256 public constant SUPPLY = 1_000_000_000e18;
    uint24 public constant V3_FEE = 10_000;
    int24 public constant V3_TICK_SPACING = 200;
    int24 public constant V4_TICK_SPACING = 200;
    int24 public constant TICK_EDGE = 887_200;         // MAX_TICK rounded to the spacing
    uint32 public constant MIN_CAP_USD = 1_000;
    uint32 public constant MAX_CAP_USD = 1_000_000;
    uint256 public constant FEED_MAX_AGE = 3 hours;
    uint8 public constant POOL_V3 = 0;
    uint8 public constant POOL_V4 = 1;

    struct Config {
        address implementation; address fees; address locker; address v4Locker; address hook; address swap;
        address v3Factory; address nfpm; address swapRouter; address weth; address poolManager; address ethUsdFeed;
    }

    struct LaunchParams {
        string name;
        string symbol;
        string uri;            // metadata (description, image, links), at most 256 bytes
        uint8 pool;            // POOL_V3 or POOL_V4
        uint32 startCapUsd;    // the market cap the first buy sees, in whole dollars
        uint8 module;          // HalcyonFees module
        address stock;         // the Stock module's stock, else zero
        bytes32 salt;          // picks the coin's address (for a v3 pool it must sort below WETH)
        address[] splitTo;     // the Split module's recipients, else empty
        uint16[] splitBps;
        uint24 launchFee;      // v4 rules (ignored for v3): opening fee in pips, sell fee in pips, window in seconds, max per swap in bps of the supply
        uint24 sellFee;
        uint32 window;
        uint16 maxSwapBps;
        uint256 minOut;        // the founder's buy: at least this many coins for msg.value
    }

    struct Launch {
        address creator;
        uint8 pool;
        address v3Pool;        // v3: the pool
        uint256 tokenId;       // v3: the locked position
        bytes32 poolId;        // v4: the pool id
        int24 tickLower;
        int24 tickUpper;
        uint32 startCapUsd;
        uint64 launchedAt;
        uint256 ethUsd;        // the feed's answer at launch (8 decimals), for the record
    }

    address public immutable implementation;
    IHalcyonFeesMin public immutable fees;
    address public immutable locker;
    address public immutable v4Locker;
    address public immutable hook;
    address public immutable swap;
    IUniswapV3FactoryMin public immutable v3Factory;
    INonfungiblePositionManagerMin public immutable nfpm;
    ISwapRouter02Min public immutable swapRouter;
    address public immutable weth;
    IPoolManager public immutable poolManager;
    IAggregatorV3Min public immutable ethUsdFeed;
    uint8 public immutable feedDecimals;

    address[] public tokens;
    mapping(address => Launch) public launches;
    bool private _entered;

    event Launched(address indexed token, address indexed creator, string name, string symbol, string uri, uint8 pool, uint8 module, address stock, uint32 startCapUsd, int24 startTick, bytes32 poolRef, uint256 ethUsd);
    event FounderBought(address indexed token, address indexed creator, uint256 eth, uint256 coins);

    modifier nonReentrant() { require(!_entered, "reentrant"); _entered = true; _; _entered = false; }

    constructor(Config memory c) {
        require(c.implementation != address(0) && c.fees != address(0) && c.locker != address(0) && c.v3Factory != address(0) && c.nfpm != address(0) && c.swapRouter != address(0) && c.weth != address(0) && c.ethUsdFeed != address(0), "zero");
        implementation = c.implementation;
        fees = IHalcyonFeesMin(c.fees);
        locker = c.locker;
        v4Locker = c.v4Locker;
        hook = c.hook;
        swap = c.swap;
        v3Factory = IUniswapV3FactoryMin(c.v3Factory);
        nfpm = INonfungiblePositionManagerMin(c.nfpm);
        swapRouter = ISwapRouter02Min(c.swapRouter);
        weth = c.weth;
        poolManager = IPoolManager(c.poolManager);
        ethUsdFeed = IAggregatorV3Min(c.ethUsdFeed);
        feedDecimals = IAggregatorV3Min(c.ethUsdFeed).decimals();
    }

    function count() external view returns (uint256) { return tokens.length; }
    function v4Ready() public view returns (bool) { return v4Locker != address(0) && hook != address(0) && swap != address(0) && address(poolManager) != address(0); }

    /// @notice The address a launch by `sender` with `salt` will give the coin (CREATE2), so a launcher can pick a salt that sorts below WETH.
    function predict(address sender, bytes32 salt) public view returns (address) {
        bytes32 s = keccak256(abi.encode(sender, salt));
        bytes32 h = keccak256(abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"));
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(this), s, h)))));
    }

    /// @notice The ETH/USD price the next launch would use, and the wei a market cap in dollars means at it.
    function ethUsd() public view returns (uint256 answer) {
        (, int256 a, , uint256 updatedAt, ) = ethUsdFeed.latestRoundData();
        require(a > 0 && updatedAt + FEED_MAX_AGE > block.timestamp, "feed");
        return uint256(a);
    }

    function capToWei(uint32 capUsd, uint256 answer) public view returns (uint256) {
        return FullMath.mulDiv(uint256(capUsd) * 1e18, 10 ** feedDecimals, answer);
    }

    /// @notice Launch a coin. Pays the gas of the launch and, with msg.value, the founder's first buy from the fresh pool.
    function launch(LaunchParams calldata p) external payable nonReentrant returns (address token) {
        require(bytes(p.name).length > 0 && bytes(p.name).length <= 48, "name");
        require(bytes(p.symbol).length >= 2 && bytes(p.symbol).length <= 12, "symbol");
        require(bytes(p.uri).length <= 256, "uri");
        require(p.startCapUsd >= MIN_CAP_USD && p.startCapUsd <= MAX_CAP_USD, "cap");
        require(p.pool == POOL_V3 || (p.pool == POOL_V4 && v4Ready()), "pool");
        uint256 answer = ethUsd();
        uint256 capWei = capToWei(p.startCapUsd, answer);

        token = _clone(keccak256(abi.encode(msg.sender, p.salt)));
        IHalcyonTokenMin(token).initialize(p.name, p.symbol, SUPPLY, address(this));
        Launch memory l = Launch({ creator: msg.sender, pool: p.pool, v3Pool: address(0), tokenId: 0, poolId: bytes32(0), tickLower: 0, tickUpper: 0, startCapUsd: p.startCapUsd, launchedAt: uint64(block.timestamp), ethUsd: answer });
        int24 startTick;
        bytes32 poolRef;
        if (p.pool == POOL_V3) {
            (l.v3Pool, l.tokenId, startTick) = _launchV3(token, capWei);
            l.tickLower = startTick;
            l.tickUpper = TICK_EDGE;
            poolRef = bytes32(uint256(uint160(l.v3Pool)));
        } else {
            (l.poolId, startTick) = _launchV4(token, capWei, p);
            l.tickLower = -TICK_EDGE;
            l.tickUpper = startTick;
            poolRef = l.poolId;
        }
        launches[token] = l;
        tokens.push(token);
        fees.register(token, msg.sender, p.module, p.pool, p.stock, p.splitTo, p.splitBps);
        emit Launched(token, msg.sender, p.name, p.symbol, p.uri, p.pool, p.module, p.stock, p.startCapUsd, startTick, poolRef, answer);

        if (msg.value > 0) {
            uint256 got;
            if (p.pool == POOL_V3) {
                got = swapRouter.exactInputSingle{value: msg.value}(ISwapRouter02Min.ExactInputSingleParams({
                    tokenIn: weth, tokenOut: token, fee: V3_FEE, recipient: msg.sender, amountIn: msg.value, amountOutMinimum: p.minOut, sqrtPriceLimitX96: 0
                }));
            } else {
                PoolKey memory key = IHalcyonFeesKey(address(fees)).poolKey(token);
                IHalcyonHookMin(hook).setExempt(key, true);
                got = IHalcyonSwapMin(swap).buy{value: msg.value}(key, p.minOut, msg.sender, block.timestamp);
                IHalcyonHookMin(hook).setExempt(key, false);
            }
            emit FounderBought(token, msg.sender, msg.value, got);
        }
    }

    /// @dev v3: the coin is token0 (its address sorts below WETH), the position is [startTick, edge] and holds only the coin.
    function _launchV3(address token, uint256 capWei) internal returns (address pool, uint256 tokenId, int24 tickLower) {
        require(token < weth, "salt");
        // price = WETH per coin = capWei / SUPPLY; sqrtPriceX96 = sqrt(price) * 2^96 = sqrt(capWei * 2^192 / SUPPLY)
        uint160 sqrtPrice = uint160(_sqrt(FullMath.mulDiv(capWei, 1 << 192, SUPPLY)));
        tickLower = _floorTick(TickMath.getTickAtSqrtPrice(sqrtPrice), V3_TICK_SPACING);
        require(tickLower < TICK_EDGE && tickLower > -TICK_EDGE, "tick");
        require(v3Factory.getPool(token, weth, V3_FEE) == address(0), "pool exists");
        pool = v3Factory.createPool(token, weth, V3_FEE);
        IUniswapV3PoolMin(pool).initialize(TickMath.getSqrtPriceAtTick(tickLower));
        IERC20Min(token).approve(address(nfpm), SUPPLY);
        uint256 amount0;
        (tokenId, , amount0, ) = nfpm.mint(INonfungiblePositionManagerMin.MintParams({
            token0: token, token1: weth, fee: V3_FEE, tickLower: tickLower, tickUpper: TICK_EDGE,
            amount0Desired: SUPPLY, amount1Desired: 0, amount0Min: SUPPLY - SUPPLY / 1_000_000, amount1Min: 0, recipient: locker, deadline: block.timestamp
        }));
        require(amount0 <= SUPPLY, "mint");
        uint256 dust = IERC20Min(token).balanceOf(address(this));
        if (dust > 0) IHalcyonTokenMin(token).burn(dust);
        IHalcyonLockerMin(locker).lock(token, tokenId);
    }

    /// @dev v4: native ETH is currency0 and the coin currency1; the position is [-edge, startTick] and holds only the coin.
    function _launchV4(address token, uint256 capWei, LaunchParams calldata p) internal returns (bytes32 poolId, int24 tickUpper) {
        // price = coins per ETH = SUPPLY / capWei; sqrtPriceX96 = sqrt(SUPPLY * 2^192 / capWei)
        uint160 sqrtPrice = uint160(_sqrt(FullMath.mulDiv(SUPPLY, 1 << 192, capWei)));
        tickUpper = _ceilTick(TickMath.getTickAtSqrtPrice(sqrtPrice), V4_TICK_SPACING);
        require(tickUpper < TICK_EDGE && tickUpper > -TICK_EDGE, "tick");
        PoolKey memory key = IHalcyonFeesKey(address(fees)).poolKey(token);
        require(address(key.hooks) == hook, "hook");
        IHalcyonHookMin(hook).prepare(key, p.launchFee, p.sellFee, p.window, uint128(uint256(p.maxSwapBps) * SUPPLY / 10_000));
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(tickUpper));
        require(IERC20Min(token).transfer(v4Locker, SUPPLY), "transfer");
        IHalcyonV4LockerMin(v4Locker).seed(key, -TICK_EDGE, tickUpper, SUPPLY);
        poolId = PoolId.unwrap(key.toId());
    }

    /// @dev EIP-1167 minimal proxy of the implementation, at a CREATE2 address.
    function _clone(bytes32 salt) internal returns (address instance) {
        address impl = implementation;
        assembly ("memory-safe") {
            let clone := mload(0x40)
            mstore(clone, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(clone, 0x14), shl(0x60, impl))
            mstore(add(clone, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create2(0, clone, 0x37, salt)
        }
        require(instance != address(0), "clone");
    }

    function _floorTick(int24 tick, int24 spacing) internal pure returns (int24 t) {
        t = tick / spacing * spacing;
        if (tick < 0 && t != tick) t -= spacing;
    }

    function _ceilTick(int24 tick, int24 spacing) internal pure returns (int24 t) {
        t = tick / spacing * spacing;
        if (tick > 0 && t != tick) t += spacing;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) { y = z; z = (x / z + z) / 2; }
    }
}
