// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Drainer, Token, Vault} from "../src/Fixture.sol";

/// The cheatcodes these scripts use (forge-std's `Vm`, cut down so the fixture needs no
/// dependencies).
interface Vm {
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function deal(address who, uint256 amount) external;
    function addr(uint256 privateKey) external returns (address);
    function envAddress(string calldata name) external returns (address);
    function envUint(string calldata name) external returns (uint256);
}

abstract contract Base {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bool public IS_SCRIPT = true;
}

/// Deploys the fixture state, broadcast by anvil's first account: a token, two vaults
/// holding 1000 tokens each, and 5 ether in the first vault.
contract Setup is Base {
    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_KEY"));
        Token token = new Token(10_000);
        Vault v1 = new Vault(token);
        Vault v2 = new Vault(token);
        token.transfer(address(v1), 1000);
        token.transfer(address(v2), 1000);
        payable(address(v1)).transfer(5 ether);
        vm.stopBroadcast();
    }
}

/// The fixture exploits, each a Foundry script whose broadcast transactions become the
/// judge's exploit. They run as dry runs (no --broadcast): `vm.deal` gives the fresh
/// account the seed for forge's own simulation, as the judge does for the replay.
contract Exploits is Base {
    uint256 internal constant FRESH_KEY = 0xb0b;

    function fresh() internal returns (address attacker) {
        attacker = vm.addr(FRESH_KEY);
        vm.deal(attacker, 1 ether);
        vm.startBroadcast(FRESH_KEY);
    }

    /// 300 tokens from vault 1 and 500 from vault 2 to the attacker, 200 from vault 1 to
    /// the treasury (not attacker holdings), and 2 ether from vault 1 to the attacker.
    function drain() external {
        Vault v1 = Vault(payable(vm.envAddress("VAULT_1")));
        Vault v2 = Vault(payable(vm.envAddress("VAULT_2")));
        address treasury = vm.envAddress("TREASURY");
        address attacker = fresh();
        v1.rescue(attacker, 300);
        v1.rescue(treasury, 200);
        v2.rescue(attacker, 500);
        v1.rescueNative(payable(attacker), 2 ether);
        vm.stopBroadcast();
    }

    /// A contract the fresh account creates takes 400 tokens from vault 1 for itself.
    function viaContract() external {
        Vault v1 = Vault(payable(vm.envAddress("VAULT_1")));
        fresh();
        new Drainer(v1, 400);
        vm.stopBroadcast();
    }

    /// The fresh account does nothing of value: it sends itself 0 tokens.
    function seedOnly() external {
        Token token = Token(vm.envAddress("TOKEN"));
        address attacker = fresh();
        token.transfer(attacker, 0);
        vm.stopBroadcast();
    }

    /// The same theft as `drain`'s first step, sent by an account that exists (R4.1).
    function existingSender() external {
        Vault v1 = Vault(payable(vm.envAddress("VAULT_1")));
        vm.startBroadcast(vm.envUint("DEPLOYER_KEY"));
        v1.rescue(vm.addr(vm.envUint("DEPLOYER_KEY")), 100);
        vm.stopBroadcast();
    }
}
