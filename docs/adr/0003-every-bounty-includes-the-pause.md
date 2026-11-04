# Every bounty includes the pause, and granting the pause role proves control

R12 requires that only whoever controls the covered contracts can post a bounty on them and receive their exploits; otherwise a Fake poster could buy a working exploit of someone else's protocol. Only a contract's real admin can grant a pause role on it, so a bounty goes live only once every covered contract on every covered chain has granted the pause role to that bounty. Granting the role is the proof of control, with no separate verification step, and the exploit is delivered to the Protocol that posted. Every bounty therefore includes the circuit breaker: there is one setup flow, not two kinds of bounty.

## Consequences

- Pre-launch code, which has nothing live to pause, is out of scope for the hackathon and is named in the README as later work.
- A contract that hasn't granted the role isn't covered by BounTEE at all. There is no "warning" mode for unregistered protocols: publishing that a contract is exploitable without being able to pause it is exactly the public bug signal ADR-0001 avoids.
- Protocol setup must make clear, chain by chain, which grants are still missing before the bounty can go live.
- A NEAR contract can't read EVM state, so an enclave job at posting checks the grants: it confirms each chain's block against several independent RPCs, then checks the role grant with a storage proof against that block's state root. Those RPCs are named as trusted in the README. (Since ADR-0014, the posting check instead simulates `pause()` from the pause-role address and checks its pause gas, reading each chain through the RPCs pinned in the judge's build.)
- A Fake poster could still deploy a copy of someone else's code at their own address and post a bounty on the copy. That buys an exploit of code they don't control, at the price of the bounty. The threat model states this residual risk.
