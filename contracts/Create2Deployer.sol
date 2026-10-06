// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Create2Deployer: deploys a contract at an address chosen by a salt. The Halcyon hook needs an address whose low bits
/// spell its permissions (Uniswap v4 reads them from the address), so the deploy script mines a salt and deploys it through here.
contract Create2Deployer {
    event Deployed(address indexed at, bytes32 salt);
    function deploy(bytes32 salt, bytes calldata initCode) external payable returns (address at) {
        bytes memory code = initCode;
        assembly ("memory-safe") { at := create2(callvalue(), add(code, 0x20), mload(code), salt) }
        require(at != address(0), "create2");
        emit Deployed(at, salt);
    }
    function predict(bytes32 salt, bytes32 initCodeHash) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(this), salt, initCodeHash)))));
    }
}
