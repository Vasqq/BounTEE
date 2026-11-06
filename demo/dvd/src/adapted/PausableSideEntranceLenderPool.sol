// SPDX-License-Identifier: MIT
// Adapted by BounTEE from Damn Vulnerable DeFi v4 (https://damnvulnerabledefi.xyz),
// src/side-entrance/SideEntranceLenderPool.sol at v4.1.0, MIT licence (demo/dvd/LICENSE).
// Modification: BounTEE's standard pause (PauseRole) added; `flashLoan`, `deposit` and
// `withdraw`, the exploit's path, refuse to run while paused. The level's bug is kept unchanged.
pragma solidity =0.8.25;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IFlashLoanEtherReceiver} from "../v4/side-entrance/SideEntranceLenderPool.sol";
import {PauseRole} from "./PauseRole.sol";

contract PausableSideEntranceLenderPool is PauseRole {
    mapping(address => uint256) public balances;

    error RepayFailed();

    event Deposit(address indexed who, uint256 amount);
    event Withdraw(address indexed who, uint256 amount);

    constructor(address pauser_) PauseRole(pauser_) {}

    function deposit() external payable whenNotPaused {
        unchecked {
            balances[msg.sender] += msg.value;
        }
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw() external whenNotPaused {
        uint256 amount = balances[msg.sender];

        delete balances[msg.sender];
        emit Withdraw(msg.sender, amount);

        SafeTransferLib.safeTransferETH(msg.sender, amount);
    }

    function flashLoan(uint256 amount) external whenNotPaused {
        uint256 balanceBefore = address(this).balance;

        IFlashLoanEtherReceiver(msg.sender).execute{value: amount}();

        if (address(this).balance < balanceBefore) {
            revert RepayFailed();
        }
    }
}
