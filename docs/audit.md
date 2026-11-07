# Self-audit of the bounty contract

Nov 6, 2026, on commit `462cc1c`, the build deployed to mainnet as `bounty.bountee.near`. It was a manual review of `contract/src` against the `near-contract-audit` checklist, done by a reviewer who hadn't written the code. Earlier per-ticket reviews had already fixed what they found; this pass read the whole contract at once.

**No critical or high findings.** The findings below are known and unfixed in the deployed build. That build has to be the one the full testnet rehearsal ran (ADR-0018), and any change to the contract changes its code hash.

## Medium

**M1. Two states have no exit, and the contract can't be upgraded.** A bounty whose pause signatures can never be made stays in `Signing`. That would happen if the MPC network changed its `sign` interface or its root key: `on_pauses_signed` changes nothing on a failed or mismatched signature, `pauses.rs:301-318`. A bounty whose winner Circle has blocklisted stays in `Paying`, because every `retry_payout` sends the same transfer to the same Whitehat (`payout.rs:124-128`). In both cases the Protocol can't withdraw (`withdrawal.rs:43`), so the USDC stays locked. This is the cost of a keyless contract with no admin, and the README states it as a limit.

## Low

**L1. A Whitehat can delay a Protocol's withdrawal after the end date.** `retry_claim` still works on a `Live` bounty after its end date (`claims.rs:531`), and a running claim blocks the withdrawal (`withdrawal.rs:59-66`). Someone who keeps one claim retrying at all times holds the withdrawal back, for about 0.03 NEAR per retry. Nothing is lost.

**L2. A posting check whose callback runs out of gas leaves the bounty `Checking` forever.** USDC's own refund returns the money, but the bounty's covered contracts can't be posted again under the same name (`posting.rs:127`, `posting.rs:187`). The callback is light and has 15 Tgas.

**L3. A copied sealed exploit can block its author's claim.** Someone who sees a pending `submit_claim` (an RPC operator, for example) can file the same ciphertext first. Their claim is judged INVALID (`account_mismatch`), but the ciphertext is now marked as filed, so the real Whitehat's claim is refused (`claims.rs:183-194`) and must be sealed again. The fix is to refuse a refile only from the same Whitehat.

**L4. The contract can repay a job deposit OutLayer kept.** When OutLayer's own callback runs out of gas, the deposit stays with OutLayer, and only the requester can cancel to get it back. Here the requester is the keyless contract, which has no way to call that. Yet `on_claim_judged` credits the deposit back to the claim balance (`claims.rs:390-396`), so the contract pays it from its own NEAR, about 0.9 NEAR per claim at most. This breaks R11.4 in a rare case.

## Info

- **I1.** A pause signature from a failed signing round is still public in its MPC receipt. If someone broadcasts it, `verify_pause` checks only the stored signature's hash and never marks it verified. This doesn't affect the payout.
- **I2.** USDC sent to the contract with a plain `ft_transfer` (no `msg`) can't be recovered: there is no sweep.

## Checked and clean

- **Callbacks:** all ten are `#[private]`, none panic, and each drops a stale result by its timestamp marker.
- **Reentrancy:** state is written before every promise (`paying_out`, `Withdrawn`, claim-balance debits, in-flight markers).
- **Access:** `withdraw_claim_balance` requires 1 yoctoNEAR, and every other transfer goes to a fixed recipient.
- **Tokens:** `ft_on_transfer` accepts only the configured USDC, and amounts are exact base units.
- **Storage:** what it costs is measured and charged to the posting fee or the claim balance.
- **Pauses:** the signed payload is built only from the posted rules. The calldata is `pause()`, the value is 0, and the chain ID is signed. The derivation path `<protocol>/<name>` can't collide, and each signature is checked to recover to the derived address.
- **Mainnet config:** `v1.signer`'s live root key matches `MAINNET_ROOT_PUBLIC_KEY`, and the 20 Tgas the contract attaches to `sign` exceeds the 15 Tgas mainnet asks for.
