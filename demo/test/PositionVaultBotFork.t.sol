// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PositionVault, IPosition} from "../src/PositionVault.sol";

interface IUSDC {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// Seam E, ADR-0019 evidence (not a requirement test): the drain bot's real on-chain code (its
/// EIP-7702 delegate on Arbitrum One) used as the position, on a fork. It is refused and the
/// vault's USDC does not move. Skipped unless FORK_RPC is set; the bot's 7702 designator needs
/// the Prague EVM, so run it under the `fork` Foundry profile:
///   FORK_RPC=<arbitrum one rpc> FOUNDRY_PROFILE=fork forge test --match-contract PositionVaultBotFork
contract PositionVaultBotForkTest is Test {
    address constant BOT = 0x4a00e700C0005610c9E0C0000040126E55007821;
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    PositionVault vault;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        vault = new PositionVault(USDC, makeAddr("pauser"));
        address protocol = makeAddr("protocol");
        deal(USDC, protocol, 1e6);
        vm.startPrank(protocol);
        IUSDC(USDC).approve(address(vault), 1e6);
        vault.deposit(1e6);
        vm.stopPrank();
    }

    function test_real_bot_code_as_its_own_position_is_refused() public {
        assertGt(BOT.code.length, 0, "the bot's 7702 designator is on the fork");
        vm.prank(BOT);
        vm.expectRevert(bytes("position belongs to another vault"));
        vault.depositFrom(IPosition(BOT));
        assertEq(IUSDC(USDC).balanceOf(address(vault)), 1e6, "vault USDC unchanged");
    }
}
