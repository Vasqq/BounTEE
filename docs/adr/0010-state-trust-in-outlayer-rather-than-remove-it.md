# State the trust in OutLayer plainly rather than try to remove it

The bounty contract acts on the verdict OutLayer's contract returns; only OutLayer's worker account can resolve a job, OutLayer's contract is upgradeable, and its keystore is governed by a one-member DAO that also approves enclave measurements. Three simulated jurors asked for the bounty contract to check the enclave's attestation itself. Verifying an Intel TDX quote inside a NEAR contract is not a proven pattern and would be a large, risky build for the window. We keep OutLayer as a named trusted party and make a forged verdict detectable by anyone after the fact: the attestation, the rebuilt program hash, and a local re-run of the published exploit (ADR-0008). The README's threat model lists every trusted party (OutLayer's operator and keystore DAO, Intel, the NEAR MPC network, and the RPCs pinned in the judge's build, of which at least two must agree (ADR-0014)) and what each could do if it misbehaved; the worst a forged verdict can do is pause the covered contracts and pay out one bounty.

## Considered Options

- **Verify the TDX quote in the bounty contract:** removes trust in OutLayer's operator but not in Intel; unproven on NEAR, costly in gas and build time.
- **Check OutLayer's on-chain measurement approval from the bounty contract:** cheap, but still trusts the same one-member DAO, so it adds code without removing trust. Revisit if time allows.
