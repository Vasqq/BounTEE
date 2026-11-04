//! BounTEE's judge. OutLayer's convention: the job's input is JSON on stdin, the result is
//! JSON on stdout (at most 900 bytes), secrets arrive as environment variables.
//!
//! The job is a [`bountee_formats::Job`]: a local replay (R2.9), or the enclave's
//! `judge_claim`, which opens the sealed exploit ([`sealed::open`], #15) and replays it
//! (#14 adds block confirmation before the replay).
//!
//! stdout carries only the verdict. In a local replay, stderr names each read the claim
//! doesn't prove (one `unproven …` line each), which `cli/src/proofs.ts` uses to fetch the
//! missing proofs. A job that can't have a verdict exits non-zero with nothing on stdout.

mod header;
mod proofs;
mod replay;
mod score;
mod sealed;
mod state;

use std::io::{Read, Write};

use bountee_formats::{from_json, to_json, AccountProof, Job, JudgeClaim, Reason, Verdict};

fn main() {
    let mut input = String::new();
    // Unreadable input can't be an exploit the judge can run.
    let _ = std::io::stdin().read_to_string(&mut input);
    let verdict = match from_json::<Job>(&input) {
        // R3.11: a job that isn't well-formed carries no runnable exploit.
        Err(e) => {
            eprintln!("malformed: {e}");
            Verdict::new(Reason::MalformedExploit)
        }
        Ok(Job::Replay(job)) => {
            let mut diagnostics = |line: &dyn std::fmt::Display| eprintln!("{line}");
            match replay::judge(
                &job.rules,
                &job.block,
                &job.header,
                &job.proofs,
                &job.exploit,
                &mut diagnostics,
            ) {
                Ok(verdict) => verdict,
                Err(why) => {
                    eprintln!("no verdict: {why:?}");
                    std::process::exit(2);
                }
            }
        }
        Ok(Job::JudgeClaim(job)) => judge_claim(&job),
    };
    let mut stdout = std::io::stdout();
    stdout
        .write_all(to_json(&verdict).as_bytes())
        .expect("stdout is writable");
    stdout.flush().expect("stdout flushes");
}

/// The enclave's claim-judging action. Nothing but the verdict is ever written: no
/// diagnostics, so a ZERO or INVALID claim's exploit leaves no trace in the job's output
/// (R5.5). A job with no verdict exits non-zero with nothing written; OutLayer then reports
/// it failed and the bounty contract's callback receives `null` (R2.6).
fn judge_claim(job: &JudgeClaim) -> Verdict {
    let no_verdict = || -> ! { std::process::exit(3) };
    let exploit = match sealed::open(&job.whitehat) {
        Ok(exploit) => exploit,
        Err(sealed::NotOpened::Refused) => no_verdict(),
        Err(sealed::NotOpened::Invalid(reason)) => return Verdict::new(reason),
    };
    // R4.5: proofs that can't be read prove nothing.
    let Ok(proofs) = from_json::<Vec<AccountProof>>(&job.proofs_json) else {
        return Verdict::new(Reason::UnprovenState);
    };
    let mut silent = |_: &dyn std::fmt::Display| {};
    replay::judge(
        &job.rules,
        &job.block,
        &job.header,
        &proofs,
        &exploit,
        &mut silent,
    )
    .unwrap_or_else(|_| no_verdict())
}
