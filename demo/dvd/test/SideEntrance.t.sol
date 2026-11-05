// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {World} from "../script/World.sol";
import {PauseRole} from "../src/adapted/PauseRole.sol";
import {PausableSideEntranceLenderPool} from "../src/adapted/PausableSideEntranceLenderPool.sol";
import {SideEntranceAttacker} from "../script/SideEntrance.s.sol";

/// Seam E, ticket #27: Damn Vulnerable DeFi v4 Side Entrance, adapted with BounTEE's standard
/// pause. Catches: the exploit (a flash loan repaid by depositing it, then withdrawn) drains the
/// adapted pool while unpaused; once paused, every function on its path refuses to run (R7.5);
/// the pause role can pause and nothing else (R8.2). Misses: the judge's verdict (J and T).
contract SideEntranceTest is Test, World {
    address pauser = makeAddr("pauser");
    address attacker = makeAddr("attacker");
    PausableSideEntranceLenderPool pool;

    function setUp() public {
        vm.deal(address(this), 2000 ether);
        pool = PausableSideEntranceLenderPool(deployLevels(pauser).sideEntrance);
    }

    /// The adaptation keeps the level's bug: unpaused, a fresh account takes the pool's 1,000 ETH.
    function test_exploitDrainsTheAdaptedPoolWhileUnpaused() public {
        vm.startPrank(attacker);
        new SideEntranceAttacker(address(pool)).attack();
        vm.stopPrank();
        assertEq(address(pool).balance, 0);
        assertEq(attacker.balance, SIDE_ENTRANCE_ETH);
    }

    /// R7.5: once paused, `flashLoan`, `deposit` and `withdraw` each refuse to run.
    function test_R7_5_pausedPoolRefusesEveryFunctionOnTheExploitPath() public {
        vm.prank(attacker);
        SideEntranceAttacker attack = new SideEntranceAttacker(address(pool));
        vm.prank(pauser);
        pool.pause();

        vm.prank(attacker);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        attack.attack();

        vm.deal(attacker, 1 ether);
        vm.startPrank(attacker);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.flashLoan(1 ether);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.deposit{value: 1 ether}();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.withdraw();
        vm.stopPrank();
        assertEq(address(pool).balance, SIDE_ENTRANCE_ETH);
    }

    /// The honest path (deposit, then withdraw what was deposited) works while unpaused.
    function test_honestDepositThenWithdrawWhileUnpaused() public {
        vm.deal(attacker, 1 ether);
        vm.startPrank(attacker);
        pool.deposit{value: 1 ether}();
        pool.withdraw();
        vm.stopPrank();
        assertEq(attacker.balance, 1 ether);
        assertEq(address(pool).balance, SIDE_ENTRANCE_ETH);
    }

    /// R8.2: the pause role can pause, and has no unpause and no way to take the pool's ETH.
    function test_R8_2_pauseRoleCanPauseOnly() public {
        vm.startPrank(pauser);
        pool.pause();
        (bool ok,) = address(pool).call(abi.encodeWithSignature("unpause()"));
        assertFalse(ok, "no unpause");
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.withdraw();
        vm.stopPrank();
        assertTrue(pool.paused());
        assertEq(pauser.balance, 0, "pauser moved nothing");
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
