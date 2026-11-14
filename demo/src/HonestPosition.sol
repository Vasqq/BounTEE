// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPosition} from "./PositionVault.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// A position for the demo vault: it holds its owner's USDC for one vault. Its owner funds it by
/// sending USDC to it, then calls the vault's deposit-from-position to move that USDC into the
/// vault and receive shares.
contract HonestPosition is IPosition {
    IERC20 public immutable token;
    address public immutable owner;
    address public immutable vault;

    error NotVault();
    error WrongToken();

    constructor(address token_, address owner_, address vault_) {
        require(token_ != address(0), "token=0");
        require(owner_ != address(0), "owner=0");
        require(vault_ != address(0), "vault=0");
        token = IERC20(token_);
        owner = owner_;
        vault = vault_;
    }

    /// The USDC this position can release right now: everything it holds.
    function withdrawable() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// Send `amount` of `token_` to `to`. Only the vault may call it, and only for this
    /// position's own token.
    function pushTo(address token_, address to, uint256 amount) external {
        if (msg.sender != vault) revert NotVault();
        if (token_ != address(token)) revert WrongToken();
        require(IERC20(token_).transfer(to, amount), "transfer failed");
    }
}
