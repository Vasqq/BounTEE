// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {DemoVault, IERC20} from "../src/DemoVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// Deploys a fresh demo instance: the vault, seeded with USDC, granting the pause role to an
/// address passed in (D21 — the fresh-instance script calls this). On testnet the USDC is a
/// new mock, minted into the vault; on mainnet it is real USDC, sent from the broadcaster.
/// Prints the deployed addresses as a single JSON line so a caller can parse them.
///
/// Env:
///   PAUSE_ROLE    (address, required) — the pause-role address (on a real bounty, the
///                 MPC-derived address; on a fork/anvil, any address).
///   OPERATOR      (address, optional) — the vault operator; defaults to the broadcaster.
///   USDC          (address, optional) — an existing USDC (mainnet: Circle's); the seed is
///                 sent from the broadcaster. Unset: a new MockUSDC, the seed minted.
///   SEED_USDC     (uint,  optional) — USDC (6dp, smallest unit) to seed the vault with;
///                 defaults to 1_000_000e6.
/// Broadcast key: the usual forge `--private-key` / keystore flags.
contract Deploy is Script {
    function run() external {
        address pauser = vm.envAddress("PAUSE_ROLE");
        uint256 seed = vm.envOr("SEED_USDC", uint256(1_000_000e6));

        vm.startBroadcast();
        address operator = vm.envOr("OPERATOR", msg.sender);

        address usdc = vm.envOr("USDC", address(0));
        DemoVault vault;
        if (usdc == address(0)) {
            MockUSDC mock = new MockUSDC();
            usdc = address(mock);
            vault = new DemoVault(usdc, operator, pauser);
            mock.mint(address(vault), seed);
        } else {
            vault = new DemoVault(usdc, operator, pauser);
            require(IERC20(usdc).transfer(address(vault), seed), "USDC transfer failed");
        }
        vm.stopBroadcast();

        string memory json = "deploy";
        vm.serializeAddress(json, "usdc", usdc);
        vm.serializeAddress(json, "vault", address(vault));
        vm.serializeAddress(json, "operator", operator);
        vm.serializeAddress(json, "pauser", pauser);
        string memory out = vm.serializeUint(json, "seed", seed);

        console.log("DEMO_DEPLOY_JSON:");
        console.log(out);
    }
}
