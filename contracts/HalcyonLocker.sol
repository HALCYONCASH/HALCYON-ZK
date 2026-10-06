// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHalcyonFeesMin, INonfungiblePositionManagerMin, ISwapRouter02Min, IWETH9, IERC20Min} from "./Interfaces.sol";

/// @title HalcyonLocker: holds every coin's Uniswap v3 liquidity position forever.
/// The launchpad mints a coin's whole supply into a single-sided position of its 1% pool and makes this contract the owner of
/// the position NFT. There is no function here that transfers the NFT or decreases the liquidity: the pool can never be pulled.
/// The one thing the locker does is `collect`: the gardener has it gather the fees the position earned (the coin's 1% on every
/// trade), turn the coin side into ETH through the same pool, and deposit the ETH in HalcyonFees, where the 80/20 split applies.
contract HalcyonLocker {
    IHalcyonFeesMin public immutable fees;
    INonfungiblePositionManagerMin public immutable nfpm;
    ISwapRouter02Min public immutable router;
    IWETH9 public immutable weth;
    uint24 public constant FEE = 10_000;
    mapping(address => uint256) public positions;   // token => NFT id
    mapping(uint256 => address) public tokenOf;     // NFT id => token

    event Locked(address indexed token, uint256 indexed tokenId);
    event Collected(address indexed token, uint256 indexed tokenId, uint256 coins, uint256 wethFees, uint256 eth);

    constructor(address fees_, address nfpm_, address router_, address weth_) {
        require(fees_ != address(0) && nfpm_ != address(0) && router_ != address(0) && weth_ != address(0), "zero");
        fees = IHalcyonFeesMin(fees_);
        nfpm = INonfungiblePositionManagerMin(nfpm_);
        router = ISwapRouter02Min(router_);
        weth = IWETH9(weth_);
    }

    /// @notice The launchpad records the position it just minted to this contract.
    function lock(address token, uint256 tokenId) external {
        require(msg.sender == fees.launchpad(), "launchpad");
        require(positions[token] == 0 && tokenOf[tokenId] == address(0), "locked");
        require(nfpm.ownerOf(tokenId) == address(this), "not held");
        positions[token] = tokenId;
        tokenOf[tokenId] = token;
        emit Locked(token, tokenId);
    }

    /// @notice The gardener gathers a coin's earned fees: the coin side is sold for WETH through the pool (at least `minOut` for it),
    /// the WETH is unwrapped and everything is deposited in HalcyonFees. Returns the ETH deposited and the part the coin side made
    /// (the gardener simulates with minOut 0 to size its real minOut).
    function collect(address token, uint256 minOut) external returns (uint256 eth, uint256 fromCoins) {
        require(msg.sender == fees.gardener(), "gardener");
        uint256 id = positions[token];
        require(id != 0, "unknown coin");
        (uint256 a0, uint256 a1) = nfpm.collect(INonfungiblePositionManagerMin.CollectParams({
            tokenId: id, recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max
        }));
        (uint256 coinAmount, uint256 wethAmount) = token < address(weth) ? (a0, a1) : (a1, a0);
        if (coinAmount > 0) {
            IERC20Min(token).approve(address(router), coinAmount);
            fromCoins = router.exactInputSingle(ISwapRouter02Min.ExactInputSingleParams({
                tokenIn: token, tokenOut: address(weth), fee: FEE, recipient: address(this), amountIn: coinAmount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0
            }));
        }
        eth = wethAmount + fromCoins;
        if (eth > 0) {
            weth.withdraw(eth);
            fees.deposit{value: eth}(token);
        }
        emit Collected(token, id, coinAmount, wethAmount, eth);
    }

    /// @notice What a collect would gather right now, before selling the coin side: the gardener simulates `collect` for the exact figure.
    function owed(address token) external view returns (uint256 coins, uint256 wethFees) {
        uint256 id = positions[token];
        if (id == 0) return (0, 0);
        (, , , , , , , , , , uint128 owed0, uint128 owed1) = nfpm.positions(id);
        return token < address(weth) ? (owed0, owed1) : (owed1, owed0);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// @dev WETH unwraps land here on their way to HalcyonFees.
    receive() external payable {
        require(msg.sender == address(weth), "weth only");
    }
}
