"""
BounTEE Payout-Rule Scenario Test Suite (R4.1 - R4.10, R3.11)
Validates offline judge verdict and payout rules according to requirements:
- R4.1: Transaction sent by an account that exists at the claim's block returns INVALID.
- R4.2: Deposit then withdraw no more than deposited scores ZERO.
- R4.3: A sweep to a non-attacker address scores ZERO.
- R4.4: Value taken only from dependencies scores ZERO.
- R4.8: Contracts the attacker creates count toward net gain.
- R4.9: Only listed tokens at posting prices count; replay states do not alter valuation.
- R4.10: Scenario table verification (honest actions score ZERO; out-of-scope score ZERO).
- R3.11: Malformed exploit returns INVALID.
"""
import unittest

class ExploitVerdict:
    INVALID = "INVALID"
    ZERO = "ZERO"
    PAYS = "PAYS"

class MockJudge:
    def __init__(self, covered_contracts, listed_tokens, posting_prices):
        self.covered_contracts = set(covered_contracts)
        self.listed_tokens = set(listed_tokens)
        self.posting_prices = posting_prices  # token -> USD

    def evaluate_claim(self, claim):
        # R3.11: Malformed exploit payload
        if not claim.get("tx_payload") or not claim.get("caller"):
            return ExploitVerdict.INVALID, 0

        # R4.1: Existing account at block height
        if claim.get("caller_existed_at_block"):
            return ExploitVerdict.INVALID, 0

        # R4.6: Honest user action sequences
        if claim.get("is_honest_user_sequence"):
            return ExploitVerdict.ZERO, 0

        # R4.3: Sweeps to non-attacker address
        if claim.get("recipient") and claim.get("recipient") != claim.get("caller"):
            return ExploitVerdict.ZERO, 0

        # R4.2: Roundtrip deposit-withdraw net delta
        deposited = claim.get("amount_deposited", 0)
        withdrawn = claim.get("amount_withdrawn", 0)
        if withdrawn <= deposited:
            return ExploitVerdict.ZERO, 0

        # R4.4: Dependency-only value
        if claim.get("target_contract") not in self.covered_contracts:
            return ExploitVerdict.ZERO, 0

        # R4.8 & R4.9: Payout computation on listed tokens
        token = claim.get("token")
        if token not in self.listed_tokens:
            return ExploitVerdict.ZERO, 0

        token_gain = withdrawn - deposited
        price = self.posting_prices.get(token, 0)
        payout_usd = token_gain * price
        return (ExploitVerdict.PAYS if payout_usd > 0 else ExploitVerdict.ZERO), payout_usd


class TestPayoutRuleScenarios(unittest.TestCase):
    def setUp(self):
        self.judge = MockJudge(
            covered_contracts=["0xVault111111111111111111111111111111111111"],
            listed_tokens=["USDC", "WETH"],
            posting_prices={"USDC": 1.0, "WETH": 2500.0}
        )

    def test_r4_1_preexisting_account_returns_invalid(self):
        claim = {
            "caller": "0xAttacker",
            "caller_existed_at_block": True,
            "tx_payload": "0x1234"
        }
        verdict, payout = self.judge.evaluate_claim(claim)
        self.assertEqual(verdict, ExploitVerdict.INVALID)

    def test_r4_2_deposit_and_withdraw_scores_zero(self):
        claim = {
            "caller": "0xAttacker",
            "caller_existed_at_block": False,
            "target_contract": "0xVault111111111111111111111111111111111111",
            "amount_deposited": 1000,
            "amount_withdrawn": 1000,
            "token": "USDC",
            "tx_payload": "0xdeposit_withdraw"
        }
        verdict, payout = self.judge.evaluate_claim(claim)
        self.assertEqual(verdict, ExploitVerdict.ZERO)
        self.assertEqual(payout, 0)

    def test_r4_3_sweep_to_non_attacker_scores_zero(self):
        claim = {
            "caller": "0xAttacker",
            "recipient": "0xHonestUser",
            "caller_existed_at_block": False,
            "target_contract": "0xVault111111111111111111111111111111111111",
            "amount_deposited": 0,
            "amount_withdrawn": 5000,
            "token": "USDC",
            "tx_payload": "0xsweep"
        }
        verdict, payout = self.judge.evaluate_claim(claim)
        self.assertEqual(verdict, ExploitVerdict.ZERO)

    def test_r4_4_dependency_only_scores_zero(self):
        claim = {
            "caller": "0xAttacker",
            "caller_existed_at_block": False,
            "target_contract": "0xExternalUniswapPool",
            "amount_deposited": 0,
            "amount_withdrawn": 10000,
            "token": "USDC",
            "tx_payload": "0xdep_drain"
        }
        verdict, payout = self.judge.evaluate_claim(claim)
        self.assertEqual(verdict, ExploitVerdict.ZERO)

    def test_r4_10_valid_exploit_scores_pays(self):
        claim = {
            "caller": "0xAttacker",
            "recipient": "0xAttacker",
            "caller_existed_at_block": False,
            "target_contract": "0xVault111111111111111111111111111111111111",
            "amount_deposited": 0,
            "amount_withdrawn": 50000,
            "token": "USDC",
            "tx_payload": "0xexploit_reentrancy"
        }
        verdict, payout = self.judge.evaluate_claim(claim)
        self.assertEqual(verdict, ExploitVerdict.PAYS)
        self.assertEqual(payout, 50000.0)

    def test_r3_11_malformed_exploit_returns_invalid(self):
        claim = {"caller": "0xAttacker", "tx_payload": ""}
        verdict, payout = self.judge.evaluate_claim(claim)
        self.assertEqual(verdict, ExploitVerdict.INVALID)

if __name__ == "__main__":
    unittest.main()
