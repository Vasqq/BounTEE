//! BounTEE's judge. OutLayer's convention: the job's input is JSON on stdin, the result is
//! JSON on stdout (at most 900 bytes), secrets arrive as environment variables.
//!
//! The job is a [`bountee_formats::Job`]:
//! - `replay`, a local run (R2.9): [`replay::judge`] against a recorded header and proofs.
//!   stderr names each read the claim doesn't prove (one `unproven …` line each), which
//!   `cli/src/proofs.ts` uses to fetch the missing proofs.
//! - `judge_claim`, the enclave (#14): [`claim::judge`] confirms the block through the
//!   pinned RPCs, then opens the sealed exploit ([`sealed::exploit`], #15) and replays
//!   it. Nothing is written to stderr.
//! - `posting_check`, the enclave (#17): [`posting::check`] simulates each covered
//!   contract's pause from the bounty's pause-role address and checks its pause gas,
//!   through the pinned RPCs. stdout is a `PostingCheckResult`; nothing goes to stderr.
//!
//! stdout carries only the verdict. A job that can't have a verdict (R2.6) exits with
//! status 2 and nothing on stdout: OutLayer reports it as a failed job, which reaches the
//! bounty contract's callback as `null`, so the claim stays pending with no verdict.

mod claim;
mod confirm;
mod header;
mod posting;
mod proofs;
mod replay;
mod rpc;
mod score;
mod sealed;
mod state;

use std::io::{Read, Write};

use bountee_formats::{from_json, to_json, Job, Reason, Verdict};
use serde::Serialize;

/// The exit status of a job with no verdict.
const NO_VERDICT: i32 = 2;

fn main() {
    let mut input = String::new();
    // Unreadable input can't be an exploit the judge can run.
    let _ = std::io::stdin().read_to_string(&mut input);
    let job = from_json::<Job>(&input);
    if is_enclave_job(&input) {
        // A panic's message would go to stderr; the abort still fails the job.
        std::panic::set_hook(Box::new(|_| {}));
    }
    let verdict = match job {
        // R3.11: a job that isn't well-formed carries no runnable exploit.
        Err(e) => {
            if !is_enclave_job(&input) {
                eprintln!("malformed: {e}");
            }
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
                    std::process::exit(NO_VERDICT);
                }
            }
        }
        Ok(Job::PostingCheck(job)) => return write(&posting::check(&job)),
        Ok(Job::JudgeClaim(job)) => {
            match claim::judge(&job, || sealed::exploit(&job.whitehat)) {
                Ok(verdict) => verdict,
                Err(_) => std::process::exit(NO_VERDICT),
            }
        }
    };
    write(&verdict);
}

/// Write the job's answer, and nothing else, to stdout.
fn write<T: Serialize>(answer: &T) {
    let mut stdout = std::io::stdout();
    stdout
        .write_all(to_json(answer).as_bytes())
        .expect("stdout is writable");
    stdout.flush().expect("stdout flushes");
}

/// Whether `input` is meant as an enclave job, so even its parse error stays off stderr.
fn is_enclave_job(input: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(input)
        .map(|v| v.get("judge_claim").is_some() || v.get("posting_check").is_some())
        .unwrap_or(false)
}
