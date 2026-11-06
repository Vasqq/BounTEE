// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {DemoVault} from "../src/DemoVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// Deploys a fresh demo instance: the mock USDC, the vault, seeds the vault, and grants the
/// pause role to an address passed in (D21 — #16's fresh-instance script D21 calls this).
/// Prints the deployed addresses as a single JSON line so a caller can parse them.
///
/// Env:
///   PAUSE_ROLE    (address, required) — the pause-role address (on a real bounty, the
///                 MPC-derived address; on a fork/anvil, any address).
///   OPERATOR      (address, optional) — the vault operator; defaults to the broadcaster.
///   SEED_USDC     (uint,  optional) — USDC (6dp, smallest unit) to mint into the vault;
///                 defaults to 1_000_000e6.
/// Broadcast key: the usual forge `--private-key` / keystore flags.
contract Deploy is Script {
    function run() external {
        address pauser = vm.envAddress("PAUSE_ROLE");
        uint256 seed = vm.envOr("SEED_USDC", uint256(1_000_000e6));

        vm.startBroadcast();
        address operator = vm.envOr("OPERATOR", msg.sender);

        MockUSDC usdc = new MockUSDC();
        DemoVault vault = new DemoVault(address(usdc), operator, pauser);
        usdc.mint(address(vault), seed);
        vm.stopBroadcast();

        string memory json = "deploy";
        vm.serializeAddress(json, "usdc", address(usdc));
        vm.serializeAddress(json, "vault", address(vault));
        vm.serializeAddress(json, "operator", operator);
        vm.serializeAddress(json, "pauser", pauser);
        string memory out = vm.serializeUint(json, "seed", seed);

        console.log("DEMO_DEPLOY_JSON:");
        console.log(out);
    }
}
