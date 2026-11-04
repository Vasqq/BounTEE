// Ticket #6: the rules (R1.1), claim and verdict formats parse and write back unchanged,
// and refuse what they must. Same cases as formats/tests/fixtures.rs, from the same file.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseBountyId, parseClaim, parseExploit, parseJob, parseRules, parseSealedBundle, parseVerdict, toJson } from "../src/index.ts";

interface Case {
  kind: string;
  note?: string;
  value: unknown;
}
interface Edit {
  note: string;
  path: (string | number)[];
  value: unknown;
}
const cases: { valid: Case[]; invalid: Case[]; invalid_rules_edits: Edit[] } = JSON.parse(
  readFileSync(new URL("../../fixtures/cases.json", import.meta.url), "utf8"),
);

const parsers: Record<string, (v: unknown) => unknown> = {
  rules: parseRules,
  claim: parseClaim,
  verdict: parseVerdict,
  bounty_id: parseBountyId,
  exploit: parseExploit,
  job: parseJob,
  sealed_bundle: parseSealedBundle,
};

describe("shared format cases", () => {
  for (const c of cases.valid) {
    test(`R1.2: valid ${c.kind} round-trips unchanged: ${c.note ?? JSON.stringify(c.value)}`, () => {
      const written = toJson(parsers[c.kind]!(c.value));
      // Field order is part of the format: the JSON written matches the fixture byte for byte.
      expect(written).toBe(JSON.stringify(c.value));
    });
  }

  for (const c of cases.invalid) {
    test(`R1.4, R3.11: invalid ${c.kind} is refused: ${c.note}`, () => {
      expect(() => parsers[c.kind]!(c.value)).toThrow();
    });
  }

  for (const e of cases.invalid_rules_edits) {
    test(`R1.1 rules refuse: ${e.note}`, () => {
      const rules = structuredClone(cases.valid[0]!.value) as Record<string | number, unknown>;
      applyEdit(rules, e.path, e.value);
      expect(() => parseRules(rules)).toThrow();
    });
  }
});

function applyEdit(target: any, path: (string | number)[], value: unknown) {
  let at = target;
  for (const step of path.slice(0, -1)) at = at[step];
  const last = path[path.length - 1]!;
  if (value === null) delete at[last];
  else at[last] = value;
}
