"use client";
// The posting flow (#31): a Protocol posts a bounty with the MetaMask it already uses (D13).
// Four steps, moved between with the floating dock (DESIGN.md, Posting flow). Everything
// checked is read live (lib/posting.ts) and ticked off only once it is on chain; MetaMask signs
// the EVM grants and top-ups directly, and NEAR transactions as the Protocol's 0x… account.
// The rules need no wallet: MetaMask connects at the first step that needs its address.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { encodeFunctionData, formatUnits, hexToBytes, keccak256, parseAbi, toHex, type Address } from "viem";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useSignMessage } from "wagmi";
import { sendTransaction, switchChain, waitForTransactionReceipt } from "wagmi/actions";
import { draftProblems, emptyDraft, nextLabel, rulesOf, slug, usdcUnits, type Draft } from "@/lib/draft.ts";
import { exploitKeyMessage, keyFromFile, keyFromSignature, publicKeyText } from "@/lib/exploit-key.ts";
import { shortHash, units } from "@/lib/format.ts";
import { enableNearSigning, MAX_GAS, nearFunctionCall } from "@/lib/near-eth.ts";
import { coveredChain, net } from "@/lib/network.ts";
import type { EvmCall, PostingBasics, PostingStatus } from "@/lib/posting.ts";
import { BOUNTY_CONTRACT, NEAR_USDC, pauseRoleOf } from "@/lib/pinned.ts";
import { rulesInPlainEnglish } from "@/lib/rules.ts";
import { wagmiConfig } from "@/lib/wagmi.ts";
import { CommandBlock } from "../CommandBlock.tsx";
import { ChainSelect } from "./ChainSelect.tsx";
import { EndDate } from "./EndDate.tsx";
import { Hint } from "../Hint.tsx";
import { ChainMark } from "../ChainMark.tsx";
import { TxChip } from "../Chips.tsx";
import { RiskPanel } from "./RiskPanel.tsx";

// Verb-first, so the dock reads as the to-do list it is.
const STEPS = ["Set rules", "Set up pause", "Add funds", "Post bounty"] as const;
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

// Both reads refetch on their own, so a failed one says it is retrying rather than asking for anything.
const CHAINS_DOWN = "Couldn't read the chains just now. Trying again.";

/** Checked like the full status: the contract and USDC this build pins. */
function useBasics() {
  return useQuery({
    queryKey: ["posting-basics"],
    queryFn: async () => {
      const res = await fetch("/api/post");
      if (!res.ok) throw new Error(CHAINS_DOWN);
      const b = ((await res.json()) as { basics: PostingBasics }).basics;
      if (b.contract !== BOUNTY_CONTRACT || b.usdc !== NEAR_USDC) throw new Error("The app's server named another bounty contract or USDC than this page expects, so nothing will be signed.");
      return b;
    },
    staleTime: Infinity,
  });
}

function usePostingStatus(account: string | undefined, draft: Draft) {
  const covered = draft.covered.filter((c) => /^0x[0-9a-fA-F]{40}$/.test(c.address));
  return useQuery({
    queryKey: ["posting", account, draft.name, covered],
    enabled: !!account,
    queryFn: async () => {
      const res = await fetch("/api/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol: account, name: draft.name || "unnamed", covered }) });
      if (!res.ok) throw new Error(CHAINS_DOWN);
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
  const basicsQuery = useBasics();
  const q = usePostingStatus(account, draft);
  // While a new name or contract list loads, the last answer is another bounty's: its pause-role
  // address and buttons would grant or fund the wrong address, so nothing shows until it lands.
  const s = q.isPlaceholderData ? undefined : q.data;
  // A name posted in this visit stays this bounty's, not one "used before" (D25).
  const [postedAs, setPostedAs] = useState<string | null>(null);
  const basics = s ?? basicsQuery.data;
  // The exploit key is derived from a message naming the bounty (D20): a new name needs a new signature.
  useEffect(() => setKey(null), [draft.name]);

  // The step is in the URL's hash, so the dock and the browser's back button agree.
  useEffect(() => {
    const read = () => {
      const n = Number(location.hash.slice(1));
      if (n >= 1 && n <= STEPS.length) setStep(n);
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

  const problems = useMemo(() => (basics ? draftProblems(draft, basics.usdcDecimals) : { pending: "" }), [draft, basics]);
  // A name is taken only within the Protocol's own bounties, so it is known once the wallet is.
  const taken = !!s?.nameTaken && postedAs !== draft.name;
  const rulesOk = Object.keys(problems).length === 0 && !taken;
  const bounty = s ? bountyUnits(draft, s.usdcDecimals) : null;
  const funded = !!s && BigInt(s.account.near) >= BigInt(s.nearNeeded) && bounty !== null && BigInt(s.account.usdc) >= bounty;
  const posted = s?.bountyState === "live";
  // Proven steps turn green only once the chain shows them; the others are only complete.
  const pauseReady = !!s && s.covered.length > 0 && s.covered.every((c) => c.granted) && s.gas.every((g) => g.ok);
  const proven = [false, pauseReady, funded, posted];
  const complete = [rulesOk, pauseReady, funded, posted];
  // Why the pause-role steps can't start yet. A name is taken only within the Protocol's own
  // bounties, so that is learned once the wallet connects, and offered a fresh name in one click.
  const renamed = nextLabel(draft.label);
  const rulesFirst = rulesOk ? null : taken ? (
    <>
      <p className="step-lead">You've posted a bounty named {draft.name} before, and a name is never reused.</p>
      <div className="send">
        <button type="button" className="btn btn-ink" onClick={() => setDraft({ ...draft, label: renamed, name: slug(renamed) })}>
          Use {slug(renamed)}
        </button>
      </div>
    </>
  ) : (
    <p className="step-lead">Fill in the rules first: the pause-role address comes from the bounty's name.</p>
  );

  return (
    <>
      <h1 className="page-title">Post a bounty</h1>
      <p className="lead">Everything signs with MetaMask. No NEAR wallet needed.</p>
      <div className="post-grid">
        <div>
          {[basicsQuery, q].map((x, i) =>
            x.isError ? (
              <p key={i} role="alert" className="ink post-error">
                {(x.error as Error).message}
              </p>
            ) : null,
          )}
          {step === 1 && <RulesStep basics={basics} taken={taken} account={account} draft={draft} setDraft={setDraft} problems={problems} ok={rulesOk} next={() => go(2)} />}
          {step === 2 && <PauseStep account={account} s={rulesOk ? s : undefined} rulesFirst={rulesFirst} done={pauseReady} next={() => go(3)} />}
          {step === 3 && <FundStep s={s} account={account} draft={draft} done={funded} next={() => go(4)} />}
          {step === 4 && <PostStep s={s} account={account} draft={draft} keyState={key} setKey={setKey} onPosted={setPostedAs} ready={complete.slice(0, 3).every(Boolean)} />}
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
// The item's state sits on its title row, so a glance down the list reads every state at once.
function Item({ n, title, done, status, children }: { n: number; title: ReactNode; done: boolean; status?: string; children?: ReactNode }) {
  return (
    <li className="check-item">
      <h3>
        <span className={`num${done ? " ok" : ""}`}>{n}.</span>
        <span className="item-title">{title}</span>
        <span className={`item-state${done ? " ok" : ""}`}>{status ?? (done ? "done" : "not yet")}</span>
      </h3>
      {children}
    </li>
  );
}

function Next({ ok, next, why, primary = true }: { ok: boolean; next: () => void; why?: string; primary?: boolean }) {
  return (
    <div className="send">
      <button type="button" className={ink(primary)} onClick={next} disabled={!ok}>
        Continue
      </button>
      {!ok && why && <p>{why}</p>}
    </div>
  );
}

function Problem({ m }: { m: { isError: boolean; error: unknown } }) {
  return m.isError ? <p role="alert">{walletError(m.error)}</p> : null;
}

/**
 * The wallet connects only when a step first needs it: the wallet's address is the Protocol's
 * NEAR account and part of the bounty's ID, which the pause-role address comes from (D13, D25).
 * The button opens the wallet picker (D34); the step goes on once wagmi reports an account.
 */
function WithWallet({ account, why, children }: { account?: string; why: string; children: ReactNode }) {
  const { status } = useAccount();
  // RainbowKit offers the picker only while no wallet is connected or connecting.
  const { openConnectModal } = useConnectModal();
  if (account) return <>{children}</>;
  const connecting = status === "connecting" || status === "reconnecting";
  return (
    <div className="send">
      <button type="button" className="btn btn-ink" onClick={() => openConnectModal?.()} disabled={connecting}>
        {connecting ? "Connecting" : "Connect MetaMask"}
      </button>
      <p>{why}</p>
    </div>
  );
}

// One short hint under the field; an error takes its place rather than stacking under it. The
// hint sits outside the label so it isn't read as part of the field's name.
function Field({ label, error, help, children }: { label: string; error?: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-main">
        <span>{label}</span>
        {children}
      </label>
      {error ? <small className="err">{error}</small> : help && <small>{help}</small>}
    </div>
  );
}

function RulesStep(p: { basics?: PostingBasics; taken: boolean; account?: string; draft: Draft; setDraft: (d: Draft) => void; problems: Record<string, string>; ok: boolean; next: () => void }) {
  const { draft: d, setDraft } = p;
  const set = (patch: Partial<Draft>) => setDraft({ ...d, ...patch });
  // The chains offered are this build's (the network table), never the server's: a bounty here
  // can't cover a contract on another network's chain (D30).
  const chains = net.chains;
  const setCovered = (i: number, patch: Partial<Draft["covered"][number]>) => set({ covered: d.covered.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  // A typo shows once its field has been left.
  const [seen, setSeen] = useState<Record<string, boolean>>({});
  const err = (k: string) => (seen[k] ? p.problems[k] : undefined);
  const touch = (k: string) => () => setSeen((x) => ({ ...x, [k]: true }));
  // Continue stays pressable: a disabled button can't say what's missing, so a click shows every
  // gap and moves to the first.
  const showGaps = () => {
    setSeen(Object.fromEntries(Object.keys(p.problems).map((k) => [k, true])));
    requestAnimationFrame(() => document.querySelector(".err")?.closest(".field")?.querySelector<HTMLElement>("input, button")?.focus());
  };
  return (
    <Step n={1} title={STEPS[0]}>
      <p className="step-lead">Once posted, nobody can change them, not even you.</p>
      <div className="form">
        <Field
          label="What does this bounty protect?"
          error={err("name") ?? (p.taken && d.name ? "You've posted a bounty with this name before, and a name is never reused." : undefined)}
          help={
            <>
              Whitehats find it at <span className="datum">/bounties/{p.account ? shortHash(p.account) : "your-address"}/{d.name || "…"}</span>
            </>
          }
        >
          <input value={d.label} onChange={(e) => set({ label: e.target.value, name: slug(e.target.value) })} onBlur={touch("name")} placeholder="Lending Pool v1" spellCheck={false} />
        </Field>
        <fieldset className="covered">
          <legend>Covered contracts</legend>
          <p className="fine">
            Each needs a <Hint tip="Next, you let the bounty's own address call it. It can only pause: no unpause, no other power.">pause() you can grant</Hint>. Only contracts that{" "}
            <Hint tip="A liquidation or keeper reward pays whoever calls it, so normal use would look like theft and pause you.">pay callers nothing</Hint> can be covered, so no liquidations.
          </p>
          {d.covered.map((c, i) => (
            <div className="covered-row" key={i}>
              <ChainSelect label="Chain" value={c.chainId} options={chains} onChange={(chainId) => setCovered(i, { chainId })} />
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
          {d.covered.length < 8 && (
            <button type="button" className="btn btn-line" onClick={() => set({ covered: [...d.covered, { chainId: d.covered.at(-1)!.chainId, address: "" }] })}>
              Add a contract
            </button>
          )}
        </fieldset>
        <div className="cols">
          <Field label="Bounty amount" error={err("amount")} help={<>Paid in full to the <Hint tip="If nobody proves one by the end date, you take the bounty back.">first proven theft</Hint>.</>}>
            <span className="suffixed">
              <input inputMode="decimal" value={d.amount} onChange={(e) => set({ amount: e.target.value.trim() })} onBlur={touch("amount")} placeholder="2,000" />
              <span>USDC</span>
            </span>
          </Field>
          <Field label="Smallest theft that counts" error={err("minimum")} help={<><Hint tip="Stops a rounding error worth cents from winning the bounty and pausing your contracts.">Smaller takes</Hint> don't win or pause anything.</>}>
            <span className="suffixed">
              <input inputMode="decimal" value={d.minimum} onChange={(e) => set({ minimum: e.target.value.trim() })} onBlur={touch("minimum")} />
              <span>USDC</span>
            </span>
          </Field>
          <EndDate value={d.endDate} onChange={(endDate) => setDraft({ ...d, endDate })} onBlur={touch("endDate")} error={err("endDate")} />
          <Field label="Keep the exploit private for" error={err("delay")} help={<>Your time to fix the bug before it <Hint tip="You get the exploit the moment the bounty pays, with your contracts already paused. After this, anyone can publish it so others can check the verdict.">goes public</Hint>.</>}>
            <span className="suffixed">
              <input inputMode="numeric" value={d.delay} onChange={(e) => set({ delay: e.target.value.trim() })} onBlur={touch("delay")} />
              <span>days</span>
            </span>
          </Field>
        </div>
      </div>
      <Next ok next={() => (p.ok ? p.next() : showGaps())} />
    </Step>
  );
}

const PAUSE_ROLE_NEEDS_WALLET = "Connect to see the address you'll grant it to.";

/** One ink action per view (DESIGN.md): the next thing to do gets it; the others are secondary. */
const ink = (primary: boolean) => `btn ${primary ? "btn-ink" : "btn-line"}`;

// Grants and pause gas are one job on one address, so they share a step: a card per chain
// holds that chain's grants and its gas (D5), and the posting check refuses while either is
// missing. The single ink button goes to the first thing left to do, top to bottom.
function PauseStep({ account, s, rulesFirst, done, next }: { account?: string; s?: PostingStatus; rulesFirst: ReactNode; done: boolean; next: () => void }) {
  const chains = s ? [...new Set([...s.covered.map((c) => c.chainId), ...s.gas.map((g) => g.chainId)])] : [];
  const todo = s ? chains.flatMap((id) => [...s.covered.filter((c) => c.chainId === id && !c.granted && c.grant).map((c) => `grant:${c.address}`), ...s.gas.filter((g) => g.chainId === id && !g.ok).map(() => `gas:${id}`)]) : [];
  return (
    <Step n={2} title={STEPS[1]}>
      <p className="step-lead">Let this bounty pause your contracts once an exploit is proven. It can only pause: no unpause, no access to funds.</p>
      <WithWallet account={account} why={PAUSE_ROLE_NEEDS_WALLET}>
        {s ? (
          <div className="form">
            <div className="field">
              <span>Pause-role address</span>
              <CommandBlock text={s.pauseRole} />
              <small>
                The same on every chain. Grant it the pause role and fund its gas below.{" "}
                <Hint tip="Only the bounty contract can sign for it, through NEAR's MPC network. It comes from your address and the bounty's name, so renaming the bounty means granting again.">
                  Who controls it?
                </Hint>
              </small>
            </div>
          </div>
        ) : (
          rulesFirst
        )}
        <ol className="checklist">
          {s &&
            chains.map((id, i) => (
              <ChainCard key={id} n={i + 1} chainId={id} s={s} next={todo[0]} />
            ))}
        </ol>
        {/* Continue never waits: a multisig grant can take days, and Post checks everything anyway. */}
        <Next ok next={next} primary={!!s && todo.length === 0} />
        {s && !done && <p className="fine">Posting waits until every chain is ready. You can carry on meanwhile.</p>}
      </WithWallet>
    </Step>
  );
}

function ChainCard({ n, chainId, s, next }: { n: number; chainId: number; s: PostingStatus; next?: string }) {
  const grants = s.covered.filter((c) => c.chainId === chainId);
  const gas = s.gas.find((g) => g.chainId === chainId);
  const name = grants[0]?.chain ?? gas?.chain ?? String(chainId);
  const explorerTx = coveredChain(chainId)?.explorerTx;
  const ready = grants.every((c) => c.granted) && (!gas || gas.ok);
  const left = grants.filter((c) => !c.granted).length + (gas && !gas.ok ? 1 : 0);
  const title = (
    <>
      <ChainMark chainId={chainId} name={name} /> {name}
    </>
  );
  return (
    <Item n={n} title={title} done={ready} status={ready ? "ready" : `${left} to do`}>
      <div className="tasks">
        {grants.map((c) => (
          <GrantTask key={c.address} c={c} explorerTx={explorerTx} primary={next === `grant:${c.address}`} />
        ))}
        {gas && <GasTask g={gas} pauseRole={s.pauseRole} explorerTx={explorerTx} primary={next === `gas:${chainId}`} />}
      </div>
    </Item>
  );
}

/** A row inside a chain card: what it is on the left, its state on the right, then its actions. */
function Task({ label, state, ok, children }: { label: ReactNode; state: string; ok: boolean; children?: ReactNode }) {
  return (
    <div className="task">
      <div className="task-head">
        <span className="task-label">{label}</span>
        <span className={`item-state${ok ? " ok" : ""}`}>{state}</span>
      </div>
      {children}
    </div>
  );
}

// A grant ticks off when pause() from the pause-role address succeeds in a simulated call, not
// when its transaction lands, so "checking" covers the few seconds between the two.
function GrantTask({ c, explorerTx, primary }: { c: PostingStatus["covered"][number]; explorerTx?: string; primary: boolean }) {
  const grant = useMutation({ mutationFn: () => sendOn(c.grant!) });
  const [copied, setCopied] = useState(false);
  const label = (
    <>
      Pause role on{" "}
      <span className="datum" title={c.address}>
        {shortHash(c.address)}
      </span>
    </>
  );
  const state = c.granted ? "granted" : grant.isPending ? "waiting for the transaction" : grant.isSuccess ? "checking" : "not granted";
  let body: ReactNode = null;
  if (c.granted) {
    if (grant.data && explorerTx) body = <TxChip chain={c.chain} hash={grant.data} href={`${explorerTx}${grant.data}`} />;
  } else if (!c.grant) {
    body = <p>No standard pause role here. Let the address above call pause() your own way, and this ticks off once it can.</p>;
  } else if (!grant.isSuccess) {
    body = (
      <>
        <div className="send">
          <button type="button" className={ink(primary)} onClick={() => grant.mutate()} disabled={grant.isPending}>
            {grant.isPending ? "Granting" : "Grant"}
          </button>
          <button
            type="button"
            className="btn btn-line"
            onClick={async () => {
              await navigator.clipboard.writeText(JSON.stringify(c.grant, null, 2));
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
          >
            {copied ? "Copied" : "Copy for multisig"}
          </button>
        </div>
        <Problem m={grant} />
      </>
    );
  }
  return (
    <Task label={label} state={state} ok={c.granted}>
      {body}
    </Task>
  );
}

// D5's points live in the tooltip: the pause is a real transaction paid from this address, so it
// needs that chain's token in advance; NEAR funds can't pay it; only the bounty can sign for it, so nobody can take the gas back; and a
// proven exploit, not a person, triggers the pause.
function GasTask({ g, pauseRole, explorerTx, primary }: { g: PostingStatus["gas"][number]; pauseRole: string; explorerTx?: string; primary: boolean }) {
  const top = useMutation({ mutationFn: () => sendOn({ chainId: g.chainId, to: pauseRole, data: "0x", value: g.short }) });
  const label = (
    <>
      <Hint
        tip={`Pausing is a real ${g.chain} transaction, paid from the address above, so it needs a few cents of ${g.token} there in advance: your bounty's funds on NEAR can't pay for it. Only the bounty contract can sign for that address, so nobody can take the gas back, you included. Nobody presses pause: a proven exploit triggers it.`}
      >
        Pause gas
      </Hint>{" "}
      <span className="datum">
        {eth(g.held)} / {eth(g.needed)} {g.token}
      </span>
    </>
  );
  const state = g.ok ? "funded" : top.isPending ? "waiting for the transaction" : top.isSuccess ? "checking" : "not funded";
  let body: ReactNode = null;
  if (g.ok) {
    if (top.data && explorerTx) body = <TxChip chain={g.chain} hash={top.data} href={`${explorerTx}${top.data}`} />;
  } else if (!top.isSuccess) {
    body = (
      <>
        <div className="send">
          <button type="button" className={ink(primary)} onClick={() => top.mutate()} disabled={top.isPending}>
            {top.isPending ? "Sending" : `Send ${eth(g.short)} ${g.token}`}
          </button>
        </div>
        <Problem m={top} />
      </>
    );
  }
  return (
    <Task label={label} state={state} ok={g.ok}>
      {body}
    </Task>
  );
}

/** USDC's smallest unit as people read it: 2000000000n with 6 decimals is "2,000". */
const usdcText = (raw: string | bigint, decimals: number) => Number(formatUnits(BigInt(raw), decimals)).toLocaleString("en-US", { maximumFractionDigits: decimals });

/** The bounty amount from step 1 in USDC's smallest unit, or null while it isn't a valid amount. */
function bountyUnits(draft: Draft, decimals: number): bigint | null {
  try {
    const v = usdcUnits(draft.amount, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

// Everything the posting costs, asked for in one place right before posting (D17): the bounty's
// USDC and the NEAR for the posting fee (R11.4) and the prompts' gas, both to the Protocol's own
// 0x… NEAR account, each ticking off once it holds enough.
function FundStep({ s, account, draft, done, next }: { s?: PostingStatus; account?: string; draft: Draft; done: boolean; next: () => void }) {
  const faucet = net.nearFaucet;
  const bounty = s ? bountyUnits(draft, s.usdcDecimals) : null;
  const usdcOk = !!s && bounty !== null && BigInt(s.account.usdc) >= bounty;
  const nearOk = !!s && BigInt(s.account.near) >= BigInt(s.nearNeeded);
  return (
    <Step n={3} title={STEPS[2]}>
      <p className="step-lead">Send both to your NEAR account, from an exchange or another wallet. Each ticks off once it arrives.</p>
      <WithWallet account={account} why="Your NEAR account is your MetaMask address.">
        {account && (
          <div className="form">
            <div className="field">
              <span>Your NEAR account</span>
              <CommandBlock text={account} />
              <small>
                Your MetaMask address, on NEAR.{" "}
                <Hint tip="NEAR accepts Ethereum addresses as accounts, and MetaMask signs for this one. No NEAR wallet needed.">Why this address?</Hint>
              </small>
            </div>
          </div>
        )}
        {s && (
          <ol className="checklist">
            <Item
              n={1}
              title={
                <>
                  Bounty <span className="datum">{bounty !== null ? `${usdcText(bounty, s.usdcDecimals)} USDC` : "USDC"}</span>
                </>
              }
              done={usdcOk}
              status={usdcOk ? "received" : bounty === null ? "set it in step 1" : `${usdcText(s.account.usdc, s.usdcDecimals)} received`}
            >
              {!usdcOk && (
                <p>
                  <Hint tip={`Circle's native USDC on NEAR, token ${s.usdc}. When withdrawing from an exchange, pick NEAR as the network.`}>USDC on NEAR</Hint>, locked in the bounty when
                  you post.
                  {/* D32: Circle's faucet for test USDC, on testnet only (the network table). */}
                  {net.usdcFaucet && (
                    <>
                      {" "}
                      <a href={net.usdcFaucet} target="_blank" rel="noopener">
                        Get test USDC from Circle&apos;s faucet
                      </a>
                    </>
                  )}
                </p>
              )}
            </Item>
            <Item
              n={2}
              title={
                <>
                  Fees <span className="datum">{near(s.nearNeeded)}</span>
                </>
              }
              done={nearOk}
              status={nearOk ? "received" : `${near(s.account.near)} received`}
            >
              {!nearOk && (
                <>
                  <p>
                    <Hint tip={`The posting fee, ${near(s.postingFee)}, pays for checking your contracts, storing the bounty and its later jobs, and isn't refunded. The rest is gas for the posting prompts.`}>
                      Posting fee and gas
                    </Hint>
                    , paid in NEAR.
                  </p>
                  {/* D17: NEAR has a faucet only on testnet (the network table). */}
                  {faucet && (
                    <p>
                      <a href={faucet} target="_blank" rel="noopener">
                        Get NEAR from the faucet
                      </a>
                    </p>
                  )}
                </>
              )}
            </Item>
          </ol>
        )}
        <Next ok next={next} />
        {s && !done && <p className="fine">Posting waits until both arrive. You can carry on meanwhile.</p>}
      </WithWallet>
    </Step>
  );
}

// The exploit key is the first item here (D20): derived from a signature right before the posting
// prompts, so it needs no step of its own and leaves no file to keep.
function PostStep(p: {
  s?: PostingStatus;
  account?: string;
  draft: Draft;
  keyState: { publicKey: string; from: string } | null;
  setKey: (k: { publicKey: string; from: "wallet" | "key-file" }) => void;
  onPosted: (name: string) => void;
  ready: boolean;
}) {
  const { s, account, draft, ready } = p;
  const exploitKey = p.keyState?.publicKey ?? null;
  const rules = useMemo(() => {
    try {
      return s && exploitKey ? rulesOf(draft, s, exploitKey) : null;
    } catch {
      return null;
    }
  }, [s, draft, exploitKey]);
  const { signMessageAsync } = useSignMessage();
  const [differs, setDiffers] = useState(false);
  const [fileProblem, setFileProblem] = useState("");
  const sign = useMutation({
    mutationFn: async () => {
      const message = exploitKeyMessage(s!.contract, { protocol: account!, name: draft.name });
      // Signed twice: the key is derived only from a wallet that signs the same way each time (D20).
      const a = await signMessageAsync({ account: account as Address, message });
      const b = await signMessageAsync({ account: account as Address, message });
      if (a.toLowerCase() !== b.toLowerCase()) {
        setDiffers(true);
        return;
      }
      p.setKey({ publicKey: publicKeyText(keyFromSignature(hexToBytes(a))), from: "wallet" });
    },
  });
  const feeShort = s ? BigInt(s.postingFee) - BigInt(s.account.postingFeeBalance) : 0n;
  const prepaid = !!s && feeShort <= 0n;
  const usdcShort = !!s && !!rules && BigInt(s.account.usdc) < BigInt(rules.bounty_amount);
  const prepay = useMutation({
    mutationFn: () =>
      nearFunctionCall({
        receiverId: s!.contract,
        method: "prepay_posting_fee",
        args: {},
        gas: 30n * 10n ** 12n,
        deposit: feeShort + (BigInt(s!.account.postingFeeBalance) === 0n ? ENTRY_STORAGE : 0n),
      }),
  });
  // The name travels with the mutation, so a rename while it's pending can't be recorded as posted.
  const post = useMutation({
    mutationFn: (name: string) =>
      nearFunctionCall({
        receiverId: s!.usdc,
        method: "ft_transfer_call",
        args: { receiver_id: s!.contract, amount: rules!.bounty_amount, msg: JSON.stringify({ name, rules }) },
        gas: MAX_GAS,
        deposit: 1n,
      }),
    onSuccess: (_, name) => p.onPosted(name),
  });
  const enable = useMutation({ mutationFn: () => enableNearSigning(account as Address, s!.account.relayerKey) });
  const onboarded = !!s?.account.onboarded;
  const live = s?.bountyState === "live";
  const keyed = !!exploitKey;
  const finishFirst = !ready && <p>Finish steps 1 to {STEPS.length - 1} first.</p>;
  // The read-back needs no key: it says what the rules do, not who opens the exploit.
  const bounty = s ? bountyUnits(draft, s.usdcDecimals) : null;
  const plain =
    s && ready && bounty !== null
      ? rulesInPlainEnglish({
          amount: `${usdcText(bounty, s.usdcDecimals)} USDC`,
          minimumTheft: `${usdcText(bountyUnits({ ...draft, amount: draft.minimum }, s.usdcDecimals) ?? 0n, s.usdcDecimals)} USDC`,
          covered: draft.covered.map((c) => ({ chain: coveredChain(c.chainId)?.name ?? String(c.chainId), address: c.address.toLowerCase() })),
          recencyMinutes: s.fixed.recency_limit_secs / 60,
          ends: draft.endDate,
          disclosureDelayDays: Number(draft.delay),
        } as Parameters<typeof rulesInPlainEnglish>[0])
      : [];
  return (
    <Step n={4} title={STEPS[3]}>
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
      <WithWallet account={account} why="Your wallet signs the NEAR prompts as your NEAR account.">
        <ol className="checklist">
          <Item n={1} title="Your exploit key" done={false} status={keyed ? "signed" : "not signed"}>
            {keyed && (
              <>
                <p>Goes into the rules, so only you can open the winning exploit.</p>
                <CommandBlock text={exploitKey} />
              </>
            )}
            {!keyed &&
              (differs ? (
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
                  <p>
                    The winning exploit opens only with this key.{" "}
                    <Hint tip="It comes from one MetaMask signature of a message naming this bounty. Sign the same message again later to open the exploit: there's no file to keep.">
                      No file to keep
                    </Hint>
                    .
                  </p>
                  <div className="send">
                    <button type="button" className={ink(ready && !keyed)} onClick={() => sign.mutate()} disabled={!s || !draft.name || sign.isPending}>
                      {sign.isPending ? "Signing" : "Sign with MetaMask"}
                    </button>
                  </div>
                  <Problem m={sign} />
                </>
              ))}
          </Item>
          {/* NEAR signing is enabled here, before the first NEAR transaction, once the account holds NEAR. */}
          <Item n={2} title="Enable NEAR signing" done={onboarded}>
            {!onboarded && s && (
              <>
                <p>Lets MetaMask sign for your NEAR account. Free, and needed once.</p>
                <div className="send">
                  <button type="button" className={ink(ready && keyed && !onboarded)} onClick={() => enable.mutate()} disabled={!ready || enable.isPending || enable.isSuccess}>
                    {enable.isPending ? "Enabling" : enable.isSuccess ? "Confirming" : "Enable NEAR signing"}
                  </button>
                  {finishFirst}
                </div>
                <Problem m={enable} />
              </>
            )}
          </Item>
          <Item n={3} title="Prepay the posting fee" done={prepaid}>
            {!prepaid && s && (
              <>
                <p>{near(feeShort)}, not refunded even if the posting check fails.</p>
                <div className="send">
                  <button type="button" className={ink(ready && keyed && onboarded && !prepaid)} onClick={() => prepay.mutate()} disabled={!ready || !onboarded || prepay.isPending || prepay.isSuccess}>
                    {prepay.isPending ? "Signing" : prepay.isSuccess ? "Confirming" : "Prepay the posting fee"}
                  </button>
                  {ready && !onboarded && <p>Enable NEAR signing first.</p>}
                </div>
                <Problem m={prepay} />
              </>
            )}
          </Item>
          <Item n={4} title="Post the bounty" done={live}>
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
                <p>Sends {bounty !== null && s ? `${usdcText(bounty, s.usdcDecimals)} USDC` : "the bounty amount"} with the rules. It goes live once the posting check confirms every grant and the pause gas.</p>
                {usdcShort && <p className="ink">Your account holds {usdcText(s!.account.usdc, s!.usdcDecimals)} USDC on NEAR; the bounty needs more.</p>}
                <div className="send">
                  <button type="button" className={ink(ready && keyed && onboarded && prepaid)} onClick={() => post.mutate(draft.name)} disabled={!ready || !keyed || !prepaid || !rules || usdcShort || post.isPending || post.isSuccess}>
                    {post.isPending ? "Signing" : post.isSuccess ? "Checking" : "Post the bounty"}
                  </button>
                  {ready && !keyed && <p>Sign your exploit key first.</p>}
                  {ready && keyed && !prepaid && <p>Prepay the posting fee first.</p>}
                  {post.isSuccess && !live && <p>The posting check is confirming every grant and the pause gas.</p>}
                </div>
                <Problem m={post} />
              </>
            )}
          </Item>
        </ol>
      </WithWallet>
    </Step>
  );
}
