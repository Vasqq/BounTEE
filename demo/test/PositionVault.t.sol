// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PositionVault, IPosition} from "../src/PositionVault.sol";
import {HonestPosition} from "../src/HonestPosition.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// Seam E (the demo contracts, Foundry). The vault lets a depositor deposit USDC directly or
/// from a position contract they own, and redeem shares for their part of the vault.
///
/// Seams agreed for #50 before the first test (loop notes, "#50"): E catches the vault's
/// on-chain behaviour at the contract boundary — the pause role is pause-only and moves no
/// funds (R8.2); a paused vault refuses deposit-from-position (R7.5), shown with the honest
/// position; and honest deposit, redeem and deposit-from-position return no more than was put
/// in (spec #48 user stories 9 and 10; no requirement ID: R4.6 itself is proved at seam J). It
/// misses the live chains, real USDC, and bots other than the one observed (stated limit). No
/// other seam fits: these are pure EVM contract behaviours.
///
/// What this stub is for: the drain bot seen on Base and Arbitrum (read-only eth_call against
/// 0x4a00e700…7821 on Nov 7) answers `owner()` with its own address and any other call with 1.
/// The invariant reuses it as one of its positions, and a unit test shows the vault refuses it.
contract ObservedBotStub {
    function owner() external view returns (address) {
        return address(this);
    }

    function attack(PositionVault v) external {
        v.depositFrom(IPosition(address(this)));
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(uint256(1));
    }
}

contract PositionVaultTest is Test {
    MockUSDC usdc;
    PositionVault vault;
    address pauser = makeAddr("pauser");
    address protocol = makeAddr("protocol");
    address depositor = makeAddr("depositor");
    uint256 constant SEED = 2e6; // the mainnet demo's 2 USDC

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PositionVault(address(usdc), pauser);
        usdc.mint(protocol, SEED);
        vm.startPrank(protocol);
        usdc.approve(address(vault), SEED);
        vault.deposit(SEED);
        vm.stopPrank();
    }

    /// Spec #48 user story 9 (no requirement ID; R4.6 is proved at seam J): an honest depositor
    /// deposits and redeems and gets back no more than they put in.
    function test_honest_deposit_and_redeem_returns_no_more_than_deposited() public {
        usdc.mint(depositor, 1e6);
        vm.startPrank(depositor);
        usdc.approve(address(vault), 1e6);
        uint256 s = vault.deposit(1e6);
        uint256 back = vault.redeem(s);
        vm.stopPrank();
        assertLe(back, 1e6, "redeem returns no more than deposited");
        assertLe(usdc.balanceOf(depositor), 1e6);
    }

    /// Spec #48 user stories 9 and 10 (no requirement ID; R4.6 is proved at seam J): depositing
    /// from an honest position the caller owns moves the position's USDC into the vault, and
    /// redeeming the shares returns no more than was put in.
    function test_honest_depositFrom_returns_no_more_than_put_in() public {
        HonestPosition position = new HonestPosition(address(usdc), depositor, address(vault));
        usdc.mint(address(position), 1e6);
        vm.startPrank(depositor);
        uint256 s = vault.depositFrom(IPosition(address(position)));
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(vault)), SEED + 1e6, "the position's USDC moved into the vault");
        vm.prank(depositor);
        uint256 back = vault.redeem(s);
        assertLe(back, 1e6, "redeem returns no more than the position held");
    }

    /// R8.2: the pause role can pause, cannot unpause (no such entrypoint), and cannot move
    /// funds; only the pause role may pause.
    function test_pauseRole_canPauseOnly() public {
        // A stranger cannot pause.
        vm.prank(depositor);
        vm.expectRevert(PositionVault.NotPauser.selector);
        vault.pause();

        // The pause role can pause.
        vm.prank(pauser);
        vault.pause();
        assertTrue(vault.paused());

        // No unpause-style entrypoint exists.
        bytes4[2] memory nonExistent =
            [bytes4(keccak256("unpause()")), bytes4(keccak256("setPaused(bool)"))];
        for (uint256 i; i < nonExistent.length; i++) {
            (bool ok,) = address(vault).call(abi.encodeWithSelector(nonExistent[i]));
            assertFalse(ok, "no unpause-style function may exist");
        }
        assertTrue(vault.paused(), "still paused");

        // The pause role can move no funds: it has no fund-moving power, and every
        // state-changing path is paused anyway.
        uint256 vaultUsdc = usdc.balanceOf(address(vault));
        vm.prank(pauser);
        vm.expectRevert(PositionVault.EnforcedPause.selector);
        vault.redeem(0);
        assertEq(usdc.balanceOf(pauser), 0, "pauser moved nothing");
        assertEq(usdc.balanceOf(address(vault)), vaultUsdc, "vault funds untouched");
    }

    /// R7.5: once paused, deposit-from-position refuses to run, so replaying it after a winning
    /// claim's pause fails. Shown with the honest position.
    function test_paused_vault_refuses_depositFrom() public {
        HonestPosition position = new HonestPosition(address(usdc), depositor, address(vault));
        usdc.mint(address(position), 1e6);

        vm.prank(pauser);
        vault.pause();

        vm.prank(depositor);
        vm.expectRevert(PositionVault.EnforcedPause.selector);
        vault.depositFrom(IPosition(address(position)));
        assertEq(usdc.balanceOf(address(vault)), SEED, "funds safe");
    }

    /// ADR-0019's recorded analysis evidence (requirements.md method A): the drain bot seen on
    /// Nov 7, replicated, is refused and moves nothing.
    function test_observed_bot_stub_is_refused() public {
        ObservedBotStub bot = new ObservedBotStub();
        vm.expectRevert(bytes("position belongs to another vault"));
        bot.attack(vault);
        assertEq(usdc.balanceOf(address(vault)), SEED, "vault USDC unchanged");
    }
}
