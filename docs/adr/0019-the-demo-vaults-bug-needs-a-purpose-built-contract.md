# The demo vault's bug needs a purpose-built contract

On Nov 7 the first mainnet run's demo vaults were drained 4 s (Base) and 8 s (Arbitrum) after funding, before any claim, by a general-purpose drain bot: an EIP-7702 account (`0x4a00e700…7821`) live on both chains since Sep 23, with about 80 victims, that simulates calls against new contracts and new token balances and fires one transaction when one profits. The vault's bug, a missing access check modelled on the DEPUSDT/LEVUSDC hack, is one call deep, which is exactly what such a bot finds. A demo bounty whose funds a bot takes first can't be won by the Whitehat, so the demo vault's bug must be out of a generic bot's reach and within an AI agent's. The new demo vault is a USDC vault whose deposit-from-a-position trusts the position's own word for who owns it, which vault it belongs to and how much it holds, and mints shares without checking the USDC arrived: the Visor Finance class (Dec 2021, about $8.2M; Pickle Finance's fake jars, Nov 2020). Exploiting it means writing and deploying a contract that gives those three vault-specific answers, then redeeming the free shares. That is the reasoning a coding agent does and a scanner doesn't, which is also the purpose the demo gives the agent.

The evidence, gathered on a prototype before any mainnet spend: the bot's own on-chain code, used as the position on an Arbitrum fork, is refused and moves nothing (asked as a vault would ask, it answers `owner()` with its own address and every other call with 1, so it passes an owner check but not the vault check); a stub that also echoes its caller as the vault gets at most 1 micro-USDC; 100,000 fuzzed calls by random accounts with random positions profit nobody beyond rounding; and a fresh agent given only the vault's source found and proved the exploit in about a minute.

## Considered Options

- **A Damn Vulnerable DeFi or Ethernaut level as the live vault:** most levels are one call or a short fixed sequence, the class the bot drains, and their solutions are published and memorised, so "the agent found it" reads as "the agent recalled a writeup". They stay offline judge scenarios (ADR-0018).
- **Keep the old vault and fund it later or for less time:** the bot struck 4 s after funding, faster than any claim can be sealed, judged and paid.
- **A harder bug (several steps, a flash loan):** costs more to deploy and fund on mainnet and risks the agent missing the Nov 10 deadline, for no gain against the bots seen.
- **A new requirement that the demo vault resists the bot:** the requirements describe BounTEE, and R3.10 already covers any real exploit of the demo protocol; how hard the demo's bug is belongs to this one demo, so it is recorded here, with the fork test as its evidence.

## Consequences

- The missing-access-check vault stays as the judge's offline scenario 21; it is no longer the demo protocol's bug. The DEPUSDT/LEVUSDC historical replay is unaffected.
- The vault is seeded by an ordinary deposit, so the Protocol holds shares; the pause role still only pauses, and a paused vault refuses the exploit (R7.5, R8.2).
- Residual risk, stated as a limit: a bot that answers `owner()` with itself, `vault()` with its caller and a balance large enough to mint the vault's shares yet small enough not to overflow could drain it. None has been seen. The vaults are still funded minutes before the claims and hold 2 USDC on Base and 1 on Arbitrum.
- The exploit stays sealed until the run: no script or test that performs it is pushed before the bounty is won and its disclosure delay has passed, so neither the agent nor anyone reading the repo can copy it, and "the agent found it" stays true.
- The drained first attempt is part of the public record: 3 USDC and about $1 of gas lost, the drain transactions linked from the README.
- Amends ADR-0018: the demo vault and its bug.

Amended by ADR-0020: the vault holds 2 USDC on each chain.
