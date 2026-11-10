"use client";
// The posting flow (#31): a Protocol posts a bounty with the MetaMask it already uses (D13).
// Seven steps, moved between with the floating dock (DESIGN.md, Posting flow). Everything
// checked is read live (lib/posting.ts) and ticked off only once it is on chain; MetaMask signs
// the EVM grants and top-ups directly, and NEAR transactions as the Protocol's 0x… account.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { encodeFunctionData, formatUnits, hexToBytes, keccak256, parseAbi, toHex, type Address } from "viem";
import { useAccount, useConnect, useSignMessage } from "wagmi";
import { sendTransaction, switchChain, waitForTransactionReceipt } from "wagmi/actions";
import { draftProblems, emptyDraft, rulesOf, type Draft } from "@/lib/draft.ts";
import { exploitKeyMessage, keyFromFile, keyFromSignature, publicKeyText } from "@/lib/exploit-key.ts";
import { listOf, units } from "@/lib/format.ts";
import { enableNearSigning, MAX_GAS, nearFunctionCall } from "@/lib/near-eth.ts";
import { coveredChain, net } from "@/lib/network.ts";
import type { EvmCall, PostingStatus } from "@/lib/posting.ts";
import { BOUNTY_CONTRACT, NEAR_USDC, pauseRoleOf } from "@/lib/pinned.ts";
import { rulesInPlainEnglish } from "@/lib/rules.ts";
import { wagmiConfig } from "@/lib/wagmi.ts";
import { CommandBlock } from "../CommandBlock.tsx";
import { RiskPanel } from "./RiskPanel.tsx";

/** The chains this build's bounties can cover, as the copy names them. */
const CHAIN_NAMES = net.chains.map((c) => c.name);
const STEPS = ["Connect", "Rules", "Pause role", "Pause gas", "Add NEAR", "Exploit key", "Post"] as const;
/** What a first posting-fee prepayment adds for its balance entry's storage, with room to spare (as `bountee post` does). */
const ENTRY_STORAGE = 10n ** 22n;
const near = (yocto: string | bigint) => `${Number(units(yocto, 24)).toLocaleString("en-US", { maximumFractionDigits: 3 })} NEAR`;
const eth = (wei: string | bigint) => units(wei, 18);

/** A wallet error as one sentence: a rejection says so; anything else, what the wallet or chain said. */
function walletError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; code?: number; cause?: { code?: number } };
  if (err.code === 4001 || err.cause?.code === 4001 || /reject|denied/i.test(err.message ?? "")) return "MetaMask didn't send it.";
  return err.shortMessage ?? err.message ?? "Something went wrong.";
}

function usePostingStatus(account: string | undefined, draft: Draft) {
  const covered = draft.covered.filter((c) => /^0x[0-9a-fA-F]{40}$/.test(c.address));
  return useQuery({
    queryKey: ["posting", account, draft.name, covered],
    enabled: !!account,
    queryFn: async () => {
      const res = await fetch("/api/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol: account, name: draft.name || "unnamed", covered }) });
      if (!res.ok) throw new Error(`the posting status answered ${res.status}`);
      return trusted(((await res.json()) as { status: PostingStatus }).status, account!, draft.name || "unnamed");
    },
    refetchInterval: 4_000,
    placeholderData: (prev) => prev,
  });
}

const GRANT_ROLE = parseAbi(["function grantRole(bytes32 role, address account)"]);
const PAUSER_ROLE = keccak256(toHex("PAUSER_ROLE"));

/**
 * The server's answer, checked against what this build pins before any of it reaches
 * MetaMask: the bounty contract, NEAR's USDC, and the pause-role address derived here. Each
 * grant's calldata is rebuilt here too, so the server only says which contracts use
 * AccessControl, never what to sign.
 */
function trusted(s: PostingStatus, protocol: string, name: string): PostingStatus {
  const role = pauseRoleOf(protocol, name);
  if (s.contract !== BOUNTY_CONTRACT || s.usdc !== NEAR_USDC || s.pauseRole.toLowerCase() !== role.toLowerCase()) {
    throw new Error("The app's server named another bounty contract, USDC or pause-role address than this page expects, so nothing will be signed.");
  }
  return {
    ...s,
    pauseRole: role,
    covered: s.covered.map((c) =>
      c.grant ? { ...c, grant: { chainId: c.chainId, to: c.address, value: "0", data: encodeFunctionData({ abi: GRANT_ROLE, functionName: "grantRole", args: [PAUSER_ROLE, role as Address] }) } } : c,
    ),
  };
}

/** Send one EVM transaction from MetaMask on its chain and wait for it to land. */
async function sendOn(call: EvmCall) {
  // Widened to number: wagmi types a send by the wallet setup's chains, which are built from the table untyped by ID.
  const chainId: number | undefined = coveredChain(call.chainId)?.id;
  if (chainId === undefined) throw new Error(`This app can't send on chain ${call.chainId}.`);
  await switchChain(wagmiConfig, { chainId });
  const hash = await sendTransaction(wagmiConfig, { chainId, to: call.to as Address, data: call.data as `0x${string}`, value: BigInt(call.value) });
  const r = await waitForTransactionReceipt(wagmiConfig, { hash, chainId });
  if (r.status !== "success") throw new Error("The transaction reverted.");
  return hash;
}

export function PostFlow() {
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [key, setKey] = useState<{ publicKey: string; from: "wallet" | "key-file" } | null>(null);
  const { address } = useAccount();
  const account = address?.toLowerCase();
  const q = usePostingStatus(account, draft);
  const s = q.data;
  // The exploit key is derived from a message naming the bounty (D20): a new name needs a new signature.
  useEffect(() => setKey(null), [draft.name]);

  // The step is in the URL's hash, so the dock and the browser's back button agree.
  useEffect(() => {
    const read = () => {
      const n = Number(location.hash.slice(1));
      if (n >= 1 && n <= 7) setStep(n);
    };
    read();
    addEventListener("hashchange", read);
    return () => removeEventListener("hashchange", read);
  }, []);
  const go = (n: number) => {
    setStep(n);
    history.replaceState(null, "", `#${n}`);
    scrollTo({ top: 0 });
  };

  const problems = useMemo(() => (s && account ? draftProblems(draft, account, s.usdcDecimals) : { pending: "" }), [draft, account, s]);
  const rulesOk = Object.keys(problems).length === 0 && !!s && !s.nameTaken;
  const nearOk = !!s && BigInt(s.account.near) >= BigInt(s.nearNeeded);
  const posted = s?.bountyState === "live";
  // Proven steps turn green only once the chain shows them; the others are only complete.
  const proven = [!!s?.account.onboarded && !!account, false, !!s && s.covered.length > 0 && s.covered.every((c) => c.granted), !!s && s.gas.length > 0 && s.gas.every((g) => g.ok), nearOk, false, posted];
  const complete = [proven[0], rulesOk, proven[2], proven[3], nearOk, !!key, posted];

  return (
    <>
      <h1 className="page-title">Post a bounty</h1>
      <p className="lead">Posting connects MetaMask. It signs every step, on {listOf([...CHAIN_NAMES, "NEAR"])}.</p>
      <div className="post-grid">
        <div>
          {q.isError && (
            <p role="alert" className="ink post-error">
              {(q.error as Error).message}
            </p>
          )}
          {step === 1 && <ConnectStep s={s} account={account} done={!!proven[0]} next={() => go(2)} />}
          {step === 2 && <RulesStep s={s} account={account} draft={draft} setDraft={setDraft} problems={problems} ok={rulesOk} next={() => go(3)} />}
          {step === 3 && <GrantStep s={rulesOk ? s : undefined} done={!!proven[2]} next={() => go(4)} />}
          {step === 4 && <GasStep s={rulesOk ? s : undefined} done={!!proven[3]} next={() => go(5)} />}
          {step === 5 && <NearStep s={s} account={account} done={nearOk} next={() => go(6)} />}
          {step === 6 && <KeyStep s={s} account={account} draft={draft} keyState={key} setKey={setKey} next={() => go(7)} />}
          {step === 7 && <PostStep s={s} account={account} draft={draft} exploitKey={key?.publicKey ?? null} ready={complete.slice(0, 6).every(Boolean)} />}
        </div>
        <RiskPanel className="risk-side" />
      </div>
      <nav className="dock show" aria-label="Posting steps">
        {STEPS.map((label, i) => (
          <button key={label} type="button" className={proven[i] ? "done" : complete[i] ? "complete" : ""} aria-current={step === i + 1 ? "step" : undefined} onClick={() => go(i + 1)}>
            <span className="k">{i + 1}.</span>
            <span className="lbl">{label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="post-step" aria-label={`${n}. ${title}`}>
      <h2>
        <span className="n">{n}.</span> {title}
      </h2>
      {children}
    </section>
  );
}

/** A checklist item (DESIGN.md, Posting checklist): its number turns green once it lands. */
function Item({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <li className="check-item">
      <h3>
        <span className={`num${done ? " ok" : ""}`}>{n}.</span> {title}
        <span className="sr-only">{done ? " done" : " not yet"}</span>
      </h3>
      {children}
      {!done && (
        <p className="wait" aria-hidden="true">
          not yet
        </p>
      )}
    </li>
  );
}

function Next({ ok, next, why }: { ok: boolean; next: () => void; why?: string }) {
  return (
    <div className="send">
      <button type="button" className="btn btn-ink" onClick={next} disabled={!ok}>
        Continue
      </button>
      {!ok && why && <p>{why}</p>}
    </div>
  );
}

function Problem({ m }: { m: { isError: boolean; error: unknown } }) {
  return m.isError ? <p role="alert">{walletError(m.error)}</p> : null;
}

function ConnectStep({ s, account, done, next }: { s?: PostingStatus; account?: string; done: boolean; next: () => void }) {
  const { connectors, connectAsync } = useConnect();
  const connect = useMutation({
    mutationFn: async () => {
      const mm = connectors.find((c) => c.id === "io.metamask") ?? connectors.find((c) => c.id === "metaMask");
      if (!mm || !(await mm.getProvider().catch(() => null))) throw new Error("MetaMask isn't installed in this browser.");
      await connectAsync({ connector: mm });
    },
  });
  const enable = useMutation({ mutationFn: () => enableNearSigning(account as Address, s!.account.relayerKey) });
  return (
    <Step n={1} title="Connect">
      <p className="step-lead">One MetaMask signs everything: the pause-role grants on {listOf(CHAIN_NAMES)}, and the bounty on NEAR as your account named after your address.</p>
      <ol className="checklist">
        <Item n={1} title="Your NEAR account" done={done}>
          {account ? (
            <>
              <CommandBlock text={account} />
              {s && !s.account.onboarded && (
                <>
                  <p>MetaMask signs NEAR transactions through NEAR's relayer. Let it submit them for this account: it's free, and needed once.</p>
                  <div className="send">
                    <button type="button" className="btn btn-ink" onClick={() => enable.mutate()} disabled={enable.isPending}>
                      {enable.isPending ? "Enabling" : "Enable NEAR signing"}
                    </button>
                  </div>
                  <Problem m={enable} />
                </>
              )}
            </>
          ) : (
            <>
              <div className="send">
                <button type="button" className="btn btn-ink" onClick={() => connect.mutate()} disabled={connect.isPending}>
                  {connect.isPending ? "Connecting" : "Connect MetaMask"}
                </button>
              </div>
              <Problem m={connect} />
            </>
          )}
        </Item>
      </ol>
      {done && <Next ok next={next} />}
    </Step>
  );
}

function Field({ label, error, help, children }: { label: string; error?: string; help?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {help && <small>{help}</small>}
      {error && <small className="err">{error}</small>}
    </label>
  );
}

function RulesStep(p: { s?: PostingStatus; account?: string; draft: Draft; setDraft: (d: Draft) => void; problems: Record<string, string>; ok: boolean; next: () => void }) {
  const { draft: d, setDraft } = p;
  const set = (patch: Partial<Draft>) => setDraft({ ...d, ...patch });
  // The chains offered are this build's (the network table), never the server's: a bounty here
  // can't cover a contract on another network's chain (D30).
  const chains = net.chains;
  const setCovered = (i: number, patch: Partial<Draft["covered"][number]>) => set({ covered: d.covered.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const coveredChains = [...new Set(d.covered.map((c) => c.chainId))];
  // A typo shows once its field has been left.
  const [seen, setSeen] = useState<Record<string, boolean>>({});
  const err = (k: string) => (seen[k] ? p.problems[k] : undefined);
  const touch = (k: string) => () => setSeen((x) => ({ ...x, [k]: true }));
  return (
    <Step n={2} title="Rules">
      <p className="step-lead">Fixed once posted: nobody can change them, you included.</p>
      <div className="form">
        <Field label="Bounty name" error={err("name") ?? (p.s?.nameTaken && d.name ? "That name is taken: a bounty name is never reused." : undefined)} help={p.account ? `Its ID: ${p.account}/${d.name || "<name>"}. The pause-role address comes from it, so renaming after a grant or top-up means doing them again.` : undefined}>
          <input className="datum" value={d.name} onChange={(e) => set({ name: e.target.value.trim() })} onBlur={touch("name")} spellCheck={false} />
        </Field>
        <fieldset className="covered">
          <legend>Covered contracts</legend>
          {d.covered.map((c, i) => (
            <div className="covered-row" key={i}>
              <Field label="Chain">
                <select value={c.chainId} onChange={(e) => setCovered(i, { chainId: Number(e.target.value) })}>
                  {chains.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {ch.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Contract address" error={err(`covered.${i}`)}>
                <input className="datum" value={c.address} onChange={(e) => setCovered(i, { address: e.target.value.trim() })} onBlur={touch(`covered.${i}`)} placeholder="0x…" spellCheck={false} />
              </Field>
              {d.covered.length > 1 && (
                <button type="button" className="btn btn-line" onClick={() => set({ covered: d.covered.filter((_, j) => j !== i) })}>
                  Remove
                </button>
              )}
            </div>
          ))}
          <p className="fine">Only contracts that pay nothing to callers by design can be covered.</p>
          {d.covered.length < 8 && (
            <button type="button" className="btn btn-line" onClick={() => set({ covered: [...d.covered, { chainId: d.covered.at(-1)!.chainId, address: "" }] })}>
              Add a contract
            </button>
          )}
        </fieldset>
        <Field label="Proof chain" help="Claims are replayed against this chain's state; theft is valued in its USDC.">
          <select value={coveredChains.includes(d.proofChain) ? d.proofChain : coveredChains[0]} onChange={(e) => set({ proofChain: Number(e.target.value) })}>
            {coveredChains.map((id) => (
              <option key={id} value={id}>
                {chains.find((c) => c.id === id)?.name ?? id}
              </option>
            ))}
          </select>
        </Field>
        <div className="cols">
          <Field label="Bounty amount" error={err("amount")} help="USDC on NEAR, paid in full to the winner.">
            <input inputMode="decimal" value={d.amount} onChange={(e) => set({ amount: e.target.value.trim() })} onBlur={touch("amount")} />
          </Field>
          <Field label="Minimum theft" error={err("minimum")} help="USDC. A smaller theft scores zero.">
            <input inputMode="decimal" value={d.minimum} onChange={(e) => set({ minimum: e.target.value.trim() })} onBlur={touch("minimum")} />
          </Field>
          <Field label="End date" error={err("endDate")} help="Claims close at the end of this day, UTC.">
            <input type="date" value={d.endDate} onChange={(e) => set({ endDate: e.target.value })} onBlur={touch("endDate")} />
          </Field>
          <Field label="Disclosure delay" error={err("delay")} help="Days after the payout before the exploit is published: 1 to 90.">
            <input inputMode="numeric" value={d.delay} onChange={(e) => set({ delay: e.target.value.trim() })} onBlur={touch("delay")} />
          </Field>
        </div>
      </div>
      <Next ok={p.ok} next={() => (coveredChains.includes(d.proofChain) ? p.next() : (set({ proofChain: coveredChains[0]! }), p.next()))} why={p.account ? "Fill in every field to continue." : "Connect MetaMask first."} />
    </Step>
  );
}

function GrantStep({ s, done, next }: { s?: PostingStatus; done: boolean; next: () => void }) {
  return (
    <Step n={3} title="Pause role">
      <p className="step-lead">
        Grant the pause role on each covered contract to the bounty's pause-role address. It can only pause: no unpause, no other power. Granting it is what proves you control the contract.
      </p>
      {s ? <CommandBlock text={s.pauseRole} /> : <p className="step-lead">Fill in the rules first: the pause-role address comes from the bounty's name.</p>}
      <ol className="checklist">
        {s?.covered.map((c, i) => (
          <GrantItem key={`${c.chainId}:${c.address}`} n={i + 1} c={c} pauseRole={s.pauseRole} primary={i === s.covered.findIndex((x) => !x.granted && x.grant)} />
        ))}
      </ol>
      <Next ok={done} next={next} why="Each grant ticks off once pause() from the pause-role address succeeds on its chain." />
    </Step>
  );
}

/** One ink action per view (DESIGN.md): the next item to do gets it; the others are secondary. */
const ink = (primary: boolean) => `btn ${primary ? "btn-ink" : "btn-line"}`;

function GrantItem({ n, c, pauseRole, primary }: { n: number; c: PostingStatus["covered"][number]; pauseRole: string; primary: boolean }) {
  const grant = useMutation({ mutationFn: () => sendOn(c.grant!) });
  const [copied, setCopied] = useState(false);
  const multisig = c.grant ?? { chainId: c.chainId, to: c.address, note: `grant pause() on this contract to ${pauseRole}` };
  return (
    <Item n={n} title={`${c.chain} · ${c.address}`} done={c.granted}>
      {!c.granted && (
        <>
          <p>
            {c.grant
              ? "This contract uses OpenZeppelin's AccessControl: grant PAUSER_ROLE from your wallet, or copy the transaction into your multisig."
              : "This contract has no standard pause role to grant from here. Let the pause-role address call pause() in your contract's own way."}
          </p>
          <div className="send">
            {c.grant && (
              <button type="button" className={ink(primary)} onClick={() => grant.mutate()} disabled={grant.isPending}>
                {grant.isPending ? "Granting" : `Grant on ${c.chain}`}
              </button>
            )}
            <button
              type="button"
              className="btn btn-line"
              onClick={async () => {
                await navigator.clipboard.writeText(JSON.stringify(multisig, null, 2));
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }}
            >
              {copied ? "Copied" : "Copy for your multisig"}
            </button>
          </div>
          <Problem m={grant} />
        </>
      )}
    </Item>
  );
}

function GasStep({ s, done, next }: { s?: PostingStatus; done: boolean; next: () => void }) {
  return (
    <Step n={4} title="Pause gas">
      <p className="step-lead">
        The pause is a real transaction on that chain, paid by the pause-role address, so it needs a few cents of that chain's token there in advance. BounTEE's funds on NEAR can't pay gas there. Only the BounTEE
        contract can sign for that address, so nobody, the Protocol included, can take that gas back. Nobody presses the pause button: a proven exploit triggers it.
      </p>
      {!s && <p className="step-lead">Fill in the rules first: the pause-role address comes from the bounty's name.</p>}
      <ol className="checklist">
        {s?.gas.map((g, i) => (
          <GasItem key={g.chainId} n={i + 1} g={g} pauseRole={s.pauseRole} primary={i === s.gas.findIndex((x) => !x.ok)} />
        ))}
      </ol>
      <Next ok={done} next={next} why="Each chain ticks off once the pause-role address holds what its pauses need." />
    </Step>
  );
}

function GasItem({ n, g, pauseRole, primary }: { n: number; g: PostingStatus["gas"][number]; pauseRole: string; primary: boolean }) {
  const top = useMutation({ mutationFn: () => sendOn({ chainId: g.chainId, to: pauseRole, data: "0x", value: g.short }) });
  return (
    <Item n={n} title={g.chain} done={g.ok}>
      <p>
        Holds {eth(g.held)} {g.token}. Its pauses need {eth(g.needed)} {g.token}.
      </p>
      {!g.ok && (
        <>
          <div className="send">
            <button type="button" className={ink(primary)} onClick={() => top.mutate()} disabled={top.isPending}>
              {top.isPending ? "Sending" : `Top up on ${g.chain}`}
            </button>
            <p>
              Sends {eth(g.short)} {g.token}.
            </p>
          </div>
          <Problem m={top} />
        </>
      )}
    </Item>
  );
}

function NearStep({ s, account, done, next }: { s?: PostingStatus; account?: string; done: boolean; next: () => void }) {
  const faucet = net.nearFaucet;
  return (
    <Step n={5} title="Add NEAR">
      <p className="step-lead">Your NEAR account pays the posting fee and the gas of the two posting prompts. Send NEAR to it from an exchange or another wallet.</p>
      <ol className="checklist">
        <Item n={1} title={s ? `Needs ${near(s.nearNeeded)}` : "Needs NEAR"} done={done}>
          {s && (
            <p>
              The posting fee is {near(s.postingFee)}; the rest pays gas. It holds {near(s.account.near)}.
            </p>
          )}
          {account && <CommandBlock text={account} />}
          {/* D17: NEAR has a faucet only on testnet (the network table). */}
          {faucet && (
            <p>
              <a href={faucet} target="_blank" rel="noopener">
                Get NEAR from the faucet
              </a>
            </p>
          )}
        </Item>
      </ol>
      <Next ok={done} next={next} why="It ticks off once the NEAR arrives." />
    </Step>
  );
}

function KeyStep(p: { s?: PostingStatus; account?: string; draft: Draft; keyState: { publicKey: string; from: string } | null; setKey: (k: { publicKey: string; from: "wallet" | "key-file" }) => void; next: () => void }) {
  const { signMessageAsync } = useSignMessage();
  const [differs, setDiffers] = useState(false);
  const sign = useMutation({
    mutationFn: async () => {
      const message = exploitKeyMessage(p.s!.contract, { protocol: p.account!, name: p.draft.name });
      // Signed twice: the key is derived only from a wallet that signs the same way each time (D20).
      const a = await signMessageAsync({ account: p.account as Address, message });
      const b = await signMessageAsync({ account: p.account as Address, message });
      if (a.toLowerCase() !== b.toLowerCase()) {
        setDiffers(true);
        return;
      }
      p.setKey({ publicKey: publicKeyText(keyFromSignature(hexToBytes(a))), from: "wallet" });
    },
  });
  const [fileProblem, setFileProblem] = useState("");
  return (
    <Step n={6} title="Exploit key">
      <p className="step-lead">
        After the payout, the winning exploit is released to this key, and only you can open it. It comes from one MetaMask signature, so there's no file to keep: sign the same message again to open it.
      </p>
      <ol className="checklist">
        <Item n={1} title="Your exploit key" done={false}>
          {p.keyState ? (
            <CommandBlock text={p.keyState.publicKey} />
          ) : differs ? (
            <>
              <p className="ink">Your wallet gave two different signatures, so no key can come from it. Use a saved X25519 key file instead.</p>
              <Field label="Exploit key file" error={fileProblem || undefined} help="PKCS#8 PEM, or 32 bytes as hex: openssl genpkey -algorithm x25519">
                <input
                  type="file"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    try {
                      p.setKey({ publicKey: publicKeyText(keyFromFile(await f.text())), from: "key-file" });
                      setFileProblem("");
                    } catch (err) {
                      setFileProblem((err as Error).message);
                    }
                  }}
                />
              </Field>
            </>
          ) : (
            <>
              <div className="send">
                <button type="button" className="btn btn-ink" onClick={() => sign.mutate()} disabled={sign.isPending || !p.s || !p.draft.name}>
                  {sign.isPending ? "Signing" : "Sign with MetaMask"}
                </button>
              </div>
              <Problem m={sign} />
            </>
          )}
        </Item>
      </ol>
      <Next ok={!!p.keyState} next={p.next} />
    </Step>
  );
}

function PostStep({ s, account, draft, exploitKey, ready }: { s?: PostingStatus; account?: string; draft: Draft; exploitKey: string | null; ready: boolean }) {
  const rules = useMemo(() => {
    try {
      return s && exploitKey ? rulesOf(draft, s, exploitKey) : null;
    } catch {
      return null;
    }
  }, [s, draft, exploitKey]);
  const feeShort = s ? BigInt(s.postingFee) - BigInt(s.account.postingFeeBalance) : 0n;
  const prepaid = !!s && feeShort <= 0n;
  const usdcShort = !!s && !!rules && BigInt(s.account.usdc) < BigInt(rules.bounty_amount);
  const prepay = useMutation({
    mutationFn: () =>
      nearFunctionCall({ receiverId: s!.contract, method: "prepay_posting_fee", args: {}, gas: 30n * 10n ** 12n, deposit: feeShort + (BigInt(s!.account.postingFeeBalance) === 0n ? ENTRY_STORAGE : 0n) }),
  });
  const post = useMutation({
    mutationFn: () =>
      nearFunctionCall({
        receiverId: s!.usdc,
        method: "ft_transfer_call",
        args: { receiver_id: s!.contract, amount: rules!.bounty_amount, msg: JSON.stringify({ name: draft.name, rules }) },
        gas: MAX_GAS,
        deposit: 1n,
      }),
  });
  const live = s?.bountyState === "live";
  const plain = rules && s
    ? rulesInPlainEnglish({
        amount: `${formatUnits(BigInt(rules.bounty_amount), s.usdcDecimals)} USDC`,
        minimumTheft: `${formatUnits(BigInt(rules.minimum_theft), s.usdcDecimals)} USDC`,
        covered: rules.covered_contracts.map((c) => ({ chain: coveredChain(c.chain_id)?.name ?? String(c.chain_id), address: c.address })),
        // The rules name no proof chain any more (D27); until #65 drops the field, the read-back names the one picked.
        proofChain: coveredChain(draft.proofChain)?.name ?? String(draft.proofChain),
        recencyMinutes: rules.recency_limit_secs / 60,
        ends: draft.endDate,
        disclosureDelayDays: rules.disclosure_delay_days,
      } as Parameters<typeof rulesInPlainEnglish>[0])
    : [];
  return (
    <Step n={7} title="Post">
      {plain.length > 0 ? (
        <div className="panel-app readback">
          <h3>Your rules, read back</h3>
          {plain.map((t) => (
            <p key={t}>{t}</p>
          ))}
        </div>
      ) : (
        <p className="step-lead">Finish the steps before this one to see your rules read back.</p>
      )}
      <RiskPanel className="risk-inline" />
      <ol className="checklist">
        <Item n={1} title="Prepay the posting fee" done={prepaid}>
          {!prepaid && s && (
            <>
              <p>
                {near(feeShort)} toward the posting check, storage and later jobs. It isn't refunded, even if the posting check fails.
              </p>
              <div className="send">
                <button type="button" className="btn btn-ink" onClick={() => prepay.mutate()} disabled={!ready || prepay.isPending || prepay.isSuccess}>
                  {prepay.isPending ? "Signing" : prepay.isSuccess ? "Confirming" : "Prepay the posting fee"}
                </button>
                {!ready && <p>Finish steps 1 to 6 first.</p>}
              </div>
              <Problem m={prepay} />
            </>
          )}
        </Item>
        <Item n={2} title="Post the bounty" done={live}>
          {live ? (
            <>
              <p className="ink">Your bounty is live.</p>
              <a className="btn btn-line" href={`/bounties/${account}/${draft.name}`}>
                See your bounty
              </a>
            </>
          ) : s?.bountyState === "check_failed" ? (
            <p className="ink">The posting check failed: the bounty amount came back in full. Check each grant and the pause gas, then post again under a new name.</p>
          ) : (
            <>
              <p>
                Sends {rules ? `${formatUnits(BigInt(rules.bounty_amount), s!.usdcDecimals)} USDC` : "the bounty amount"} with the rules. The bounty goes live once the posting check confirms every grant and the pause gas.
              </p>
              {usdcShort && <p className="ink">Your account holds {formatUnits(BigInt(s!.account.usdc), s!.usdcDecimals)} USDC on NEAR; the bounty needs more.</p>}
              <div className="send">
                <button type="button" className={ink(prepaid)} onClick={() => post.mutate()} disabled={!ready || !prepaid || !rules || usdcShort || post.isPending || post.isSuccess}>
                  {post.isPending ? "Signing" : post.isSuccess ? "Checking" : "Post the bounty"}
                </button>
                {ready && !prepaid && <p>Prepay the posting fee first.</p>}
                {post.isSuccess && !live && <p>The posting check is confirming every grant and the pause gas.</p>}
              </div>
              <Problem m={post} />
            </>
          )}
        </Item>
      </ol>
    </Step>
  );
}
