#!/usr/bin/env bash
# Run every seam's test suite: `pnpm test` (all) or `pnpm test:<suite>` / `scripts/test-all.sh <suite>...`.
# Suites: formats (shared formats, Rust + TypeScript round trip), j (judge), c (bounty
# contract), t (command-line tool), w (web app), e (demo contracts).
# Needs: the Rust toolchain in rust-toolchain.toml, wasmtime, pnpm (after `pnpm install`),
# Foundry, and Playwright's Chromium (`pnpm --filter @bountee/web exec playwright install chromium`).
set -euo pipefail
cd "$(dirname "$0")/.."

suites=("$@")
[ ${#suites[@]} -eq 0 ] && suites=(formats j c t w e)

need() { command -v "$1" >/dev/null || { echo "missing: $1 ($2)" >&2; exit 1; }; }
need cargo "install rustup"
need pnpm "corepack enable"

run() { echo; echo "=== $1 ==="; shift; "$@"; }

for suite in "${suites[@]}"; do
  case "$suite" in
    formats)
      run "formats (Rust)" cargo test -p bountee-formats
      run "formats (TypeScript, round trip with Rust)" pnpm --filter @bountee/formats test
      ;;
    j)
      need wasmtime "https://wasmtime.dev"
      run "seam J: judge as $(cat judge/wasm-target) under wasmtime" cargo test -p bountee-judge
      ;;
    c) run "seam C: bounty contract in the NEAR sandbox (rustc $(sed -n 's/channel = "\(.*\)"/\1/p' contract/rust-toolchain.toml))" bash -c 'cd contract && cargo test -- --test-threads=1' ;;
    t) run "seam T: command-line tool" pnpm --filter @bountee/cli test ;;
    w) run "seam W: web app in Playwright" pnpm --filter @bountee/web test ;;
    e)
      need forge "https://getfoundry.sh"
      run "seam E: demo contracts in Foundry" bash -c 'cd demo && forge soldeer install >/dev/null && forge test'
      run "seam E: Damn Vulnerable DeFi levels in Foundry" bash -c 'cd demo/dvd && forge soldeer install >/dev/null && forge test'
      ;;
    *) echo "unknown suite: $suite (formats|j|c|t|w|e)" >&2; exit 2 ;;
  esac
done

echo; echo "all suites passed: ${suites[*]}"
