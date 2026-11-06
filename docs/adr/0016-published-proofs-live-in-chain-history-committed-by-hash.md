# A published exploit's proofs live in NEAR's chain history, committed by hash

D7.1 asks that a published exploit carry the claim's block header and proofs, so that anyone can re-run it to the enclave's verdict. Storing the proofs in contract state would cost about 1.2 NEAR for a live claim's ~120 KB, and up to about 15 NEAR at NEAR's transaction-size limit. That is more than the 0.5 NEAR posting fee, which must pay for publication (R11.4) so the keyless contract never spends its own balance.

The proofs are already on chain. The Whitehat's `submit_claim` transaction carries them as arguments, so they are part of NEAR's chain history, which every archival node keeps permanently. The contract records their sha256 when the claim is filed. A published exploit therefore keeps the block header, the verdict, the judge's output and the proofs' hash in state, and points to the claim's submission block. `bountee rerun` reads the proofs back from that block's chunks and checks them against the hash before re-running. This is the commit-and-reveal pattern rollups use with calldata: state holds a binding commitment, and the bulk data lives in permanent chain history.

The RPC that serves the block is trusted for nothing: proofs that don't match the recorded hash are refused. The only new dependency is availability. Some NEAR archival node must still serve the claim's block. Any one of them will do, including one the verifier runs.

## Consequences

- Publication stays inside the posting fee, whatever the proofs' size (R11.4).
- A re-run needs an archival NEAR RPC for the claim's block. The tool defaults to FastNEAR's archival RPC, and `--near-rpc` takes any other. Ordinary nodes keep about two and a half days, and the disclosure delay is at least a day.
- The proofs can't be altered after the claim: the hash was recorded when the claim was filed, before any verdict.
- A claim filed through a cross-contract call is found among the block's receipts, not only its transactions.
- D7.1's wording changes from "include the proofs" to "commit to the proofs by hash, with the proofs readable from the claim's transaction in NEAR's chain history".
