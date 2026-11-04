// Remakes judge/tests/fixtures/sealed/*.txt: the value of the secret BOUNTEE_SEALED_EXPLOIT
// as `bountee claim` writes it (cli/src/seal.ts), for the J tests of the enclave's
// judge_claim action (#15). Run: node judge/tests/fixtures/make-sealed.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { bundle } from "../../../cli/src/seal.ts";

const here = new URL(".", import.meta.url);
const exploit = (name: string) => JSON.parse(readFileSync(new URL(`exploits/${name}.json`, here), "utf8"));

const cases: [file: string, whitehat: string, exploit: string][] = [
  ["alice-seedOnly", "alice.testnet", "seedOnly"],
  ["alice-drain", "alice.testnet", "drain"],
];
mkdirSync(new URL("sealed/", here), { recursive: true });
for (const [file, whitehat, name] of cases) {
  writeFileSync(new URL(`sealed/${file}.txt`, here), bundle(whitehat, exploit(name)) + "\n");
}
