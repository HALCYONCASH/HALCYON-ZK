// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Refuser: a test double that refuses ETH, so the tests can see a push fall back to `claimable`.
contract Refuser {
    receive() external payable { revert("no"); }
}
