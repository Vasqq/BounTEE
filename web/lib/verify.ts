// A bounty's Verify section (D6): R15.1's checks, each passing, failing or not yet, in the
// order the landing page lists them. The checks that read only public chain data are the
// command-line tool's own (`chainChecks` in cli/src/verify-chain.ts), run here on the server.
import { Near } from "@bountee/cli/src/near.ts";
import type { BountyView } from "@bountee/cli/src/status.ts";
import { chainChecks, type Check, type ConfigView } from "@bountee/cli/src/verify-chain.ts";
import type { BountyId } from "./bounties.ts";
import { config, type Config } from "./config.ts";
import { listOf, units } from "./format.ts";
import { view } from "./near.ts";

export type RowStatus = "pass" | "fail" | "wait";

export interface VerifyRow {
  name: string;
  status: RowStatus;
  detail: string;
  links: { label: string; href: string }[];
}

export interface VerifyResult {
  command: string;
  rows: VerifyRow[];
}

const status = (checks: Check[]): RowStatus =>
  checks.some((c) => c.status === "fail") ? "fail" : checks.length > 0 && checks.every((c) => c.status === "pass") ? "pass" : "wait";

const chainName = (c: Config, id: unknown) => c.chains[Number(id)]?.name ?? `chain ${id}`;

/** One row for every pause on every chain: passing only once each has passed (R7.7). */
function pauseRow(c: Config, name: string, checks: Check[], waiting: string): VerifyRow {
  const s = status(checks);
  const failed = checks.filter((x) => x.status === "fail");
  return {
    name,
    status: s,
    detail:
      s === "fail"
        ? failed.map((x) => `${chainName(c, x.chain_id)}: ${x.detail}`).join("; ")
        : s === "pass"
          ? "every covered chain"
          : checks.length === 0
            ? waiting
            : `not yet on ${listOf([...new Set(checks.filter((x) => x.status !== "pass").map((x) => chainName(c, x.chain_id)))])}`,
    links: checks.flatMap((x) => (typeof x.link === "string" && x.status !== "not_yet" ? [{ label: chainName(c, x.chain_id), href: x.link }] : [])),
  };
}

interface Publication {
  state: "delayed" | "publishable" | "requested" | "published";
  publishable_from_ns: string;
}

export async function readVerify(id: BountyId): Promise<VerifyResult | null> {
  const c: Config = config();
  const bounty = await view<BountyView | null>(c, c.contract, "bounty", { id });
  if (!bounty) return null;
  const cfg = await view<ConfigView>(c, c.contract, "config");
  const near = new Near("mainnet", c.nearRpc);
  const checks = await chainChecks(
    {
      near,
      network: "mainnet",
      contract: c.contract,
      bounty: id,
      rpcs: Object.fromEntries(Object.values(c.chains).map((ch) => [ch.id, ch.rpc])),
      outlayerApi: c.outlayerApi,
      txApi: c.txApi,
    },
    bounty,
    cfg,
  );
  // chainChecks always answers attestation and payout; a missing one would be a failure to show, not to hide.
  const one = (kind: Check["check"]): Check => checks.find((x) => x.check === kind) ?? { check: kind, status: "fail", detail: "the check didn't run" };
  const decimals = (await view<{ decimals: number }>(c, cfg.usdc, "ft_metadata")).decimals;
  const claimWinner = bounty.winning_claim === null ? "" : (await view<{ whitehat: string }>(c, c.contract, "claim", { claim_id: bounty.winning_claim })).whitehat;
  const attestation = one("attestation");
  const payout = one("payout");
  const pub = bounty.winning_claim === null ? null : await view<Publication | null>(c, c.contract, "published_exploit", { id });
  const days = bounty.rules.disclosure_delay_days;
  const after = `after ${days} ${days === 1 ? "day" : "days"}`;

  const rows: VerifyRow[] = [
    { name: "Contract code matches source", status: "wait", detail: "rebuilt from source by bountee verify", links: [] },
    { name: "Judge build is the one that ran", status: "wait", detail: "rebuilt from source by bountee verify", links: [] },
    { name: "Enclave attestation", status: status([attestation]), detail: attestation.status === "pass" ? "Intel-signed TDX quote from OutLayer" : attestation.detail, links: [] },
    {
      name: "Payout on NEAR",
      status: status([payout]),
      detail: payout.status === "pass" ? `${units(bounty.rules.bounty_amount, decimals)} USDC, once, to ${claimWinner}` : payout.detail,
      links: typeof payout.link === "string" ? [{ label: "NEAR", href: payout.link }] : [],
    },
    pauseRow(c, "Pauses landed", checks.filter((x) => x.check === "pause_landed"), "no pause is signed yet"),
    pauseRow(c, "Pauses verified on NEAR", checks.filter((x) => x.check === "pause_verified"), "no pause is signed yet"),
    pub?.state === "published"
      ? { name: "Re-run of the published exploit", status: "wait", detail: "published · re-run it with bountee verify", links: [] }
      : { name: "Re-run of the published exploit", status: "wait", detail: `not yet published · ${after}`, links: [] },
  ];
  return { command: `bountee verify ${id.protocol}/${id.name} --network mainnet`, rows };
}
