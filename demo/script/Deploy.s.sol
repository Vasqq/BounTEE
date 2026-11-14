// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PositionVault} from "../src/PositionVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// Deploys a fresh demo instance: the vault, seeded by an ordinary deposit, granting the pause
/// role to an address passed in (D21 — the fresh-instance script calls this). On testnet the
/// USDC is a new mock (deployed first, so it sits at the deployer's nonce 0 and the vault at
/// nonce 1), minted to the deployer; on mainnet it is an existing USDC, held by the deployer.
/// Either way the deployer approves the vault and deposits the seed, so the vault's USDC is
/// owned through shares like any depositor's. Prints the deployed addresses as a single JSON
/// line so a caller can parse them.
///
/// Env:
///   PAUSE_ROLE    (address, required) — the pause-role address (on a real bounty, the
///                 MPC-derived address; on a fork/anvil, any address).
///   USDC          (address, optional) — an existing USDC (mainnet: Circle's); the seed is
///                 deposited from the broadcaster. Unset: a new MockUSDC, the seed minted first.
///   SEED_USDC     (uint,  optional) — USDC (6dp, smallest unit) to seed the vault with;
///                 defaults to 1_000_000e6.
/// Broadcast key: the usual forge `--private-key` / keystore flags.
contract Deploy is Script {
    function run() external {
        address pauser = vm.envAddress("PAUSE_ROLE");
        uint256 seed = vm.envOr("SEED_USDC", uint256(1_000_000e6));
        address usdc = vm.envOr("USDC", address(0));

        vm.startBroadcast();

        // Nonce 0: the mock USDC on testnet, so the vault lands at nonce 1 (tests pin it there).
        if (usdc == address(0)) {
            usdc = address(new MockUSDC());
        }
        // Nonce 1 on testnet: the vault.
        PositionVault vault = new PositionVault(usdc, pauser);

        // Seed by an ordinary deposit so the protocol holds the vault's USDC through shares.
        if (IERC20(usdc).balanceOf(msg.sender) < seed) {
            MockUSDC(usdc).mint(msg.sender, seed);
        }
        IERC20(usdc).approve(address(vault), seed);
        uint256 minted = vault.deposit(seed);
        // The first deposit into an empty vault mints shares 1:1 with the seed.
        require(minted == seed, "seed minted unexpected shares");
        require(vault.shares(msg.sender) == minted, "seed shares not credited");
        require(IERC20(usdc).balanceOf(address(vault)) == seed, "seed not held by vault");

        vm.stopBroadcast();

        string memory json = "deploy";
        vm.serializeAddress(json, "usdc", usdc);
        vm.serializeAddress(json, "vault", address(vault));
        vm.serializeAddress(json, "pauser", pauser);
        vm.serializeUint(json, "shares", minted);
        string memory out = vm.serializeUint(json, "seed", seed);

        console.log("DEMO_DEPLOY_JSON:");
        console.log(out);
    }
}
