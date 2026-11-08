// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PositionVault, IPosition} from "../src/PositionVault.sol";
import {HonestPosition} from "../src/HonestPosition.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {ObservedBotStub} from "./PositionVault.t.sol";

/// Seam E, ADR-0019 evidence (not a requirement test): a fuzzing stand-in for the scanner and
/// fuzzer bots. Random actors with some USDC call the vault in random order, passing as a
/// position any of: their own address, the vault, the token, the observed drain bot's stub, and
/// an honest position one of them owns. None writes a purpose-built, non-cooperating position.
/// The protocol's seed and each actor's own USDC must survive: no actor profits beyond rounding.
contract Handler is Test {
    PositionVault vault;
    MockUSDC usdc;
    HonestPosition honest;
    address[] public actors;
    address[] positions;

    uint256 constant ENDOWMENT = 1e6;

    constructor(PositionVault v, MockUSDC u) {
        vault = v;
        usdc = u;
        for (uint160 i = 1; i <= 3; i++) {
            address a = address(i * 0x1000);
            actors.push(a);
            usdc.mint(a, ENDOWMENT);
            vm.prank(a);
            usdc.approve(address(v), type(uint256).max);
        }
        // An honest position owned by actor 0, funded out of actor 0's own endowment, so its
        // owner's total holdings never exceed what they started with.
        honest = new HonestPosition(address(u), actors[0], address(v));
        vm.prank(actors[0]);
        usdc.transfer(address(honest), ENDOWMENT / 2);

        positions.push(address(v));
        positions.push(address(u));
        positions.push(address(new ObservedBotStub()));
        positions.push(address(honest));
        positions.push(actors[0]);
    }

    function deposit(uint256 who, uint256 amount) external {
        address a = actors[who % actors.length];
        amount = bound(amount, 1, usdc.balanceOf(a) + 1);
        vm.prank(a);
        try vault.deposit(amount) {} catch {}
    }

    function redeem(uint256 who, uint256 amount) external {
        address a = actors[who % actors.length];
        amount = bound(amount, 0, vault.shares(a));
        vm.prank(a);
        try vault.redeem(amount) {} catch {}
    }

    function depositFrom(uint256 who, uint256 which) external {
        address a = actors[who % actors.length];
        vm.prank(a);
        try vault.depositFrom(IPosition(positions[which % positions.length])) {} catch {}
    }

    function depositFromAny(uint256 who, address p) external {
        vm.prank(actors[who % actors.length]);
        try vault.depositFrom(IPosition(p)) {} catch {}
    }

    /// An actor's total holdings: its wallet USDC, the value of its shares, and — for the honest
    /// position's owner — the USDC still sitting in that position.
    function holdings(address a) external view returns (uint256) {
        uint256 held = usdc.balanceOf(a);
        uint256 ts = vault.totalShares();
        uint256 inShares = ts == 0 ? 0 : (vault.shares(a) * vault.totalAssets()) / ts;
        uint256 inPosition = honest.owner() == a ? usdc.balanceOf(address(honest)) : 0;
        return held + inShares + inPosition;
    }
}

contract PositionVaultInvariantTest is Test {
    PositionVault vault;
    MockUSDC usdc;
    Handler handler;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PositionVault(address(usdc), makeAddr("pauser"));
        address protocol = makeAddr("protocol");
        usdc.mint(protocol, 2e6);
        vm.startPrank(protocol);
        usdc.approve(address(vault), 2e6);
        vault.deposit(2e6);
        vm.stopPrank();
        handler = new Handler(vault, usdc);
        targetContract(address(handler));
    }

    /// No fuzzed actor ends with more than its 1 USDC endowment plus dust.
    function invariant_no_actor_profits() public view {
        for (uint256 i; i < 3; i++) {
            assertLe(handler.holdings(handler.actors(i)), 1e6 + 100, "an actor profited beyond dust");
        }
    }
}
