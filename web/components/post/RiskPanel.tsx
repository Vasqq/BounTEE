// "What you're risking" (D15): before the Protocol signs, the panel states what a bounty
// commits it to, and the same trusted parties the README names (R15.5). Built as the
// ledger without glyphs (DESIGN.md, Posting flow).
const RISKS: [string, string][] = [
  ["A bug you fix stops paying", "A claim tests your contracts as they are at a recent block, so a bug you fix yourself stops being claimable 5 minutes after the fix lands."],
  ["The bounty is locked", "It is locked until the end date and paid in full to the first proven theft of at least the minimum theft."],
  ["Fees stay spent", "The posting fee isn't refunded and pause gas can't be recovered."],
  ["The worst case is a pause", "The worst a wrong verdict can do is pause the covered contracts. BounTEE can never move your funds."],
  ["The exploit goes public", "The winning exploit is published after the disclosure delay you choose."],
];

const TRUSTED: [string, string][] = [
  ["OutLayer", "runs the judge in its enclave and returns the verdict."],
  ["Intel", "makes the enclave's hardware and signs its attestation."],
  ["NEAR's MPC network", "signs each pause and confirms it landed."],
  ["The judge's pinned RPCs", "confirm the block a claim is judged against, three per chain."],
  ["NEAR", "runs the bounty contract as written."],
  ["Circle", "issues the USDC the bounty is held and paid in."],
  ["BounTEE's builders", "hold no keys: after deployment they can't move funds, pause or change a bounty's rules."],
];

export function RiskPanel({ className = "" }: { className?: string }) {
  return (
    <aside className={`panel-app risk ${className}`.trim()} aria-label="What you're risking">
      <h2 className="h-panel">What you're risking</h2>
      <ul>
        {RISKS.map(([title, text]) => (
          <li key={title}>
            <b>{title}</b>
            <p>{text}</p>
          </li>
        ))}
        <li>
          <b>Who you trust</b>
          <p>
            {TRUSTED.map(([who, what]) => (
              <span key={who}>
                {who} {what}{" "}
              </span>
            ))}
            The README says what each could do if it misbehaved.
          </p>
        </li>
      </ul>
    </aside>
  );
}
