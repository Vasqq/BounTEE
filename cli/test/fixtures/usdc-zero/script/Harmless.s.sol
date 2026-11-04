// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// The cheatcodes this script uses (forge-std's `Vm`, cut down so the fixture needs no
/// dependencies).
interface Vm {
    function startBroadcast() external;
    function stopBroadcast() external;
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// Sends itself 0 USDC: a real call into the covered contract that takes nothing, so the
/// judge must score it ZERO. Broadcast by whatever key `bountee test` hands forge.
contract Harmless {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    IERC20 internal constant USDC = IERC20(0x036CbD53842c5426634e7929541eC2318f3dCF7e);

    function run() external {
        vm.startBroadcast();
        USDC.transfer(msg.sender, 0);
        vm.stopBroadcast();
    }
}
