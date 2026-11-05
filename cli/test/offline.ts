// The offline harness the D19 tests share (#9, #27, #28): a command run inside an OS sandbox
// that denies all networking to it and every process it starts, so a test passes only if the
// verdict needs no RPC, keys or funds.
//
// macOS: `sandbox-exec` with a deny-network profile. Linux: a new user and network namespace
// (`unshare --user --map-root-user --net`). Ubuntu 23.10 and later, GitHub's ubuntu-latest
// among them, let AppArmor refuse unprivileged user namespaces; CI turns that off
// (`kernel.apparmor_restrict_unprivileged_userns=0`, .github/workflows/ci.yml). Where no sandbox
// works the harness throws, naming the fix: it never runs a command with the network on.
// (`docker run --network none` was the other way, but the judge's wasmtime, node and the
// checkout would all have to be in the image; the sysctl is one line on CI.)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DARWIN = ["sandbox-exec", "-p", "(version 1)(allow default)(deny network*)"];
const LINUX = ["unshare", "--user", "--map-root-user", "--net"];

let checked: string[] | undefined;

/** The command prefix that denies networking here, checked once; throws if there is none. */
export function sandbox(): string[] {
  if (checked) return checked;
  const prefix = process.platform === "darwin" ? DARWIN : process.platform === "linux" ? LINUX : undefined;
  if (!prefix) throw new Error(`no network sandbox for ${process.platform}: the offline tests need macOS or Linux`);
  const probe = spawnSync(prefix[0]!, [...prefix.slice(1), "true"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    const why = probe.error?.message ?? probe.stderr.trim();
    throw new Error(
      `can't deny networking here (${prefix.join(" ")}: ${why}), so the offline tests won't run.` +
        (process.platform === "linux"
          ? " On Ubuntu 23.10+ AppArmor blocks unprivileged user namespaces: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`."
          : ""),
    );
  }
  checked = prefix;
  return prefix;
}

/** `cmd args` with networking denied. */
export function offline(cmd: string, args: string[]) {
  const [bin, ...pre] = sandbox();
  const res = spawnSync(bin!, [...pre, cmd, ...args], { encoding: "utf8", timeout: 300_000 });
  if (res.error) throw new Error(`can't deny networking here: ${res.error.message}`);
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** The `bountee` command line with networking denied. */
export const bounteeOffline = (args: string[]) => offline(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url)), ...args]);
