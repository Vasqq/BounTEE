//! BounTEE's judge. OutLayer's convention: the job's input is JSON on stdin, the result is
//! JSON on stdout (at most 900 bytes), secrets arrive as environment variables.
//!
//! The job is a [`bountee_formats::Job`]. Today the only action is a local replay (R2.9):
//! the enclave's claim-judging action (#14 block confirmation, #15 the sealed exploit)
//! joins it and reuses [`replay::judge`].
//!
//! stdout carries only the verdict. In a local replay, stderr names each read the claim
//! doesn't prove (one `unproven …` line each), which `cli/src/proofs.ts` uses to fetch the
//! missing proofs. A job that can't have a verdict exits non-zero with nothing on stdout.

mod header;
mod proofs;
mod replay;
mod score;
mod state;

use std::io::{Read, Write};

use bountee_formats::{from_json, to_json, Job, Reason, Verdict};

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
    };
    let mut stdout = std::io::stdout();
    stdout
        .write_all(to_json(&verdict).as_bytes())
        .expect("stdout is writable");
    stdout.flush().expect("stdout flushes");
}
