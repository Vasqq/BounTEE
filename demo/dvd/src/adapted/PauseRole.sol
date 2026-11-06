// SPDX-License-Identifier: MIT
pragma solidity =0.8.25;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// BounTEE's standard pause for the adapted Damn Vulnerable DeFi levels: OpenZeppelin's
/// `Pausable` with one pause role, fixed at deployment, that can call `pause()` and nothing
/// else (R8.2). There is no unpause: pausing is terminal, as on the demo vault. `pause()` is
/// the call every signed pause makes (selector 0x8456cb59); pausing a paused pool does nothing,
/// so a pause delivered twice still lands.
abstract contract PauseRole is Pausable {
    /// The bounty's pause-role address (D25).
    address public immutable pauser;

    error NotPauser();

    constructor(address pauser_) {
        if (pauser_ == address(0)) revert NotPauser();
        pauser = pauser_;
    }

    function pause() external {
        if (msg.sender != pauser) revert NotPauser();
        if (!paused()) _pause();
    }
}
