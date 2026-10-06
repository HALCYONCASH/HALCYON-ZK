// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev The slices of other people's contracts that Halcyon calls. Nothing here is Halcyon's own.
interface IERC20Min {
    function balanceOf(address a) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}

interface IWETH9 is IERC20Min {
    function deposit() external payable;
    function withdraw(uint256 value) external;
}

interface IHalcyonTokenMin is IERC20Min {
    function initialize(string calldata name_, string calldata symbol_, uint256 supply_, address to_) external;
    function burn(uint256 value) external;
}

/// @dev Uniswap v3 factory and pool, the parts a launch needs.
interface IUniswapV3FactoryMin {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address);
}

interface IUniswapV3PoolMin {
    function initialize(uint160 sqrtPriceX96) external;
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
}

/// @dev Uniswap v3 NonfungiblePositionManager: mint, collect, read.
interface INonfungiblePositionManagerMin {
    struct MintParams {
        address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper;
        uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline;
    }
    struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }
    function mint(MintParams calldata params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
    function ownerOf(uint256 tokenId) external view returns (address);
    function positions(uint256 tokenId) external view returns (
        uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity,
        uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1);
}

/// @dev Uniswap v3 SwapRouter02 (no deadline in the structs).
interface ISwapRouter02Min {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev One hop of a Uniswap v4 route: the pool between the currency before it and `currency` (the two sorted into the pool key),
/// at this fee and tick spacing, with these hooks (zero for a plain pool). ETH is address(0), as v4 names it.
struct Hop { address currency; uint24 fee; int24 tickSpacing; address hooks; }

/// @dev Chainlink aggregator, the one read a launch makes (ETH/USD, 8 decimals).
interface IAggregatorV3Min {
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

/// @dev What the lockers, the hook and the launchpad ask HalcyonFees.
interface IHalcyonFeesMin {
    function launchpad() external view returns (address);
    function gardener() external view returns (address);
    function platform() external view returns (address);
    function register(address token, address creator, uint8 module, uint8 pool, address stock, address[] calldata splitTo, uint16[] calldata splitBps) external;
    function deposit(address token) external payable;
}
