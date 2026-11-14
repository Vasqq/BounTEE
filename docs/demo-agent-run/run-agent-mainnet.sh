#!/bin/zsh
# Tomorrow's cold agent (#35, R14.6): sandboxed headless Claude Code, its own throwaway config
# (no memory, no CLAUDE.md), no web tools, network only to the mainnet RPCs, NEAR, OutLayer and
# FastFS, reads denied for the repo, keys and notes. Same setup as the Nov 10 testnet cold win.
# Run only after: bounty2 deployed, demo.bountee.near/demo posted, the claim key written to
# ~/bountee-agent-35/mainnet/claim-key by `bountee key add ... --allowance 2 --out-dir`.
set -e
B=$HOME/bountee-agent-35
M=$B/mainnet
ls $M/claim-key/*.json >/dev/null  # no key, no run
mkdir -p $B/config-mainnet
cd $M
CLAUDE_CONFIG_DIR=$B/config-mainnet CLAUDE_CODE_OAUTH_TOKEN=$(cat $HOME/.bountee-testnet/claude-token) \
  claude -p "$(cat $B/prompt-mainnet.txt)" --settings $B/settings-mainnet.json --setting-sources "" \
  --strict-mcp-config --disallowedTools WebFetch WebSearch --permission-mode dontAsk --max-turns 300 \
  --output-format stream-json --verbose < /dev/null > $B/mainnet-transcript.jsonl 2> $B/mainnet-stderr.log
echo "agent exited $?; transcript $B/mainnet-transcript.jsonl"
