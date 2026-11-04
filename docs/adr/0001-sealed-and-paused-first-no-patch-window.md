# Sealed and paused first, with no quiet patch window

A successful claim announces that a covered contract had a bug. Five of nine simulated jurors asked for a "quiet claim": a blinded commitment that pays out automatically after a fixed patch window. We decided against it. The exploit stays sealed and failed claims never surface. On a successful claim, the pause for every covered contract is signed before the Whitehat is paid and before the Protocol receives the exploit, and the signed pauses are broadcast at once, so the bug is contained within seconds of anyone learning it existed. The payout doesn't wait for the pauses to land on the EVM chains: NEAR can't observe them, and waiting would let a Protocol that revoked its pause role block a valid payout (R2). A patch window would break the "paid in seconds" promise to Whitehats and add a second claim flow, while the pause already removes the danger the window was meant to cover.

## Consequences

- The README states the limit plainly: a pause protects only the covered contracts. Copies of the same code deployed elsewhere stay exposed, as with any disclosure.
- Pauses on different chains must take effect together, so that a pause on one chain doesn't tip off an attacker on another. How that's done is a separate technical decision.
- A PAYS verdict is public on NEAR a few seconds before the pauses land. It reveals that a covered contract has a bug, not where. The README's threat model states this gap and its measured length.
- The public web page shows outcomes only: it never shows a claim in progress, and it flips to paused per chain as each pause lands, with paid shown alongside.
