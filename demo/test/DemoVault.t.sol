// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DemoVault} from "../src/DemoVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// Seam E (the demo contracts, Foundry). Seams for ticket #7, written before the first test:
///  - E catches the vault's on-chain behaviour: the missing-access-check drain (R4.10 row 21),
///    the honest deposit/withdraw path (R4.10 row 1), that pausing reverts the exploit path
///    (R7.5), and that the pause role is pause-only and cannot move funds (R8.2). It misses the
///    judge's verdict on the exploit (seam J/T) and the MPC-derived pause-role address (formats/C).
///  - No other seam fits: these are pure EVM contract behaviours at the contract boundary.
///
/// The vault models the DEPUSDT/LEVUSDC hack of June 2023: a fund-moving function meant to be
/// operator-only (`executeStrategy`) that is missing its access check, so anyone can move the
/// vault's entire token balance to an address they control.
///
/// The bug is deliberate, and documented here and in docs/spec.md ("The demo contracts"), not
/// in DemoVault.sol: the vault's own comments read as a real protocol's would (#33), because the
/// demo's AI agent and the judges read that source, and a comment naming the bug would hand the
/// agent the answer. What the source no longer says: `executeStrategy` is meant to be
/// operator-only but never checks `operator`, so the role is decorative (R4.10 row 21); every
/// function on the exploit's path refuses to run once paused, so replaying the exploit after a
/// pause fails (R7.5); the pause role can only pause, with no unpause and no power over funds
/// (R8.2).
contract DemoVaultTest is Test {
    MockUSDC usdc;
    DemoVault vault;

    address operator = makeAddr("operator");
    address pauser = makeAddr("pauser");
    address depositor = makeAddr("depositor");

    uint256 constant SEED = 1_000_000e6; // 1,000,000 USDC (6 decimals)

    function setUp() public {
        usdc = new MockUSDC();
        vault = new DemoVault(address(usdc), operator, pauser);
        usdc.mint(address(vault), SEED); // vault pre-seeded with protocol funds
    }

    /// R4.10 row 21 / R4.3: a fresh attacker drains the whole vault through the unguarded
    /// `executeStrategy`, sending the funds to an attacker-held address.
    function test_exploit_missingAccessCheckDrainsVault() public {
        address attacker = makeAddr("attacker");
        assertEq(usdc.balanceOf(address(vault)), SEED);

        vm.prank(attacker);
        vault.executeStrategy(attacker, usdc.balanceOf(address(vault)));

        assertEq(usdc.balanceOf(address(vault)), 0, "vault drained");
        assertEq(usdc.balanceOf(attacker), SEED, "attacker holds the loot");
    }

    /// R4.10 row 1 / R4.2: an honest depositor can withdraw no more than they deposited, and
    /// cannot withdraw more than their balance.
    function test_honest_depositThenWithdrawNoMoreThanDeposited() public {
        uint256 amount = 500e6;
        usdc.mint(depositor, amount);

        vm.startPrank(depositor);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        assertEq(vault.deposits(depositor), amount);

        // Cannot take more than deposited.
        vm.expectRevert(bytes("withdraw > deposit"));
        vault.withdraw(amount + 1);

        vault.withdraw(amount);
        vm.stopPrank();

        assertEq(usdc.balanceOf(depositor), amount, "depositor got exactly their deposit back");
        assertEq(vault.deposits(depositor), 0);
        assertEq(usdc.balanceOf(address(vault)), SEED, "other funds untouched");
    }

    /// R7.5: once paused, the exploit's path (`executeStrategy`) reverts, so replaying the
    /// exploit live after the pause fails. The vault keeps its funds.
    function test_pause_revertsTheExploitPath() public {
        address attacker = makeAddr("attacker");

        vm.prank(pauser);
        vault.pause();
        assertTrue(vault.paused());

        vm.prank(attacker);
        vm.expectRevert(DemoVault.EnforcedPause.selector);
        vault.executeStrategy(attacker, SEED);

        assertEq(usdc.balanceOf(address(vault)), SEED, "exploit blocked, funds safe");
    }

    /// R8.2: the pause role can pause, and cannot unpause or move funds.
    function test_pauseRole_canPauseOnly() public {
        // Can pause.
        vm.prank(pauser);
        vault.pause();
        assertTrue(vault.paused());

        // Cannot unpause: there is no unpause entrypoint at all. Proven by ABI inspection —
        // the only state-changing powers the pauser could reach are below, and none clears it.
        bytes4[] memory nonExistent = new bytes4[](2);
        nonExistent[0] = bytes4(keccak256("unpause()"));
        nonExistent[1] = bytes4(keccak256("setPaused(bool)"));
        for (uint256 i = 0; i < nonExistent.length; i++) {
            (bool ok,) = address(vault).call(abi.encodeWithSelector(nonExistent[i]));
            assertFalse(ok, "no unpause-style function may exist");
        }
        assertTrue(vault.paused(), "still paused");

        // Cannot move funds: the pauser is not the vault's operator, but even calling the
        // (unguarded) fund mover is blocked now because the vault is paused.
        vm.prank(pauser);
        vm.expectRevert(DemoVault.EnforcedPause.selector);
        vault.executeStrategy(pauser, SEED);
        assertEq(usdc.balanceOf(pauser), 0, "pauser moved nothing");
    }

    /// R8.2: only the pause role may pause.
    function test_pause_rejectsNonPauser() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(DemoVault.NotPauser.selector);
        vault.pause();
        assertFalse(vault.paused());
    }
}
