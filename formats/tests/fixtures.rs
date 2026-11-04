//! Ticket #6: the rules (R1.1), claim and verdict formats parse and write back unchanged,
//! and refuse what they must. The TypeScript side runs the same cases from the same file.

use bountee_formats::{from_json, to_json, BountyId, Claim, Exploit, Job, Rules, Verdict};
use serde_json::Value;

fn cases() -> Value {
    serde_json::from_str(include_str!("../fixtures/cases.json")).unwrap()
}

/// Parse `value` as `kind` and write it back, or say why it was refused.
fn round_trip(kind: &str, value: &Value) -> Result<Value, String> {
    fn go<T: serde::de::DeserializeOwned + serde::Serialize>(v: &Value) -> Result<Value, String> {
        let parsed: T = from_json(&v.to_string()).map_err(|e| e.to_string())?;
        Ok(serde_json::from_str(&to_json(&parsed)).unwrap())
    }
    match kind {
        "rules" => go::<Rules>(value),
        "claim" => go::<Claim>(value),
        "verdict" => go::<Verdict>(value),
        "bounty_id" => go::<BountyId>(value),
        "exploit" => go::<Exploit>(value),
        "job" => go::<Job>(value),
        other => panic!("unknown kind {other}"),
    }
}

#[test]
fn valid_values_round_trip_unchanged() {
    for case in cases()["valid"].as_array().unwrap() {
        let kind = case["kind"].as_str().unwrap();
        let out = round_trip(kind, &case["value"]).unwrap_or_else(|e| panic!("{kind} {case}: {e}"));
        assert_eq!(out, case["value"], "{kind} {}", case["note"]);
    }
}

#[test]
fn invalid_values_are_refused() {
    for case in cases()["invalid"].as_array().unwrap() {
        let kind = case["kind"].as_str().unwrap();
        assert!(
            round_trip(kind, &case["value"]).is_err(),
            "accepted: {}",
            case["note"]
        );
    }
}

#[test]
fn r1_1_rules_refuse_each_invalid_edit() {
    let cases = cases();
    let base = cases["valid"][0]["value"].clone();
    for edit in cases["invalid_rules_edits"].as_array().unwrap() {
        let mut rules = base.clone();
        apply_edit(&mut rules, edit["path"].as_array().unwrap(), &edit["value"]);
        assert!(
            round_trip("rules", &rules).is_err(),
            "accepted: {}",
            edit["note"]
        );
    }
}

/// Set the value at `path` (`null` removes the key).
fn apply_edit(target: &mut Value, path: &[Value], value: &Value) {
    let (last, parents) = path.split_last().unwrap();
    let mut at = target;
    for step in parents {
        at = match step {
            Value::String(k) => &mut at[k.as_str()],
            Value::Number(i) => &mut at[i.as_u64().unwrap() as usize],
            _ => unreachable!(),
        };
    }
    match last {
        Value::String(k) if value.is_null() => {
            at.as_object_mut().unwrap().remove(k);
        }
        Value::String(k) => at[k.as_str()] = value.clone(),
        Value::Number(i) => at[i.as_u64().unwrap() as usize] = value.clone(),
        _ => unreachable!(),
    }
}
