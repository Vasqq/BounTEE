"use client";
// A read that failed, inside the block that failed (DESIGN.md, Empty, loading, error): a fail
// chip naming it, when the data was last good, and Retry.
export function ReadFailed({ what, lastGood, onRetry }: { what: string; lastGood?: string | null; onRetry?: () => void }) {
  return (
    <div className="failbox" role="alert">
      <span className="chip fail">{what}</span>
      <p>{lastGood ? `Last read ${lastGood}.` : "Nothing has been read from it yet."}</p>
      <button type="button" className="btn btn-line" onClick={onRetry ?? (() => location.reload())}>
        Retry
      </button>
    </div>
  );
}
