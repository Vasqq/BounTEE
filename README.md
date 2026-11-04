# BounTEE: Autonomous Keyless Bounty Contract & Cross-Chain Exploit Settlement

BounTEE is a decentralized, keyless bug bounty infrastructure built on NEAR and secured with NEAR Chain Signatures. It enables protocol authors to post bounties for smart contracts across EVM chains (e.g., Base Sepolia) and allows autonomous AI agents and whitehat security researchers to submit valid exploit proofs that automatically trigger cross-chain protocol pauses and release bounties with zero human intervention.

---

## 1. Core Architecture & Architectural Promises on NEAR (R13.1)
BounTEE's trust model eliminates custodial keys and multi-sig single points of failure:
- **Keyless Bounty Contract:** Deployed to a NEAR account with locked/empty full-access keys. Funds and pause rights are managed exclusively through validated smart contract execution rules (R2.1).
- **NEAR Chain Signatures MPC:** Generates ECDSA signatures for transactions on foreign chains (such as `pause()` on Base Sepolia) directly from NEAR contract state without exposing private keys (R7.1).
- **Claim Keys (R14.2):** Autonomous agents interact via limited function-call access keys that can only invoke claim evaluation methods on the bounty contract, protecting agent funds.

---

## 2. Threat Model & Trusted Parties (R15.5, R15.7)

### Trusted Parties & Responsibilities:
1. **NEAR Consensus & Chain Signatures Network:** Signs the cross-chain pause transaction upon successful exploit verification.
2. **TEE / Sandbox Oracle / Judge:** Evaluates replay execution against the defined invariant rules.
3. **Protocol Poster:** Configures covered contract addresses, listed tokens, and bounty parameters.

### Stated Security Boundaries & Limits:
- **Exposed Replays (R15.7):** Submitting a claim publishes the transaction trace to the blockchain. Posters acknowledge that published exploit code is publicly viewable.
- **Verdict-to-Pause Latency Window (R7.8):** The measured delay between an exploit claim reaching `PAYS` status and the `pause()` transaction executing on the target chain is constrained by cross-chain finality (benchmarked at ~2–4 seconds).
- **Coverage Limits (R4.12):** BounTEE only rewards exploits that directly manipulate the declared covered contract invariants or drain listed tokens at posting prices. Out-of-scope interactions score zero.
- **Fake Poster Guard:** Bounties are fully escrowed upon creation; protocols cannot revoke bounty funds during active evaluation periods.

---

## 3. Quickstart & Verification ("Do X → See Y") (R15.4, D21)

Ensure zero-friction verification on a fresh clone without requiring funded accounts:

```bash
# 1. Inspect project glossary and requirements
cat GLOSSARY.md
cat docs/requirements.md

# 2. Run the automated step checker
bash scripts/check_steps.sh
```

---

## 4. Autonomous Agent Claim Integration (R14.6)
For autonomous coding agents and automated security scanners:
See [`docs/agents/agent-instructions.md`](./docs/agents/agent-instructions.md) for automated initialization, claim key provisioning, and headless proof submission.
