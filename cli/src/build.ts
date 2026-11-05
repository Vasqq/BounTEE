// The reproducible build (R15.2): `bountee build --contract <account> [--rev <commit>]`
// rebuilds, from one commit of this repo, the exact bytes a deployment pins: the bounty
// contract's wasm (whose sha256 is the code hash NEAR shows for the account) and the judge's
// wasm pinned to that contract (whose sha256 the contract pins and OutLayer attests). The
// deploy scripts build with it too, so what is deployed is what anyone rebuilds.
//
// Both builds run in Docker images pinned by digest, on linux/amd64 (the judge's bytes differ
// between amd64 and arm64 hosts), from the commit's tracked files only:
// - the contract: `cargo near build reproducible-wasm` (cargo-near 0.20.3 on rustc 1.86, the
//   image named in contract/Cargo.toml), which also writes the image, command and commit into
//   the contract's NEP-330 `contract_source_metadata`, so a deployment names its own commit;
// - the judge: `cargo build --locked --release` in the official rustc 1.97.1 image below, with
//   `BOUNTEE_BOUNTY_CONTRACT` set to the contract it answers to (judge/src/sealed.rs).
// cargo-near can't build from a git worktree, so both build from a throwaway clone.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { base58 } from "@scure/base";

const repo = fileURLToPath(new URL("../../", import.meta.url));

/** The judge's build environment: rustc 1.97.1 (rust-toolchain.toml), pinned by digest. */
export const JUDGE_IMAGE = "rust:1.97.1-slim-bookworm@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3";
export const PLATFORM = "linux/amd64";

export interface Built {
  wasm: string;
  sha256: string;
}

export interface BuildResult {
  /** The commit both were built from. */
  rev: string;
  /** The bounty contract the judge is pinned to. */
  pinned_to: string;
  /** `code_hash` is what NEAR's `view_account` shows: base58 of the wasm's sha256. */
  contract?: Built & { code_hash: string };
  judge?: Built;
}

export const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** NEAR's code hash of a wasm: base58 of its sha256. */
export const codeHash = (path: string) => base58.encode(createHash("sha256").update(readFileSync(path)).digest());

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A full commit hash for `rev` in this repo. */
export function resolveRev(rev = "HEAD"): string {
  return git(repo, ["rev-parse", "--verify", `${rev}^{commit}`]);
}

/** The commit a deployment says it was built from (NEP-330 `source_code_snapshot`), if any. */
export function revFromSourceMetadata(meta: any): string | null {
  const snapshot: string | undefined = meta?.build_info?.source_code_snapshot;
  const m = snapshot?.match(/[?&]rev=([0-9a-f]{40})/);
  return m ? m[1]! : null;
}

function run(cmd: string, args: string[], cwd: string, input?: Buffer) {
  const r = spawnSync(cmd, args, { cwd, input, stdio: [input ? "pipe" : "ignore", process.stderr, process.stderr] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status ?? r.signal})`);
}

/**
 * Rebuild the contract and the judge pinned to `pin` from commit `rev` (default HEAD), into
 * `outDir` (default target/reproducible/<rev>/). Needs Docker and cargo-near.
 */
export function reproducibleBuild(o: { pin: string; rev?: string; outDir?: string; only?: "judge" | "contract" }): BuildResult {
  const rev = resolveRev(o.rev);
  const outDir = resolve(o.outDir ?? join(repo, "target/reproducible", rev, o.pin));
  mkdirSync(outDir, { recursive: true });
  const site = mkdtempSync(join(tmpdir(), "bountee-build-"));
  const result: BuildResult = { rev, pinned_to: o.pin };
  try {
    run("git", ["clone", "--quiet", "--shared", "--no-checkout", repo, site], repo);
    run("git", ["checkout", "--quiet", "--detach", rev], site);
    if (o.only !== "judge") {
      run("cargo", ["near", "build", "reproducible-wasm", "--out-dir", outDir], join(site, "contract"));
      const wasm = join(outDir, "bountee_contract.wasm");
      result.contract = { wasm, sha256: sha256File(wasm), code_hash: codeHash(wasm) };
    }
    if (o.only !== "contract") {
      const target = readFileSync(join(site, "judge/wasm-target"), "utf8").trim();
      const tree = execFileSync("git", ["archive", rev], { cwd: site, maxBuffer: 1 << 30 });
      run(
        "docker",
        [
          "run", "-i", "--rm", "--platform", PLATFORM,
          "-v", "bountee-judge-cargo-registry:/usr/local/cargo/registry",
          "-v", `${outDir}:/out`,
          "-e", `BOUNTEE_BOUNTY_CONTRACT=${o.pin}`,
          "-e", "RUSTUP_TOOLCHAIN=1.97.1",
          JUDGE_IMAGE,
          "sh", "-euc",
          `mkdir /src && tar -x -C /src && cd /src && rustup target add ${target} >&2 && ` +
            `cargo build --locked --release -p bountee-judge --target ${target} >&2 && ` +
            `cp target/${target}/release/bountee-judge.wasm /out/`,
        ],
        site,
        tree,
      );
      const wasm = join(outDir, "bountee-judge.wasm");
      result.judge = { wasm, sha256: sha256File(wasm) };
    }
  } finally {
    rmSync(site, { recursive: true, force: true });
  }
  return result;
}

export function formatBuildResult(r: BuildResult): string {
  return [
    `built from commit ${r.rev}`,
    ...(r.contract ? [`contract: ${r.contract.wasm}`, `  sha256 ${r.contract.sha256} (NEAR code hash ${r.contract.code_hash})`] : []),
    ...(r.judge ? [`judge:    ${r.judge.wasm} (pinned to ${r.pinned_to})`, `  sha256 ${r.judge.sha256}`] : []),
  ].join("\n");
}
