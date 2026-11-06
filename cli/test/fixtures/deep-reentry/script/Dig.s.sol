// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Pot} from "../src/Pot.sol";

/// The cheatcodes this script uses (forge-std's `Vm`, cut down so the fixture needs no
/// dependencies).
interface Vm {
    function envAddress(string calldata name) external view returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Drains the Pot (env POT) through a 100-deep reentrancy, to the broadcaster.
contract Dig {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external {
        Pot pot = Pot(payable(vm.envAddress("POT")));
        vm.startBroadcast();
        pot.dig(100, payable(msg.sender));
        vm.stopBroadcast();
    }
}
