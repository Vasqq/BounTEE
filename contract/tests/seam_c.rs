//! Seam C: the bounty contract's public actions in a local NEAR sandbox, with test
//! stand-ins for OutLayer, the MPC network and USDC (`tests/stand-ins/`).
//!
//! Add a C test with `Sandbox::start()`, then drive the contract through its public calls
//! and read back only what its public views (and the stand-ins' records) return.
//!
//! What seam C catches: every behaviour below as seen through the contract's own calls and
//! views; the exact job and secret requests it sends (as the OutLayer stand-in records
//! them); verdicts arriving only through OutLayer's callback; refunds through the token's
//! own resolve; payouts through a real NEP-141. What it misses: whether the real OutLayer,
//! MPC network and Circle USDC answer as the stand-ins do, and real gas and costs (seam T).

use near_workspaces::network::Sandbox as SandboxNet;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

const JUDGE_BUILD_HASH: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const JUDGE_WASM_URL: &str = "https://example.test/judge.wasm";
const SEED_NATIVE: &str = "1000000000000000000";
const BOUNTY_AMOUNT: u128 = 5_000_000_000; // 5,000 USDC
const SEALED: &str = "AXNlYWxlZCBleHBsb2l0IGNpcGhlcnRleHQ=";
const PROOFS: &str = r#"[{"address":"0x00000000000000000000000000000000000000aa"}]"#;

fn tgas(n: u64) -> Gas {
    Gas::from_tgas(n)
}

struct Sandbox {
    worker: Worker<SandboxNet>,
    contract: Contract,
    test_outlayer: Contract,
    test_mpc: Contract,
    test_usdc: Contract,
    protocol: Account,
    whitehat: Account,
    other: Account,
}

impl Sandbox {
    /// A sandbox with the stand-ins deployed and the bounty contract deployed, initialised
    /// and left keyless in one transaction, as the real deployment does (R2.1).
    async fn start() -> anyhow::Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;
        let account = |name: &'static str, near: u128| {
            let root = root.clone();
            async move {
                anyhow::Ok(
                    root.create_subaccount(name)
                        .initial_balance(NearToken::from_near(near))
                        .transact()
                        .await?
                        .into_result()?,
                )
            }
        };
        let deploy = |name: &'static str, path: &'static str| async move {
            let wasm = near_workspaces::compile_project(path).await?;
            anyhow::Ok(
                account(name, 20)
                    .await?
                    .deploy(&wasm)
                    .await?
                    .into_result()?,
            )
        };
        let test_outlayer = deploy("test-outlayer", "./tests/stand-ins/test-outlayer").await?;
        let test_mpc = deploy("test-mpc", "./tests/stand-ins/test-mpc").await?;
        let test_usdc = deploy("test-usdc", "./tests/stand-ins/test-usdc").await?;
        test_usdc.call("new").transact().await?.into_result()?;

        let wasm = near_workspaces::compile_project("./").await?;
        let bounty = account("bounty", 20).await?;
        let config = json!({
            "outlayer": test_outlayer.id(),
            "mpc": test_mpc.id(),
            "usdc": test_usdc.id(),
            "judge_build_hash": JUDGE_BUILD_HASH,
            "judge_wasm_url": JUDGE_WASM_URL,
            "seed": { "native": SEED_NATIVE, "tokens": [] },
        });
        bounty
            .batch(bounty.id())
            .deploy(&wasm)
            .call(
                Function::new("new")
                    .args_json(json!({ "config": config }))
                    .deposit(NearToken::from_millinear(125))
                    .gas(tgas(100)),
            )
            .delete_key(bounty.secret_key().public_key())
            .transact()
            .await?
            .into_result()?;
        let contract =
            Contract::from_secret_key(bounty.id().clone(), bounty.secret_key().clone(), &worker);

        let protocol = account("protocol", 30).await?;
        let whitehat = account("whitehat", 30).await?;
        let other = account("other", 30).await?;
        test_usdc
            .call("mint")
            .args_json(
                json!({ "account_id": protocol.id(), "amount": (10 * BOUNTY_AMOUNT).to_string() }),
            )
            .transact()
            .await?
            .into_result()?;
        Ok(Self {
            worker,
            contract,
            test_outlayer,
            test_mpc,
            test_usdc,
            protocol,
            whitehat,
            other,
        })
    }

    async fn view(&self, method: &str, args: Value) -> anyhow::Result<Value> {
        Ok(self.contract.view(method).args_json(args).await?.json()?)
    }

    async fn usdc_balance(&self, id: &AccountId) -> anyhow::Result<u128> {
        let v: String = self
            .test_usdc
            .view("ft_balance_of")
            .args_json(json!({ "account_id": id }))
            .await?
            .json()?;
        Ok(v.parse()?)
    }

    async fn fees(&self) -> anyhow::Result<Value> {
        self.view("fees", json!({})).await
    }

    async fn fee(&self, name: &str) -> anyhow::Result<NearToken> {
        let v = self.fees().await?;
        Ok(NearToken::from_yoctonear(
            v[name].as_str().unwrap().parse()?,
        ))
    }

    /// Queue the OutLayer stand-in's answer for the next job request.
    async fn script(&self, answer: Value) -> anyhow::Result<()> {
        self.test_outlayer
            .call("script")
            .args_json(json!({ "answer": answer }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn requests(&self) -> anyhow::Result<Vec<Value>> {
        Ok(self.test_outlayer.view("requests").await?.json()?)
    }

    /// Prepay `amount` of posting fees, plus what a first deposit's balance entry costs.
    async fn prepay_posting_fee(&self, by: &Account, amount: NearToken) -> anyhow::Result<()> {
        self.prepay_exactly(by, amount.saturating_add(NearToken::from_millinear(5)))
            .await
    }

    async fn prepay_exactly(&self, by: &Account, amount: NearToken) -> anyhow::Result<()> {
        by.call(self.contract.id(), "prepay_posting_fee")
            .deposit(amount)
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// The bounty amount as one USDC transfer-and-call carrying the rules.
    async fn transfer_call(
        &self,
        by: &Account,
        amount: u128,
        msg: &Value,
        gas: Gas,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(by
            .call(self.test_usdc.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": self.contract.id(),
                "amount": amount.to_string(),
                "msg": msg.to_string(),
            }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(gas)
            .transact()
            .await?)
    }

    /// Post a bounty the usual way: prepay the fee, then the transfer-and-call; the posting
    /// check's job is answered at once.
    async fn post(&self, name: &str, rules: &Value) -> anyhow::Result<ExecutionFinalResult> {
        self.prepay_posting_fee(&self.protocol, self.fee("posting_fee").await?)
            .await?;
        self.script(json!({ "output": "{}" })).await?;
        let amount: u128 = rules["bounty_amount"].as_str().unwrap().parse()?;
        self.transfer_call(
            &self.protocol,
            amount,
            &json!({ "name": name, "rules": rules }),
            tgas(270),
        )
        .await
    }

    async fn bounty(&self, name: &str) -> anyhow::Result<Value> {
        self.view(
            "bounty",
            json!({ "id": { "protocol": self.protocol.id(), "name": name } }),
        )
        .await
    }

    async fn top_up(&self, by: &Account, amount: NearToken) -> anyhow::Result<()> {
        by.call(self.contract.id(), "top_up_claim_balance")
            .deposit(amount)
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn claim_balance(&self, id: &AccountId) -> anyhow::Result<u128> {
        let v = self
            .view("claim_balance", json!({ "account_id": id }))
            .await?;
        Ok(v.as_str().unwrap().parse()?)
    }

    fn claim_args(&self, name: &str) -> Value {
        json!({
            "bounty": { "protocol": self.protocol.id(), "name": name },
            "block": { "number": 1234, "hash": format!("0x{}", "ab".repeat(32)) },
            "header": "0xf90200",
            "proofs": PROOFS,
            "sealed_exploit": SEALED,
        })
    }

    /// File a claim and wait for every receipt (the job's answer must already be scripted).
    async fn submit_claim(&self, by: &Account, name: &str) -> anyhow::Result<ExecutionFinalResult> {
        Ok(by
            .call(self.contract.id(), "submit_claim")
            .args_json(self.claim_args(name))
            .gas(tgas(300))
            .transact()
            .await?)
    }

    async fn claim(&self, id: u64) -> anyhow::Result<Value> {
        self.view("claim", json!({ "claim_id": id })).await
    }
}

fn rules(s: &Sandbox, end_in_ns: u64, now_ns: u64) -> Value {
    let _ = s;
    json!({
        "covered_contracts": [
            { "chain_id": 84532, "address": "0x00000000000000000000000000000000000000aa" },
        ],
        "proof_chain": 84532,
        "recency_limit_secs": 300,
        "listed_tokens": [
            { "token": "native", "price": "1" },
            { "token": "0x00000000000000000000000000000000000000bb", "price": "1000000000000" },
        ],
        "seed": { "native": SEED_NATIVE, "tokens": [] },
        "bounty_amount": BOUNTY_AMOUNT.to_string(),
        "minimum_theft": "1000000000000000000",
        "end_date_ns": (now_ns + end_in_ns).to_string(),
        "disclosure_delay_days": 30,
        "exploit_public_key": "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f",
        "judge_build_hash": JUDGE_BUILD_HASH,
    })
}

const DAY_NS: u64 = 86_400_000_000_000;

async fn now_ns(s: &Sandbox) -> anyhow::Result<u64> {
    Ok(s.worker.view_block().await?.timestamp())
}

async fn valid_rules(s: &Sandbox) -> anyhow::Result<Value> {
    Ok(rules(s, 30 * DAY_NS, now_ns(s).await?))
}

/// R1.1, R1.2: a posting records every rule, including the seed and judge build hash set
/// by BounTEE, and the bounty reads them back unchanged.
#[tokio::test]
async fn posting_records_every_rule_and_returns_them_unchanged() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let rules = valid_rules(&s).await?;
    s.post("demo-vault-1", &rules).await?.into_result()?;

    let bounty = s.bounty("demo-vault-1").await?;
    assert_eq!(bounty["rules"], rules);
    assert_eq!(bounty["state"], "live");
    assert_eq!(
        bounty["id"],
        json!({ "protocol": s.protocol.id(), "name": "demo-vault-1" })
    );
    // The USDC is held by the contract.
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);
    Ok(())
}

// ---- helpers for claims and refusals ----

const PAYS: &str = r#"{"outcome":"PAYS","reason":"minimum_theft_reached"}"#;
const ZERO: &str = r#"{"outcome":"ZERO","reason":"below_minimum_theft"}"#;
const INVALID: &str = r#"{"outcome":"INVALID","reason":"malformed_exploit"}"#;

/// The panic messages a refused call left in its receipts.
fn failure_text(r: &ExecutionFinalResult) -> String {
    format!("{:?}", r.receipt_failures())
}

/// A live bounty and a Whitehat with a topped-up claim balance.
async fn live_bounty(name: &str) -> anyhow::Result<Sandbox> {
    let s = Sandbox::start().await?;
    let rules = valid_rules(&s).await?;
    s.post(name, &rules).await?.into_result()?;
    s.top_up(&s.whitehat, NearToken::from_near(1)).await?;
    Ok(s)
}

impl Sandbox {
    async fn free_balance(&self) -> anyhow::Result<u128> {
        let a = self.worker.view_account(self.contract.id()).await?;
        Ok(a.balance.as_yoctonear() - a.storage_usage as u128 * 10_000_000_000_000_000_000)
    }

    async fn wait_for_requests(&self, n: usize) -> anyhow::Result<Vec<Value>> {
        for _ in 0..100 {
            let r = self.requests().await?;
            if r.len() >= n {
                return Ok(r);
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        anyhow::bail!("the job was never requested")
    }

    async fn wait_for_claim_state(&self, id: u64, state: &str) -> anyhow::Result<()> {
        for _ in 0..100 {
            if self.claim(id).await?["state"] == state {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        anyhow::bail!("claim {id} never reached {state}")
    }

    async fn resolve(&self, request_id: u64, output: Option<&str>) -> anyhow::Result<()> {
        self.test_outlayer
            .call("resolve")
            .args_json(json!({ "request_id": request_id, "output": output }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn sign_requests(&self) -> anyhow::Result<Vec<String>> {
        Ok(self.test_mpc.view("sign_requests").await?.json()?)
    }
}

/// R1.3: the judge build is fixed at deployment, and a posting naming another is refused.
#[tokio::test]
async fn a_posting_naming_another_judge_build_is_refused() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let config = s.view("config", json!({})).await?;
    assert_eq!(config["judge_build_hash"], JUDGE_BUILD_HASH);

    let mut rules = valid_rules(&s).await?;
    rules["judge_build_hash"] = json!(format!("0x{}", "22".repeat(32)));
    let before = s.usdc_balance(s.protocol.id()).await?;
    let r = s.post("other-judge", &rules).await?;
    assert!(failure_text(&r).contains("another judge build"), "{r:?}");
    assert_eq!(s.bounty("other-judge").await?, Value::Null);
    assert_eq!(s.usdc_balance(s.protocol.id()).await?, before);
    Ok(())
}

/// R1.4: missing or invalid rules are refused, and the USDC goes back.
#[tokio::test]
async fn missing_or_invalid_rules_are_refused() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let now = now_ns(&s).await?;
    let before = s.usdc_balance(s.protocol.id()).await?;
    type Change = Box<dyn Fn(&mut Value)>;
    let cases: Vec<(&str, Change, &str)> = vec![
        (
            "zero-theft",
            Box::new(|r| r["minimum_theft"] = json!("0")),
            "minimum theft",
        ),
        (
            "past-end",
            Box::new(move |r| r["end_date_ns"] = json!((now - 1).to_string())),
            "end date",
        ),
        (
            "delay-0",
            Box::new(|r| r["disclosure_delay_days"] = json!(0)),
            "disclosure delay",
        ),
        (
            "delay-91",
            Box::new(|r| r["disclosure_delay_days"] = json!(91)),
            "disclosure delay",
        ),
        (
            "no-contract",
            Box::new(|r| r["covered_contracts"] = json!([])),
            "cover at least one",
        ),
        (
            "no-token",
            Box::new(|r| r["listed_tokens"] = json!([])),
            "list at least one",
        ),
        (
            "no-key",
            Box::new(|r| {
                r.as_object_mut().unwrap().remove("exploit_public_key");
            }),
            "invalid posting",
        ),
        (
            "recency",
            Box::new(|r| r["recency_limit_secs"] = json!(3600)),
            "recency",
        ),
        (
            "own-seed",
            Box::new(|r| r["seed"]["native"] = json!("5")),
            "seed",
        ),
    ];
    for (name, change, expected) in cases {
        let mut rules = rules(&s, 30 * DAY_NS, now);
        change(&mut rules);
        let r = s.post(name, &rules).await?;
        assert!(failure_text(&r).contains(expected), "{name}: {r:?}");
        assert_eq!(s.bounty(name).await?, Value::Null, "{name}");
    }
    assert_eq!(s.usdc_balance(s.protocol.id()).await?, before);
    assert_eq!(s.usdc_balance(s.contract.id()).await?, 0);
    Ok(())
}

/// R1.5: a posting without the full USDC amount is refused, and no funds are accepted for
/// a bounty after it is posted. Also the posting shape: a posting left with less than
/// 100 Tgas is refused, so the token refunds it.
#[tokio::test]
async fn only_the_full_amount_is_accepted_and_nothing_after_posting() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let rules = valid_rules(&s).await?;
    let start = s.usdc_balance(s.protocol.id()).await?;
    let msg = json!({ "name": "short", "rules": rules });
    s.prepay_posting_fee(&s.protocol, s.fee("posting_fee").await?)
        .await?;

    let r = s
        .transfer_call(&s.protocol, BOUNTY_AMOUNT - 1, &msg, tgas(270))
        .await?;
    assert!(failure_text(&r).contains("full bounty amount"), "{r:?}");
    let r = s
        .transfer_call(&s.protocol, BOUNTY_AMOUNT + 1, &msg, tgas(270))
        .await?;
    assert!(failure_text(&r).contains("full bounty amount"), "{r:?}");
    let r = s
        .transfer_call(&s.protocol, BOUNTY_AMOUNT, &msg, tgas(90))
        .await?;
    assert!(failure_text(&r).contains("100 Tgas"), "{r:?}");
    assert_eq!(s.bounty("short").await?, Value::Null);
    assert_eq!(s.usdc_balance(s.protocol.id()).await?, start);

    s.post("posted", &rules).await?.into_result()?;
    let again = json!({ "name": "posted", "rules": rules });
    s.prepay_posting_fee(&s.protocol, s.fee("posting_fee").await?)
        .await?;
    let r = s
        .transfer_call(&s.protocol, BOUNTY_AMOUNT, &again, tgas(270))
        .await?;
    assert!(
        failure_text(&r).contains("takes no funds after it is posted"),
        "{r:?}"
    );
    // Only USDC's own contract can deliver a posting.
    let fake = json!({ "name": "fake", "rules": rules }).to_string();
    let r = s
        .other
        .call(s.contract.id(), "ft_on_transfer")
        .args_json(
            json!({ "sender_id": s.other.id(), "amount": BOUNTY_AMOUNT.to_string(), "msg": fake }),
        )
        .gas(tgas(300))
        .transact()
        .await?;
    assert!(failure_text(&r).contains("only USDC"), "{r:?}");
    assert_eq!(s.bounty("fake").await?, Value::Null);
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);
    assert_eq!(
        s.usdc_balance(s.protocol.id()).await?,
        start - BOUNTY_AMOUNT
    );
    Ok(())
}

/// R11.4: a posting without the prepaid posting fee is refused; the fee is spent on the
/// posting and never refunded; the contract's own balance never pays a bounty's or claim's
/// costs.
#[tokio::test]
async fn a_posting_needs_the_prepaid_fee_and_the_contract_never_spends_its_own_balance(
) -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let free_at_start = s.free_balance().await?;
    let rules = valid_rules(&s).await?;
    let msg = json!({ "name": "unpaid", "rules": rules });
    let r = s
        .transfer_call(&s.protocol, BOUNTY_AMOUNT, &msg, tgas(270))
        .await?;
    assert!(failure_text(&r).contains("prepay the posting fee"), "{r:?}");
    let fee = s.fee("posting_fee").await?;
    let short = fee.saturating_sub(NearToken::from_yoctonear(1));
    s.prepay_exactly(&s.protocol, short).await?;
    let r = s
        .transfer_call(&s.protocol, BOUNTY_AMOUNT, &msg, tgas(270))
        .await?;
    assert!(failure_text(&r).contains("prepay the posting fee"), "{r:?}");
    assert_eq!(s.bounty("unpaid").await?, Value::Null);

    // Topping up to the full fee lets the posting through, and the fee is used up.
    s.post("paid", &rules).await?.into_result()?;
    let left = s
        .view(
            "posting_fee_balance",
            json!({ "account_id": s.protocol.id() }),
        )
        .await?;
    // What's left is both deposits, less one posting fee and the balance entry's storage
    // (the second deposit carried 5 milliNEAR for that); nothing came back.
    let left: u128 = left.as_str().unwrap().parse()?;
    let margin = NearToken::from_millinear(5).as_yoctonear();
    assert!(
        left > short.as_yoctonear() && left < short.as_yoctonear() + margin,
        "{left}"
    );

    // A deposit too small to pay for its own balance entry is refused, not paid for.
    for method in ["prepay_posting_fee", "top_up_claim_balance"] {
        let r = s
            .other
            .call(s.contract.id(), method)
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?;
        assert!(
            failure_text(&r).contains("doesn't cover the storage"),
            "{method}: {r:?}"
        );
    }

    // A whole claim, judged PAYS and paid, costs the contract nothing of its own.
    s.top_up(&s.whitehat, NearToken::from_near(1)).await?;
    s.script(json!({ "output": PAYS })).await?;
    s.submit_claim(&s.whitehat, "paid").await?.into_result()?;
    assert_eq!(s.bounty("paid").await?["state"], "paid");
    let free_at_end = s.free_balance().await?;
    assert!(
        free_at_end >= free_at_start,
        "{free_at_end} < {free_at_start}"
    );
    Ok(())
}

/// R2.1: the contract account holds no access keys after deployment.
#[tokio::test]
async fn the_contract_account_is_keyless() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let keys = s.worker.view_access_keys(s.contract.id()).await?;
    assert!(keys.is_empty(), "{keys:?}");
    // It still works without keys: a posting goes live.
    s.post("keyless", &valid_rules(&s).await?)
        .await?
        .into_result()?;
    assert_eq!(s.bounty("keyless").await?["state"], "live");
    Ok(())
}

/// R11.1, R11.2: a claim draws its replay fee and storage deposit from the claim balance,
/// which must cover it; its sealed exploit is stored once as its own secret, and its job is
/// requested on submission with that secret.
#[tokio::test]
async fn a_claim_draws_from_the_claim_balance_and_requests_its_job_at_once() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    s.post("vault", &valid_rules(&s).await?)
        .await?
        .into_result()?;

    // No balance, then too little: refused, no job.
    let jobs_before = s.requests().await?.len();
    let r = s.submit_claim(&s.whitehat, "vault").await?;
    assert!(failure_text(&r).contains("can't cover"), "{r:?}");
    s.top_up(&s.whitehat, NearToken::from_millinear(20)).await?;
    let r = s.submit_claim(&s.whitehat, "vault").await?;
    assert!(failure_text(&r).contains("can't cover"), "{r:?}");
    assert_eq!(s.requests().await?.len(), jobs_before);

    s.top_up(&s.whitehat, NearToken::from_near(1)).await?;
    let balance = s.claim_balance(s.whitehat.id()).await?;
    s.script(json!({ "output": ZERO })).await?;
    let id: u64 = s
        .submit_claim(&s.whitehat, "vault")
        .await?
        .into_result()?
        .json()?;
    let claim = s.claim(id).await?;
    assert_eq!(claim["state"], "judged");
    assert_eq!(claim["whitehat"], json!(s.whitehat.id()));

    let job = s.requests().await?.pop().unwrap();
    assert_eq!(job["predecessor"], json!(s.contract.id()));
    let source: Value = serde_json::from_str(job["source"].as_str().unwrap())?;
    assert_eq!(
        source,
        json!({ "WasmUrl": { "url": JUDGE_WASM_URL, "hash": &JUDGE_BUILD_HASH[2..], "build_target": "wasm32-wasip2" } })
    );
    let secrets_ref: Value = serde_json::from_str(job["secrets_ref"].as_str().unwrap())?;
    let profile = claim["secret_profile"].as_str().unwrap();
    assert_eq!(
        secrets_ref,
        json!({ "profile": profile, "account_id": s.contract.id() })
    );
    let input: Value = serde_json::from_str(job["input_data"].as_str().unwrap())?;
    assert_eq!(input["judge_claim"]["proofs_json"], PROOFS);
    assert_eq!(input["judge_claim"]["whitehat"], json!(s.whitehat.id()));
    assert_eq!(
        input["judge_claim"]["submitted_at_ns"],
        claim["submitted_at_ns"]
    );
    assert!(
        !input.to_string().contains(SEALED),
        "the sealed exploit is never in the input"
    );

    let secret: Value = s
        .test_outlayer
        .view("secret")
        .args_json(json!({ "owner": s.contract.id(), "profile": profile }))
        .await?
        .json()?;
    assert_eq!(secret["encrypted_secrets_base64"], SEALED);
    assert_eq!(secret["stores"], 1);
    let access: Value = serde_json::from_str(secret["access"].as_str().unwrap())?;
    assert_eq!(
        access,
        json!({ "Logic": { "operator": "And", "conditions": [
            { "WasmHash": { "hash": &JUDGE_BUILD_HASH[2..] } },
            { "Predecessor": { "condition": { "Whitelist": { "accounts": [s.contract.id()] } } } },
        ] } })
    );

    // What was drawn is the job deposit plus the secret's deposit plus the claim's storage.
    let job_deposit: u128 = job["deposit"].as_str().unwrap().parse()?;
    let secret_deposit: u128 = secret["deposit"].as_str().unwrap().parse()?;
    let drawn = balance - s.claim_balance(s.whitehat.id()).await?;
    assert!(job_deposit > 0 && secret_deposit > 0);
    assert!(
        drawn > job_deposit + secret_deposit,
        "the claim's own storage is drawn too"
    );
    assert!(drawn < job_deposit + secret_deposit + NearToken::from_millinear(10).as_yoctonear());
    Ok(())
}

/// R11.2, R2.2: two claims' jobs are both requested at submission, neither waiting for the
/// other; a verdict from anyone but OutLayer's contract is refused; each claim's exploit is
/// its own secret, stored once.
#[tokio::test]
async fn jobs_are_requested_at_once_and_only_outlayer_delivers_verdicts() -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    let jobs_before = s.requests().await?.len();
    let mut pending_txs = Vec::new();
    for _ in 0..2 {
        pending_txs.push(
            s.whitehat
                .call(s.contract.id(), "submit_claim")
                .args_json(s.claim_args("vault"))
                .gas(tgas(300))
                .transact_async()
                .await?,
        );
    }
    let jobs = s.wait_for_requests(jobs_before + 2).await?;
    let pending: Vec<&Value> = jobs[jobs_before..].iter().collect();
    assert!(
        pending.iter().all(|j| j["resolved"] == false),
        "both jobs wait on OutLayer"
    );

    // Anyone else calling the verdict callback is refused, and nothing changes.
    for id in [0u64, 1] {
        let r = s
            .other
            .call(s.contract.id(), "on_claim_judged")
            .args_json(json!({ "claim_id": id, "job_deposit": "0" }))
            .gas(tgas(100))
            .transact()
            .await?;
        assert!(!r.is_success());
        assert_eq!(s.claim(id).await?["state"], "judging");
    }
    assert_eq!(s.bounty("vault").await?["state"], "live");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);

    // OutLayer answers the second claim first, then the first.
    s.resolve(pending[1]["id"].as_u64().unwrap(), Some(ZERO))
        .await?;
    s.resolve(pending[0]["id"].as_u64().unwrap(), Some(INVALID))
        .await?;
    for tx in pending_txs {
        tx.await?.into_result()?;
    }
    // The transactions report done before their callbacks run; wait for the verdicts.
    for id in [0u64, 1] {
        s.wait_for_claim_state(id, "judged").await?;
    }
    let verdicts = [
        s.claim(0).await?["verdict"].clone(),
        s.claim(1).await?["verdict"].clone(),
    ];
    assert!(verdicts.contains(&serde_json::from_str(ZERO)?));
    assert!(verdicts.contains(&serde_json::from_str(INVALID)?));

    let rows: Vec<(String, u32)> = s.test_outlayer.view("secret_rows").await?.json()?;
    let ours: Vec<&(String, u32)> = rows
        .iter()
        .filter(|(k, _)| k.starts_with(&format!("{}/", s.contract.id())))
        .collect();
    assert_eq!(ours.len(), 2, "{rows:?}");
    assert!(ours.iter().all(|(_, stores)| *stores == 1), "{rows:?}");
    Ok(())
}

/// R3.1, R3.2, R2.7, D9, R1.2: PAYS pays the whole bounty to a Whitehat never registered
/// with USDC, with no allowlist, and closes the bounty; the rules read back unchanged.
#[tokio::test]
async fn pays_pays_the_whole_amount_to_an_unregistered_account() -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    let rules = s.bounty("vault").await?["rules"].clone();
    let registered: Value = s
        .test_usdc
        .view("storage_balance_of")
        .args_json(json!({ "account_id": s.whitehat.id() }))
        .await?
        .json()?;
    assert_eq!(registered, Value::Null, "the Whitehat starts unregistered");

    s.script(json!({ "output": PAYS })).await?;
    let id: u64 = s
        .submit_claim(&s.whitehat, "vault")
        .await?
        .into_result()?
        .json()?;
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, BOUNTY_AMOUNT);
    assert_eq!(s.usdc_balance(s.contract.id()).await?, 0);
    let bounty = s.bounty("vault").await?;
    assert_eq!(bounty["state"], "paid");
    assert_eq!(bounty["winning_claim"], id);
    assert_eq!(bounty["rules"], rules);
    Ok(())
}

/// R3.3: ZERO and INVALID move nothing and request no signature.
#[tokio::test]
async fn zero_and_invalid_move_nothing_and_request_no_signature() -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    for verdict in [ZERO, INVALID] {
        s.script(json!({ "output": verdict })).await?;
        let id: u64 = s
            .submit_claim(&s.whitehat, "vault")
            .await?
            .into_result()?
            .json()?;
        assert_eq!(
            s.claim(id).await?["verdict"],
            serde_json::from_str::<Value>(verdict)?
        );
    }
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, 0);
    assert_eq!(s.bounty("vault").await?["state"], "live");
    assert!(s.sign_requests().await?.is_empty());
    Ok(())
}

/// The sealing decision for #12 (spike #1; R2.6 is verified in #18): a job that comes back
/// `null`, or a request OutLayer refuses, gives no verdict and moves nothing.
#[tokio::test]
async fn a_null_or_failed_job_gives_no_verdict() -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    s.script(json!({ "output": null })).await?;
    let id: u64 = s
        .submit_claim(&s.whitehat, "vault")
        .await?
        .into_result()?
        .json()?;
    let claim = s.claim(id).await?;
    assert_eq!(claim["state"], "no_verdict");
    assert_eq!(claim["verdict"], Value::Null);

    let balance = s.claim_balance(s.whitehat.id()).await?;
    s.script(json!({ "fail": true })).await?;
    let id: u64 = s
        .submit_claim(&s.whitehat, "vault")
        .await?
        .into_result()?
        .json()?;
    assert_eq!(s.claim(id).await?["state"], "no_verdict");
    // OutLayer refused the request, so its deposit is back in the claim balance.
    let job_deposit = s.fee("job_deposit").await?.as_yoctonear();
    let drawn = balance - s.claim_balance(s.whitehat.id()).await?;
    assert!(
        drawn < job_deposit,
        "the job deposit came back: drew {drawn}"
    );

    assert_eq!(s.bounty("vault").await?["state"], "live");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);
    Ok(())
}

/// R3.4: after a payout every later claim is refused without replaying it.
#[tokio::test]
async fn after_a_payout_later_claims_are_refused_without_replay() -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    s.script(json!({ "output": PAYS })).await?;
    s.submit_claim(&s.whitehat, "vault").await?.into_result()?;
    let jobs = s.requests().await?.len();
    let rows: Vec<(String, u32)> = s.test_outlayer.view("secret_rows").await?.json()?;

    s.top_up(&s.other, NearToken::from_near(1)).await?;
    for who in [&s.whitehat, &s.other] {
        let r = s.submit_claim(who, "vault").await?;
        assert!(failure_text(&r).contains("closed"), "{r:?}");
    }
    assert_eq!(s.requests().await?.len(), jobs, "no job was requested");
    let after: Vec<(String, u32)> = s.test_outlayer.view("secret_rows").await?.json()?;
    assert_eq!(after, rows, "no exploit was stored");
    Ok(())
}

/// R3.12: claims on a bounty whose posting check hasn't passed are refused.
#[tokio::test]
async fn claims_wait_for_the_posting_check() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    s.top_up(&s.whitehat, NearToken::from_near(1)).await?;
    s.prepay_posting_fee(&s.protocol, s.fee("posting_fee").await?)
        .await?;
    let rules = valid_rules(&s).await?;
    // No answer scripted: the posting check's job stays pending.
    let posting = s
        .protocol
        .call(s.test_usdc.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": s.contract.id(),
            "amount": BOUNTY_AMOUNT.to_string(),
            "msg": json!({ "name": "checking", "rules": rules }).to_string(),
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(tgas(270))
        .transact_async()
        .await?;
    let jobs = s.wait_for_requests(1).await?;
    assert_eq!(s.bounty("checking").await?["state"], "checking");

    let r = s.submit_claim(&s.whitehat, "checking").await?;
    assert!(
        failure_text(&r).contains("posting check hasn't passed"),
        "{r:?}"
    );
    assert_eq!(s.requests().await?.len(), jobs.len());

    s.resolve(jobs[0]["id"].as_u64().unwrap(), Some("{}"))
        .await?;
    posting.await?.into_result()?;
    assert_eq!(s.bounty("checking").await?["state"], "live");
    Ok(())
}

/// R1.1 (the seed BounTEE sets): the seed is native coin only, because the judge gives no
/// verdict for a seed holding an ERC-20; a deployment naming one is refused.
#[tokio::test]
async fn a_deployment_with_an_erc20_seed_is_refused() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let wasm = near_workspaces::compile_project("./").await?;
    let root = s.worker.root_account()?;
    let second = root
        .create_subaccount("bounty2")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let mut config = s.view("config", json!({})).await?;
    config["seed"]["tokens"] =
        json!([{ "token": "0x00000000000000000000000000000000000000bb", "amount": "1" }]);
    let r = second
        .batch(second.id())
        .deploy(&wasm)
        .call(
            Function::new("new")
                .args_json(json!({ "config": config }))
                .deposit(NearToken::from_millinear(125))
                .gas(tgas(100)),
        )
        .transact()
        .await?;
    assert!(failure_text(&r).contains("native coin only"), "{r:?}");
    Ok(())
}

// ---- Ticket #15: sealing ---------------------------------------------------------------
//
// Seam C here: the contract's public record of a ZERO or INVALID claim, and the access rule
// it stores (R5.7 is also asserted in
// `a_claim_draws_from_the_claim_balance_and_requests_its_job_at_once` and
// `the_contract_account_is_keyless`). Misses: whether real OutLayer enforces the rule (T).

/// R5.5, R5.7: a ZERO or INVALID claim records publicly only its one coarse reason: the claim
/// view and every event carry the verdict and nothing more, never the sealed exploit, even
/// if the job's output held more than a verdict; the sealed exploit is kept only as the
/// contract's own secret, under the rule naming the pinned build and the contract.
#[tokio::test]
async fn r5_5_r5_7_a_failed_claim_records_only_its_coarse_reason() -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    let leaky = r#"{"outcome":"ZERO","reason":"below_minimum_theft","gain":"99999"}"#;
    for (output, recorded) in [
        (ZERO, Some(ZERO)),
        (INVALID, Some(INVALID)),
        (leaky, None),
    ] {
        s.script(json!({ "output": output })).await?;
        let r = s.submit_claim(&s.whitehat, "vault").await?;
        let logs = r.logs().join("\n");
        let id: u64 = r.into_result()?.json()?;
        let claim = s.claim(id).await?;
        let public = format!("{claim}\n{logs}");
        assert!(!public.contains(SEALED), "the sealed exploit is not published");
        assert!(!public.contains("99999"), "nothing beyond the coarse reason");
        match recorded {
            Some(verdict) => {
                assert_eq!(claim["verdict"], serde_json::from_str::<Value>(verdict)?);
                assert_eq!(claim["verdict"].as_object().unwrap().len(), 2);
            }
            None => assert_eq!(claim["state"], "no_verdict", "{claim}"),
        }
        let secret: Value = s
            .test_outlayer
            .view("secret")
            .args_json(json!({ "owner": s.contract.id(), "profile": claim["secret_profile"] }))
            .await?
            .json()?;
        let access: Value = serde_json::from_str(secret["access"].as_str().unwrap())?;
        assert_eq!(
            access,
            json!({ "Logic": { "operator": "And", "conditions": [
                { "WasmHash": { "hash": &JUDGE_BUILD_HASH[2..] } },
                { "Predecessor": { "condition": { "Whitelist": { "accounts": [s.contract.id()] } } } },
            ] } })
        );
    }
    assert!(s.worker.view_access_keys(s.contract.id()).await?.is_empty());
    Ok(())
}
