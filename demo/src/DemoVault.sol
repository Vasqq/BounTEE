// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// BounTEE demo vault. Holds test USDC on behalf of depositors. It carries a deliberate,
/// well-known vulnerability for the security bounty demo: a fund-moving function
/// (`executeStrategy`) that is meant to be operator-only but is MISSING its access check,
/// modelled on the DEPUSDT/LEVUSDC hack of June 2023. Anyone can call it and move the vault's
/// entire token balance to any address.
///
/// The vault has a pause role that can ONLY pause (there is no unpause and no fund-moving power
/// for the pauser; R8.2). Every function on the exploit's path refuses to run while paused, so
/// replaying the exploit after a pause fails (R7.5). Pausing is terminal by design: once paused
/// the vault stays paused, matching the demo's "a signed pause stops the live exploit" story.
contract DemoVault {
    IERC20 public immutable token;

    /// Operator is the intended caller of `executeStrategy`. The bug is that the function never
    /// checks it, so the role is decorative — exactly the DEPUSDT/LEVUSDC mistake.
    address public immutable operator;

    /// The pause role. It can call `pause()` and nothing else.
    address public immutable pauser;

    bool public paused;

    mapping(address => uint256) public deposits;

    event Deposit(address indexed account, uint256 amount);
    event Withdraw(address indexed account, uint256 amount);
    event StrategyExecuted(address indexed caller, address indexed to, uint256 amount);
    event Paused(address indexed by);

    error EnforcedPause();
    error NotPauser();

    constructor(address token_, address operator_, address pauser_) {
        require(token_ != address(0), "token=0");
        require(pauser_ != address(0), "pauser=0");
        token = IERC20(token_);
        operator = operator_;
        pauser = pauser_;
    }

    modifier whenNotPaused() {
        if (paused) revert EnforcedPause();
        _;
    }

    /// Honest-user path: pull `amount` USDC from the caller (needs prior approve) and credit it.
    function deposit(uint256 amount) external whenNotPaused {
        require(token.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        deposits[msg.sender] += amount;
        emit Deposit(msg.sender, amount);
    }

    /// Honest-user path: withdraw no more than the caller deposited.
    function withdraw(uint256 amount) external whenNotPaused {
        require(deposits[msg.sender] >= amount, "withdraw > deposit");
        deposits[msg.sender] -= amount;
        require(token.transfer(msg.sender, amount), "transfer failed");
        emit Withdraw(msg.sender, amount);
    }

    /// VULNERABLE: intended to let the operator deploy idle funds into a strategy, but it is
    /// missing `require(msg.sender == operator)`. Anyone can move the vault's whole balance to
    /// any address. This is the exploit's path, so it is also gated by `whenNotPaused` (R7.5).
    function executeStrategy(address to, uint256 amount) external whenNotPaused {
        require(token.transfer(to, amount), "transfer failed");
        emit StrategyExecuted(msg.sender, to, amount);
    }

    /// Pause role, pause-only (R8.2). No unpause exists and the pauser has no other power.
    function pause() external {
        if (msg.sender != pauser) revert NotPauser();
        paused = true;
        emit Paused(msg.sender);
    }
}
