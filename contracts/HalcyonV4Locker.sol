// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHalcyonFeesMin, IHalcyonTokenMin, IERC20Min} from "./Interfaces.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";

/// @title HalcyonV4Locker: holds every v4 coin's liquidity forever, as the one liquidity provider of its pool.
/// A v4 coin's pool is native ETH against the coin, with the Halcyon hook. The launchpad hands this contract the whole supply and
/// has it seed one single-sided position from the starting price up; the hook lets no other address add liquidity, so every fee
/// the pool ever charges belongs to this position. Nothing here removes liquidity. `collect` has the gardener gather the fees, sell
/// the coin side for ETH through the same pool, and deposit the ETH in HalcyonFees.
contract HalcyonV4Locker is IUnlockCallback {
    IPoolManager public immutable manager;
    IHalcyonFeesMin public immutable fees;

    struct Position { int24 tickLower; int24 tickUpper; uint128 liquidity; }
    mapping(address => Position) public positions;  // token => its position
    mapping(address => PoolKey) private _keys;

    enum Action { SEED, COLLECT }

    event Seeded(address indexed token, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 coins);
    event Collected(address indexed token, uint256 coins, uint256 ethFees, uint256 eth);

    constructor(address manager_, address fees_) {
        require(manager_ != address(0) && fees_ != address(0), "zero");
        manager = IPoolManager(manager_);
        fees = IHalcyonFeesMin(fees_);
    }

    function keyOf(address token) external view returns (PoolKey memory) { return _keys[token]; }

    /// @notice The launchpad, having transferred `amount` coins here and initialized the pool at `tickUpper`, has the locker put
    /// them in one position below the price: [tickLower, tickUpper] holds only the coin, and buys walk the price down the range.
    function seed(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint256 amount) external returns (uint128 liquidity) {
        require(msg.sender == fees.launchpad(), "launchpad");
        address token = Currency.unwrap(key.currency1);
        require(Currency.unwrap(key.currency0) == address(0) && token != address(0), "key");
        require(positions[token].liquidity == 0, "seeded");
        require(IERC20Min(token).balanceOf(address(this)) >= amount && amount > 0, "coins");
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(tickUpper);
        // all of `amount` is token1: liquidity = amount * 2^96 / (sqrtB - sqrtA)
        liquidity = uint128(FullMath.mulDiv(amount, FixedPoint96.Q96, sqrtB - sqrtA));
        require(liquidity > 0, "liquidity");
        _keys[token] = key;
        positions[token] = Position({ tickLower: tickLower, tickUpper: tickUpper, liquidity: liquidity });
        bytes memory ret = manager.unlock(abi.encode(Action.SEED, token, uint256(liquidity)));
        uint256 used = abi.decode(ret, (uint256));
        // rounding leaves dust behind: burn it, so the supply is exactly the pool's
        uint256 left = IERC20Min(token).balanceOf(address(this));
        if (left > 0) IHalcyonTokenMin(token).burn(left);
        emit Seeded(token, tickLower, tickUpper, liquidity, used);
    }

    /// @notice The gardener gathers a coin's earned fees: the coin side is sold for ETH through the pool (at least `minOut` ETH for
    /// it), and everything is deposited in HalcyonFees.
    function collect(address token, uint256 minOut) external returns (uint256 eth, uint256 fromCoins) {
        require(msg.sender == fees.gardener(), "gardener");
        require(positions[token].liquidity > 0, "unknown coin");
        bytes memory ret = manager.unlock(abi.encode(Action.COLLECT, token, minOut));
        (uint256 coins, uint256 ethFees, uint256 total) = abi.decode(ret, (uint256, uint256, uint256));
        if (total > 0) fees.deposit{value: total}(token);
        emit Collected(token, coins, ethFees, total);
        return (total, total - ethFees);
    }

    /// @dev The PoolManager calls back here inside `unlock`; only the manager may, and only for what this contract asked.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "manager");
        (Action action, address token, uint256 value) = abi.decode(data, (Action, address, uint256));
        PoolKey memory key = _keys[token];
        Position memory p = positions[token];
        if (action == Action.SEED) {
            (BalanceDelta delta, ) = manager.modifyLiquidity(key, ModifyLiquidityParams({ tickLower: p.tickLower, tickUpper: p.tickUpper, liquidityDelta: int256(value), salt: bytes32(0) }), "");
            require(delta.amount0() == 0, "needs eth");
            uint256 owed = uint256(uint128(-delta.amount1()));
            _settle(key.currency1, token, owed);
            return abi.encode(owed);
        }
        uint256 minOut = value;
        // a zero-liquidity modification credits the fees the position has earned
        (, BalanceDelta accrued) = manager.modifyLiquidity(key, ModifyLiquidityParams({ tickLower: p.tickLower, tickUpper: p.tickUpper, liquidityDelta: 0, salt: bytes32(0) }), "");
        uint256 ethFees = accrued.amount0() > 0 ? uint256(uint128(accrued.amount0())) : 0;
        uint256 coins = accrued.amount1() > 0 ? uint256(uint128(accrued.amount1())) : 0;
        uint256 ethOut = 0;
        if (coins > 0) {
            // sell the coin side for ETH in the same pool (oneForZero, exact in); the delta nets against the credit above
            BalanceDelta d = manager.swap(key, SwapParams({ zeroForOne: false, amountSpecified: -int256(coins), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1 }), "");
            uint256 sold = uint256(uint128(-d.amount1()));
            ethOut = uint256(uint128(d.amount0()));
            require(ethOut >= minOut, "min out");
            if (sold < coins) manager.take(key.currency1, address(this), coins - sold); // a sell past the bottom of the range leaves coins: keep them for next time
        }
        uint256 total = ethFees + ethOut;
        if (total > 0) manager.take(key.currency0, address(this), total);
        return abi.encode(coins, ethFees, total);
    }

    function _settle(Currency currency, address token, uint256 amount) internal {
        manager.sync(currency);
        require(IERC20Min(token).transfer(address(manager), amount), "transfer");
        manager.settle();
    }

    receive() external payable {
        require(msg.sender == address(manager), "manager only");
    }
}
