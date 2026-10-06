// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHalcyonFeesMin} from "./Interfaces.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title HalcyonHook: the rules of a Halcyon v4 pool, enforced by Uniswap itself on every swap, whoever routes it.
/// One hook serves every v4 coin; each pool carries the rules its creator chose at launch, fixed from then on:
///   the opening fee     the first minutes charge a fee that starts high (the creator picks, up to 90%) and falls in a straight line
///                       to the base 1% over the window the creator set. A sniper who buys in the first block pays most of the buy
///                       to the pool, and the pool's fees are the coin's: snipers pay the holders.
///   the max per swap    during the same window no single swap may take more than the creator's share of the supply.
///   the sell fee        sells can pay more than buys, forever (the creator picks, 1% to 5%); the extra is the coin's too.
///   one liquidity provider  only the Halcyon locker may add liquidity, so every fee the pool charges goes to the locked position.
/// None of these rules needs to know who the trader is: they hold for every router, aggregator and contract alike.
contract HalcyonHook is IHooks {
    using PoolIdLibrary for PoolKey;

    uint24 public constant BASE_FEE = 10_000;          // 1% in pips
    uint24 public constant MAX_LAUNCH_FEE = 900_000;   // 90%
    uint24 public constant MAX_SELL_FEE = 50_000;      // 5%
    uint32 public constant MAX_WINDOW = 1 days;

    struct Rules {
        uint24 launchFee;     // the opening fee at the first second, in pips (0 = no opening fee)
        uint24 sellFee;       // the fee on sells, in pips (BASE_FEE..MAX_SELL_FEE)
        uint32 window;        // seconds the opening fee and the max per swap last
        uint64 start;         // when the pool was initialized
        uint128 maxSwap;      // coins one swap may take during the window (0 = no cap)
        address token;        // the coin (currency1)
        bool exempt;          // set by the launchpad around the founder's buy: base fee, no cap
    }

    IPoolManager public immutable manager;
    IHalcyonFeesMin public immutable fees;
    address public immutable locker;
    mapping(PoolId => Rules) public rules;

    event Prepared(PoolId indexed id, address indexed token, uint24 launchFee, uint24 sellFee, uint32 window, uint128 maxSwap);

    constructor(address manager_, address fees_, address locker_) {
        require(manager_ != address(0) && fees_ != address(0) && locker_ != address(0), "zero");
        manager = IPoolManager(manager_);
        fees = IHalcyonFeesMin(fees_);
        locker = locker_;
        Hooks.validateHookPermissions(this, permissions());
    }

    function permissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false, afterInitialize: true,
            beforeAddLiquidity: true, afterAddLiquidity: false,
            beforeRemoveLiquidity: false, afterRemoveLiquidity: false,
            beforeSwap: true, afterSwap: true,
            beforeDonate: false, afterDonate: false,
            beforeSwapReturnDelta: false, afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false, afterRemoveLiquidityReturnDelta: false
        });
    }

    modifier onlyLaunchpad() { require(msg.sender == fees.launchpad(), "launchpad"); _; }
    modifier onlyManager() { require(msg.sender == address(manager), "manager"); _; }

    /// @notice The launchpad sets a pool's rules before it initializes the pool. A pool nobody prepared cannot be initialized with this hook.
    function prepare(PoolKey calldata key, uint24 launchFee, uint24 sellFee, uint32 window, uint128 maxSwap) external onlyLaunchpad {
        PoolId id = key.toId();
        require(rules[id].token == address(0), "prepared");
        require(Currency.unwrap(key.currency0) == address(0) && key.fee == LPFeeLibrary.DYNAMIC_FEE_FLAG, "key");
        require(launchFee == 0 || (launchFee > BASE_FEE && launchFee <= MAX_LAUNCH_FEE), "launch fee");
        require(sellFee >= BASE_FEE && sellFee <= MAX_SELL_FEE, "sell fee");
        require(window <= MAX_WINDOW, "window");
        require((launchFee == 0 && maxSwap == 0) || window > 0, "window");
        address token = Currency.unwrap(key.currency1);
        rules[id] = Rules({ launchFee: launchFee, sellFee: sellFee, window: window, start: 0, maxSwap: maxSwap, token: token, exempt: false });
        emit Prepared(id, token, launchFee, sellFee, window, maxSwap);
    }

    /// @notice The launchpad lifts the opening rules for the founder's own buy inside the launch transaction.
    function setExempt(PoolKey calldata key, bool on) external onlyLaunchpad {
        rules[key.toId()].exempt = on;
    }

    /// @notice The fee a swap pays right now, in pips, for a pool and a direction (buy = ETH in, zeroForOne).
    function feeNow(PoolId id, bool buy) public view returns (uint24) {
        Rules storage r = rules[id];
        uint24 base = buy ? BASE_FEE : r.sellFee;
        if (r.launchFee == 0 || r.start == 0 || !buy) return base;
        uint256 elapsed = block.timestamp - r.start;
        if (elapsed >= r.window) return base;
        return uint24(uint256(r.launchFee) - (uint256(r.launchFee) - BASE_FEE) * elapsed / r.window);
    }

    function afterInitialize(address sender, PoolKey calldata key, uint160, int24) external onlyManager returns (bytes4) {
        Rules storage r = rules[key.toId()];
        require(r.token != address(0) && sender == fees.launchpad(), "not a halcyon pool");
        r.start = uint64(block.timestamp);
        manager.updateDynamicLPFee(key, BASE_FEE);
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external view onlyManager returns (bytes4) {
        require(sender == locker, "lp locked");
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata) external view onlyManager returns (bytes4, BeforeSwapDelta, uint24) {
        PoolId id = key.toId();
        Rules storage r = rules[id];
        uint24 fee = (sender == locker || r.exempt) ? BASE_FEE : feeNow(id, params.zeroForOne);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata, BalanceDelta delta, bytes calldata) external view onlyManager returns (bytes4, int128) {
        Rules storage r = rules[key.toId()];
        if (r.maxSwap != 0 && sender != locker && !r.exempt && block.timestamp < uint256(r.start) + r.window) {
            int128 got = delta.amount1();
            require(got <= 0 || uint128(got) <= r.maxSwap, "max per swap");
        }
        return (IHooks.afterSwap.selector, 0);
    }

    // the hooks this contract does not take part in (its address says so; the manager never calls them)
    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) { revert("unused"); }
    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) { revert("unused"); }
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external pure returns (bytes4) { revert("unused"); }
    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) { revert("unused"); }
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert("unused"); }
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert("unused"); }
}
