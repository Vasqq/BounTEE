// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {DemoVault} from "../src/DemoVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// The honest-user path, as a script: a depositor mints test USDC, deposits it, then withdraws
/// no more than they deposited. #16's cheat claim and #8/#10's scenarios run this as the
/// ZERO-verdict case (R4.10 row 1).
///
/// Env:
///   VAULT   (address, required) — the deployed DemoVault.
///   AMOUNT  (uint,  optional) — USDC (6dp, smallest unit) to deposit; defaults to 500e6.
/// Broadcast key: any funded account.
contract HonestUser is Script {
    function run() external {
        DemoVault vault = DemoVault(vm.envAddress("VAULT"));
        MockUSDC usdc = MockUSDC(address(vault.token()));
        uint256 amount = vm.envOr("AMOUNT", uint256(500e6));

        vm.startBroadcast();
        usdc.mint(msg.sender, amount);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vault.withdraw(amount); // never more than deposited
        vm.stopBroadcast();

        console.log("deposited then withdrew (USDC smallest unit):", amount);
        console.log("remaining deposit credit:", vault.deposits(msg.sender));
    }
}
