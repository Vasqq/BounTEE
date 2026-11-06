"use client";
// The app's live reads, as TanStack Query hooks: each asks the app's server, which reads the
// chains on every request (R15.6). A failed read keeps the last good value on screen and says so.
import { useQuery } from "@tanstack/react-query";
import type { BountyId, BountyPage } from "./bounties.ts";
import type { Demo } from "./demo.ts";
import type { ReleaseView } from "./release.ts";
import type { VerifyResult } from "./verify.ts";

const path = (id: BountyId) => `/api/bounties/${encodeURIComponent(id.protocol)}/${encodeURIComponent(id.name)}`;

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

export const bountyKey = (id: BountyId) => ["bounty", id.protocol, id.name] as const;

/** A bounty's page, re-read every 15 s, or every 3 s while `fast` (a sent pause waiting to land). */
export function useBounty(id: BountyId, fast = false) {
  return useQuery({
    queryKey: bountyKey(id),
    queryFn: async () => (await get<{ bounty: BountyPage | null }>(path(id))).bounty,
    refetchInterval: fast ? 3_000 : 15_000,
  });
}

export function useVerify(id: BountyId | null) {
  return useQuery({
    queryKey: ["verify", id?.protocol, id?.name],
    queryFn: async () => (await get<{ verify: VerifyResult | null }>(`${path(id!)}/verify`)).verify,
    enabled: id !== null,
    refetchInterval: 30_000,
  });
}

export function useDemo() {
  return useQuery({
    queryKey: ["demo"],
    queryFn: async () => (await get<{ demo: Demo | null }>("/api/demo")).demo,
    refetchInterval: 30_000,
  });
}

export function useRelease(id: BountyId) {
  return useQuery({
    queryKey: ["release", id.protocol, id.name],
    queryFn: async () => (await get<{ release: ReleaseView | null }>(`${path(id)}/exploit`)).release,
  });
}
