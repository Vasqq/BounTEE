# BounTEE Coding Agent Instructions (R14.6)

This instructions file teaches an ordinary coding agent how to interact with BounTEE, inspect demo instances, locate the demo vulnerability, and submit a verified claim using a limited claim key with no human input.

---

## 1. Architecture & Threat Model Overview
BounTEE operates keyless bounty verification on NEAR with Chain Signatures for cross-chain execution:
- **Bounty Contract:** Holds escrowed funds and verifies exploit proofs.
- **Claim Key (R14.1):** A limited function-call key restricted strictly to `claim` actions on the bounty contract. It cannot transfer funds, withdraw balances, or call other methods.
- **Automated Settlement:** When a claim evaluates to `PAYS`, the contract triggers signed pauses and pays out the Whitehat account.

---

## 2. Autonomous Claim Workflow (Step-by-Step)

### Step 1: Initialize Workspace & CLI
Ensure the CLI tool is available in machine-readable mode (`--json`):
```bash
bountee --version --json
bountee init --network testnet
```

### Step 2: Generate Limited Claim Key (R14.1, R14.3)
Generate a function-call access key limited strictly to the target bounty contract:
```bash
bountee keys create-claim-key   --account "$WHITEHAT_ACCOUNT"   --contract "$BOUNTEE_CONTRACT"   --json > claim_key.json
```

### Step 3: Discover Demo Bug / Exploit
Inspect the covered contract in the demo sandbox:
1. Examine state transitions and invariant assertions.
2. Formulate the minimal reproducible transaction sequence demonstrating the vulnerability.
3. Validate locally against the sandbox RPC.

### Step 4: Submit Exploit Claim (R14.2)
Execute the claim transaction using the generated claim key:
```bash
bountee claim submit   --contract "$BOUNTEE_CONTRACT"   --bounty "$BOUNTEE_NAME"   --claim-key ./claim_key.json   --exploit-payload ./exploit.json   --json
```

### Step 5: Verify Execution Verdict (R14.6)
Query machine-readable claim status:
```bash
bountee claim status   --contract "$BOUNTEE_CONTRACT"   --bounty "$BOUNTEE_NAME"   --json
```
A successful exploit yields `"status": "PAYS"` and emits the signed pause payload.

---

## 3. Post-Claim Key Revocation (R14.4)
Immediately revoke the function-call claim key upon completion:
```bash
bountee keys revoke-claim-key   --account "$WHITEHAT_ACCOUNT"   --key-id "$(jq -r .public_key claim_key.json)"   --json
```
