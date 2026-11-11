"use client";
// The end date as the Protocol thinks of it, a length of time (R1.1). A choice of terms sets the
// date; "Custom" opens the exact day for anyone who needs one. The rules record the date.
import { useEffect, useId, useState } from "react";

const TERMS = [1, 3, 6];

/** The UTC day n months from today, as the date field writes it: "2027-02-07". Jan 31 plus a month is Feb 28, not Mar 3. */
export function monthsFromNow(n: number): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(now.getUTCDate(), last))).toISOString().slice(0, 10);
}

const spoken = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function EndDate({ value, onChange, onBlur, error }: { value: string; onChange: (day: string) => void; onBlur: () => void; error?: string }) {
  const id = useId();
  const [exact, setExact] = useState(false);
  // Set after mount, not in the first render, so the prerendered page never carries a stale date.
  useEffect(() => {
    if (!value) onChange(monthsFromNow(3));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const term = exact ? undefined : TERMS.find((n) => monthsFromNow(n) === value);
  return (
    <div className="field">
      <span id={`${id}-label`}>End date</span>
      <div className="term-opts" role="radiogroup" aria-labelledby={`${id}-label`}>
        {TERMS.map((n) => (
          <label key={n} className="term-opt">
            <input type="radio" name={`${id}-term`} checked={term === n} onChange={() => (setExact(false), onChange(monthsFromNow(n)))} />
            <span>{n === 1 ? "1 month" : `${n} months`}</span>
          </label>
        ))}
        <label className="term-opt">
          <input type="radio" name={`${id}-term`} checked={exact} onChange={() => setExact(true)} />
          <span>Custom</span>
        </label>
      </div>
      {exact && <input type="date" aria-label="Exact end date" value={value} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} autoFocus />}
      {error ? <small className="err">{error}</small> : value && <small>Ends {spoken(value)}, 23:59 UTC.</small>}
    </div>
  );
}
