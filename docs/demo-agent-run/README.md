# The AI agent's mainnet run

On 11 November 2026 a coding agent, started cold, found the bug in the demo bounty's covered vault, proved it with `bountee test`, filed the claim with claim-only access to the Whitehat's account, and was paid 10 USDC on NEAR mainnet. This folder holds what it was given, what it wrote, and what it did.

## Files

| File | What it is |
| --- | --- |
| [`run-agent-mainnet.sh`](run-agent-mainnet.sh) | The launch script, as run. Headless Claude Code with a throwaway config folder, no settings sources, no MCP servers, web tools disallowed, `dontAsk` permissions, at most 300 turns. Its header comment names `bounty2`; the run went to `bounty3.bountee.near`, as `handover.txt` says. |
| [`settings-mainnet.json`](settings-mainnet.json) | The sandbox settings the script passes with `--settings`: the network allowlist (chain RPCs, NEAR RPCs, OutLayer, FastFS, the Solidity compiler host) and the read denials. Home paths are shortened to `~/`. |
| [`prompt.txt`](prompt.txt) | The prompt, word for word. `<kit>` stands for the folder the agent was handed. |
| [`handover.txt`](handover.txt) | The `bounty.txt` the prompt sends the agent to first: network, bounty contract, bounty, Whitehat account, credentials folder and tools. |
| [`agent-instructions-as-given.md`](agent-instructions-as-given.md) | The instructions file in the kit. It matches [`docs/agent-instructions.md`](../agent-instructions.md) apart from two lines under "When something fails" (don't file a claim twice), which the agent had and the repo copy now lacks. |
| [`transcript.md`](transcript.md) | The run's log as readable markdown: each tool call's command and its trimmed output, and the agent's own remarks. |

## The run

| | |
| --- | --- |
| Start | 2026-11-11 04:31:17 UTC (first event in the log) |
| Claim filed | 2026-11-11 04:37:07 UTC (NEAR block 224017119) |
| End | 2026-11-11 04:47:04 UTC (final message) |
| Duration | 949 s wall clock (about 16 minutes), of which 239 s were model calls |
| Turns | 35; 33 tool calls |
| Cost | $0.88 (list price, as the log reports it) |
| Model | `claude-sonnet-5`. The session started on `claude-sonnet-5-5`, whose first response a safety classifier stopped; the harness moved the session to `claude-sonnet-5`, which wrote every message after that. |
| Outcome | `success`. PAYS (`minimum_theft_reached`) on Base and on Arbitrum One with `bountee test`; one claim filed, on Base. |

**Limits.** A fresh, empty config folder, so no memory, no `CLAUDE.md`, and no skills or plugins beyond the ones built into Claude Code. No web: `WebFetch` and `WebSearch` disallowed, and the sandbox reaches only the hosts in `settings-mainnet.json`. The only key the agent could reach was the claim key: a NEAR function-call key that can call only `submit_claim` and `retry_claim` on the bounty contract, with nothing attached. Reads of the repository, the operator's other key folders and other run folders were denied.

## On chain

- **Claim and payout:** [`6xbAxbuABt1i2f37YQobnCpot1iuSfUfKKRSih5nV5DL`](https://nearblocks.io/txns/6xbAxbuABt1i2f37YQobnCpot1iuSfUfKKRSih5nV5DL). `submit_claim` on `bounty3.bountee.near`, signed by the Whitehat account `d394d052bf52d60330c55853bd508fe7d6159243969668f9fdfbf101f6aea6b8` with the claim key `ed25519:2Z4vE8ktWEpMLAmcRN2p2p8sLCgCPWbdhwVW8Hz6e7sg`. Its 36 receipts, none failed, emit `claim_submitted`, `claim_judged` (PAYS, `minimum_theft_reached`), `pauses_signed` for Base and Arbitrum One, a 10 USDC `ft_transfer` to the Whitehat, and `bounty_paid`.
- **Publication:** [`ErRTXzQWFSJxXbfkqC3LFeXvNU1SjijzFeicw6d7hf1`](https://nearblocks.io/txns/ErRTXzQWFSJxXbfkqC3LFeXvNU1SjijzFeicw6d7hf1). `publish_exploit` on `bounty3.bountee.near`, signed by `demo.bountee.near`, in NEAR block 224166770 at 2026-11-12 04:54:50 UTC; emits `exploit_published` for claim 1. Its return value (also served by the contract's `published_exploit` view) is the judged exploit, deflated and base64-encoded, so anyone can read and re-run it (`bountee rerun`).

Both transactions were checked against NEAR mainnet RPC (`archival-rpc.mainnet.fastnear.com`) on 12 November 2026.

## What was changed for publication

Local paths are shortened (`<kit>`, `<tmp>`, `<bountee-…>`, `~/`) and the operator's user name in `ls` output reads `user`. The exploit the agent wrote, and its one-sentence description of the bug, are left out, because the testnet site's bounties cover the same vault; the exploit itself is public on chain (the publication above). The transcript leaves out the per-token housekeeping events and the empty thinking blocks, and cuts long tool outputs where it says so. Nothing else is edited.
