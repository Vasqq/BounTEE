# Claims draw from a prepaid claim balance, the same for people and agents

Every claim costs a small, non-refundable fee to replay in the enclave. Paying it from the bounty would let a Griefer drain the bounty with junk claims (R2, R11), so the Whitehat pays. An AI agent's claim key is a NEAR function-call key, which can't attach a deposit to a call. Rather than give agents a separate path, every Whitehat tops up a small claim balance once, and each claim draws from it, whether filed by hand or by their agent. The claim key is added to the Whitehat's own account, so every claim comes from that account and any payout lands there.

## Considered Options

- **Per-claim deposit for people, a balance for agents:** two claim paths for one action.
- **A funded account with a full-access key for the agent:** caps the loss but hands an AI a full-access key, which the security track's own brief rules out.
- **Sponsored free claims for early Whitehats:** invites farming, needs a funded sponsor pot with an owner, and isn't something judges reward. Future work.
