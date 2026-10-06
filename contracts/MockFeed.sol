// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MockFeed: a Chainlink-shaped ETH/USD feed for the tests (8 decimals, settable answer and age).
contract MockFeed {
    int256 public answer;
    uint256 public updatedAt;
    uint8 public constant decimals = 8;
    constructor(int256 answer_) { answer = answer_; updatedAt = block.timestamp; }
    function set(int256 answer_, uint256 updatedAt_) external { answer = answer_; updatedAt = updatedAt_; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (1, answer, updatedAt, updatedAt, 1); }
}
