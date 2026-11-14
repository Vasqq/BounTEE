// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// A position contract that holds USDC for its owner and is attached to one vault (a
/// strategy's escrow, a vault-managed sub-account, and the like).
interface IPosition {
    function owner() external view returns (address);
    function vault() external view returns (address);
    /// USDC the position can release right now.
    function withdrawable() external view returns (uint256);
    /// Sends `amount` of `token` from the position to `to`.
    function pushTo(address token, address to, uint256 amount) external;
}

/// A USDC vault. Depositors get shares and redeem them for their part of the vault. USDC can
/// come straight from the depositor, or from a position the depositor owns.
///
/// The pauser can only pause: there is no unpause, and the pauser has no other power. Once
/// paused, the vault stays paused and every state-changing function refuses to run.
contract PositionVault {
    IERC20 public immutable token;
    /// The pause role. It can call `pause()` and nothing else.
    address public immutable pauser;
    bool public paused;

    uint256 public totalShares;
    mapping(address => uint256) public shares;

    event Deposit(address indexed account, uint256 amount, uint256 shares);
    event Redeem(address indexed account, uint256 shares, uint256 amount);
    event Paused(address indexed by);

    error EnforcedPause();
    error NotPauser();

    constructor(address token_, address pauser_) {
        require(token_ != address(0), "token=0");
        require(pauser_ != address(0), "pauser=0");
        token = IERC20(token_);
        pauser = pauser_;
    }

    modifier whenNotPaused() {
        if (paused) revert EnforcedPause();
        _;
    }

    function totalAssets() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// Shares worth `amount` USDC at the current price.
    function toShares(uint256 amount) public view returns (uint256) {
        uint256 assets = totalAssets();
        return totalShares == 0 || assets == 0 ? amount : (amount * totalShares) / assets;
    }

    /// Deposit `amount` USDC from the caller (needs a prior approve).
    function deposit(uint256 amount) external whenNotPaused returns (uint256 minted) {
        minted = toShares(amount);
        require(token.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        _mint(msg.sender, minted, amount);
    }

    /// Deposit everything a position the caller owns can release.
    function depositFrom(IPosition position) external whenNotPaused returns (uint256 minted) {
        require(position.owner() == msg.sender, "not your position");
        require(position.vault() == address(this), "position belongs to another vault");
        uint256 amount = position.withdrawable();
        require(amount > 0, "nothing to deposit");
        minted = toShares(amount);
        position.pushTo(address(token), address(this), amount);
        _mint(msg.sender, minted, amount);
    }

    /// Redeem `amount` shares for their part of the vault's USDC.
    function redeem(uint256 amount) external whenNotPaused returns (uint256 assets) {
        require(shares[msg.sender] >= amount, "redeem > shares");
        assets = (amount * totalAssets()) / totalShares;
        shares[msg.sender] -= amount;
        totalShares -= amount;
        require(token.transfer(msg.sender, assets), "transfer failed");
        emit Redeem(msg.sender, amount, assets);
    }

    /// Pause-only. No unpause exists.
    function pause() external {
        if (msg.sender != pauser) revert NotPauser();
        paused = true;
        emit Paused(msg.sender);
    }

    function _mint(address to, uint256 minted, uint256 amount) private {
        require(minted > 0, "zero shares");
        shares[to] += minted;
        totalShares += minted;
        emit Deposit(to, amount, minted);
    }
}
