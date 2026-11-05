// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {World} from "../script/World.sol";
import {PauseRole} from "../src/adapted/PauseRole.sol";
import {PausablePuppetPool} from "../src/adapted/PausablePuppetPool.sol";
import {PuppetAttacker} from "../script/Puppet.s.sol";
import {DamnValuableToken} from "../src/v4/DamnValuableToken.sol";

/// Seam E, ticket #27: Damn Vulnerable DeFi v4 Puppet, adapted with BounTEE's standard pause.
/// Catches: the exploit (dumping borrowed DVT into the thin Uniswap V1 pool the lending pool
/// reads its price from, then borrowing everything for almost no collateral) drains the adapted
/// lending pool while unpaused, starting from only the 1 ETH seed; once paused, `borrow`, the
/// exploit's path, refuses to run (R7.5); the pause role can pause and nothing else (R8.2).
/// Misses: the judge's verdict (J and T).
contract PuppetTest is Test, World {
    address pauser = makeAddr("pauser");
    address attacker = makeAddr("attacker");
    Levels l;
    PausablePuppetPool pool;
    DamnValuableToken token;

    function setUp() public {
        vm.deal(address(this), 2000 ether);
        l = deployLevels(pauser);
        pool = PausablePuppetPool(l.puppet);
        token = l.token;
    }

    /// The adaptation keeps the level's bug: unpaused, a fresh account holding only the 1 ETH
    /// seed takes all 100,000 DVT in one transaction.
    function test_exploitDrainsTheAdaptedPoolWhileUnpaused() public {
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        new PuppetAttacker{value: 0.99 ether}(address(pool), address(l.uniswap));
        assertEq(token.balanceOf(address(pool)), 0, "pool drained");
        // What it sold into the Uniswap pool along the way stays there: about 415 DVT.
        assertGt(token.balanceOf(attacker), 99_500e18, "attacker holds the loot");
    }

    /// R7.5: once paused, `borrow` refuses to run, so the exploit fails and the pool keeps its DVT.
    function test_R7_5_pausedPoolRefusesTheExploitPath() public {
        vm.prank(pauser);
        pool.pause();

        vm.deal(attacker, 1 ether);
        vm.startPrank(attacker);
        try new PuppetAttacker{value: 0.99 ether}(address(pool), address(l.uniswap)) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), Pausable.EnforcedPause.selector);
        }
        uint256 deposit = pool.calculateDepositRequired(0.01e18);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.borrow{value: deposit}(0.01e18, attacker);
        vm.stopPrank();
        assertEq(token.balanceOf(address(pool)), PUPPET_POOL_TOKENS);
    }

    /// The honest path (borrow at twice the oracle price in collateral) works while unpaused.
    function test_honestBorrowWhileUnpaused() public {
        uint256 deposit = pool.calculateDepositRequired(0.01e18);
        assertEq(deposit, 0.02 ether, "1 DVT costs 1 ETH in the Uniswap pool; collateral is twice that");
        vm.deal(attacker, deposit);
        vm.prank(attacker);
        pool.borrow{value: deposit}(0.01e18, attacker);
        assertEq(token.balanceOf(attacker), 0.01e18);
    }

    /// R8.2: the pause role can pause, and has no unpause and no way to take the pool's DVT.
    function test_R8_2_pauseRoleCanPauseOnly() public {
        vm.deal(pauser, 1 ether);
        vm.startPrank(pauser);
        pool.pause();
        (bool ok,) = address(pool).call(abi.encodeWithSignature("unpause()"));
        assertFalse(ok, "no unpause");
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pool.borrow{value: 1 ether}(0.1e18, pauser);
        vm.stopPrank();
        assertTrue(pool.paused());
        assertEq(token.balanceOf(pauser), 0, "pauser moved nothing");
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
