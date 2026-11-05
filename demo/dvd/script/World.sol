// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Vm} from "forge-std/Vm.sol";
import {DamnValuableToken} from "../src/v4/DamnValuableToken.sol";
import {TrusterLenderPool} from "../src/v4/truster/TrusterLenderPool.sol";
import {SideEntranceLenderPool} from "../src/v4/side-entrance/SideEntranceLenderPool.sol";
import {PuppetPool} from "../src/v4/puppet/PuppetPool.sol";
import {IUniswapV1Exchange} from "../src/v4/puppet/IUniswapV1Exchange.sol";
import {IUniswapV1Factory} from "../src/v4/puppet/IUniswapV1Factory.sol";
import {PausableTrusterLenderPool} from "../src/adapted/PausableTrusterLenderPool.sol";
import {PausableSideEntranceLenderPool} from "../src/adapted/PausableSideEntranceLenderPool.sol";
import {PausablePuppetPool} from "../src/adapted/PausablePuppetPool.sol";

/// One deployment of the three Damn Vulnerable DeFi v4 levels BounTEE uses, with DVD v4's own
/// starting balances, except Puppet's Uniswap pool (see below). `pauser == address(0)` deploys
/// the levels unmodified (the judge's R4.10 scenarios, rows 22-24); any other address deploys
/// the adapted levels with that address as their pause role (the DVD bounties).
///
/// Puppet's Uniswap pool holds 0.1 ETH and 0.1 DVT instead of DVD's 10 and 10, because a
/// BounTEE exploit starts from fresh accounts holding only the seed (1 ETH), not DVD's player
/// with 25 ETH and 1,000 DVT. The level's flaw is the same: a spot-price oracle on a thin pool.
abstract contract World {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant TRUSTER_TOKENS = 1_000_000e18; // DVD v4 TrusterChallenge
    uint256 internal constant SIDE_ENTRANCE_ETH = 1000e18; // DVD v4 SideEntranceChallenge
    uint256 internal constant PUPPET_POOL_TOKENS = 100_000e18; // DVD v4 PuppetChallenge
    uint256 internal constant UNISWAP_ETH = 0.1e18;
    uint256 internal constant UNISWAP_TOKENS = 0.1e18;

    struct Levels {
        DamnValuableToken token;
        address truster;
        address sideEntrance;
        address puppet;
        IUniswapV1Exchange uniswap;
    }

    /// Deploys and funds the levels; the caller pays (it needs about 1,000.2 ETH).
    function deployLevels(address pauser) internal returns (Levels memory l) {
        l.token = new DamnValuableToken();

        if (pauser == address(0)) {
            l.truster = address(new TrusterLenderPool(l.token));
            l.sideEntrance = address(new SideEntranceLenderPool());
        } else {
            l.truster = address(new PausableTrusterLenderPool(l.token, pauser));
            l.sideEntrance = address(new PausableSideEntranceLenderPool(pauser));
        }
        l.token.transfer(l.truster, TRUSTER_TOKENS);
        SideEntranceLenderPool(l.sideEntrance).deposit{value: SIDE_ENTRANCE_ETH}();

        IUniswapV1Factory factory = IUniswapV1Factory(deployBuild("UniswapV1Factory"));
        factory.initializeFactory(deployBuild("UniswapV1Exchange"));
        l.uniswap = IUniswapV1Exchange(factory.createExchange(address(l.token)));
        l.token.approve(address(l.uniswap), UNISWAP_TOKENS);
        l.uniswap.addLiquidity{value: UNISWAP_ETH}(0, UNISWAP_TOKENS, block.timestamp * 2);

        l.puppet = pauser == address(0)
            ? address(new PuppetPool(address(l.token), address(l.uniswap)))
            : address(new PausablePuppetPool(address(l.token), address(l.uniswap), pauser));
        l.token.transfer(l.puppet, PUPPET_POOL_TOKENS);
    }

    /// Deploys one of DVD v4's Uniswap V1 builds (builds/uniswap, GPL-3.0, see NOTICE).
    function deployBuild(string memory name) private returns (address deployed) {
        bytes memory code = VM.getCode(string.concat(VM.projectRoot(), "/builds/uniswap/", name, ".json"));
        assembly ("memory-safe") {
            deployed := create(0, add(code, 0x20), mload(code))
        }
        require(deployed != address(0), name);
    }
}
