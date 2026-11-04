//! Test helper for the Rust ↔ TypeScript round trip (`formats/ts/test/roundtrip.test.ts`).
//! Reads one JSON request per line, `{"kind": ..., "value": ...}`, and answers each with
//! `{"ok": <value exactly as Rust writes it>}` or `{"err": "<why it was refused>"}`.

use std::io::{BufRead, Write};

use bountee_formats::{
    from_json, pause_role, to_json, AccountId, BountyId, BountyName, Claim, Exploit, Job, Rules,
    SealedBundle, Verdict,
};
use serde_json::{json, Value};

/// Parse as `T` and write back in Rust's own field order (not via `Value`, which sorts keys).
fn echo<T: serde::de::DeserializeOwned + serde::Serialize>(
    value: &Value,
) -> Result<String, String> {
    let parsed: T = from_json(&value.to_string()).map_err(|e| e.to_string())?;
    Ok(to_json(&parsed))
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn answer(request: &Value) -> Result<String, String> {
    let value = &request["value"];
    match text(&request["kind"]) {
        "rules" => echo::<Rules>(value),
        "claim" => echo::<Claim>(value),
        "verdict" => echo::<Verdict>(value),
        "exploit" => echo::<Exploit>(value),
        "job" => echo::<Job>(value),
        "sealed_bundle" => echo::<SealedBundle>(value),
        "bounty_id" => echo::<BountyId>(value),
        "account_id" => AccountId::parse(text(value))
            .map(|a| to_json(&a))
            .map_err(|e| e.0),
        "bounty_name" => BountyName::parse(text(value))
            .map(|n| to_json(&n))
            .map_err(|e| e.0),
        "pause_role_address" => {
            let contract = AccountId::parse(text(&value["bounty_contract"])).map_err(|e| e.0)?;
            let bounty: BountyId = from_json(&value["bounty"].to_string()).map_err(|e| e.0)?;
            pause_role::address(text(&value["root"]), &contract, &bounty)
                .map(|a| to_json(&a))
                .map_err(|e| e.0)
        }
        other => Err(format!("unknown kind {other:?}")),
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line)
            .map_err(|e| e.to_string())
            .and_then(|r| answer(&r))
        {
            Ok(raw) => format!("{{\"ok\":{raw}}}"),
            Err(e) => json!({ "err": e }).to_string(),
        };
        writeln!(stdout, "{reply}").unwrap();
    }
    stdout.flush().unwrap();
}
