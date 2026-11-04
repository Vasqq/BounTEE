// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

/// Seam E: the demo contracts with Foundry. Add an E test as demo/test/<Name>.t.sol and
/// name the requirement IDs it proves in the test's NatSpec. Demo contracts go in
/// demo/src/, deploy scripts in demo/script/, committed block headers and proofs for the
/// demo exploits in demo/fixtures/.
contract SmokeTest is Test {
    /// Ticket #6 smoke: Foundry compiles and runs the demo suite on the pinned compiler.
    function test_smoke_foundryRunsTheDemoSuite() public {
        address fresh = makeAddr("fresh");
        vm.deal(fresh, 1 ether);
        assertEq(fresh.balance, 1 ether);
    }
}
