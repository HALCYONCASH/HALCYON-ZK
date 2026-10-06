// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title HalcyonToken: the coin. A plain ERC-20, minted once, with a burn and nothing else.
/// Every Halcyon coin is an EIP-1167 clone of one verified implementation, initialized once by the launchpad, which mints the
/// whole supply and puts it in the coin's Uniswap pool. No owner, no mint, no pause, no blacklist, no tax, no max wallet: the
/// fee lives in the pool (the 1% tier, paid to the locked liquidity Halcyon holds), not in the coin.
contract HalcyonToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public launchpad;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @dev The implementation itself is never a coin: its slot is taken here so nobody can initialize it and pass it off as one.
    /// A clone copies the code, not this storage, so every clone starts fresh and the launchpad initializes it.
    constructor() {
        launchpad = msg.sender;
    }

    /// @notice Called once by the launchpad on a fresh clone: name it and mint the supply to `to_`.
    function initialize(string calldata name_, string calldata symbol_, uint256 supply_, address to_) external {
        require(launchpad == address(0), "initialized");
        require(bytes(name_).length > 0 && bytes(symbol_).length > 0 && supply_ > 0 && to_ != address(0), "params");
        launchpad = msg.sender;
        name = name_;
        symbol = symbol_;
        totalSupply = supply_;
        balanceOf[to_] = supply_;
        emit Transfer(address(0), to_, supply_);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= value, "allowance");
            allowance[from][msg.sender] = a - value;
        }
        _transfer(from, to, value);
        return true;
    }

    /// @notice Anyone may burn their own coins; the Burn module burns what it buys back.
    function burn(uint256 value) external {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        totalSupply -= value;
        emit Transfer(msg.sender, address(0), value);
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(to != address(0), "to zero");
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
