// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// A USDC vault. Depositors deposit and withdraw; the operator deploys idle funds into a
/// strategy.
///
/// The pauser can only pause: there is no unpause, and the pauser has no other power. Once
/// paused, the vault stays paused and every state-changing function refuses to run.
contract DemoVault {
    IERC20 public immutable token;

    /// Deploys idle funds into a strategy.
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

    /// Moves idle funds to a strategy.
    function executeStrategy(address to, uint256 amount) external whenNotPaused {
        require(token.transfer(to, amount), "transfer failed");
        emit StrategyExecuted(msg.sender, to, amount);
    }

    /// Pause-only. No unpause exists.
    function pause() external {
        if (msg.sender != pauser) revert NotPauser();
        paused = true;
        emit Paused(msg.sender);
    }
}
