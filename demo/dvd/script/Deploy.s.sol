// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Script, console} from "forge-std/Script.sol";
import {World} from "./World.sol";

/// Deploys the three levels twice: unmodified (the judge's R4.10 rows 22-24) and adapted with
/// the pause role PAUSER (the DVD bounties). Prints each address as `<world>.<contract> <address>`.
/// Env: PAUSER. Broadcast key: any account holding about 2,001 ETH (make-fixtures.ts uses anvil's).
contract Deploy is Script, World {
    function run() external {
        address pauser = vm.envAddress("PAUSER");
        vm.startBroadcast();
        Levels memory unmodified = deployLevels(address(0));
        Levels memory adapted = deployLevels(pauser);
        vm.stopBroadcast();

        show("unmodified", unmodified, "TrusterLenderPool", "SideEntranceLenderPool", "PuppetPool");
        show("adapted", adapted, "PausableTrusterLenderPool", "PausableSideEntranceLenderPool", "PausablePuppetPool");
    }

    function show(string memory world, Levels memory l, string memory t, string memory s, string memory p) internal pure {
        console.log(string.concat(world, ".DamnValuableToken"), address(l.token));
        console.log(string.concat(world, ".", t), l.truster);
        console.log(string.concat(world, ".", s), l.sideEntrance);
        console.log(string.concat(world, ".", p), l.puppet);
        console.log(string.concat(world, ".UniswapV1Exchange"), address(l.uniswap));
    }
}
