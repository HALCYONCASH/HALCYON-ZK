// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Min, Hop} from "./Interfaces.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @title HalcyonSwap: the simplest possible router for Uniswap v4. `buy` and `sell` are for Halcyon's own pools (native ETH
/// against a coin); `swapPath` walks any v4 pools, one hop each, from ETH or a token to whatever the last hop names (the Harvest
/// module buys tokenized stocks through it). Exact input every way, a minimum output, a deadline, and any input the first pool
/// could not take is refunded. The site and the gardener use it; anyone may.
contract HalcyonSwap is IUnlockCallback {
    IPoolManager public immutable manager;
    uint8 private constant MODE_BUY = 0;
    uint8 private constant MODE_SELL = 1;
    uint8 private constant MODE_PATH = 2;

    event Bought(address indexed token, address indexed to, uint256 ethIn, uint256 coinsOut);
    event Sold(address indexed token, address indexed to, uint256 coinsIn, uint256 ethOut);
    event Swapped(address indexed currencyIn, address indexed currencyOut, address indexed to, uint256 amountIn, uint256 amountOut, uint256 hops);

    constructor(address manager_) {
        require(manager_ != address(0), "zero");
        manager = IPoolManager(manager_);
    }

    /// @notice Buy the coin of `key` with the ETH sent. Reverts unless at least `minOut` coins come out before `deadline`.
    function buy(PoolKey calldata key, uint256 minOut, address to, uint256 deadline) external payable returns (uint256 out) {
        require(block.timestamp <= deadline, "deadline");
        require(msg.value > 0 && to != address(0), "params");
        bytes memory ret = manager.unlock(abi.encode(MODE_BUY, abi.encode(key, msg.value, to)));
        (uint256 used, uint256 got) = abi.decode(ret, (uint256, uint256));
        require(got >= minOut, "min out");
        if (used < msg.value) _send(msg.sender, msg.value - used);
        emit Bought(Currency.unwrap(key.currency1), to, used, got);
        return got;
    }

    /// @notice Sell `amountIn` of the coin of `key` (approved to this contract) for ETH, at least `minOut`, before `deadline`.
    function sell(PoolKey calldata key, uint256 amountIn, uint256 minOut, address to, uint256 deadline) external returns (uint256 out) {
        require(block.timestamp <= deadline, "deadline");
        require(amountIn > 0 && to != address(0), "params");
        address token = Currency.unwrap(key.currency1);
        require(IERC20Min(token).transferFrom(msg.sender, address(this), amountIn), "transfer");
        bytes memory ret = manager.unlock(abi.encode(MODE_SELL, abi.encode(key, amountIn, to)));
        (uint256 used, uint256 got) = abi.decode(ret, (uint256, uint256));
        require(got >= minOut, "min out");
        if (used < amountIn) require(IERC20Min(token).transfer(msg.sender, amountIn - used), "refund");
        emit Sold(token, to, used, got);
        return got;
    }

    /// @notice Swap `amountIn` of `currencyIn` (ETH when address(0), sent as the value; a token otherwise, approved to this contract)
    /// along `path`, one pool per hop, each hop naming the currency it leads to. Exact input; at least `minOut` of the last currency
    /// goes to `to` before `deadline`. What the first pool could not take is refunded; a later pool that cannot take its whole
    /// input reverts (the route is too thin). Returns what the first pool took and what the last one gave.
    function swapPath(Hop[] calldata path, address currencyIn, uint256 amountIn, uint256 minOut, address to, uint256 deadline) external payable returns (uint256 used, uint256 out) {
        require(block.timestamp <= deadline, "deadline");
        require(path.length > 0 && amountIn > 0 && to != address(0), "params");
        if (currencyIn == address(0)) require(msg.value == amountIn, "value");
        else {
            require(msg.value == 0, "value");
            require(IERC20Min(currencyIn).transferFrom(msg.sender, address(this), amountIn), "transfer");
        }
        bytes memory ret = manager.unlock(abi.encode(MODE_PATH, abi.encode(path, currencyIn, amountIn, to)));
        (used, out) = abi.decode(ret, (uint256, uint256));
        require(out >= minOut, "min out");
        if (used < amountIn) {
            if (currencyIn == address(0)) _send(msg.sender, amountIn - used);
            else require(IERC20Min(currencyIn).transfer(msg.sender, amountIn - used), "refund");
        }
        emit Swapped(currencyIn, path[path.length - 1].currency, to, used, out, path.length);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "manager");
        (uint8 mode, bytes memory inner) = abi.decode(data, (uint8, bytes));
        if (mode == MODE_PATH) return _walk(inner);
        (PoolKey memory key, uint256 amountIn, address to) = abi.decode(inner, (PoolKey, uint256, address));
        require(Currency.unwrap(key.currency0) == address(0), "eth pools only");
        bool isBuy = mode == MODE_BUY;
        BalanceDelta d = manager.swap(key, SwapParams({
            zeroForOne: isBuy, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: isBuy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        }), "");
        if (isBuy) {
            uint256 used = uint256(uint128(-d.amount0()));
            uint256 got = uint256(uint128(d.amount1()));
            manager.settle{value: used}();
            manager.take(key.currency1, to, got);
            return abi.encode(used, got);
        } else {
            uint256 used = uint256(uint128(-d.amount1()));
            uint256 got = uint256(uint128(d.amount0()));
            manager.sync(key.currency1);
            require(IERC20Min(Currency.unwrap(key.currency1)).transfer(address(manager), used), "pay");
            manager.settle();
            manager.take(key.currency0, to, got);
            return abi.encode(used, got);
        }
    }

    /// @dev The hops of `swapPath`, inside the manager's lock: swap through each pool in turn, then settle the input once and take
    /// the output once (the currencies in between net to zero inside the lock).
    function _walk(bytes memory inner) internal returns (bytes memory) {
        (Hop[] memory path, address currencyIn, uint256 amountIn, address to) = abi.decode(inner, (Hop[], address, uint256, address));
        Currency cur = Currency.wrap(currencyIn);
        uint256 amount = amountIn;
        uint256 used = 0;
        for (uint256 i = 0; i < path.length; i++) {
            Currency next = Currency.wrap(path[i].currency);
            require(Currency.unwrap(next) != Currency.unwrap(cur), "hop");
            bool zeroForOne = cur < next;
            PoolKey memory key = zeroForOne
                ? PoolKey({ currency0: cur, currency1: next, fee: path[i].fee, tickSpacing: path[i].tickSpacing, hooks: IHooks(path[i].hooks) })
                : PoolKey({ currency0: next, currency1: cur, fee: path[i].fee, tickSpacing: path[i].tickSpacing, hooks: IHooks(path[i].hooks) });
            BalanceDelta d = manager.swap(key, SwapParams({
                zeroForOne: zeroForOne, amountSpecified: -int256(amount), sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }), "");
            uint256 took = uint256(uint128(-(zeroForOne ? d.amount0() : d.amount1())));
            uint256 got = uint256(uint128(zeroForOne ? d.amount1() : d.amount0()));
            if (i == 0) used = took; else require(took == amount, "thin");
            cur = next;
            amount = got;
        }
        if (currencyIn == address(0)) manager.settle{value: used}();
        else {
            manager.sync(Currency.wrap(currencyIn));
            require(IERC20Min(currencyIn).transfer(address(manager), used), "pay");
            manager.settle();
        }
        manager.take(cur, to, amount);
        return abi.encode(used, amount);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "refund");
    }

    receive() external payable {
        require(msg.sender == address(manager), "manager only");
    }
}
