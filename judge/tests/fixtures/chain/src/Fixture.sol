// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Judge test fixtures only (ticket #8): a small token and a buggy vault, deployed on anvil
// to make committed block headers and proofs. Not the demo vault (demo/), and nothing in
// the judge knows about them (D11).

/// A minimal ERC-20.
contract Token {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    constructor(uint256 supply) {
        balanceOf[msg.sender] = supply;
        totalSupply = supply;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Holds tokens and native coin for its owner. `rescue` and `rescueNative` forget the
/// owner check: anyone can send the vault's holdings anywhere.
contract Vault {
    address public owner;
    Token public token;

    constructor(Token token_) {
        owner = msg.sender;
        token = token_;
    }

    receive() external payable {}

    function rescue(address to, uint256 amount) external {
        token.transfer(to, amount);
    }

    function rescueNative(address payable to, uint256 amount) external {
        to.transfer(amount);
    }
}

/// An exploit's helper contract: created by a fresh account, it takes tokens for itself,
/// so the value it ends holding is attacker holdings (R4.8).
contract Drainer {
    constructor(Vault vault, uint256 amount) {
        vault.rescue(address(this), amount);
    }
}
