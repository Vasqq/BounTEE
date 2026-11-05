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
/// What every test sealed exploit starts with; each claim gets its own (see [`sealed`]).
const SEALED: &str = "AXNlYWxlZCBleHBsb2l0";
static SEALED_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A new sealed exploit ciphertext (base64), never filed before, so each claim is its own
/// exploit (R3.5 refuses the same one twice).
fn sealed() -> String {
    let n = SEALED_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{SEALED}{n:08}")
}
/// The judge's answer to a posting check that passed (`bountee_formats::PostingCheckResult`).
const PASSED: &str = r#"{"failures":[]}"#;
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
    /// The sandbox node, when the test started its own ([`Sandbox::start_with_days`]).
    _node: Option<near_sandbox::Sandbox>,
}

impl Sandbox {
    /// A sandbox with the stand-ins deployed and the bounty contract deployed, initialised
    /// and left keyless in one transaction, as the real deployment does (R2.1).
    async fn start() -> anyhow::Result<Self> {
        Self::start_on(near_workspaces::sandbox().await?, None).await
    }

    /// The same, on a sandbox node whose `fast_forward` moves the clock about 100 s per
    /// block, so a test can let days pass (the disclosure delay is at least one, D7). The
    /// node advances block time by the mean of its least and greatest block production
    /// delays per skipped block (nearcore's `sandbox_delta_time`); only the greatest is
    /// raised, which a single validator never waits for, so blocks still come as fast.
    async fn start_with_days() -> anyhow::Result<Self> {
        let node = near_sandbox::Sandbox::start_sandbox_with_config(near_sandbox::SandboxConfig {
            additional_accounts: vec![near_sandbox::GenesisAccount::default_with_name(
                "registrar".parse()?,
            )],
            additional_config: Some(json!({
                "consensus": { "max_block_production_delay": { "secs": 200, "nanos": 0 } },
            })),
            ..Default::default()
        })
        .await?;
        let worker = near_workspaces::sandbox()
            .rpc_addr(&node.rpc_addr)
            .validator_key(near_workspaces::network::ValidatorKey::HomeDir(
                node.home_dir.path().to_path_buf(),
            ))
            .await?;
        Self::start_on(worker, Some(node)).await
    }

    async fn start_on(
        worker: Worker<SandboxNet>,
        node: Option<near_sandbox::Sandbox>,
    ) -> anyhow::Result<Self> {
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
            "mpc_root_public_key": mpc::root_public_key(),
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
            _node: node,
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
        self.script(json!({ "output": PASSED })).await?;
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
            "sealed_exploit": sealed(),
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
        "exploit_public_key": "x25519:6W7B3sSYk1p2DZ7FXyRbJWDNiaRfVTj1hm6k8Cqnq6wA",
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

    async fn sign_requests(&self) -> anyhow::Result<Vec<Value>> {
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
    s.pay_claim("paid").await?;
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
    assert!(secret["encrypted_secrets_base64"]
        .as_str()
        .unwrap()
        .starts_with(SEALED));
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

    let id = s.pay_claim("vault").await?;
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
    s.pay_claim("vault").await?;
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

    s.resolve(jobs[0]["id"].as_u64().unwrap(), Some(PASSED))
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
    for (output, recorded) in [(ZERO, Some(ZERO)), (INVALID, Some(INVALID)), (leaky, None)] {
        s.script(json!({ "output": output })).await?;
        let r = s.submit_claim(&s.whitehat, "vault").await?;
        let logs = r.logs().join("\n");
        let id: u64 = r.into_result()?.json()?;
        let claim = s.claim(id).await?;
        let public = format!("{claim}\n{logs}");
        assert!(
            !public.contains(SEALED),
            "the sealed exploit is not published"
        );
        assert!(
            !public.contains("99999"),
            "nothing beyond the coarse reason"
        );
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

/// R11.2 (found on testnet in #15): a live claim's proofs run to ~120 KB of JSON; such a
/// claim's job is still requested and judged, not left `storing` because writing its large
/// job input overran the gas the callback kept back.
#[tokio::test]
async fn a_claim_with_live_sized_proofs_is_judged() -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    s.top_up(&s.whitehat, NearToken::from_near(3)).await?;
    s.script(json!({ "output": ZERO })).await?;
    let proof = json!({ "address": "0x00000000000000000000000000000000000000aa",
        "account_proof": vec![format!("0x{}", "ab".repeat(532)); 110] });
    let proofs = Value::Array(vec![proof; 1]).to_string();
    assert!(proofs.len() > 110_000, "{}", proofs.len());
    let mut args = s.claim_args("vault");
    args["proofs"] = Value::String(proofs);
    let id: u64 = s
        .whitehat
        .call(s.contract.id(), "submit_claim")
        .args_json(args)
        .gas(tgas(300))
        .transact()
        .await?
        .into_result()?
        .json()?;
    let claim = s.claim(id).await?;
    assert_eq!(claim["state"], "judged", "{claim}");
    Ok(())
}

// ---- pause signing (ticket #13) ----

/// The test side of the MPC stand-in: a known root key, the key the network derives from it
/// for (predecessor, path), and answers in the MPC network's own JSON.
mod mpc {
    use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
    use k256::elliptic_curve::sec1::ToEncodedPoint;
    use k256::elliptic_curve::PrimeField;
    use k256::Scalar;
    use serde_json::{json, Value};
    use sha3::{Digest, Keccak256, Sha3_256};

    const ROOT_SECRET: [u8; 32] = [7u8; 32];

    fn root() -> SigningKey {
        SigningKey::from_bytes(&ROOT_SECRET.into()).unwrap()
    }

    pub fn root_public_key() -> String {
        let point = root().verifying_key().to_encoded_point(false);
        format!(
            "secp256k1:{}",
            bs58::encode(&point.as_bytes()[1..]).into_string()
        )
    }

    /// The key the network signs with for `predecessor` and `path`: root + tweak.
    pub fn derived(predecessor: &str, path: &str) -> SigningKey {
        let digest: [u8; 32] = Sha3_256::digest(format!(
            "near-mpc-recovery v0.1.0 epsilon derivation:{predecessor},{path}"
        ))
        .into();
        let tweak = Scalar::from_repr(digest.into()).unwrap();
        let secret = *root().as_nonzero_scalar().as_ref() + tweak;
        SigningKey::from_bytes(&secret.to_repr()).unwrap()
    }

    /// A key that is not the bounty's.
    pub fn wrong() -> SigningKey {
        SigningKey::from_bytes(&[9u8; 32].into()).unwrap()
    }

    /// The MPC network's answer to a request for `payload_hex`, signed by `key`, with hex
    /// in upper case as the network's docs show it. With `high_s`, s is the other valid
    /// (non-EIP-2) half, as an unnormalised signer might send.
    pub fn answer(key: &SigningKey, payload_hex: &str, high_s: bool) -> Value {
        let hash = hex::decode(payload_hex).unwrap();
        let (sig, recid): (Signature, RecoveryId) = key.sign_prehash_recoverable(&hash).unwrap();
        let s = if high_s {
            -*sig.s().as_ref()
        } else {
            *sig.s().as_ref()
        };
        let big_r = format!(
            "{}{}",
            if recid.is_y_odd() { "03" } else { "02" },
            hex::encode(sig.r().to_repr())
        );
        json!({
            "scheme": "Secp256k1",
            "big_r": { "affine_point": big_r.to_uppercase() },
            "s": { "scalar": hex::encode(s.to_repr()).to_uppercase() },
            "recovery_id": recid.to_byte(),
        })
    }

    fn keccak(b: &[u8]) -> [u8; 32] {
        Keccak256::digest(b).into()
    }

    /// Who signed a type-2 transaction decoded by `cast decode-transaction`: its signing
    /// hash is rebuilt with `cast to-rlp` from the decoded fields, then recovered.
    pub fn sender(decoded: &Value) -> String {
        let num = |k: &str| {
            let v = u128::from_str_radix(&decoded[k].as_str().unwrap()[2..], 16).unwrap();
            if v == 0 {
                "0x".to_owned()
            } else {
                let h = format!("{v:x}");
                format!("0x{}{h}", if h.len() % 2 == 1 { "0" } else { "" })
            }
        };
        let fields = json!([
            num("chainId"),
            num("nonce"),
            num("maxPriorityFeePerGas"),
            num("maxFeePerGas"),
            num("gas"),
            decoded["to"],
            num("value"),
            decoded["input"],
            []
        ]);
        let rlp = super::cast(&["to-rlp", &fields.to_string()]);
        let mut payload = vec![0x02];
        payload.extend(hex::decode(rlp.trim().trim_start_matches("0x")).unwrap());
        let hash = keccak(&payload);
        let sig = Signature::from_slice(
            &hex::decode(super::word(&decoded["r"]) + &super::word(&decoded["s"])).unwrap(),
        )
        .unwrap();
        let parity = u8::from_str_radix(&decoded["yParity"].as_str().unwrap()[2..], 16).unwrap();
        let key =
            VerifyingKey::recover_from_prehash(&hash, &sig, RecoveryId::from_byte(parity).unwrap())
                .unwrap();
        let point = key.to_encoded_point(false);
        format!("0x{}", hex::encode(&keccak(&point.as_bytes()[1..])[12..]))
    }
}

/// A decoded 256-bit value as 64 hex digits.
fn word(v: &Value) -> String {
    format!("{:0>64}", v.as_str().unwrap().trim_start_matches("0x"))
}

/// Half the secp256k1 group order: an EIP-2 signature's s is at most this.
const HALF_ORDER: &str = "7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0";

/// Run Foundry's `cast`, an EVM decoder independent of the contract's own encoder.
fn cast(args: &[&str]) -> String {
    let out = std::process::Command::new("cast")
        .args(args)
        .output()
        .expect("cast (Foundry) on PATH");
    assert!(
        out.status.success(),
        "cast {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

/// The D25 pause-role address, derived by the shared formats crate, not the contract.
fn pause_role_address(s: &Sandbox, name: &str) -> String {
    let bounty = bountee_formats::BountyId {
        protocol: bountee_formats::AccountId::parse(s.protocol.id().as_str()).unwrap(),
        name: bountee_formats::BountyName::parse(name).unwrap(),
    };
    let contract = bountee_formats::AccountId::parse(s.contract.id().as_str()).unwrap();
    bountee_formats::pause_role::address(&mpc::root_public_key(), &contract, &bounty)
        .unwrap()
        .to_string()
}

type Pending = near_workspaces::operations::TransactionStatus;

impl Sandbox {
    async fn wait_for_sign_requests(&self, n: usize) -> anyhow::Result<Vec<Value>> {
        for _ in 0..150 {
            let r = self.sign_requests().await?;
            if r.len() >= n {
                return Ok(r);
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        anyhow::bail!(
            "only {} sign requests arrived",
            self.sign_requests().await?.len()
        )
    }

    async fn respond(&self, index: usize, response: Value) -> anyhow::Result<()> {
        self.test_mpc
            .call("respond")
            .args_json(json!({ "index": index, "response": response }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// Answer the requests from index `from` on, each signed by `key`.
    async fn answer_from(
        &self,
        requests: &[Value],
        from: usize,
        key: &k256::ecdsa::SigningKey,
        high_s: bool,
    ) -> anyhow::Result<()> {
        for (i, r) in requests.iter().enumerate().skip(from) {
            let request: Value = serde_json::from_str(r["request"].as_str().unwrap())?;
            let payload = request["payload_v2"]["Ecdsa"].as_str().unwrap();
            self.respond(i, mpc::answer(key, payload, high_s)).await?;
        }
        Ok(())
    }

    fn pause_key(&self, name: &str) -> k256::ecdsa::SigningKey {
        mpc::derived(
            self.contract.id().as_str(),
            &format!("{}/{name}", self.protocol.id()),
        )
    }

    /// Anyone retries the pause signing, without waiting for its receipts.
    async fn sign_pauses(&self, name: &str) -> anyhow::Result<Pending> {
        Ok(self
            .other
            .call(self.contract.id(), "sign_pauses")
            .args_json(json!({ "id": { "protocol": self.protocol.id(), "name": name } }))
            .gas(tgas(300))
            .transact_async()
            .await?)
    }

    /// A claim that scores PAYS, submitted without waiting for its receipts.
    async fn submit_pays(&self, name: &str) -> anyhow::Result<Pending> {
        self.script(json!({ "output": PAYS })).await?;
        Ok(self
            .whitehat
            .call(self.contract.id(), "submit_claim")
            .args_json(self.claim_args(name))
            .gas(tgas(300))
            .transact_async()
            .await?)
    }

    /// A claim by the Whitehat that scores PAYS, its pauses signed by the MPC stand-in with
    /// the bounty's own key, and paid. Returns the claim's ID.
    async fn pay_claim(&self, name: &str) -> anyhow::Result<u64> {
        let id = self.judge_pays(name).await?;
        self.wait_for_bounty_state(name, "paid").await?;
        Ok(id)
    }

    /// A claim by the Whitehat that scores PAYS, its pauses signed by the MPC stand-in with
    /// the bounty's own key; the payout is started. Returns the claim's ID.
    async fn judge_pays(&self, name: &str) -> anyhow::Result<u64> {
        let before = self.sign_requests().await?.len();
        let covered = self.bounty(name).await?["rules"]["covered_contracts"]
            .as_array()
            .unwrap()
            .len();
        let claim = self.submit_pays(name).await?;
        let requests = self.wait_for_sign_requests(before + covered).await?;
        self.answer_from(&requests, before, &self.pause_key(name), false)
            .await?;
        let id: u64 = claim.await?.into_result()?.json()?;
        Ok(id)
    }

    async fn wait_for_bounty_state(&self, name: &str, state: &str) -> anyhow::Result<Value> {
        for _ in 0..150 {
            let b = self.bounty(name).await?;
            if b["state"] == state {
                return Ok(b);
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        anyhow::bail!(
            "bounty {name} never reached {state}: {}",
            self.bounty(name).await?
        )
    }

    /// The bounty is closed with its PAYS claim waiting: nothing paid, nothing stored,
    /// and no other claim can take its place.
    async fn assert_waiting(&self, name: &str, claim_id: u64) -> anyhow::Result<()> {
        let bounty = self.bounty(name).await?;
        assert_eq!(bounty["state"], "signing", "{bounty}");
        assert_eq!(bounty["winning_claim"], claim_id);
        assert_eq!(bounty["signed_pauses"], json!([]));
        assert_eq!(self.usdc_balance(self.whitehat.id()).await?, 0);
        assert_eq!(self.usdc_balance(self.contract.id()).await?, BOUNTY_AMOUNT);
        let r = self.submit_claim(&self.other, name).await?;
        assert!(failure_text(&r).contains("closed"), "{r:?}");
        Ok(())
    }
}

/// R7.1, R7.2, R8.1, R2.4, R7.11, D25: on PAYS a pause is signed for every covered contract
/// on every chain, each from the bounty's pause-role address, each calling only `pause()`
/// on its contract with the chain ID signed, all stored before the payout; the payout then
/// goes through with no EVM chain involved at all.
#[tokio::test]
async fn pays_signs_every_pause_from_the_pause_role_address_and_then_pays() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let mut rules = valid_rules(&s).await?;
    rules["covered_contracts"] = json!([
        { "chain_id": 84532, "address": "0x00000000000000000000000000000000000000aa" },
        { "chain_id": 84532, "address": "0x00000000000000000000000000000000000000cc" },
        { "chain_id": 421614, "address": "0x00000000000000000000000000000000000000aa" },
    ]);
    s.post("vault", &rules).await?.into_result()?;
    s.top_up(&s.whitehat, NearToken::from_near(1)).await?;
    let role = pause_role_address(&s, "vault");
    let view = s
        .view(
            "pause_role",
            json!({ "id": { "protocol": s.protocol.id(), "name": "vault" } }),
        )
        .await?;
    assert_eq!(
        view["address"], role,
        "D25: the same address the formats derive"
    );

    let claim = s.submit_pays("vault").await?;
    let requests = s.wait_for_sign_requests(3).await?;
    // Nothing is paid while the pauses are unsigned.
    assert_eq!(s.bounty("vault").await?["state"], "signing");
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, 0);
    for r in &requests {
        assert_eq!(r["predecessor"], s.contract.id().as_str());
        assert_eq!(r["deposit"], "1");
        let request: Value = serde_json::from_str(r["request"].as_str().unwrap())?;
        assert_eq!(request["path"], format!("{}/vault", s.protocol.id()));
        assert_eq!(request["domain_id"], 0);
    }
    // The first answer has a high s, which the contract must make low (EIP-2).
    let key = s.pause_key("vault");
    s.answer_from(&requests[..1], 0, &key, true).await?;
    s.answer_from(&requests, 1, &key, false).await?;
    let id: u64 = claim.await?.into_result()?.json()?;
    // The yields resume in later receipts than the claim's own transaction.
    s.wait_for_bounty_state("vault", "paid").await?;

    let bounty = s.bounty("vault").await?;
    assert_eq!(bounty["state"], "paid");
    assert_eq!(bounty["winning_claim"], id);
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, BOUNTY_AMOUNT);
    let pauses = bounty["signed_pauses"].as_array().unwrap();
    assert_eq!(pauses.len(), 3);
    let expected = [(84532, "aa", 0), (84532, "cc", 1), (421614, "aa", 0)];
    for (p, (chain, to, nonce)) in pauses.iter().zip(expected) {
        let raw = p["tx"].as_str().unwrap();
        let tx: Value = serde_json::from_str(&cast(&["decode-transaction", raw]))?;
        assert_eq!(tx["type"], "0x2");
        assert_eq!(tx["chainId"], format!("{:#x}", chain));
        assert_eq!(tx["to"], format!("0x{}{to}", "0".repeat(38)));
        assert_eq!(tx["input"], "0x8456cb59", "pause() and nothing else");
        assert_eq!(tx["value"], "0x0");
        assert_eq!(tx["accessList"], json!([]));
        assert_eq!(tx["nonce"], format!("{:#x}", nonce));
        assert_eq!(tx["hash"], p["tx_hash"]);
        assert!(word(&tx["s"]).as_str() <= HALF_ORDER, "low s: {}", tx["s"]);
        assert_eq!(mpc::sender(&tx), role, "signed from the pause-role address");
    }
    Ok(())
}

/// D1, R7.1: a bounty covering Base Sepolia and Arbitrum Sepolia, with Base as its proof
/// chain. A claim is ONE judge job, carrying the rules with that one proof chain and the
/// claim's block on it, with nothing asked of the other chain; its PAYS verdict signs a
/// pause for the covered contract on each chain, each for its own chain ID with that
/// chain's first nonce, before the payout.
#[tokio::test]
async fn d1_a_two_chain_bounty_is_judged_once_on_its_proof_chain_and_pauses_both_chains(
) -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let mut rules = valid_rules(&s).await?;
    rules["covered_contracts"] = json!([
        { "chain_id": 84532, "address": "0x00000000000000000000000000000000000000aa" },
        { "chain_id": 421614, "address": "0x00000000000000000000000000000000000000dd" },
    ]);
    s.post("vault", &rules).await?.into_result()?;
    s.top_up(&s.whitehat, NearToken::from_near(1)).await?;
    let jobs_before = s.requests().await?.len();

    let id = s.pay_claim("vault").await?;

    let jobs = s.requests().await?;
    assert_eq!(jobs.len(), jobs_before + 1, "one job for the claim");
    let input: Value = serde_json::from_str(jobs.last().unwrap()["input_data"].as_str().unwrap())?;
    let judged = &input["judge_claim"];
    assert_eq!(judged["rules"]["proof_chain"], 84532);
    assert_eq!(judged["rules"]["covered_contracts"], rules["covered_contracts"]);
    assert_eq!(judged["block"], s.claim_args("vault")["block"]);

    let bounty = s.bounty("vault").await?;
    assert_eq!(bounty["state"], "paid");
    assert_eq!(bounty["winning_claim"], id);
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, BOUNTY_AMOUNT);
    let role = pause_role_address(&s, "vault");
    let signed: Vec<(String, String, String)> = bounty["signed_pauses"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let tx: Value =
                serde_json::from_str(&cast(&["decode-transaction", p["tx"].as_str().unwrap()]))
                    .unwrap();
            assert_eq!(mpc::sender(&tx), role, "signed from the pause-role address");
            assert_eq!(tx["input"], "0x8456cb59");
            (
                tx["chainId"].as_str().unwrap().to_owned(),
                tx["to"].as_str().unwrap().to_owned(),
                tx["nonce"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let to = |b: &str| format!("0x{}{b}", "0".repeat(38));
    assert_eq!(
        signed,
        vec![
            ("0x14a34".to_owned(), to("aa"), "0x0".to_owned()),
            ("0x66eee".to_owned(), to("dd"), "0x0".to_owned()),
        ]
    );
    Ok(())
}

impl Sandbox {
    /// Wait until no pause signing is under way, and return the bounty.
    async fn wait_until_not_signing(&self, name: &str) -> anyhow::Result<Value> {
        for _ in 0..300 {
            let b = self.bounty(name).await?;
            if b["signing_pauses"] == false {
                return Ok(b);
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        anyhow::bail!("pause signing never finished: {}", self.bounty(name).await?)
    }

    async fn sign_request_payload(&self, index: usize) -> anyhow::Result<String> {
        let requests = self.wait_for_sign_requests(index + 1).await?;
        let request: Value = serde_json::from_str(requests[index]["request"].as_str().unwrap())?;
        Ok(request["payload_v2"]["Ecdsa"].as_str().unwrap().to_owned())
    }
}

/// R2.5: when signing fails (an answer from the wrong key, a malformed answer, a failed
/// `sign`), the PAYS claim stays the bounty's winner, unpaid with nothing stored, no other
/// claim takes its place, and anyone can retry until every pause is signed; then it pays.
#[tokio::test]
async fn a_failed_signing_keeps_the_claim_waiting_in_its_place_until_a_retry() -> anyhow::Result<()>
{
    let s = live_bounty("vault").await?;
    let r = s.sign_pauses("vault").await?.await?;
    assert!(failure_text(&r).contains("no pauses waiting"), "{r:?}");

    let claim = s.submit_pays("vault").await?;
    // An answer from the wrong key.
    let payload = s.sign_request_payload(0).await?;
    s.respond(0, mpc::answer(&mpc::wrong(), &payload, false))
        .await?;
    let id: u64 = claim.await?.into_result()?.json()?;
    s.wait_until_not_signing("vault").await?;
    s.assert_waiting("vault", id).await?;

    // A malformed answer; a second retry while one is under way is refused.
    let retry = s.sign_pauses("vault").await?;
    s.sign_request_payload(1).await?;
    let r = s.sign_pauses("vault").await?.await?;
    assert!(failure_text(&r).contains("already under way"), "{r:?}");
    s.respond(
        1,
        json!({ "scheme": "Secp256k1", "big_r": { "affine_point": "02" },
                "s": { "scalar": "00" }, "recovery_id": 0 }),
    )
    .await?;
    retry.await?;
    s.wait_until_not_signing("vault").await?;
    s.assert_waiting("vault", id).await?;

    // `sign` itself fails.
    s.test_mpc
        .call("fail_next_sign")
        .transact()
        .await?
        .into_result()?;
    s.sign_pauses("vault").await?.await?;
    s.wait_until_not_signing("vault").await?;
    s.assert_waiting("vault", id).await?;

    // A retry signed with the bounty's key pays the same claim.
    let retry = s.sign_pauses("vault").await?;
    let payload = s.sign_request_payload(2).await?;
    s.respond(2, mpc::answer(&s.pause_key("vault"), &payload, false))
        .await?;
    retry.await?.into_result()?;
    let bounty = s.wait_for_bounty_state("vault", "paid").await?;
    assert_eq!(bounty["winning_claim"], id);
    assert_eq!(bounty["signed_pauses"].as_array().unwrap().len(), 1);
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, BOUNTY_AMOUNT);
    Ok(())
}

/// R2.5: a signature request nobody answers times out; the claim waits unpaid in its
/// place, and a retry pays it.
#[tokio::test]
async fn a_timed_out_signing_keeps_the_claim_waiting_until_a_retry() -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    let claim = s.submit_pays("vault").await?;
    s.sign_request_payload(0).await?;
    // NEAR times a yield out after 200 blocks.
    s.worker.fast_forward(250).await?;
    let id: u64 = claim.await?.into_result()?.json()?;
    s.wait_until_not_signing("vault").await?;
    s.assert_waiting("vault", id).await?;

    let retry = s.sign_pauses("vault").await?;
    let payload = s.sign_request_payload(1).await?;
    s.respond(1, mpc::answer(&s.pause_key("vault"), &payload, false))
        .await?;
    retry.await?.into_result()?;
    s.wait_for_bounty_state("vault", "paid").await?;
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, BOUNTY_AMOUNT);
    Ok(())
}

/// R2.5: a signing callback arriving after its request went stale and a retry started
/// can't clear the retry's in-flight flag, so no second retry can run beside it; the retry
/// then pays the same claim.
#[tokio::test]
async fn a_stale_signing_callback_leaves_the_newer_request_in_flight() -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    let claim = s.submit_pays("vault").await?;
    s.sign_request_payload(0).await?;
    // Hold the first request open past the contract's stale limit (300 blocks); each
    // deferral lasts one yield (200 blocks).
    let defer = json!({ "stand_in_defer": true });
    s.respond(0, defer.clone()).await?;
    s.worker.fast_forward(150).await?;
    s.respond(0, defer).await?;
    s.worker.fast_forward(160).await?;
    assert_eq!(s.bounty("vault").await?["signing_pauses"], false, "stale");

    let retry = s.sign_pauses("vault").await?;
    let payload = s.sign_request_payload(1).await?;
    assert_eq!(s.bounty("vault").await?["signing_pauses"], true);
    // The stale request's answer arrives now, and its callback runs within a few blocks.
    let stale = s.sign_request_payload(0).await?;
    s.respond(0, mpc::answer(&mpc::wrong(), &stale, false))
        .await?;
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    assert_eq!(
        s.bounty("vault").await?["signing_pauses"],
        true,
        "the retry is still in flight"
    );
    let r = s.sign_pauses("vault").await?.await?;
    assert!(failure_text(&r).contains("already under way"), "{r:?}");

    s.respond(1, mpc::answer(&s.pause_key("vault"), &payload, false))
        .await?;
    retry.await?.into_result()?;
    let id: u64 = claim.await?.into_result()?.json()?;
    let bounty = s.wait_for_bounty_state("vault", "paid").await?;
    assert_eq!(bounty["winning_claim"], id);
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, BOUNTY_AMOUNT);
    Ok(())
}

/// D25: the pause-role address can be computed before posting, and a Protocol can't
/// reuse a bounty name: the second posting is refused and its USDC goes back.
#[tokio::test]
async fn a_protocol_cannot_reuse_a_bounty_name() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let view = s
        .view(
            "pause_role",
            json!({ "id": { "protocol": s.protocol.id(), "name": "vault" } }),
        )
        .await?;
    assert_eq!(view["address"], pause_role_address(&s, "vault"));
    assert_eq!(view["path"], format!("{}/vault", s.protocol.id()));

    let rules = valid_rules(&s).await?;
    s.post("vault", &rules).await?.into_result()?;
    let usdc = s.usdc_balance(s.protocol.id()).await?;
    let again = s.post("vault", &rules).await?;
    assert!(failure_text(&again).contains("already used"), "{again:?}");
    assert_eq!(s.usdc_balance(s.protocol.id()).await?, usdc, "refunded");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);
    Ok(())
}

// ---- payout retry (code review of #12) ----

impl Sandbox {
    /// `by` retries the payout of `name`, without waiting for its receipts.
    async fn retry_payout(&self, by: &Account, name: &str) -> anyhow::Result<Pending> {
        Ok(by
            .call(self.contract.id(), "retry_payout")
            .args_json(json!({ "id": { "protocol": self.protocol.id(), "name": name } }))
            .gas(tgas(100))
            .transact_async()
            .await?)
    }

    async fn refuse_transfers(&self, refuse: bool) -> anyhow::Result<()> {
        self.test_usdc
            .call("refuse_transfers")
            .args_json(json!({ "refuse": refuse }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// Wait until no payout transfer is under way, and return the bounty.
    async fn wait_until_not_paying_out(&self, name: &str) -> anyhow::Result<Value> {
        for _ in 0..150 {
            let b = self.bounty(name).await?;
            if b["paying_out"] == false {
                return Ok(b);
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        anyhow::bail!("the payout never finished: {}", self.bounty(name).await?)
    }
}

/// R2.4, R2.3: a PAYS payout whose USDC transfer fails leaves the bounty `paying` with its
/// USDC held. Anyone may retry it; a retry re-sends the same amount to the winning
/// Whitehat only (never to the caller), and pays exactly once: two retries at once, and a
/// retry after the payout, move nothing more, even with another bounty's USDC held.
#[tokio::test]
async fn a_failed_payout_transfer_is_retried_to_the_same_winner_exactly_once() -> anyhow::Result<()>
{
    let s = live_bounty("vault").await?;
    // A second bounty, on another contract (R12.3: one live bounty per covered contract).
    let mut other_rules = valid_rules(&s).await?;
    other_rules["covered_contracts"][0]["address"] =
        json!("0x00000000000000000000000000000000000000ab");
    s.post("vault-2", &other_rules).await?.into_result()?;
    let held = 2 * BOUNTY_AMOUNT;
    assert_eq!(s.usdc_balance(s.contract.id()).await?, held);
    let r = s.retry_payout(&s.other, "vault").await?.await?;
    assert!(failure_text(&r).contains("no payout waiting"), "{r:?}");

    s.refuse_transfers(true).await?;
    let id = s.judge_pays("vault").await?;
    s.wait_for_bounty_state("vault", "paying").await?;
    let bounty = s.wait_until_not_paying_out("vault").await?;
    assert_eq!(bounty["state"], "paying", "{bounty}");
    assert_eq!(bounty["winning_claim"], id);
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, 0);
    assert_eq!(s.usdc_balance(s.contract.id()).await?, held);

    // A retry while the token still refuses fails the same way and leaves it retryable.
    let _ = s.retry_payout(&s.other, "vault").await?.await?;
    let bounty = s.wait_until_not_paying_out("vault").await?;
    assert_eq!(bounty["state"], "paying", "{bounty}");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, held);

    // Two retries at once, by two other accounts: the winner is paid once.
    s.refuse_transfers(false).await?;
    let a = s.retry_payout(&s.other, "vault").await?;
    let b = s.retry_payout(&s.protocol, "vault").await?;
    let _ = a.await?;
    let _ = b.await?;
    let bounty = s.wait_for_bounty_state("vault", "paid").await?;
    s.wait_until_not_paying_out("vault").await?;
    assert_eq!(bounty["winning_claim"], id);
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, BOUNTY_AMOUNT);
    assert_eq!(s.usdc_balance(s.other.id()).await?, 0);
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);

    let r = s.retry_payout(&s.other, "vault").await?.await?;
    assert!(failure_text(&r).contains("no payout waiting"), "{r:?}");
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, BOUNTY_AMOUNT);
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);
    assert_eq!(s.bounty("vault-2").await?["state"], "live");
    Ok(())
}

/// R11.4 (code review of #12): a payout retry draws the winner's USDC registration and the
/// transfer's yoctoNEAR from the bounty's posting fee. Retried again and again against a
/// token that refuses, the posting fee runs out; then a retry is refused unless its caller
/// attaches the shortfall, so the contract's own balance pays for none of them.
#[tokio::test]
async fn r11_4_repeated_payout_retries_never_take_the_contracts_own_balance(
) -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let free_at_start = s.free_balance().await?;
    s.post("vault", &valid_rules(&s).await?).await?.into_result()?;
    s.top_up(&s.whitehat, NearToken::from_near(1)).await?;
    s.refuse_transfers(true).await?;
    s.judge_pays("vault").await?;
    s.wait_for_bounty_state("vault", "paying").await?;
    s.wait_until_not_paying_out("vault").await?;

    // The posting fee (0.5 NEAR) covers a few dozen 0.0125 NEAR retries at most.
    let mut refused = None;
    for n in 0..60 {
        let r = s.retry_payout(&s.other, "vault").await?.await?;
        if r.is_failure() {
            refused = Some(failure_text(&r));
            break;
        }
        s.wait_until_not_paying_out("vault").await?;
        let free = s.free_balance().await?;
        assert!(free >= free_at_start, "retry {n}: {free} < {free_at_start}");
    }
    let refused = refused.expect("the retries never ran out of the posting fee");
    assert!(refused.contains("can't pay for the payout: attach"), "{refused}");
    assert_eq!(s.bounty("vault").await?["state"], "paying");

    // A caller who attaches the shortfall pays for the retry, and the winner is paid.
    s.refuse_transfers(false).await?;
    s.other
        .call(s.contract.id(), "retry_payout")
        .args_json(json!({ "id": { "protocol": s.protocol.id(), "name": "vault" } }))
        .deposit(NearToken::from_millinear(20))
        .gas(tgas(100))
        .transact()
        .await?
        .into_result()?;
    s.wait_for_bounty_state("vault", "paid").await?;
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, BOUNTY_AMOUNT);
    let free = s.free_balance().await?;
    assert!(free >= free_at_start, "{free} < {free_at_start}");
    Ok(())
}

// ---- pause verification (ticket #21) ----
//
// Seam C with the MPC stand-in's `verify_foreign_transaction`. The expected payload hash is
// computed here from the spec's byte layout ("Verify a pause"), not by the contract's code.

/// sha256(00 | chain byte | tx_id | 00000000 | 01 (Safe) | 00000000), as the spec lays it out.
fn expected_payload_hash(chain_byte: u8, tx_hash: &str) -> String {
    use sha2::Digest;
    let mut bytes = vec![0u8, chain_byte];
    bytes.extend(hex::decode(tx_hash.trim_start_matches("0x")).unwrap());
    bytes.extend([0, 0, 0, 0, 1, 0, 0, 0, 0]);
    hex::encode(sha2::Sha256::digest(&bytes))
}

/// The MPC network's answer to a verification request, in its own JSON.
fn verified_answer(payload_hash: &str) -> Value {
    json!({
        "payload_hash": payload_hash,
        "signature": {
            "scheme": "Secp256k1",
            "big_r": { "affine_point": format!("03{}", "ca".repeat(32)) },
            "s": { "scalar": "03".repeat(32) },
            "recovery_id": 0,
        },
    })
}

impl Sandbox {
    async fn verify_requests(&self) -> anyhow::Result<Vec<Value>> {
        Ok(self.test_mpc.view("verify_requests").await?.json()?)
    }

    async fn wait_for_verify_requests(&self, n: usize) -> anyhow::Result<Vec<Value>> {
        for _ in 0..150 {
            let r = self.verify_requests().await?;
            if r.len() >= n {
                return Ok(r);
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        anyhow::bail!(
            "only {} verification requests arrived",
            self.verify_requests().await?.len()
        )
    }

    async fn respond_verify(&self, index: usize, response: Value) -> anyhow::Result<()> {
        self.test_mpc
            .call("respond_verify")
            .args_json(json!({ "index": index, "response": response }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// `by` asks for `chain`'s pause of `name` to be verified, with `extra` arguments merged
    /// in, attaching `deposit`; without waiting for its receipts.
    async fn verify_pause(
        &self,
        by: &Account,
        name: &str,
        chain: u64,
        extra: Value,
        deposit: NearToken,
    ) -> anyhow::Result<Pending> {
        let mut args = json!({
            "id": { "protocol": self.protocol.id(), "name": name },
            "chain_id": chain,
        });
        for (k, v) in extra.as_object().unwrap() {
            args[k] = v.clone();
        }
        Ok(by
            .call(self.contract.id(), "verify_pause")
            .args_json(args)
            .deposit(deposit)
            .gas(tgas(100))
            .transact_async()
            .await?)
    }

    /// The bounty's pause verifications, by chain ID.
    async fn verifications(
        &self,
        name: &str,
    ) -> anyhow::Result<std::collections::BTreeMap<u64, Value>> {
        let v = self
            .view(
                "pause_verifications",
                json!({ "id": { "protocol": self.protocol.id(), "name": name } }),
            )
            .await?;
        Ok(v.as_array()
            .unwrap()
            .iter()
            .map(|c| (c["chain_id"].as_u64().unwrap(), c.clone()))
            .collect())
    }

    /// Wait until `chain`'s verification of `name` is no longer under way, and return it.
    async fn wait_until_not_verifying(&self, name: &str, chain: u64) -> anyhow::Result<Value> {
        for _ in 0..300 {
            let v = self.verifications(name).await?[&chain].clone();
            if v["verifying"] == false {
                return Ok(v);
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        anyhow::bail!("verification of chain {chain} never finished")
    }

    /// The stored signed pauses' hashes on `chain`, without `0x`.
    async fn pause_hashes(&self, name: &str, chain: u64) -> anyhow::Result<Vec<String>> {
        let b = self.bounty(name).await?;
        Ok(b["signed_pauses"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["chain_id"] == chain)
            .map(|p| p["tx_hash"].as_str().unwrap().trim_start_matches("0x").to_owned())
            .collect())
    }
}

/// A paid bounty covering two contracts on Base Sepolia and one on Arbitrum Sepolia.
async fn paid_two_chain_bounty() -> anyhow::Result<Sandbox> {
    let s = Sandbox::start().await?;
    let mut rules = valid_rules(&s).await?;
    rules["covered_contracts"] = json!([
        { "chain_id": 84532, "address": "0x00000000000000000000000000000000000000aa" },
        { "chain_id": 84532, "address": "0x00000000000000000000000000000000000000cc" },
        { "chain_id": 421614, "address": "0x00000000000000000000000000000000000000aa" },
    ]);
    s.post("vault", &rules).await?.into_result()?;
    s.top_up(&s.whitehat, NearToken::from_near(1)).await?;
    s.pay_claim("vault").await?;
    Ok(s)
}

/// R7.10, R7.11: once a PAYS bounty is paid (with no verification at all), anyone can ask
/// for a chain's pause to be verified. The contract asks the MPC network about the hash of
/// each pause it stored for that chain, at `Safe` finality, never a hash the caller passes,
/// and pins the answer to the expected payload hash. Only when every one comes back with
/// that hash is the chain's pause recorded as verified; the payout is untouched by it.
#[tokio::test]
async fn a_landed_pause_is_verified_from_the_hash_of_the_stored_signed_pause() -> anyhow::Result<()>
{
    let s = paid_two_chain_bounty().await?;
    // R7.11: paid before any verification was requested.
    assert_eq!(s.bounty("vault").await?["state"], "paid");
    let v = s.verifications("vault").await?;
    assert_eq!(v.keys().copied().collect::<Vec<_>>(), vec![84532, 421614]);
    assert!(v.values().all(|c| c["verified"] == false), "{v:?}");

    // Anyone asks; a hash in the arguments is not the contract's to take.
    let junk = "11".repeat(32);
    let call = s
        .verify_pause(
            &s.other,
            "vault",
            84532,
            json!({ "tx_hash": junk }),
            NearToken::from_yoctonear(0),
        )
        .await?;
    let requests = s.wait_for_verify_requests(2).await?;
    let mut asked = Vec::new();
    for (i, r) in requests.iter().enumerate() {
        assert_eq!(r["predecessor"], s.contract.id().as_str());
        assert_eq!(r["deposit"], "1");
        let req: Value = serde_json::from_str(r["request"].as_str().unwrap())?;
        let tx_id = req["request"]["Base"]["tx_id"].as_str().unwrap().to_owned();
        assert_eq!(
            req,
            json!({
                "request": { "Base": { "tx_id": tx_id, "extractors": [], "finality": "Safe" } },
                "domain_id": 3,
                "payload_version": 1,
                "expected_payload_hash": expected_payload_hash(6, &tx_id),
            })
        );
        asked.push(tx_id.clone());
        s.respond_verify(i, verified_answer(&expected_payload_hash(6, &tx_id)))
            .await?;
    }
    let mut stored = s.pause_hashes("vault", 84532).await?;
    stored.sort();
    asked.sort();
    assert_eq!(asked, stored, "the stored pauses' hashes, never the caller's");
    call.await?.into_result()?;
    let v = s.wait_until_not_verifying("vault", 84532).await?;
    assert_eq!(v["verified"], true, "{v}");
    assert_eq!(s.verifications("vault").await?[&421614]["verified"], false);

    // Arbitrum's request names its own chain.
    let call = s
        .verify_pause(
            &s.protocol,
            "vault",
            421614,
            json!({}),
            NearToken::from_yoctonear(0),
        )
        .await?;
    let requests = s.wait_for_verify_requests(3).await?;
    let req: Value = serde_json::from_str(requests[2]["request"].as_str().unwrap())?;
    let tx_id = s.pause_hashes("vault", 421614).await?.remove(0);
    assert_eq!(req["request"]["Arbitrum"]["tx_id"], tx_id);
    assert_eq!(req["request"]["Arbitrum"]["finality"], "Safe");
    assert_eq!(req["expected_payload_hash"], expected_payload_hash(7, &tx_id));
    s.respond_verify(2, verified_answer(&expected_payload_hash(7, &tx_id)))
        .await?;
    call.await?.into_result()?;
    assert_eq!(
        s.wait_until_not_verifying("vault", 421614).await?["verified"],
        true
    );

    // R7.11: the payout is exactly as it was.
    assert_eq!(s.bounty("vault").await?["state"], "paid");
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, BOUNTY_AMOUNT);
    assert_eq!(s.usdc_balance(s.contract.id()).await?, 0);
    Ok(())
}

/// R7.10: a pause the MPC network doesn't vouch for is never recorded as verified: a request
/// that times out (a reverted, unknown or not-yet-safe transaction), an answer about another
/// payload, a garbled answer, and a chain where only one of its two pauses comes back. The
/// next request asks only about the pauses not yet verified; one request at a time per chain;
/// nothing can be verified before pauses are signed, nor on a chain the network can't check.
#[tokio::test]
async fn a_failed_or_missing_transaction_is_never_recorded_as_verified() -> anyhow::Result<()> {
    let none = NearToken::from_yoctonear(0);
    let s = live_bounty("vault").await?;
    let r = s
        .verify_pause(&s.other, "vault", 84532, json!({}), none)
        .await?
        .await?;
    assert!(failure_text(&r).contains("no signed pause"), "{r:?}");
    drop(s);

    let s = paid_two_chain_bounty().await?;
    let r = s
        .verify_pause(&s.other, "vault", 1, json!({}), none)
        .await?
        .await?;
    assert!(failure_text(&r).contains("can't verify this chain"), "{r:?}");
    let hashes = s.pause_hashes("vault", 84532).await?;

    // Nobody answers: both requests time out. A second request meanwhile is refused.
    let call = s
        .verify_pause(&s.other, "vault", 84532, json!({}), none)
        .await?;
    s.wait_for_verify_requests(2).await?;
    let r = s
        .verify_pause(&s.other, "vault", 84532, json!({}), none)
        .await?
        .await?;
    assert!(failure_text(&r).contains("already under way"), "{r:?}");
    s.worker.fast_forward(250).await?;
    call.await?.into_result()?;
    let v = s.wait_until_not_verifying("vault", 84532).await?;
    assert_eq!(v["verified"], false, "{v}");
    assert_eq!(v["verified_pauses"], json!([]));
    assert_eq!(v["attempts"], 1);

    // One answer is about another payload, the other is garbage.
    let call = s
        .verify_pause(&s.other, "vault", 84532, json!({}), none)
        .await?;
    s.wait_for_verify_requests(4).await?;
    let other_tx = "22".repeat(32);
    s.respond_verify(2, verified_answer(&expected_payload_hash(6, &other_tx)))
        .await?;
    s.respond_verify(3, json!({ "payload_hash": 7 })).await?;
    call.await?.into_result()?;
    let v = s.wait_until_not_verifying("vault", 84532).await?;
    assert_eq!(v["verified"], false, "{v}");
    assert_eq!(v["verified_pauses"], json!([]));

    // One of the two is verified, the other times out: the chain is not verified.
    let call = s
        .verify_pause(&s.other, "vault", 84532, json!({}), none)
        .await?;
    let requests = s.wait_for_verify_requests(6).await?;
    let req: Value = serde_json::from_str(requests[4]["request"].as_str().unwrap())?;
    let first = req["request"]["Base"]["tx_id"]
        .as_str()
        .unwrap()
        .to_owned();
    s.respond_verify(4, verified_answer(&expected_payload_hash(6, &first)))
        .await?;
    s.worker.fast_forward(250).await?;
    call.await?.into_result()?;
    let v = s.wait_until_not_verifying("vault", 84532).await?;
    assert_eq!(v["verified"], false, "{v}");
    assert_eq!(v["verified_pauses"], json!([format!("0x{first}")]));

    // The next request (the fourth, paid by its caller) asks only about the other pause.
    let fee = s.fee("verify_pause_fee_per_pause").await?;
    let call = s
        .verify_pause(&s.other, "vault", 84532, json!({}), fee)
        .await?;
    let requests = s.wait_for_verify_requests(7).await?;
    let req: Value = serde_json::from_str(requests[6]["request"].as_str().unwrap())?;
    let second = req["request"]["Base"]["tx_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(first, second);
    assert!(hashes.contains(&first) && hashes.contains(&second));
    s.respond_verify(6, verified_answer(&expected_payload_hash(6, &second)))
        .await?;
    call.await?.into_result()?;
    let v = s.wait_until_not_verifying("vault", 84532).await?;
    assert_eq!(v["verified"], true, "{v}");
    let r = s
        .verify_pause(&s.other, "vault", 84532, json!({}), fee)
        .await?
        .await?;
    assert!(failure_text(&r).contains("already verified"), "{r:?}");
    Ok(())
}

/// R7.10, R11.4: the posting fee pays for three verification attempts per chain, each chain
/// counted on its own; a fourth is refused unless its caller attaches its cost, and then
/// the contract keeps that cost and refunds the rest of the deposit.
#[tokio::test]
async fn three_attempts_per_chain_are_prepaid_and_later_ones_pay_their_own_cost(
) -> anyhow::Result<()> {
    let none = NearToken::from_yoctonear(0);
    let s = paid_two_chain_bounty().await?;
    let fees = s.fees().await?;
    assert_eq!(fees["prepaid_verify_attempts"], 3);
    let fee = s.fee("verify_pause_fee_per_pause").await?;

    // Three prepaid attempts on Arbitrum, all timing out.
    for n in 1..=3u64 {
        assert_eq!(
            s.verifications("vault").await?[&421614]["prepaid_attempts_left"],
            3 - n + 1
        );
        let call = s
            .verify_pause(&s.other, "vault", 421614, json!({}), none)
            .await?;
        s.wait_for_verify_requests(n as usize).await?;
        s.worker.fast_forward(250).await?;
        call.await?.into_result()?;
        s.wait_until_not_verifying("vault", 421614).await?;
    }
    let v = s.verifications("vault").await?;
    assert_eq!(v[&421614]["attempts"], 3);
    assert_eq!(v[&421614]["prepaid_attempts_left"], 0);
    // Base's prepaid attempts are its own.
    assert_eq!(v[&84532]["prepaid_attempts_left"], 3);

    // A fourth with no deposit, or less than its cost, is refused.
    let r = s
        .verify_pause(&s.other, "vault", 421614, json!({}), none)
        .await?
        .await?;
    assert!(failure_text(&r).contains("prepaid attempts are used"), "{r:?}");
    let short = NearToken::from_yoctonear(fee.as_yoctonear() - 1);
    let r = s
        .verify_pause(&s.other, "vault", 421614, json!({}), short)
        .await?
        .await?;
    assert!(failure_text(&r).contains("prepaid attempts are used"), "{r:?}");
    assert_eq!(s.verify_requests().await?.len(), 3);

    // With more than its cost attached, the contract keeps the cost and refunds the rest.
    let before = s.free_balance().await?;
    let extra = NearToken::from_near(1);
    let call = s
        .verify_pause(&s.other, "vault", 421614, json!({}), fee.saturating_add(extra))
        .await?;
    let requests = s.wait_for_verify_requests(4).await?;
    let req: Value = serde_json::from_str(requests[3]["request"].as_str().unwrap())?;
    let tx_id = req["request"]["Arbitrum"]["tx_id"].as_str().unwrap().to_owned();
    s.respond_verify(3, verified_answer(&expected_payload_hash(7, &tx_id)))
        .await?;
    call.await?.into_result()?;
    let v = s.wait_until_not_verifying("vault", 421614).await?;
    assert_eq!(v["verified"], true, "{v}");
    assert_eq!(v["attempts"], 4);
    let after = s.free_balance().await?;
    assert!(after >= before, "the caller paid this attempt, not the contract");
    assert!(
        after < before + extra.as_yoctonear() / 2,
        "the excess went back to the caller"
    );
    Ok(())
}

// ---- posting check (#17) ----

impl Sandbox {
    /// Post `name` covering `covered` (chain 84532), with the posting check's job answered
    /// by `answer` (a stand-in script: `{"output": …}` or `{"fail": true}`; `null` scripts
    /// nothing, for a posting refused before it requests a job).
    async fn post_answered(
        &self,
        name: &str,
        covered: &[&str],
        answer: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.prepay_posting_fee(&self.protocol, self.fee("posting_fee").await?)
            .await?;
        if !answer.is_null() {
            self.script(answer).await?;
        }
        let mut rules = valid_rules(self).await?;
        rules["covered_contracts"] = covered
            .iter()
            .map(|a| json!({ "chain_id": 84532, "address": a }))
            .collect();
        self.transfer_call(
            &self.protocol,
            BOUNTY_AMOUNT,
            &json!({ "name": name, "rules": rules }),
            tgas(270),
        )
        .await
    }
}

const VAULT_A: &str = "0x00000000000000000000000000000000000000a1";
const VAULT_B: &str = "0x00000000000000000000000000000000000000b2";

/// R1.6, R7.6, R12.1, R12.2: the bounty goes live only on a passing posting check. A check
/// that fails for any reason (the pause role not granted or the contract not pausable, too
/// little pause gas, the chain unconfirmed), a failed or refused job, or an answer that
/// isn't a posting check result leaves the bounty `check_failed` and refunds the bounty
/// amount in full to the Protocol. The job's input is the posting check, exactly.
#[tokio::test]
async fn r1_6_a_failed_posting_check_refunds_the_bounty_amount_in_full() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    s.top_up(&s.whitehat, NearToken::from_near(1)).await?;
    let start = s.usdc_balance(s.protocol.id()).await?;

    // A passing check makes a posting live and keeps its USDC.
    s.post_answered("passing", &[VAULT_A], json!({ "output": PASSED }))
        .await?
        .into_result()?;
    assert_eq!(s.bounty("passing").await?["state"], "live");
    let held = start - s.usdc_balance(s.protocol.id()).await?;
    assert_eq!(held, BOUNTY_AMOUNT);

    let failing = [
        // R12.1 / R12.2: pause() from the pause-role address reverts.
        json!({ "output": r#"{"failures":[{"index":0,"reason":"cannot_pause"}]}"# }),
        // R7.6: the pause-role address holds too little pause gas.
        json!({ "output": r#"{"failures":[{"index":0,"reason":"pause_gas_short"}]}"# }),
        // R12.5: fewer than two pinned RPCs answered, or they disagreed.
        json!({ "output": r#"{"failures":[{"index":0,"reason":"chain_unconfirmed"}]}"# }),
        // A failed job reaches the callback as null.
        json!({ "output": null }),
        // Anything but a posting check result: a verdict, or nothing in particular.
        json!({ "output": r#"{"outcome":"PAYS","reason":"minimum_theft_reached"}"# }),
        json!({ "output": "{}" }),
        // OutLayer refuses the request outright (the stand-in keeps this answer queued, so
        // it goes last).
        json!({ "fail": true }),
    ];
    for (i, answer) in failing.iter().enumerate() {
        let name = format!("failing-{i}");
        let r = s.post_answered(&name, &[VAULT_B], answer.clone()).await?;
        if i == 0 {
            // The judge's reasons reach the Protocol in the bounty's event.
            let failures = r
                .logs()
                .iter()
                .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
                .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                .find(|e| e["event"] == "bounty_check_failed")
                .map(|e| e["data"][0]["failures"].clone());
            assert_eq!(
                failures,
                Some(json!([{ "index": 0, "reason": "cannot_pause" }]))
            );
        }
        let bounty = s.bounty(&name).await?;
        assert_eq!(bounty["state"], "check_failed", "{answer}: {r:?}");
        assert_eq!(
            s.usdc_balance(s.protocol.id()).await?,
            start - held,
            "{answer}: refunded in full"
        );
        assert_eq!(s.usdc_balance(s.contract.id()).await?, held, "{answer}");
        let r = s.submit_claim(&s.whitehat, &name).await?;
        assert!(r.is_failure(), "{answer}: a failed bounty takes no claims");
    }

    let jobs = s.requests().await?;
    let input: Value = serde_json::from_str(jobs[1]["input_data"].as_str().unwrap())?;
    assert_eq!(
        input,
        json!({ "posting_check": {
            "bounty": { "protocol": s.protocol.id(), "name": "failing-0" },
            "rules": s.bounty("failing-0").await?["rules"],
        }})
    );
    Ok(())
}

/// R12.3: a posting covering a contract that a live bounty, or one whose posting check is
/// still pending, already covers is refused and its USDC goes back; a contract whose
/// bounty failed its check can be covered again.
#[tokio::test]
async fn r12_3_a_contract_already_covered_by_a_live_or_pending_bounty_is_refused(
) -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let start = s.usdc_balance(s.protocol.id()).await?;

    // VAULT_A: covered by a live bounty. A refused posting requests no job, so nothing is
    // scripted for it (`Value::Null`).
    s.post_answered("live", &[VAULT_A], json!({ "output": PASSED }))
        .await?
        .into_result()?;
    let r = s
        .post_answered("again", &[VAULT_B, VAULT_A], Value::Null)
        .await?;
    assert!(failure_text(&r).contains("already covered"), "{r:?}");
    assert!(s.bounty("again").await?.is_null());
    assert_eq!(
        s.usdc_balance(s.protocol.id()).await?,
        start - BOUNTY_AMOUNT
    );

    // VAULT_B: covered by a bounty whose posting check hasn't answered yet.
    s.prepay_posting_fee(&s.protocol, s.fee("posting_fee").await?)
        .await?;
    let mut rules = valid_rules(&s).await?;
    rules["covered_contracts"] = json!([{ "chain_id": 84532, "address": VAULT_B }]);
    let pending = s
        .protocol
        .call(s.test_usdc.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": s.contract.id(),
            "amount": BOUNTY_AMOUNT.to_string(),
            "msg": json!({ "name": "pending", "rules": rules }).to_string(),
        }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(tgas(270))
        .transact_async()
        .await?;
    let jobs = s.wait_for_requests(2).await?;
    assert_eq!(s.bounty("pending").await?["state"], "checking");
    let r = s
        .post_answered("while-pending", &[VAULT_B], Value::Null)
        .await?;
    assert!(failure_text(&r).contains("already covered"), "{r:?}");

    // Its check fails: VAULT_B is free again.
    s.resolve(jobs[1]["id"].as_u64().unwrap(), None).await?;
    pending.await?.into_result()?;
    assert_eq!(s.bounty("pending").await?["state"], "check_failed");
    s.post_answered("after-failure", &[VAULT_B], json!({ "output": PASSED }))
        .await?
        .into_result()?;
    assert_eq!(s.bounty("after-failure").await?["state"], "live");
    assert_eq!(
        s.usdc_balance(s.protocol.id()).await?,
        start - 2 * BOUNTY_AMOUNT
    );
    Ok(())
}

/// R7.6: the pause gas the posting check asks of each pause is what the contract's own
/// signed pause can burn, gas limit at fee limit, plus the L1 data fee allowance, all as
/// `fees()` shows them.
#[tokio::test]
async fn r7_6_fees_show_the_pause_gas_the_posting_check_asks_for() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let fees = s.fees().await?;
    assert_eq!(fees["pause_gas_limit"], bountee_formats::PAUSE_GAS_LIMIT);
    assert_eq!(
        fees["pause_max_fee_per_gas"],
        bountee_formats::PAUSE_MAX_FEE_PER_GAS.to_string()
    );
    assert_eq!(
        fees["pause_l1_data_fee_allowance"],
        bountee_formats::PAUSE_L1_DATA_FEE_ALLOWANCE.to_string()
    );
    // 0.0002 ETH + 0.00001 ETH, from the spec.
    assert_eq!(fees["pause_gas_per_pause"], "210000000000000");
    Ok(())
}

// ---- release (#22) ----------------------------------------------------------------------
//
// Seam C here catches R6.1 (the release job is requested only once the bounty is paid, never
// while it is signing or paying, with the winning claim's own secret, one at a time), R12.4
// (the job names the exploit key recorded in the posted rules, never one from the caller,
// and the release kept is the job's output), R5.6 (no release for a failed, refused or
// losing claim) and R11.4 (the release is paid from the posting fee). It misses the real
// judge's encryption (seam J) and the real OutLayer (seam T).

/// What a release job returns, as the stand-in answers it.
const RELEASED: &str = r#"{"released":"AXNlYWxlZCB0byB0aGUgcHJvdG9jb2w="}"#;

impl Sandbox {
    /// `by` asks the contract to release `name`'s winning exploit, without waiting.
    async fn release(&self, by: &Account, name: &str) -> anyhow::Result<Pending> {
        Ok(by
            .call(self.contract.id(), "release_exploit")
            .args_json(json!({ "id": { "protocol": self.protocol.id(), "name": name } }))
            .gas(tgas(150))
            .transact_async()
            .await?)
    }

    async fn released(&self, name: &str) -> anyhow::Result<Value> {
        self.view(
            "released_exploit",
            json!({ "id": { "protocol": self.protocol.id(), "name": name } }),
        )
        .await
    }

    async fn wait_for_release_state(&self, name: &str, state: &str) -> anyhow::Result<Value> {
        for _ in 0..150 {
            let r = self.released(name).await?;
            if r["state"] == state {
                return Ok(r);
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        anyhow::bail!(
            "{name}'s release never reached {state}: {}",
            self.released(name).await?
        )
    }

    /// Wait until `n` release jobs have been requested, and return them.
    async fn wait_for_release_requests(&self, n: usize) -> anyhow::Result<Vec<Value>> {
        for _ in 0..150 {
            let r = self.release_requests().await?;
            if r.len() >= n {
                return Ok(r);
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        anyhow::bail!("release job {n} was never requested")
    }

    /// The job requests whose input is a release.
    async fn release_requests(&self) -> anyhow::Result<Vec<Value>> {
        Ok(self
            .requests()
            .await?
            .into_iter()
            .filter(|r| {
                r["input_data"]
                    .as_str()
                    .is_some_and(|i| i.starts_with(r#"{"release""#))
            })
            .collect())
    }
}

/// R6.1, R12.4, R11.4: the Protocol's copy is released only by a job the contract requests
/// once the payout has succeeded (not while the pauses are signing, not while a failed
/// transfer waits for a retry), with the winning claim's own secret, to the exploit key in
/// the posted rules; one release at a time; the release kept is the job's output; the
/// contract's own balance pays none of it.
#[tokio::test]
async fn r6_1_the_release_job_is_requested_only_after_the_payout_succeeds() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let free_at_start = s.free_balance().await?;
    let rules = valid_rules(&s).await?;
    s.post("vault", &rules).await?.into_result()?;
    s.top_up(&s.whitehat, NearToken::from_near(1)).await?;
    let refused = |r: &ExecutionFinalResult| failure_text(r).contains("not been paid");

    // Before any claim, and while a PAYS claim's pauses are being signed: nothing.
    let r = s.release(&s.other, "vault").await?.await?;
    assert!(refused(&r), "{r:?}");
    s.refuse_transfers(true).await?;
    let before = s.sign_requests().await?.len();
    let claim = s.submit_pays("vault").await?;
    let requests = s.wait_for_sign_requests(before + 1).await?;
    assert_eq!(s.bounty("vault").await?["state"], "signing");
    let r = s.release(&s.other, "vault").await?.await?;
    assert!(refused(&r), "{r:?}");

    // Signed, but the transfer failed: still nothing.
    s.answer_from(&requests, before, &s.pause_key("vault"), false)
        .await?;
    let id: u64 = claim.await?.into_result()?.json()?;
    s.wait_for_bounty_state("vault", "paying").await?;
    s.wait_until_not_paying_out("vault").await?;
    let r = s.release(&s.other, "vault").await?.await?;
    assert!(refused(&r), "{r:?}");
    assert!(s.release_requests().await?.is_empty());
    assert_eq!(s.released("vault").await?, Value::Null);

    // Paid: anyone may ask, and the contract requests the job.
    s.refuse_transfers(false).await?;
    let _ = s.retry_payout(&s.other, "vault").await?.await?;
    s.wait_for_bounty_state("vault", "paid").await?;
    let pending = s
        .other
        .call(s.contract.id(), "release_exploit")
        // A caller can't name the key: an extra argument changes nothing.
        .args_json(json!({
            "id": { "protocol": s.protocol.id(), "name": "vault" },
            "exploit_public_key": "x25519:HQm4yqJujXDwAJ3AkKTGcCjVby2TZ7HaVs3SAaqBCyAB",
        }))
        .gas(tgas(150))
        .transact_async()
        .await?;
    let release = s.wait_for_release_requests(1).await?.remove(0);
    assert_eq!(release["predecessor"], json!(s.contract.id()));
    let source: Value = serde_json::from_str(release["source"].as_str().unwrap())?;
    assert_eq!(source["WasmUrl"]["hash"], &JUDGE_BUILD_HASH[2..]);
    let claim = s.claim(id).await?;
    let secrets_ref: Value = serde_json::from_str(release["secrets_ref"].as_str().unwrap())?;
    assert_eq!(
        secrets_ref,
        json!({ "profile": claim["secret_profile"], "account_id": s.contract.id() }),
        "the winning claim's own secret"
    );
    let input: Value = serde_json::from_str(release["input_data"].as_str().unwrap())?;
    assert_eq!(
        input,
        json!({ "release": {
            "bounty": { "protocol": s.protocol.id(), "name": "vault" },
            "claim_id": id,
            "whitehat": s.whitehat.id(),
            "exploit_public_key": rules["exploit_public_key"],
        } }),
        "R12.4: the exploit key recorded in the posted rules"
    );
    assert_eq!(release["payer_account_id"], json!(s.protocol.id()));
    assert_eq!(
        release["deposit"].as_str().unwrap(),
        s.fee("job_deposit").await?.as_yoctonear().to_string()
    );

    // One at a time.
    assert_eq!(s.released("vault").await?["state"], "requested");
    let r = s.release(&s.protocol, "vault").await?.await?;
    assert!(failure_text(&r).contains("under way"), "{r:?}");

    // The job's output is what is kept, for the Protocol to open.
    s.resolve(release["id"].as_u64().unwrap(), Some(RELEASED))
        .await?;
    pending.await?.into_result()?;
    let released = s.wait_for_release_state("vault", "released").await?;
    assert_eq!(released["claim_id"], id);
    assert_eq!(released["released"], "AXNlYWxlZCB0byB0aGUgcHJvdG9jb2w=");
    let r = s.release(&s.other, "vault").await?.await?;
    assert!(failure_text(&r).contains("already released"), "{r:?}");
    assert_eq!(s.release_requests().await?.len(), 1);

    // R11.4: the posting fee paid for the job and the release's storage.
    let free_at_end = s.free_balance().await?;
    assert!(
        free_at_end >= free_at_start,
        "{free_at_end} < {free_at_start}"
    );
    Ok(())
}

/// R6.1: a release job that fails, is refused or returns anything but a release keeps
/// nothing; anyone can ask again, and the next good answer is kept.
#[tokio::test]
async fn r6_1_a_failed_release_keeps_nothing_and_can_be_asked_again() -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    s.pay_claim("vault").await?;
    for answer in [
        json!({ "output": null }),
        json!({ "output": PAYS }),
        json!({ "output": r#"{"released":"not base64!"}"# }),
    ] {
        s.script(answer.clone()).await?;
        s.release(&s.other, "vault").await?.await?.into_result()?;
        assert_eq!(s.released("vault").await?, Value::Null, "{answer}");
    }
    s.script(json!({ "output": RELEASED })).await?;
    s.release(&s.other, "vault").await?.await?.into_result()?;
    assert_eq!(s.released("vault").await?["state"], "released");

    // A request OutLayer refuses outright (the stand-in then refuses every later request,
    // so this comes last, on a second paid bounty).
    s.post("vault-2", &valid_rules(&s).await?)
        .await?
        .into_result()?;
    s.pay_claim("vault-2").await?;
    s.script(json!({ "fail": true })).await?;
    s.release(&s.other, "vault-2").await?.await?.into_result()?;
    assert_eq!(s.released("vault-2").await?, Value::Null);
    Ok(())
}

/// R5.6: a failed or refused exploit is never released: a ZERO, an INVALID and a no-verdict
/// claim leave nothing to release, and once a later claim wins, only the winner's secret is
/// ever named in a release job.
#[tokio::test]
async fn r5_6_a_failed_exploit_is_never_released() -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    s.top_up(&s.other, NearToken::from_near(1)).await?;
    let mut losers = vec![];
    let mut last_id = 0;
    for output in [Some(ZERO), Some(INVALID), None] {
        s.script(json!({ "output": output })).await?;
        let id: u64 = s
            .submit_claim(&s.other, "vault")
            .await?
            .into_result()?
            .json()?;
        losers.push(s.claim(id).await?["secret_profile"].clone());
        last_id = id;
        let r = s.release(&s.other, "vault").await?.await?;
        assert!(failure_text(&r).contains("not been paid"), "{r:?}");
    }
    assert!(s.release_requests().await?.is_empty());
    assert_eq!(s.released("vault").await?, Value::Null);

    // The no-verdict claim would hold its place against a later winner for an hour (R3.6),
    // so retry it to ZERO first; it is still a loser whose secret no release may name.
    let no_verdict = last_id;
    s.script(json!({ "output": ZERO })).await?;
    s.retry_now(&s.other, no_verdict, PROOFS)
        .await?
        .into_result()?;
    assert_eq!(s.claim(no_verdict).await?["verdict"]["outcome"], "ZERO");

    let winner = s.pay_claim("vault").await?;
    s.script(json!({ "output": RELEASED })).await?;
    s.release(&s.protocol, "vault")
        .await?
        .await?
        .into_result()?;
    let jobs = s.release_requests().await?;
    assert_eq!(jobs.len(), 1);
    let secrets_ref: Value = serde_json::from_str(jobs[0]["secrets_ref"].as_str().unwrap())?;
    assert_eq!(
        secrets_ref["profile"],
        s.claim(winner).await?["secret_profile"]
    );
    assert!(!losers.contains(&secrets_ref["profile"]));
    assert_eq!(s.released("vault").await?["claim_id"], winner);
    Ok(())
}

/// R6.2, R12.4 (code review of #22): a posting whose exploit key isn't an X25519 key of 32
/// bytes is refused, since no release could ever open for it; the USDC goes back.
#[tokio::test]
async fn r6_2_a_posting_with_an_exploit_key_no_release_can_use_is_refused() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let before = s.usdc_balance(s.protocol.id()).await?;
    for (name, key) in [
        (
            "secp",
            "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f",
        ),
        ("ed", "ed25519:6W7B3sSYk1p2DZ7FXyRbJWDNiaRfVTj1hm6k8Cqnq6wA"),
        ("short", "x25519:6W7B3sSYk1p2DZ7"),
    ] {
        let mut rules = valid_rules(&s).await?;
        rules["exploit_public_key"] = json!(key);
        let r = s.post(name, &rules).await?;
        assert!(failure_text(&r).contains("X25519"), "{name}: {r:?}");
        assert_eq!(s.bounty(name).await?, Value::Null, "{name}");
    }
    assert_eq!(s.usdc_balance(s.protocol.id()).await?, before);
    Ok(())
}

// ---- publication (#23) ------------------------------------------------------------------
//
// Seam C here catches D7 (publication is refused before the payout and before the disclosure
// delay has passed since it, and anyone may trigger it after; one at a time; the job is the
// contract's own, with the winning claim's secret, R5.6), D7.1 at the contract (what is kept
// is the claim's block, header and the very proofs it was filed with, beside the judge's
// output) and R11.4 (the contract's own balance pays none of it). The sandbox clock stands in
// for a day passing (`fast_forward`). It misses the real judge's output (seam J) and the
// real OutLayer and a real day (no live run).

/// What a publication job returns, as the stand-in answers it.
const PUBLISHED: &str = r#"{"published":"q1YqSi0uKcrMS1WyMjQwMDA1NDA0MjCwMjM2MDQ0Mlaq5QIA"}"#;

impl Sandbox {
    /// `by` asks the contract to publish `name`'s winning exploit with `proofs`, without
    /// waiting.
    async fn publish(&self, by: &Account, name: &str, proofs: &str) -> anyhow::Result<Pending> {
        Ok(by
            .call(self.contract.id(), "publish_exploit")
            .args_json(json!({
                "id": { "protocol": self.protocol.id(), "name": name },
                "proofs": proofs,
            }))
            .gas(tgas(150))
            .transact_async()
            .await?)
    }

    async fn published(&self, name: &str) -> anyhow::Result<Value> {
        self.view(
            "published_exploit",
            json!({ "id": { "protocol": self.protocol.id(), "name": name } }),
        )
        .await
    }

    async fn wait_for_publication_state(&self, name: &str, state: &str) -> anyhow::Result<Value> {
        for _ in 0..150 {
            let r = self.published(name).await?;
            if r["state"] == state {
                return Ok(r);
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        anyhow::bail!(
            "{name}'s publication never reached {state}: {}",
            self.published(name).await?
        )
    }

    /// The job requests whose input is a publication.
    async fn publish_requests(&self) -> anyhow::Result<Vec<Value>> {
        Ok(self
            .requests()
            .await?
            .into_iter()
            .filter(|r| {
                r["input_data"]
                    .as_str()
                    .is_some_and(|i| i.starts_with(r#"{"publish""#))
            })
            .collect())
    }

    async fn wait_for_publish_requests(&self, n: usize) -> anyhow::Result<Vec<Value>> {
        for _ in 0..150 {
            let r = self.publish_requests().await?;
            if r.len() >= n {
                return Ok(r);
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        anyhow::bail!("publication job {n} was never requested")
    }

    /// Move this node's clock (about 100 s a block) just past `ns`, in steps sized for that,
    /// so a target hours away isn't overshot.
    async fn pass_time_on_day_node_to(&self, ns: u64) -> anyhow::Result<()> {
        for _ in 0..400 {
            let now = now_ns(self).await?;
            if now > ns {
                return Ok(());
            }
            let blocks = (ns - now) / 100_000_000_000 + 2;
            self.worker.fast_forward(blocks.min(2_000)).await?;
        }
        anyhow::bail!("the sandbox clock didn't reach {ns}")
    }

    /// A live bounty `name` whose disclosure delay is one day, the least the rules allow.
    async fn post_one_day_delay(&self, name: &str) -> anyhow::Result<Value> {
        let mut rules = valid_rules(self).await?;
        rules["disclosure_delay_days"] = json!(1);
        self.post(name, &rules).await?.into_result()?;
        Ok(rules)
    }
}

/// D7, D7.1, R5.6, R11.4: a winning exploit's publication is refused before the payout and
/// until the disclosure delay (one day here) has passed since it; then anyone may trigger it
/// with the claim's proofs, and only those the claim was filed with. The contract requests
/// the job itself, with the winning claim's secret, one at a time, and keeps the claim's
/// block, header and proofs beside the judge's output, paid from the posting fee.
#[tokio::test]
async fn d7_publication_is_refused_before_the_delay_and_open_to_anyone_after() -> anyhow::Result<()>
{
    let s = Sandbox::start_with_days().await?;
    let free_at_start = s.free_balance().await?;
    s.post_one_day_delay("vault").await?;
    s.top_up(&s.whitehat, NearToken::from_near(1)).await?;

    // Before any winner: nothing to publish.
    let r = s.publish(&s.other, "vault", PROOFS).await?.await?;
    assert!(failure_text(&r).contains("not been paid"), "{r:?}");
    assert_eq!(s.published("vault").await?, Value::Null);

    // Paid, but the delay hasn't passed: refused, and the view says when it opens.
    let id = s.pay_claim("vault").await?;
    let paid_at = now_ns(&s).await?;
    let r = s.publish(&s.other, "vault", PROOFS).await?.await?;
    assert!(failure_text(&r).contains("disclosure delay"), "{r:?}");
    let view = s.published("vault").await?;
    assert_eq!(view["state"], "delayed");
    let from: u64 = view["publishable_from_ns"].as_str().unwrap().parse()?;
    assert!(
        from > paid_at + DAY_NS - 60_000_000_000 && from <= paid_at + DAY_NS,
        "one day after the payout: {from} vs paid at {paid_at}"
    );
    assert_eq!(view["published"], Value::Null);
    assert!(s.publish_requests().await?.is_empty());

    // Just before the day is up, still refused.
    s.pass_time_on_day_node_to(from - 2 * 3_600_000_000_000).await?;
    let r = s.publish(&s.other, "vault", PROOFS).await?.await?;
    assert!(failure_text(&r).contains("disclosure delay"), "{r:?}");

    // After it, anyone may trigger it, but only with the proofs the claim was filed with.
    s.pass_time_on_day_node_to(from).await?;
    assert_eq!(s.published("vault").await?["state"], "publishable");
    let r = s
        .publish(&s.other, "vault", r#"[{"address":"0x00000000000000000000000000000000000000ab"}]"#)
        .await?
        .await?;
    assert!(failure_text(&r).contains("proofs"), "{r:?}");
    assert!(s.publish_requests().await?.is_empty());

    let pending = s.publish(&s.other, "vault", PROOFS).await?;
    let job = s.wait_for_publish_requests(1).await?.remove(0);
    assert_eq!(job["predecessor"], json!(s.contract.id()));
    let source: Value = serde_json::from_str(job["source"].as_str().unwrap())?;
    assert_eq!(source["WasmUrl"]["hash"], &JUDGE_BUILD_HASH[2..]);
    let claim = s.claim(id).await?;
    let secrets_ref: Value = serde_json::from_str(job["secrets_ref"].as_str().unwrap())?;
    assert_eq!(
        secrets_ref,
        json!({ "profile": claim["secret_profile"], "account_id": s.contract.id() }),
        "the winning claim's own secret"
    );
    let input: Value = serde_json::from_str(job["input_data"].as_str().unwrap())?;
    assert_eq!(
        input,
        json!({ "publish": {
            "bounty": { "protocol": s.protocol.id(), "name": "vault" },
            "claim_id": id,
            "whitehat": s.whitehat.id(),
        } })
    );

    // One at a time.
    assert_eq!(s.published("vault").await?["state"], "requested");
    let r = s.publish(&s.protocol, "vault", PROOFS).await?.await?;
    assert!(failure_text(&r).contains("under way"), "{r:?}");

    // What is kept: the judge's output with the claim's block, header and proofs (D7.1).
    s.resolve(job["id"].as_u64().unwrap(), Some(PUBLISHED)).await?;
    pending.await?.into_result()?;
    let published = s.wait_for_publication_state("vault", "published").await?;
    let args = s.claim_args("vault");
    assert_eq!(published["claim_id"], id);
    assert_eq!(published["block"], args["block"]);
    assert_eq!(published["header"], args["header"]);
    assert_eq!(published["proofs"], PROOFS);
    assert_eq!(
        published["published"],
        "q1YqSi0uKcrMS1WyMjQwMDA1NDA0MjCwMjM2MDQ0Mlaq5QIA"
    );
    assert_eq!(published["verdict"], serde_json::from_str::<Value>(PAYS)?);
    let r = s.publish(&s.other, "vault", PROOFS).await?.await?;
    assert!(failure_text(&r).contains("already published"), "{r:?}");
    assert_eq!(s.publish_requests().await?.len(), 1);

    // R11.4: the posting fee paid for the job and the publication's storage.
    let free_at_end = s.free_balance().await?;
    assert!(
        free_at_end >= free_at_start,
        "{free_at_end} < {free_at_start}"
    );
    Ok(())
}

/// D7: a publication job that fails or returns anything but a publication keeps nothing;
/// anyone can ask again, and the next good answer is kept.
#[tokio::test]
async fn d7_a_failed_publication_keeps_nothing_and_can_be_asked_again() -> anyhow::Result<()> {
    let s = Sandbox::start_with_days().await?;
    s.post_one_day_delay("vault").await?;
    s.top_up(&s.whitehat, NearToken::from_near(1)).await?;
    s.pay_claim("vault").await?;
    let from: u64 = s.published("vault").await?["publishable_from_ns"]
        .as_str()
        .unwrap()
        .parse()?;
    s.pass_time_on_day_node_to(from).await?;
    for answer in [
        json!({ "output": null }),
        json!({ "output": PAYS }),
        json!({ "output": RELEASED }),
        json!({ "output": r#"{"published":"not base64!"}"# }),
    ] {
        s.script(answer.clone()).await?;
        s.publish(&s.other, "vault", PROOFS)
            .await?
            .await?
            .into_result()?;
        let view = s.published("vault").await?;
        assert_eq!(view["state"], "publishable", "{answer}");
        assert_eq!(view["published"], Value::Null, "{answer}");
    }
    s.script(json!({ "output": PUBLISHED })).await?;
    s.publish(&s.other, "vault", PROOFS)
        .await?
        .await?
        .into_result()?;
    assert_eq!(s.published("vault").await?["state"], "published");
    Ok(())
}

// ---- claim fairness (#18) ----
//
// Seam C: claims on one bounty resolve fairly. The OutLayer stand-in holds jobs pending so a
// test chooses the order verdicts arrive in, answers `null` or fails a request, or lets a
// job's yield time out. Misses: real OutLayer timing and failures (T), real gas.

impl Sandbox {
    /// Post `name` covering its own contract, so several bounties can live in one sandbox
    /// (R12.3), ending `end_in_ns` from now.
    async fn post_covering(&self, name: &str, last_byte: u8, end_in_ns: u64) -> anyhow::Result<()> {
        let mut r = rules(self, end_in_ns, now_ns(self).await?);
        r["covered_contracts"][0]["address"] =
            json!(format!("0x{}{last_byte:02x}", "00".repeat(19)));
        self.post(name, &r).await?.into_result()?;
        Ok(())
    }

    /// File a claim with exactly these arguments, without waiting for its receipts.
    async fn file(&self, by: &Account, args: &Value) -> anyhow::Result<Pending> {
        Ok(by
            .call(self.contract.id(), "submit_claim")
            .args_json(args)
            .gas(tgas(300))
            .transact_async()
            .await?)
    }

    /// File a claim with exactly these arguments and wait for every receipt.
    async fn file_now(&self, by: &Account, args: &Value) -> anyhow::Result<ExecutionFinalResult> {
        Ok(by
            .call(self.contract.id(), "submit_claim")
            .args_json(args)
            .gas(tgas(300))
            .transact()
            .await?)
    }

    /// `by` retries claim `id` with these proofs and waits for every receipt.
    async fn retry_now(
        &self,
        by: &Account,
        id: u64,
        proofs: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(by
            .call(self.contract.id(), "retry_claim")
            .args_json(json!({ "claim_id": id, "proofs": proofs }))
            .gas(tgas(300))
            .transact()
            .await?)
    }

    /// Answer every pause signature request of `name` from index `from` on, once they arrive.
    async fn sign_pauses_from(&self, name: &str, from: usize) -> anyhow::Result<()> {
        let covered = self.bounty(name).await?["rules"]["covered_contracts"]
            .as_array()
            .unwrap()
            .len();
        let requests = self.wait_for_sign_requests(from + covered).await?;
        self.answer_from(&requests, from, &self.pause_key(name), false)
            .await
    }

    fn job_input(request: &Value) -> anyhow::Result<Value> {
        Ok(serde_json::from_str(
            request["input_data"].as_str().unwrap(),
        )?)
    }

    async fn near_balance(&self, id: &AccountId) -> anyhow::Result<u128> {
        Ok(self.worker.view_account(id).await?.balance.as_yoctonear())
    }

    async fn set_fail_store(&self, fail: bool) -> anyhow::Result<()> {
        self.test_outlayer
            .call("set_fail_store")
            .args_json(json!({ "fail": fail }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }
}

/// R2.6: a job that comes back `null`, a request OutLayer refuses, and a job that times out
/// each leave the claim pending (`no_verdict`) in its place, with nothing moved. Only the
/// claim's Whitehat may retry it, with the proofs it was filed with; a retry reuses the
/// claim's sealed exploit without storing it again and keeps its original submission time.
#[tokio::test]
async fn r2_6_a_failed_or_timed_out_job_leaves_the_claim_pending_and_retryable(
) -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    s.top_up(&s.whitehat, NearToken::from_near(2)).await?;

    // A `null` job and a refused request.
    s.script(json!({ "output": null })).await?;
    let nulled: u64 = s
        .submit_claim(&s.whitehat, "vault")
        .await?
        .into_result()?
        .json()?;
    s.script(json!({ "fail": true })).await?;
    let refused: u64 = s
        .submit_claim(&s.whitehat, "vault")
        .await?
        .into_result()?
        .json()?;
    // A job nobody answers: its yield times out and OutLayer hands back `null`.
    let jobs = s.requests().await?.len();
    let pending = s.file(&s.whitehat, &s.claim_args("vault")).await?;
    s.wait_for_requests(jobs + 1).await?;
    s.worker.fast_forward(250).await?;
    let timed_out: u64 = pending.await?.into_result()?.json()?;
    s.wait_for_claim_state(timed_out, "no_verdict").await?;

    for id in [nulled, refused, timed_out] {
        let claim = s.claim(id).await?;
        assert_eq!(claim["state"], "no_verdict", "{claim}");
        assert_eq!(claim["verdict"], Value::Null);
    }
    assert_eq!(s.bounty("vault").await?["state"], "live");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);
    assert!(s.sign_requests().await?.is_empty());

    // Only the claim's Whitehat retries it, and only with the proofs it was filed with.
    s.top_up(&s.other, NearToken::from_near(1)).await?;
    let r = s.retry_now(&s.other, nulled, PROOFS).await?;
    assert!(
        failure_text(&r).contains("only the claim's Whitehat"),
        "{r:?}"
    );
    let r = s.retry_now(&s.whitehat, nulled, "[]").await?;
    assert!(failure_text(&r).contains("proofs"), "{r:?}");

    for (id, verdict) in [(nulled, ZERO), (refused, INVALID), (timed_out, ZERO)] {
        let before = s.claim(id).await?;
        let balance = s.claim_balance(s.whitehat.id()).await?;
        s.script(json!({ "output": verdict })).await?;
        s.retry_now(&s.whitehat, id, PROOFS).await?.into_result()?;
        let after = s.claim(id).await?;
        assert_eq!(after["state"], "judged", "{after}");
        assert_eq!(after["verdict"], serde_json::from_str::<Value>(verdict)?);
        assert_eq!(after["submitted_at_ns"], before["submitted_at_ns"]);

        let job = s.requests().await?.pop().unwrap();
        let input = Sandbox::job_input(&job)?;
        assert_eq!(
            input["judge_claim"]["submitted_at_ns"], before["submitted_at_ns"],
            "the retry keeps the original submission time"
        );
        assert_eq!(input["judge_claim"]["proofs_json"], PROOFS);
        let secrets_ref: Value = serde_json::from_str(job["secrets_ref"].as_str().unwrap())?;
        assert_eq!(secrets_ref["profile"], before["secret_profile"]);
        // The retry's job is drawn from the claim balance, not the contract's.
        assert!(s.claim_balance(s.whitehat.id()).await? < balance);
    }
    let rows: Vec<(String, u32)> = s.test_outlayer.view("secret_rows").await?.json()?;
    assert!(
        rows.iter().all(|(_, stores)| *stores == 1),
        "never stored again: {rows:?}"
    );
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);
    Ok(())
}

/// R3.5: the same sealed exploit is judged to a verdict at most once. Filed again, by its
/// Whitehat or anyone else, it is refused before any job; a judged claim can't be retried;
/// a claim waiting for its retry is retried, not filed again. A sealed exploit whose secret
/// couldn't be stored was never judged, so it may be filed again.
#[tokio::test]
async fn r3_5_the_same_sealed_exploit_is_judged_at_most_once() -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    s.top_up(&s.whitehat, NearToken::from_near(2)).await?;
    s.top_up(&s.other, NearToken::from_near(1)).await?;

    let judged_args = s.claim_args("vault");
    s.script(json!({ "output": ZERO })).await?;
    let judged: u64 = s
        .file_now(&s.whitehat, &judged_args)
        .await?
        .into_result()?
        .json()?;
    assert_eq!(s.claim(judged).await?["state"], "judged");

    let waiting_args = s.claim_args("vault");
    s.script(json!({ "output": null })).await?;
    let waiting: u64 = s
        .file_now(&s.whitehat, &waiting_args)
        .await?
        .into_result()?
        .json()?;
    assert_eq!(s.claim(waiting).await?["state"], "no_verdict");

    let jobs = s.requests().await?.len();
    let rows: Vec<(String, u32)> = s.test_outlayer.view("secret_rows").await?.json()?;
    for args in [&judged_args, &waiting_args] {
        for who in [&s.whitehat, &s.other] {
            let r = s.file_now(who, args).await?;
            assert!(failure_text(&r).contains("already been filed"), "{r:?}");
        }
    }
    let r = s.retry_now(&s.whitehat, judged, PROOFS).await?;
    assert!(
        failure_text(&r).contains("only a claim left with no verdict can be retried"),
        "{r:?}"
    );
    assert_eq!(s.requests().await?.len(), jobs, "no job was requested");
    let after: Vec<(String, u32)> = s.test_outlayer.view("secret_rows").await?.json()?;
    assert_eq!(after, rows, "no exploit was stored");
    assert_eq!(
        s.claim(judged).await?["verdict"],
        serde_json::from_str::<Value>(ZERO)?
    );

    // Never stored, so never judged: it may be filed again.
    let unstored_args = s.claim_args("vault");
    s.set_fail_store(true).await?;
    let unstored: u64 = s
        .file_now(&s.whitehat, &unstored_args)
        .await?
        .into_result()?
        .json()?;
    s.wait_for_claim_state(unstored, "store_failed").await?;
    s.set_fail_store(false).await?;
    s.script(json!({ "output": ZERO })).await?;
    let again: u64 = s
        .file_now(&s.whitehat, &unstored_args)
        .await?
        .into_result()?
        .json()?;
    assert_eq!(s.claim(again).await?["state"], "judged");
    Ok(())
}

/// R3.6: two PAYS claims on one bounty; the later one's verdict arrives first. Its pauses are
/// signed at once, but it isn't paid while the earlier claim is still being judged; the
/// earlier claim's PAYS then wins: it is paid the whole bounty, once, and the later is
/// refused. In the usual order, the later PAYS is refused too.
#[tokio::test]
async fn r3_6_the_earlier_of_two_pays_claims_is_paid_whichever_verdict_arrives_first(
) -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    s.top_up(&s.other, NearToken::from_near(1)).await?;

    let jobs = s.requests().await?.len();
    let earlier_tx = s.file(&s.whitehat, &s.claim_args("vault")).await?;
    s.wait_for_requests(jobs + 1).await?;
    let later_tx = s.file(&s.other, &s.claim_args("vault")).await?;
    let requests = s.wait_for_requests(jobs + 2).await?;
    let (earlier_job, later_job) = (&requests[jobs], &requests[jobs + 1]);
    assert_eq!(earlier_job["payer_account_id"], json!(s.whitehat.id()));
    assert_eq!(later_job["payer_account_id"], json!(s.other.id()));

    // The later claim's PAYS arrives first: the bounty closes and its pauses are signed...
    let signs = s.sign_requests().await?.len();
    s.resolve(later_job["id"].as_u64().unwrap(), Some(PAYS))
        .await?;
    s.sign_pauses_from("vault", signs).await?;
    let later: u64 = later_tx.await?.into_result()?.json()?;
    let bounty = s.wait_for_bounty_state("vault", "paying").await?;
    assert_eq!(bounty["signed_pauses"].as_array().unwrap().len(), 1);
    // ...but it isn't paid while the earlier claim is still being judged.
    assert_eq!(bounty["paying_out"], false, "{bounty}");
    assert_eq!(s.usdc_balance(s.other.id()).await?, 0);
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);
    let r = s.retry_payout(&s.protocol, "vault").await?.await?;
    assert!(failure_text(&r).contains("earlier claim"), "{r:?}");
    let r = s.submit_claim(&s.other, "vault").await?;
    assert!(failure_text(&r).contains("closed"), "{r:?}");

    // The earlier claim's PAYS: it is the one paid.
    s.resolve(earlier_job["id"].as_u64().unwrap(), Some(PAYS))
        .await?;
    let earlier: u64 = earlier_tx.await?.into_result()?.json()?;
    assert!(earlier < later);
    let bounty = s.wait_for_bounty_state("vault", "paid").await?;
    assert_eq!(bounty["winning_claim"], earlier);
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, BOUNTY_AMOUNT);
    assert_eq!(s.usdc_balance(s.other.id()).await?, 0);
    assert_eq!(s.usdc_balance(s.contract.id()).await?, 0);
    assert_eq!(
        s.claim(later).await?["verdict"],
        serde_json::from_str::<Value>(PAYS)?
    );
    let r = s.retry_payout(&s.protocol, "vault").await?.await?;
    assert!(failure_text(&r).contains("no payout waiting"), "{r:?}");

    // The usual order: the earlier verdict first; the later PAYS is refused.
    s.post_covering("vault-2", 0xab, 30 * DAY_NS).await?;
    let jobs = s.requests().await?.len();
    let earlier_tx = s.file(&s.whitehat, &s.claim_args("vault-2")).await?;
    s.wait_for_requests(jobs + 1).await?;
    let later_tx = s.file(&s.other, &s.claim_args("vault-2")).await?;
    let requests = s.wait_for_requests(jobs + 2).await?;
    let signs = s.sign_requests().await?.len();
    s.resolve(requests[jobs]["id"].as_u64().unwrap(), Some(PAYS))
        .await?;
    s.sign_pauses_from("vault-2", signs).await?;
    let earlier: u64 = earlier_tx.await?.into_result()?.json()?;
    s.wait_for_bounty_state("vault-2", "paid").await?;
    s.resolve(requests[jobs + 1]["id"].as_u64().unwrap(), Some(PAYS))
        .await?;
    later_tx.await?.into_result()?;
    let bounty = s.bounty("vault-2").await?;
    assert_eq!(bounty["state"], "paid");
    assert_eq!(bounty["winning_claim"], earlier);
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, 2 * BOUNTY_AMOUNT);
    assert_eq!(s.usdc_balance(s.other.id()).await?, 0);
    Ok(())
}

/// R2.6, R3.6: a claim waiting for its retry keeps its place. A later PAYS is signed but
/// not paid while it waits: retried to PAYS, the earlier claim is paid and the later
/// refused; retried to ZERO, the later is paid. A claim's place is held for
/// `claim_place_hold_ns` from its submission, so a claim never retried can't hold a later
/// winner's payout forever: after that, anyone's `retry_payout` pays the later claim.
#[tokio::test]
async fn r2_6_r3_6_a_claim_waiting_for_its_retry_keeps_its_place() -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    s.top_up(&s.whitehat, NearToken::from_near(2)).await?;
    s.top_up(&s.other, NearToken::from_near(2)).await?;
    s.post_covering("vault-2", 0xab, 30 * DAY_NS).await?;
    s.post_covering("vault-3", 0xac, 30 * DAY_NS).await?;

    // Earlier claim: no verdict. Later claim (another Whitehat): PAYS, pauses signed.
    let mut waiting = Vec::new();
    for name in ["vault", "vault-2", "vault-3"] {
        s.script(json!({ "output": null })).await?;
        let earlier: u64 = s
            .file_now(&s.whitehat, &s.claim_args(name))
            .await?
            .into_result()?
            .json()?;
        let signs = s.sign_requests().await?.len();
        s.script(json!({ "output": PAYS })).await?;
        let later_tx = s.file(&s.other, &s.claim_args(name)).await?;
        s.sign_pauses_from(name, signs).await?;
        let later: u64 = later_tx.await?.into_result()?.json()?;
        let bounty = s.wait_for_bounty_state(name, "paying").await?;
        assert_eq!(bounty["paying_out"], false, "{bounty}");
        assert_eq!(bounty["winning_claim"], later);
        let r = s.retry_payout(&s.protocol, name).await?.await?;
        assert!(failure_text(&r).contains("earlier claim"), "{r:?}");
        waiting.push((name, earlier, later));
    }
    assert_eq!(s.usdc_balance(s.other.id()).await?, 0);
    assert_eq!(s.usdc_balance(s.contract.id()).await?, 3 * BOUNTY_AMOUNT);

    // Retried to PAYS: the earlier claim is paid, the later refused.
    let (name, earlier, _) = waiting[0];
    s.script(json!({ "output": PAYS })).await?;
    s.retry_now(&s.whitehat, earlier, PROOFS)
        .await?
        .into_result()?;
    let bounty = s.wait_for_bounty_state(name, "paid").await?;
    assert_eq!(bounty["winning_claim"], earlier);
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, BOUNTY_AMOUNT);
    assert_eq!(s.usdc_balance(s.other.id()).await?, 0);

    // Retried to ZERO: the later claim is paid.
    let (name, earlier, later) = waiting[1];
    s.script(json!({ "output": ZERO })).await?;
    s.retry_now(&s.whitehat, earlier, PROOFS)
        .await?
        .into_result()?;
    let bounty = s.wait_for_bounty_state(name, "paid").await?;
    assert_eq!(bounty["winning_claim"], later);
    assert_eq!(s.usdc_balance(s.other.id()).await?, BOUNTY_AMOUNT);

    // Never retried: once its place has lapsed, the later claim is paid on anyone's retry,
    // and the lapsed claim can no longer be retried.
    let (name, earlier, later) = waiting[2];
    let hold: u64 = s.fees().await?["claim_place_hold_ns"]
        .as_str()
        .unwrap()
        .parse()?;
    let submitted: u64 = s.claim(earlier).await?["submitted_at_ns"]
        .as_str()
        .unwrap()
        .parse()?;
    for _ in 0..50 {
        if now_ns(&s).await? > submitted + hold {
            break;
        }
        s.worker.fast_forward(2_000).await?;
    }
    assert!(
        now_ns(&s).await? > submitted + hold,
        "the sandbox clock didn't move"
    );
    s.retry_payout(&s.protocol, name)
        .await?
        .await?
        .into_result()?;
    let bounty = s.wait_for_bounty_state(name, "paid").await?;
    assert_eq!(bounty["winning_claim"], later);
    assert_eq!(s.usdc_balance(s.other.id()).await?, 2 * BOUNTY_AMOUNT);
    let r = s.retry_now(&s.whitehat, earlier, PROOFS).await?;
    assert!(failure_text(&r).contains("can no longer win"), "{r:?}");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, 0);
    Ok(())
}

/// R3.7: a claim submitted after the bounty's end date is refused before any job. A claim
/// submitted before it keeps its submission time, so its retry is still judged after it.
#[tokio::test]
async fn r3_7_claims_after_the_end_date_are_refused() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    s.top_up(&s.whitehat, NearToken::from_near(2)).await?;
    s.post_covering("ending", 0xaa, 60_000_000_000).await?; // ends in a minute
    let end: u64 = s.bounty("ending").await?["rules"]["end_date_ns"]
        .as_str()
        .unwrap()
        .parse()?;
    s.script(json!({ "output": null })).await?;
    let before_end: u64 = s
        .submit_claim(&s.whitehat, "ending")
        .await?
        .into_result()?
        .json()?;
    assert_eq!(s.claim(before_end).await?["state"], "no_verdict");

    for _ in 0..50 {
        if now_ns(&s).await? > end {
            break;
        }
        s.worker.fast_forward(50).await?;
    }
    assert!(now_ns(&s).await? > end, "the sandbox clock didn't move");
    let jobs = s.requests().await?.len();
    let r = s.submit_claim(&s.whitehat, "ending").await?;
    assert!(failure_text(&r).contains("ended"), "{r:?}");
    assert_eq!(s.requests().await?.len(), jobs, "no job was requested");

    s.script(json!({ "output": ZERO })).await?;
    s.retry_now(&s.whitehat, before_end, PROOFS)
        .await?
        .into_result()?;
    assert_eq!(s.claim(before_end).await?["state"], "judged");
    Ok(())
}

/// R3.13: after a ZERO and an INVALID verdict the bounty stays open, and the same
/// Whitehat's next claim is judged and, on PAYS, paid.
#[tokio::test]
async fn r3_13_after_zero_or_invalid_the_same_whitehat_may_claim_again() -> anyhow::Result<()> {
    let s = live_bounty("vault").await?;
    s.top_up(&s.whitehat, NearToken::from_near(1)).await?;
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
        assert_eq!(s.bounty("vault").await?["state"], "live");
    }
    let id = s.pay_claim("vault").await?;
    assert_eq!(s.bounty("vault").await?["winning_claim"], id);
    assert_eq!(s.claim(id).await?["whitehat"], json!(s.whitehat.id()));
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, BOUNTY_AMOUNT);
    Ok(())
}

/// R11.3: a Whitehat tops up their claim balance and withdraws part of it, then the rest,
/// to their own account. A withdrawal needs one yoctoNEAR attached (a full-access key, not
/// a claim key), can't exceed the balance, and draws only on the caller's own balance.
#[tokio::test]
async fn r11_3_a_whitehat_tops_up_and_withdraws_their_claim_balance() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let milli = |n: u128| NearToken::from_millinear(n).as_yoctonear();
    s.top_up(&s.whitehat, NearToken::from_millinear(2_000))
        .await?;
    let first = s.claim_balance(s.whitehat.id()).await?;
    // The balance entry's own storage is taken from the first deposit (R11.4).
    assert!(first < milli(2_000) && first > milli(1_990), "{first}");
    s.top_up(&s.whitehat, NearToken::from_millinear(500))
        .await?;
    assert_eq!(s.claim_balance(s.whitehat.id()).await?, first + milli(500));

    let withdraw = |by: &Account, amount: Option<u128>, deposit: u128| {
        by.call(s.contract.id(), "withdraw_claim_balance")
            .args_json(json!({ "amount": amount.map(|a| a.to_string()) }))
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(tgas(30))
            .transact()
    };
    let r = withdraw(&s.whitehat, Some(milli(100)), 0).await?;
    assert!(failure_text(&r).contains("yoctoNEAR"), "{r:?}");
    let r = withdraw(&s.whitehat, Some(first + milli(501)), 1).await?;
    assert!(
        failure_text(&r).contains("more than the claim balance"),
        "{r:?}"
    );
    let r = withdraw(&s.other, Some(1), 1).await?;
    assert!(
        failure_text(&r).contains("more than the claim balance"),
        "{r:?}"
    );

    let gas_slack = milli(10); // the call's gas, some refunded only later
    let account = s.near_balance(s.whitehat.id()).await?;
    withdraw(&s.whitehat, Some(milli(1_000)), 1)
        .await?
        .into_result()?;
    let left = first + milli(500) - milli(1_000);
    assert_eq!(s.claim_balance(s.whitehat.id()).await?, left);
    let gained = s.near_balance(s.whitehat.id()).await? - account;
    assert!(gained > milli(1_000) - gas_slack, "{gained}");

    let account = s.near_balance(s.whitehat.id()).await?;
    withdraw(&s.whitehat, None, 1).await?.into_result()?;
    assert_eq!(s.claim_balance(s.whitehat.id()).await?, 0);
    let gained = s.near_balance(s.whitehat.id()).await? - account;
    assert!(gained > left - gas_slack, "{gained}");
    let r = withdraw(&s.whitehat, None, 1).await?;
    assert!(failure_text(&r).contains("nothing to withdraw"), "{r:?}");
    Ok(())
}

// ---- withdrawal (ticket #19) ----
//
// Seam C. The end date is passed by fast-forwarding the sandbox's blocks. Misses: real
// Circle USDC and real gas (seam T).

/// How far ahead a short bounty ends: long enough for its posting to land first.
const SHORT_END_NS: u64 = 20_000_000_000;

impl Sandbox {
    /// `by` asks to withdraw the Protocol's bounty `name`, and waits for every receipt.
    async fn withdraw_bounty(
        &self,
        by: &Account,
        name: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(by
            .call(self.contract.id(), "withdraw_bounty")
            .args_json(json!({ "id": { "protocol": self.protocol.id(), "name": name } }))
            .gas(tgas(100))
            .transact()
            .await?)
    }

    /// A live bounty that ends `SHORT_END_NS` from now, covering `address`.
    async fn post_short(&self, name: &str, address: &str) -> anyhow::Result<()> {
        let mut rules = rules(self, SHORT_END_NS, now_ns(self).await?);
        rules["covered_contracts"][0]["address"] = json!(address);
        self.post(name, &rules).await?.into_result()?;
        assert_eq!(self.bounty(name).await?["state"], "live");
        Ok(())
    }

    /// Move the sandbox's clock past the bounty's end date.
    async fn pass_end_date(&self, name: &str) -> anyhow::Result<()> {
        let end: u64 = self.bounty(name).await?["rules"]["end_date_ns"]
            .as_str()
            .unwrap()
            .parse()?;
        self.pass_time_to(end).await
    }

    /// Fast-forward until a block's time is past `ns`, in steps sized from how much time
    /// the last step moved, so a long wait takes few steps.
    async fn pass_time_to(&self, ns: u64) -> anyhow::Result<()> {
        let mut step = 20;
        loop {
            let before = now_ns(self).await?;
            if before > ns {
                return Ok(());
            }
            self.worker.fast_forward(step).await?;
            let moved = now_ns(self).await?.saturating_sub(before).max(1);
            let per_block = moved / step;
            step = ((ns - before).saturating_sub(moved) / per_block.max(1) + 5).clamp(5, 5_000);
        }
    }
}

const VAULT_W: &str = "0x00000000000000000000000000000000000000c1";

/// R10.1, R9.1, R12.3: before the end date even the posting Protocol is refused; after it,
/// with no payout made, the Protocol withdraws the whole bounty amount, exactly once. ZERO
/// and INVALID claims, resolved, don't stand in the way. A withdrawn bounty takes no more
/// claims and frees its covered contracts.
#[tokio::test]
async fn r9_1_r10_1_after_the_end_date_the_protocol_withdraws_the_whole_amount(
) -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let start = s.usdc_balance(s.protocol.id()).await?;
    s.post_short("vault", VAULT_W).await?;
    s.top_up(&s.whitehat, NearToken::from_near(1)).await?;
    for verdict in [ZERO, INVALID] {
        s.script(json!({ "output": verdict })).await?;
        s.submit_claim(&s.whitehat, "vault").await?.into_result()?;
    }

    let r = s.withdraw_bounty(&s.protocol, "vault").await?;
    assert!(failure_text(&r).contains("hasn't ended"), "{r:?}");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);
    assert_eq!(s.bounty("vault").await?["state"], "live");

    s.pass_end_date("vault").await?;
    s.withdraw_bounty(&s.protocol, "vault")
        .await?
        .into_result()?;
    assert_eq!(s.bounty("vault").await?["state"], "withdrawn");
    assert_eq!(s.usdc_balance(s.protocol.id()).await?, start);
    assert_eq!(s.usdc_balance(s.contract.id()).await?, 0);

    // Exactly once.
    let r = s.withdraw_bounty(&s.protocol, "vault").await?;
    assert!(failure_text(&r).contains("withdrawn"), "{r:?}");
    assert_eq!(s.usdc_balance(s.protocol.id()).await?, start);

    let r = s.submit_claim(&s.whitehat, "vault").await?;
    assert!(r.is_failure(), "{r:?}");

    // R12.3: its covered contract is free for a new bounty.
    s.post_short("vault-again", VAULT_W).await?;
    Ok(())
}

/// R9.2: after the end date, anyone but the posting Protocol is refused, the Whitehat
/// included, and nothing moves; the Protocol then withdraws.
#[tokio::test]
async fn r9_2_anyone_but_the_posting_protocol_is_refused() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    s.post_short("vault", VAULT_W).await?;
    s.pass_end_date("vault").await?;

    for who in [&s.whitehat, &s.other] {
        let r = s.withdraw_bounty(who, "vault").await?;
        assert!(failure_text(&r).contains("only the posting Protocol"), "{r:?}");
        assert_eq!(s.usdc_balance(who.id()).await?, 0);
    }
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);
    assert_eq!(s.bounty("vault").await?["state"], "live");

    s.withdraw_bounty(&s.protocol, "vault")
        .await?
        .into_result()?;
    assert_eq!(s.usdc_balance(s.contract.id()).await?, 0);
    Ok(())
}

/// One hour: how long a claim with no verdict holds its place, from its submission (the
/// `claim_place_hold_ns` the contract's `fees()` shows; #18's value).
const PLACE_HOLD_NS: u64 = 3_600_000_000_000;

/// R10.2: after the end date, a withdrawal is refused while any claim is unresolved: a
/// claim whose job is still running, and a claim whose job gave no verdict while it still
/// holds its place for a retry. Once the first is judged ZERO and the second's place has
/// lapsed, the Protocol withdraws.
#[tokio::test]
async fn r10_2_a_withdrawal_waits_for_every_unresolved_claim() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    s.post_short("vault", VAULT_W).await?;
    s.top_up(&s.whitehat, NearToken::from_near(2)).await?;
    assert_eq!(
        s.fees().await?["claim_place_hold_ns"],
        PLACE_HOLD_NS.to_string()
    );

    // A claim with no verdict, then a claim whose job is left running.
    s.script(json!({ "output": null })).await?;
    let no_verdict: u64 = s
        .submit_claim(&s.whitehat, "vault")
        .await?
        .into_result()?
        .json()?;
    let submitted: u64 = s.claim(no_verdict).await?["submitted_at_ns"]
        .as_str()
        .unwrap()
        .parse()?;
    let running = s
        .whitehat
        .call(s.contract.id(), "submit_claim")
        .args_json(s.claim_args("vault"))
        .gas(tgas(300))
        .transact_async()
        .await?;
    let jobs = s.wait_for_requests(3).await?;
    s.pass_end_date("vault").await?;
    assert_eq!(s.claim(1).await?["state"], "judging");

    let r = s.withdraw_bounty(&s.protocol, "vault").await?;
    assert!(failure_text(&r).contains("unresolved"), "{r:?}");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);

    // The running claim is judged; the no-verdict claim still holds its place.
    s.resolve(jobs[2]["id"].as_u64().unwrap(), Some(ZERO)).await?;
    running.await?.into_result()?;
    let r = s.withdraw_bounty(&s.protocol, "vault").await?;
    assert!(failure_text(&r).contains("unresolved"), "{r:?}");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);

    // Its place lapses: nothing is left unresolved.
    s.pass_time_to(submitted + PLACE_HOLD_NS).await?;
    s.withdraw_bounty(&s.protocol, "vault")
        .await?
        .into_result()?;
    assert_eq!(s.bounty("vault").await?["state"], "withdrawn");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, 0);
    Ok(())
}

/// R10.2, R9.1: a PAYS claim waiting for its pause signatures past the end date blocks the
/// withdrawal; once it is paid, no withdrawal is possible at all.
#[tokio::test]
async fn r10_2_a_pays_claim_waiting_for_its_pause_signatures_blocks_the_withdrawal(
) -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    s.post_short("vault", VAULT_W).await?;
    s.top_up(&s.whitehat, NearToken::from_near(1)).await?;
    let claim = s.submit_pays("vault").await?;
    s.sign_request_payload(0).await?;
    s.pass_end_date("vault").await?;
    // The signature request also times out unanswered: the claim waits for a retry.
    s.worker.fast_forward(250).await?;
    let id: u64 = claim.await?.into_result()?.json()?;
    s.wait_until_not_signing("vault").await?;
    assert_eq!(s.bounty("vault").await?["state"], "signing");

    let r = s.withdraw_bounty(&s.protocol, "vault").await?;
    assert!(failure_text(&r).contains("closed"), "{r:?}");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);

    let retry = s.sign_pauses("vault").await?;
    let payload = s.sign_request_payload(1).await?;
    s.respond(1, mpc::answer(&s.pause_key("vault"), &payload, false))
        .await?;
    retry.await?.into_result()?;
    s.wait_for_bounty_state("vault", "paid").await?;
    assert_eq!(s.bounty("vault").await?["winning_claim"], id);

    let r = s.withdraw_bounty(&s.protocol, "vault").await?;
    assert!(failure_text(&r).contains("closed"), "{r:?}");
    assert_eq!(s.usdc_balance(s.whitehat.id()).await?, BOUNTY_AMOUNT);
    assert_eq!(s.usdc_balance(s.contract.id()).await?, 0);
    Ok(())
}

/// R9.1, R2.3: a withdrawal whose USDC transfer the token refuses moves nothing and leaves
/// the bounty ended and live with its USDC held, so the Protocol can withdraw again; the
/// retry pays the whole amount once.
#[tokio::test]
async fn r9_1_a_refused_withdrawal_transfer_can_be_withdrawn_again() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    let start = s.usdc_balance(s.protocol.id()).await?;
    s.post_short("vault", VAULT_W).await?;
    s.pass_end_date("vault").await?;

    s.refuse_transfers(true).await?;
    let _ = s.withdraw_bounty(&s.protocol, "vault").await?;
    assert_eq!(s.bounty("vault").await?["state"], "live");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);
    assert_eq!(
        s.usdc_balance(s.protocol.id()).await?,
        start - BOUNTY_AMOUNT
    );

    s.refuse_transfers(false).await?;
    s.withdraw_bounty(&s.protocol, "vault")
        .await?
        .into_result()?;
    assert_eq!(s.bounty("vault").await?["state"], "withdrawn");
    assert_eq!(s.usdc_balance(s.protocol.id()).await?, start);
    assert_eq!(s.usdc_balance(s.contract.id()).await?, 0);
    Ok(())
}

/// R10.2 with retries (#18): a claim filed before the end date may be retried after it,
/// even once its place has lapsed; while that retry's job runs the withdrawal is refused,
/// and once the claim is judged ZERO the Protocol withdraws. Once withdrawn, the claim can't
/// be retried.
#[tokio::test]
async fn r10_2_a_retried_claim_blocks_the_withdrawal_while_it_is_judged() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    s.post_short("vault", VAULT_W).await?;
    s.top_up(&s.whitehat, NearToken::from_near(2)).await?;
    s.script(json!({ "output": null })).await?;
    let id: u64 = s
        .submit_claim(&s.whitehat, "vault")
        .await?
        .into_result()?
        .json()?;
    let submitted: u64 = s.claim(id).await?["submitted_at_ns"]
        .as_str()
        .unwrap()
        .parse()?;
    s.pass_time_to(submitted + PLACE_HOLD_NS).await?;
    assert_eq!(s.claim(id).await?["state"], "no_verdict");

    // No answer scripted: the retry's job stays running.
    let retry = s
        .whitehat
        .call(s.contract.id(), "retry_claim")
        .args_json(json!({ "claim_id": id, "proofs": PROOFS }))
        .gas(tgas(300))
        .transact_async()
        .await?;
    let jobs = s.wait_for_requests(3).await?;
    assert_eq!(s.claim(id).await?["state"], "judging");
    let r = s.withdraw_bounty(&s.protocol, "vault").await?;
    assert!(failure_text(&r).contains("unresolved"), "{r:?}");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);

    s.resolve(jobs[2]["id"].as_u64().unwrap(), Some(ZERO)).await?;
    retry.await?.into_result()?;
    s.withdraw_bounty(&s.protocol, "vault")
        .await?
        .into_result()?;
    assert_eq!(s.bounty("vault").await?["state"], "withdrawn");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, 0);
    Ok(())
}

/// R10.2 (code review of #19): a claim retried after its place lapsed is open again while its
/// job runs, and stays open when another claim's submission and verdict drop the lapsed
/// places: after the end date the withdrawal is refused until the retried claim is judged.
#[tokio::test]
async fn r10_2_a_retried_lapsed_claim_still_blocks_the_withdrawal_after_another_claim(
) -> anyhow::Result<()> {
    // A day node: an hour passes in a few dozen blocks, well inside a job's 200-block yield.
    let s = Sandbox::start_with_days().await?;
    // Ends half an hour after the first claim's place lapses, so a second claim fits before.
    let mut r = rules(&s, PLACE_HOLD_NS + 1_800_000_000_000, now_ns(&s).await?);
    r["covered_contracts"][0]["address"] = json!(VAULT_W);
    s.post("vault", &r).await?.into_result()?;
    s.top_up(&s.whitehat, NearToken::from_near(2)).await?;
    s.top_up(&s.other, NearToken::from_near(1)).await?;
    s.script(json!({ "output": null })).await?;
    let id: u64 = s
        .submit_claim(&s.whitehat, "vault")
        .await?
        .into_result()?
        .json()?;
    let submitted: u64 = s.claim(id).await?["submitted_at_ns"]
        .as_str()
        .unwrap()
        .parse()?;
    s.pass_time_to(submitted + PLACE_HOLD_NS).await?;

    // No answer scripted: the retry's job stays running.
    let retry = s
        .whitehat
        .call(s.contract.id(), "retry_claim")
        .args_json(json!({ "claim_id": id, "proofs": PROOFS }))
        .gas(tgas(300))
        .transact_async()
        .await?;
    let jobs = s.wait_for_requests(3).await?;
    assert_eq!(s.claim(id).await?["state"], "judging");

    // Another Whitehat's claim, judged ZERO at once: its submission and its verdict each drop
    // the places that have lapsed.
    s.script(json!({ "output": ZERO })).await?;
    let second: u64 = s
        .submit_claim(&s.other, "vault")
        .await?
        .into_result()?
        .json()?;
    assert_eq!(s.claim(second).await?["state"], "judged");
    assert_eq!(s.claim(id).await?["state"], "judging");

    s.pass_end_date("vault").await?;
    let r = s.withdraw_bounty(&s.protocol, "vault").await?;
    assert!(failure_text(&r).contains("unresolved"), "{r:?}");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);

    s.resolve(jobs[2]["id"].as_u64().unwrap(), Some(ZERO)).await?;
    retry.await?.into_result()?;
    s.withdraw_bounty(&s.protocol, "vault")
        .await?
        .into_result()?;
    assert_eq!(s.bounty("vault").await?["state"], "withdrawn");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, 0);
    Ok(())
}

/// R10.2 with ordering (#18): a PAYS claim whose payout waits behind an earlier claim with
/// no verdict blocks the withdrawal after the end date, as does the earlier claim.
#[tokio::test]
async fn r10_2_a_pays_claim_waiting_for_its_payout_blocks_the_withdrawal() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;
    s.post_short("vault", VAULT_W).await?;
    s.top_up(&s.whitehat, NearToken::from_near(2)).await?;
    s.script(json!({ "output": null })).await?;
    s.submit_claim(&s.whitehat, "vault").await?.into_result()?;
    let winner = s.judge_pays("vault").await?;
    // Every pause is signed; the payout waits behind the earlier claim's place.
    let bounty = s.wait_for_bounty_state("vault", "paying").await?;
    assert_eq!(bounty["paying_out"], false, "{bounty}");
    assert!(bounty["payout_waits_until_ns"].is_string(), "{bounty}");
    assert_eq!(bounty["winning_claim"], winner);
    s.pass_end_date("vault").await?;

    let r = s.withdraw_bounty(&s.protocol, "vault").await?;
    assert!(failure_text(&r).contains("closed"), "{r:?}");
    assert_eq!(s.usdc_balance(s.contract.id()).await?, BOUNTY_AMOUNT);
    assert_eq!(s.usdc_balance(s.protocol.id()).await?, 9 * BOUNTY_AMOUNT);
    Ok(())
}

