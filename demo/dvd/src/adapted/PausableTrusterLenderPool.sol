// SPDX-License-Identifier: MIT
// Adapted by BounTEE from Damn Vulnerable DeFi v4 (https://damnvulnerabledefi.xyz),
// src/truster/TrusterLenderPool.sol at v4.1.0, MIT licence (demo/dvd/LICENSE).
// Modification: BounTEE's standard pause (PauseRole) added; `flashLoan`, the exploit's path,
// refuses to run while paused. The level's bug is kept unchanged.
pragma solidity =0.8.25;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DamnValuableToken} from "../v4/DamnValuableToken.sol";
import {PauseRole} from "./PauseRole.sol";

contract PausableTrusterLenderPool is ReentrancyGuard, PauseRole {
    using Address for address;

    DamnValuableToken public immutable token;

    error RepayFailed();

    constructor(DamnValuableToken _token, address pauser_) PauseRole(pauser_) {
        token = _token;
    }

    function flashLoan(uint256 amount, address borrower, address target, bytes calldata data)
        external
        nonReentrant
        whenNotPaused
        returns (bool)
    {
        uint256 balanceBefore = token.balanceOf(address(this));

        token.transfer(borrower, amount);
        target.functionCall(data);

        if (token.balanceOf(address(this)) < balanceBefore) {
            revert RepayFailed();
        }

        return true;
    }
}
