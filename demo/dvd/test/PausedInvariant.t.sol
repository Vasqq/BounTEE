// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Test} from "forge-std/Test.sol";
import {World} from "../script/World.sol";
import {PauseRole} from "../src/adapted/PauseRole.sol";
import {DamnValuableToken} from "../src/v4/DamnValuableToken.sol";
import {PausableTrusterLenderPool} from "../src/adapted/PausableTrusterLenderPool.sol";
import {PausableSideEntranceLenderPool} from "../src/adapted/PausableSideEntranceLenderPool.sol";
import {PausablePuppetPool} from "../src/adapted/PausablePuppetPool.sol";
import {SideEntranceAttacker} from "../script/SideEntrance.s.sol";
import {PuppetAttacker} from "../script/Puppet.s.sol";

/// Random calls into the three paused adapted pools, from random actors (the pause role
/// included), with the known exploits among them.
contract PausedPoolsHandler is Test {
    World.Levels l;
    address pauser;
    uint256 public calls;

    constructor(World.Levels memory l_, address pauser_) {
        l = l_;
        pauser = pauser_;
    }

    function actor(uint256 seed) internal returns (address who) {
        who = seed % 4 == 0 ? pauser : address(uint160(bound(seed, 1, type(uint64).max)));
        vm.deal(who, 10 ether);
    }

    function trusterFlashLoan(uint256 seed, uint256 amount, bool approveCallback) external {
        calls++;
        address who = actor(seed);
        DamnValuableToken token = l.token;
        bytes memory data = approveCallback
            ? abi.encodeCall(token.approve, (who, type(uint256).max))
            : abi.encodeCall(token.balanceOf, (who));
        vm.prank(who);
        try PausableTrusterLenderPool(l.truster).flashLoan(bound(amount, 0, 2_000_000e18), who, address(token), data) {} catch {}
        vm.prank(who);
        try token.transferFrom(l.truster, who, 1) {} catch {}
    }

    function sideEntrance(uint256 seed, uint256 action, uint256 amount) external {
        calls++;
        address who = actor(seed);
        PausableSideEntranceLenderPool pool = PausableSideEntranceLenderPool(l.sideEntrance);
        amount = bound(amount, 0, 10 ether);
        vm.startPrank(who);
        if (action % 4 == 0) try pool.deposit{value: amount}() {} catch {}
        else if (action % 4 == 1) try pool.withdraw() {} catch {}
        else if (action % 4 == 2) try pool.flashLoan(amount) {} catch {}
        else try new SideEntranceAttacker(address(pool)).attack() {} catch {}
        vm.stopPrank();
    }

    function puppet(uint256 seed, uint256 amount, bool exploit) external {
        calls++;
        address who = actor(seed);
        PausablePuppetPool pool = PausablePuppetPool(l.puppet);
        vm.startPrank(who);
        if (exploit) {
            try new PuppetAttacker{value: 1 ether}(address(pool), address(l.uniswap)) {} catch {}
        } else {
            try pool.borrow{value: 10 ether}(bound(amount, 0, 200_000e18), who) {} catch {}
        }
        vm.stopPrank();
    }

    function pauseAgain(uint256 seed) external {
        calls++;
        vm.prank(actor(seed));
        try PauseRole(l.puppet).pause() {} catch {}
    }
}

/// Seam E, ticket #27, R7.5 and R8.2 as a property: once the three adapted pools are paused,
/// no sequence of calls by anyone, the pause role included, lowers what any pool holds or
/// unpauses it. Catches a function on an exploit path left without the pause, or a way around
/// it. Misses: paths through contracts other than the pools (none hold the pools' funds).
contract PausedInvariantTest is Test, World {
    address pauser = makeAddr("pauser");
    Levels l;
    PausedPoolsHandler handler;

    function setUp() public {
        vm.deal(address(this), 2000 ether);
        l = deployLevels(pauser);
        vm.startPrank(pauser);
        PauseRole(l.truster).pause();
        PauseRole(l.sideEntrance).pause();
        PauseRole(l.puppet).pause();
        vm.stopPrank();
        handler = new PausedPoolsHandler(l, pauser);
        targetContract(address(handler));
    }

    function invariant_R7_5_R8_2_pausedPoolsKeepTheirFunds() public view {
        assertEq(l.token.balanceOf(l.truster), TRUSTER_TOKENS);
        assertEq(l.token.allowance(l.truster, address(0xdead)), 0);
        assertGe(l.sideEntrance.balance, SIDE_ENTRANCE_ETH);
        assertEq(l.token.balanceOf(l.puppet), PUPPET_POOL_TOKENS);
        assertTrue(PauseRole(l.truster).paused() && PauseRole(l.sideEntrance).paused() && PauseRole(l.puppet).paused());
    }

    /// Not vacuous: the handler's calls really ran.
    function afterInvariant() public view {
        assertGt(handler.calls(), 0);
    }
}
