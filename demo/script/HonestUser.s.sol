// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {DemoVault} from "../src/DemoVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// The ERC-20 call the honest user makes on the vault's USDC, Circle's or the mock.
interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// Uniswap V2's router (UniswapV2Router02), the two functions the honest user needs.
interface IUniswapV2Router {
    function WETH() external view returns (address);
    function getAmountsIn(uint256 amountOut, address[] calldata path) external view returns (uint256[] memory);
    function swapETHForExactTokens(uint256 amountOut, address[] calldata path, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory);
}

/// The honest-user path, as a script: a depositor gets USDC, deposits it, then withdraws no
/// more than they deposited. #16's cheat claim (R4.11) and #8/#10's scenarios run this as the
/// ZERO-verdict case (R4.10 row 1).
///
/// How the depositor gets its USDC depends on the token. A claim's fresh account starts with
/// only the bounty's native seed (the contract allows no token seed), so:
///   - On Base and Arbitrum One the vault holds Circle's USDC, which no one but Circle can
///     mint: the depositor buys exactly `AMOUNT` with its seed ETH on Uniswap V2 (the router
///     has the same address on both chains). The buy touches only the WETH/USDC pair, never
///     the vault, so it moves nothing the judge counts (ticket #35).
///   - Anywhere else (Base Sepolia, Arbitrum Sepolia, a local anvil) the vault holds the demo's
///     MockUSDC, whose `mint` is open: the depositor mints it.
///
/// Env:
///   VAULT   (address, required) — the deployed DemoVault.
///   AMOUNT  (uint,  optional) — USDC (6dp, smallest unit) to deposit; defaults to 500e6.
/// Broadcast key: any account holding the seed (on mainnet, enough ETH to buy AMOUNT).
contract HonestUser is Script {
    /// Uniswap V2's router on Base (8453) and Arbitrum One (42161).
    IUniswapV2Router constant UNISWAP_V2 = IUniswapV2Router(0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24);

    /// Base or Arbitrum One: chains where the vault holds Circle's USDC, which has no public mint.
    function isMainnet() internal view returns (bool) {
        return block.chainid == 8453 || block.chainid == 42161;
    }

    function run() external {
        DemoVault vault = DemoVault(vm.envAddress("VAULT"));
        address usdc = address(vault.token());
        uint256 amount = vm.envOr("AMOUNT", uint256(500e6));

        vm.startBroadcast();
        if (isMainnet()) {
            address[] memory path = new address[](2);
            path[0] = UNISWAP_V2.WETH();
            path[1] = usdc;
            uint256 ethIn = UNISWAP_V2.getAmountsIn(amount, path)[0];
            // No deadline: the judge replays in the block after the claim's (timestamp + 1),
            // later than this dry run's clock, so a deadline of `block.timestamp` would expire
            // there and the buy, then the deposit, would revert.
            UNISWAP_V2.swapETHForExactTokens{value: ethIn}(amount, path, msg.sender, type(uint256).max);
        } else {
            MockUSDC(usdc).mint(msg.sender, amount);
        }
        IERC20(usdc).approve(address(vault), amount);
        vault.deposit(amount);
        vault.withdraw(amount); // never more than deposited
        vm.stopBroadcast();

        console.log("deposited then withdrew (USDC smallest unit):", amount);
        console.log("remaining deposit credit:", vault.deposits(msg.sender));
    }
}
