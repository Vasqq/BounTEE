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

/// A covered contract that deploys a child during the replay and sends it 1 ether: the
/// child needs no proof (R4.5), and it isn't attacker holdings, since no fresh account
/// created it (R4.8). `spawn` forgets an owner check, so anyone can call it.
contract Factory {
    receive() external payable {}

    function spawn() external returns (address) {
        return address(new Child{value: 1 ether}());
    }

    /// The same by CREATE2 under `salt`: a reused salt lands where the factory already
    /// deployed, so the child's address needs a proof of absence (R4.5).
    function spawn2(bytes32 salt) external returns (address) {
        return address(new Child{value: 1 ether, salt: salt}());
    }
}

/// The child: it writes, and so reads, a slot of its own while being created.
contract Child {
    uint256 public count;

    constructor() payable {
        count = count + 1;
    }
}
