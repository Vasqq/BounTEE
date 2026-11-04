//! BounTEE's judge. OutLayer's convention: the job's input is JSON on stdin, the result is
//! JSON on stdout (at most 900 bytes), secrets arrive as environment variables.
//!
//! Scaffold only (ticket #6): it answers every input with a verdict in the shared format.
//! Judging proper (R2.8, R3.8, R4.x) lands in the judge tickets.

use std::io::{Read, Write};

use bountee_formats::{to_json, Reason, Verdict};

fn main() {
    let mut input = String::new();
    // Unreadable input can't be an exploit the judge can run.
    let _ = std::io::stdin().read_to_string(&mut input);
    let verdict = judge(&input);
    let mut stdout = std::io::stdout();
    stdout
        .write_all(to_json(&verdict).as_bytes())
        .expect("stdout is writable");
    stdout.flush().expect("stdout flushes");
}

fn judge(_input: &str) -> Verdict {
    Verdict::new(Reason::MalformedExploit)
}
