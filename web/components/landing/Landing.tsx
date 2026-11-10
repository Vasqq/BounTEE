"use client";
// The landing page: the locked prototype's markup (landing C3), with the demo bounty's values
// read live (lib/demo.ts) in place of the prototype's placeholders. The pictures, story panels,
// dock and hero motion are the prototype's own script (runtime.js).
import { useEffect, useMemo, type CSSProperties } from "react";
import { listOf } from "@/lib/format.ts";
import { useDemo, useVerify } from "@/lib/live.ts";
import { VerifyRun } from "../Verify.tsx";
import { Wordmark } from "../Wordmark.tsx";
import { startLanding } from "./runtime.js";

const DASH = "–";
/** The prototype's staggered entrance: `--d` delays a `.rise`. */
const delay = (d: string) => ({ "--d": d }) as CSSProperties;

/** `nearExplorer`: the explorer the proof links point at before the demo bounty is read. */
export function Landing({ nearExplorer }: { nearExplorer: string }) {
  const { data: demo = null } = useDemo();
  const demoId = useMemo(() => (demo ? { protocol: demo.story.protocol, name: demo.story.name } : null), [demo?.story.protocol, demo?.story.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: result } = useVerify(demoId);
  // The prototype's script draws the story; it starts once and takes each new read in place.
  useEffect(() => {
    const page = startLanding();
    if (demo) page.update(demo.story);
  }, [demo]);
  return (
    <>
      <a className="sr-only" href="#main">Skip to content</a>
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <defs id="isoDefs"></defs>
      </svg>

      <header className="nav" id="nav">
        <div className="wrap">
          <Wordmark href="#top" label="BounTEE, back to top" />
          <ul>
            <li><a href="#story">The demo</a></li>
            <li><a href="#who">Whitehats</a></li>
            <li><a href="#verify">Verify</a></li>
            <li><a href="#trust">Trust</a></li>
            <li><a href="#faq">FAQ</a></li>
          </ul>
          <a className="btn btn-ink" href="/bounties">Open the app</a>
        </div>
      </header>

      <main id="main">
        <section className="hero hero-t" id="top">
          <canvas className="hero-bg" id="heroBg" aria-hidden="true"></canvas>
          <div className="hero-melt" aria-hidden="true"></div>

          <div className="wrap pw">
            <div>
              <p className="badge"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.9017 0.646973C13.3462 0.646973 12.8304 0.929357 12.5394 1.39357L9.40403 5.95741C9.30186 6.10784 9.34331 6.31059 9.49675 6.41075C9.6211 6.49202 9.78561 6.48196 9.89889 6.38645L12.9851 3.76201C13.0364 3.71677 13.1154 3.72137 13.1616 3.77165C13.1825 3.79469 13.1937 3.82444 13.1937 3.85502V12.0719C13.1937 12.1397 13.1377 12.1942 13.0684 12.1942C13.0312 12.1942 12.9962 12.1783 12.9727 12.1502L3.6435 1.20169C3.33966 0.850174 2.89352 0.647392 2.42388 0.646973H2.09782C1.21536 0.646973 0.5 1.34833 0.5 2.2135V13.7863C0.5 14.6515 1.21536 15.3528 2.09782 15.3528C2.65336 15.3528 3.16915 15.0704 3.46017 14.6062L6.59558 10.0424C6.69769 9.89194 6.65624 9.68919 6.50279 9.58903C6.37845 9.50776 6.21394 9.51782 6.10071 9.61334L3.01446 12.2378C2.96318 12.283 2.88412 12.2784 2.83797 12.2281C2.81703 12.2051 2.80592 12.1753 2.80634 12.1447V3.92583C2.80634 3.85796 2.86232 3.80349 2.93155 3.80349C2.96831 3.80349 3.00377 3.81941 3.02728 3.84748L12.3552 14.7981C12.659 15.1496 13.1052 15.3524 13.5749 15.3528H13.9009C14.7833 15.3532 15.4992 14.6523 15.5 13.7871V2.2135C15.5 1.34833 14.7842 0.646973 13.9017 0.646973Z" fill="currentColor"/></svg><span>Built on NEAR</span></p>
              <h1 aria-label="Bug bounties that pay themselves: prove the exploit, get paid, and the contract pauses on Base and Arbitrum One.">
                <span className="ln" aria-hidden="true" data-dec>Prove it.</span>
                <span className="ln" aria-hidden="true"><span data-dec>Get </span><span className="paid" data-dec>paid.</span></span>
                <span className="ln last" aria-hidden="true">Pause it on&nbsp;<span className="roll " id="roll"><span className="chain on"><img className="wm" src="/brand/Base_lockup_blue_dark.svg" width="1280" height="323.84" style={{ height: "0.62em" }} alt="Base" /></span><span className="chain"><img className="wm" src="/brand/Arbitrum_One_horizontal_blue_dark.svg" width="1653.24" height="420.29" style={{ height: "0.74em" }} alt="Arbitrum One" /></span></span></span>
              </h1>
              <p className="sub">Bug bounties that pay themselves. A Whitehat, or their AI agent, proves an exploit inside a sealed enclave. NEAR pays them and signs a pause for every chain the bounty covers. Nobody approves it.</p>
              <div className="cta"><a className="btn btn-ink" href="#verify">Verify it yourself</a><a className="btn btn-line" href="#story">See it run</a></div>
            </div>
          </div>
          <a className="cue" href="#story"><span>see it run</span><i /></a>
        </section>

        <section className="story" id="story" aria-labelledby="storyH">
          <div className="wrap story-head">
            <h2 id="storyH" className="rise">The demo, one transaction at a time.</h2>
            <div>
              <p className="lead rise" style={delay("80ms")}>{demo?.story.claimKey ? "A Whitehat claimed it: an independent AI agent, given only the instructions file and a claim key, found the bug and filed the claim. The Whitehat was paid by rule: no triage, no downgrade, nobody to dispute it." : "A Whitehat's claim is paid by rule: no triage, no downgrade, nobody to dispute it. Each step links its mainnet transaction once it happens."}</p>
              <dl className="proof rise" style={delay("140ms")} aria-label="What ran on mainnet">
                <dt>Ran on</dt><dd>{demo?.chains ? `${listOf(["NEAR", ...demo.chains])} mainnet` : DASH}</dd>
                <dt>Claimed by</dt><dd>{demo?.story.claimKey ? "a Whitehat's AI agent, with a claim key" : DASH}</dd>
                <dt>Paid</dt><dd>{demo?.paidOnce ? <><span className="ok">{demo.amount}</span>, once</> : DASH}</dd>
                <dt>Every step</dt><dd>{demo?.contract ? <a href={demo.contractHref} target="_blank" rel="noopener">{demo.contract} on nearblocks</a> : <a href={nearExplorer} target="_blank" rel="noopener">tx pending</a>}</dd>
              </dl>
            </div>
          </div>
          <div className="track" id="track">
            <div className="stage">
              <div className="stage-in">
                <figure className="world">
                  <figcaption className="world-bar"><b id="storyName"></b><span className="now" aria-hidden="true"><span id="storyNow">1. Posted</span></span></figcaption>
                  <svg className="iso" id="storyArt" aria-hidden="true"></svg>
                </figure>
                <ol className="panels" id="panels"></ol>
              </div>
            </div>
          </div>
        </section>

        <section className="who" id="who" aria-labelledby="whoH">
          <div className="wrap">
            <div className="who-head">
              <h2 id="whoH" className="rise">You, or your agent.</h2>
              <p className="lead rise" style={delay("80ms")}>Same commands, same Enclave, same payout to your NEAR account. The only difference is the key that signs the claim.</p>
            </div>
            <div className="who-cols rise" style={delay("120ms")}>
              <div>
                <svg className="glyph iso" data-glyph="whitehat" aria-hidden="true"></svg>
                <h3>You, with your own key.</h3>
                <p>Write the exploit as a Foundry script, test it locally against the rule that will judge it, and claim from the terminal. It is sealed on your machine before it leaves.</p>
                <div className="term-mini"><code id="cmdYou"><span className="p" aria-hidden="true">$</span>bountee claim &lt;protocol&gt;/&lt;name&gt;</code><button className="copy" type="button" data-copy="cmdYou">Copy</button></div>
              </div>
              <div>
                <svg className="glyph iso" data-glyph="agent" aria-hidden="true"></svg>
                <h3>Your agent, with a claim key.</h3>
                <p>A key on your own account that can file claims and nothing else. It can't move funds, withdraw your balance or add keys, and you can revoke it any time.</p>
                <div className="term-mini"><code id="cmdAgent"><span className="p" aria-hidden="true">$</span>bountee key add --contract &lt;contract&gt; --as &lt;you&gt;</code><button className="copy" type="button" data-copy="cmdAgent">Copy</button></div>
              </div>
            </div>
          </div>
        </section>

        <section className="statement" aria-label="In short">
          <div className="wrap">
            <p id="statement">Nobody approves the payout or the pause. The Enclave proves the theft, NEAR pays once, and every covered contract stops. Each step is a transaction you can check.</p>
          </div>
        </section>

        <section id="verify" aria-labelledby="verifyH">
          <div className="wrap">
            <div className="verify-head">
              <h2 id="verifyH" className="rise">Don't take our word. Run the checks.</h2>
              <p className="lead rise" style={delay("80ms")}>The command-line tool reads the demo bounty from the chains and rebuilds the code from source. It needs no keys and no funds. This is what it reports.</p>
            </div>
            <div className="term" id="term">
              <div className="term-bar">
                <code id="cmd"></code>
                <button className="copy" type="button" data-copy="cmd">Copy</button>
              </div>
              <div className="term-body">
                <p className="note" id="termNote"></p>
                {result ? <VerifyRun rows={result.rows} /> : <ul className="run" aria-label="Check results" />}
              </div>
            </div>
            <p className="verify-foot">Prefer the browser? Every bounty page runs the same checks, read live from the chains.</p>
          </div>
        </section>

        <section className="trust" id="trust" aria-labelledby="trustH">
          <div className="wrap">
            <h2 id="trustH" className="rise">What nobody can do, and what you still trust.</h2>
            <div className="ledger rise">
              <div>
                <h3>Nobody can</h3>
                <ul>
                  <li><svg className="glyph iso" data-glyph="vault" aria-hidden="true"></svg><div><b>Move the bounty</b><p>It is locked until the end date and paid in full to the first proven theft.</p></div></li>
                  <li><svg className="glyph iso" data-glyph="rules" aria-hidden="true"></svg><div><b>Change the rules</b><p>They are fixed at posting, judge build included.</p></div></li>
                  <li><svg className="glyph iso" data-glyph="funds" aria-hidden="true"></svg><div><b>Touch your funds</b><p>The worst a wrong verdict can do is pause the covered contracts.</p></div></li>
                  <li><svg className="glyph iso" data-glyph="sealed" aria-hidden="true"></svg><div><b>See a claim in progress</b><p>Nothing public points at the bug before the pause lands.</p></div></li>
                </ul>
              </div>
              <div>
                <h3>You trust</h3>
                <ul>
                  <li><svg className="glyph iso" data-glyph="enclave" aria-hidden="true"></svg><div><b>OutLayer's enclave, Intel TDX</b><p>To run the judge it attests to, and keep sealed exploits sealed.</p></div></li>
                  <li><svg className="glyph iso" data-glyph="mpc" aria-hidden="true"></svg><div><b>NEAR's MPC network</b><p>To sign pauses only for the bounty contract, and confirm they landed.</p></div></li>
                  <li><svg className="glyph iso" data-glyph="rpc" aria-hidden="true"></svg><div><b>Three independent RPCs per chain</b><p>To agree on the recent block a claim is judged against.</p></div></li>
                  <li><svg className="glyph iso" data-glyph="code" aria-hidden="true"></svg><div><b>BounTEE's deployed code</b><p>Which you can rebuild from source and match, hash for hash.</p></div></li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section id="faq" aria-labelledby="faqH">
          <div className="wrap faq">
            <div className="faq-l">
              <h2 id="faqH">Questions judges ask.</h2>
              <p className="lead">The short answers. The README has the long ones, each with a command to check it.</p>
              <svg className="iso" id="faqArt" aria-hidden="true"></svg>
            </div>
            <div>
              <div className="qa"><h3><button type="button" aria-expanded="false" aria-controls="a1">What counts as an exploit?<span className="pm" aria-hidden="true"><svg viewBox="0 0 10 10"><path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></span></button></h3><div className="ans" id="a1"><div><p>Theft from the covered contracts of at least the minimum theft, valued at the prices fixed at posting. Value taken from other contracts, and legitimate outflows passed off as theft, count for nothing.</p></div></div></div>
              <div className="qa"><h3><button type="button" aria-expanded="false" aria-controls="a2">How does the exploit stay secret?<span className="pm" aria-hidden="true"><svg viewBox="0 0 10 10"><path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></span></button></h3><div className="ans" id="a2"><div><p>It is sealed so only the bounty contract's own enclave job can read it. The Protocol can open it once the Whitehat is paid, and it is published after the disclosure delay.</p></div></div></div>
              <div className="qa"><h3><button type="button" aria-expanded="false" aria-controls="a3">Who sends the pause?<span className="pm" aria-hidden="true"><svg viewBox="0 0 10 10"><path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></span></button></h3><div className="ans" id="a3"><div><p>Anyone. NEAR's MPC network signs it, so whoever sends it can't change it. Every bounty page has a Send pause button that needs no wallet.</p></div></div></div>
              <div className="qa"><h3><button type="button" aria-expanded="false" aria-controls="a4">Do I need a wallet to check any of this?<span className="pm" aria-hidden="true"><svg viewBox="0 0 10 10"><path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></span></button></h3><div className="ans" id="a4"><div><p>No. Everything here is read from the chains, and the command-line tool's verify needs no keys and no funds. Only posting a bounty and opening a winning exploit need MetaMask.</p></div></div></div>
              <div className="qa"><h3><button type="button" aria-expanded="false" aria-controls="a5">Can an AI agent claim?<span className="pm" aria-hidden="true"><svg viewBox="0 0 10 10"><path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></span></button></h3><div className="ans" id="a5"><div><p>{demo?.story.claimKey ? "Yes. The demo bounty was won by one. " : "Yes. "}A Whitehat gives their agent a claim key that can file claims and nothing else. Payouts go to the Whitehat, never to the key.</p></div></div></div>
              <div className="qa"><h3><button type="button" aria-expanded="false" aria-controls="a6">What can't a bounty cover?<span className="pm" aria-hidden="true"><svg viewBox="0 0 10 10"><path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></span></button></h3><div className="ans" id="a6"><div><p>Only contracts that pay nothing to callers by design can be covered. A pause protects the covered contracts; copies of the same code elsewhere stay exposed.</p></div></div></div>
            </div>
          </div>
        </section>
      </main>

      <footer className="close" id="post">
        <div className="wrap">
          <div className="close-grid">
            <div>
              <h2 className="rise">Put a bounty on your contracts.</h2>
              <p className="lead">Grant the pause role, add a few cents of pause gas, and post from the MetaMask you already use.</p>
              <div className="cta">
                <a className="btn btn-ink" href="/post">Post a bounty</a>
                <a className="btn btn-line" href="https://github.com/Vasqq/bountee">Read the README</a>
              </div>
              <p className="fine">Posting connects MetaMask. Reading and verifying never do.</p>
            </div>
            <div className="close-art"><svg className="iso" id="closeArt" aria-hidden="true"></svg></div>
          </div>
          <div className="foot">
            <span>BounTEE · NEAR hackathon, security track. Every proof here is a mainnet transaction.</span>
            <nav aria-label="Footer"><a href="#story">The demo</a><a href="#verify">Verify</a><a href="#trust">Trust</a><a href="https://github.com/Vasqq/bountee">Source</a></nav>
          </div>
        </div>
      </footer>

      <nav className="dock" id="dock" aria-label="Demo steps"></nav>
    </>
  );
}
