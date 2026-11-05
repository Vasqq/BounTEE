//! TEST STAND-IN for OutLayer (`outlayer.testnet`). Lives only in the test folder and is
//! deployed only to the local sandbox. Seam C tests use it to answer the bounty contract's
//! job requests with success or failure on demand, including failures testnet can't
//! trigger at will. That the real OutLayer behaves this way is proven at seam T.
//!
//! What it copies from the real contract (`fastnear/near-outlayer`, `contract/src`, read
//! Nov 4): the `request_execution` and `store_secrets` argument names; a job's result
//! reaches the caller's callback as the yield callback's return value, with a refused or
//! failed job delivered as a successful `null` (spike #1); `store_secrets` overwrites an
//! existing row under the same owner and profile.
//!
//! How a test drives it:
//! - `script(answer)` queues an answer; each `request_execution` takes the next one.
//!   `{"output": <json>}` returns that JSON (`null` for a refused job), `{"fail": true}`
//!   hands the caller a failed promise (its deposit sent back). With no answer queued the
//!   job stays pending (a yield) until a test calls `resolve(request_id, output)`.
//!   `{"outlive": true}` leaves the job pending too, but when its yield lapses (about 200
//!   blocks) it opens another in its place, once: the caller's callback lands only after
//!   about 400 blocks, or when a test resolves it, as a lost or late callback would.
//! - `requests()` and `secret(owner, profile)` read back exactly what the caller sent.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use near_sdk::store::{IterableMap, Vector};
use near_sdk::{env, near, AccountId, Gas, GasWeight, Promise, PromiseResult, YieldId};

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Answer {
    /// The job's output, as OutLayer hands it to the callback (`null` = refused or failed).
    pub output: Option<String>,
    /// Make `request_execution` itself panic, so the caller sees a failed promise.
    pub fail: Option<bool>,
    /// Keep the job pending past its first yield's timeout (a late callback).
    pub outlive: Option<bool>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Request {
    pub id: u64,
    /// The account that called `request_execution` (OutLayer's `NEAR_PREDECESSOR_ID`).
    pub predecessor: AccountId,
    /// JSON text of each argument as received.
    pub source: String,
    pub resource_limits: Option<String>,
    pub input_data: Option<String>,
    pub secrets_ref: Option<String>,
    pub response_format: Option<String>,
    pub payer_account_id: Option<AccountId>,
    pub deposit: U128,
    /// Whether a test has resolved it yet (scripted answers are resolved at once).
    pub resolved: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Secret {
    pub accessor: String,
    pub encrypted_secrets_base64: String,
    pub access: String,
    pub deposit: U128,
    /// How many times `store_secrets` wrote this row (the real one overwrites silently).
    pub stores: u32,
}

#[near(contract_state)]
pub struct TestOutlayer {
    answers: Vector<Answer>,
    next_answer: u32,
    requests: Vector<Request>,
    yields: IterableMap<u64, YieldId>,
    secrets: IterableMap<String, Secret>,
    fail_store: bool,
    /// Requests whose first yield, on lapsing, opens a second.
    outliving: IterableMap<u64, bool>,
}

impl Default for TestOutlayer {
    fn default() -> Self {
        Self {
            answers: Vector::new(b"a"),
            next_answer: 0,
            requests: Vector::new(b"r"),
            yields: IterableMap::new(b"y"),
            secrets: IterableMap::new(b"s"),
            fail_store: false,
            outliving: IterableMap::new(b"o"),
        }
    }
}

fn text(v: &Value) -> String {
    serde_json::to_string(v).unwrap()
}

/// The bytes OutLayer returns for an output: the JSON as given, or `null`.
fn output_bytes(output: &Option<String>) -> Vec<u8> {
    output
        .clone()
        .unwrap_or_else(|| "null".to_owned())
        .into_bytes()
}

#[near]
impl TestOutlayer {
    /// Names this contract as a test stand-in, so a test can't mistake it for the real one.
    pub fn stand_in_for(&self) -> String {
        "OutLayer".to_owned()
    }

    /// Queue the answer for the next job request.
    pub fn script(&mut self, answer: Answer) {
        self.answers.push(answer);
    }

    /// Make every later `store_secrets` fail (or succeed again).
    pub fn set_fail_store(&mut self, fail: bool) {
        self.fail_store = fail;
    }

    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<Value>,
        payer_account_id: Option<AccountId>,
        params: Option<Value>,
    ) {
        let _ = params;
        let answer = self.answers.get(self.next_answer).cloned();
        if answer.is_some() {
            self.next_answer += 1;
        }
        if let Some(Answer {
            fail: Some(true), ..
        }) = answer
        {
            // Fail the caller's promise without reverting this call, so the scripted answer
            // is used up; the deposit goes back as a refused call's would.
            Promise::new(env::predecessor_account_id())
                .transfer(env::attached_deposit())
                .detach();
            let _ = Promise::new(env::current_account_id())
                .function_call(
                    "fail_as_scripted".to_owned(),
                    Vec::new(),
                    near_sdk::NearToken::from_yoctonear(0),
                    Gas::from_tgas(3),
                )
                .as_return();
            return;
        }
        let id = self.requests.len() as u64;
        self.requests.push(Request {
            id,
            predecessor: env::predecessor_account_id(),
            source: text(&source),
            resource_limits: resource_limits.as_ref().map(text),
            input_data,
            secrets_ref: secrets_ref.as_ref().map(text),
            response_format: response_format.as_ref().map(text),
            payer_account_id,
            deposit: U128(env::attached_deposit().as_yoctonear()),
            resolved: answer.is_some(),
        });
        match answer {
            Some(Answer {
                outlive: Some(true),
                ..
            }) => {
                self.requests
                    .get_mut(id as u32)
                    .expect("pushed above")
                    .resolved = false;
                self.outliving.insert(id, true);
                let args = serde_json::json!({ "request_id": id }).to_string();
                // Room for the callback to open the second yield.
                let (promise, yield_id) = Promise::new_yield(
                    "on_execution_response",
                    args,
                    Gas::from_tgas(40),
                    GasWeight(0),
                );
                self.yields.insert(id, yield_id);
                let _ = promise.as_return();
            }
            Some(a) => env::value_return(output_bytes(&a.output)),
            None => {
                let args = serde_json::json!({ "request_id": id }).to_string();
                let (promise, yield_id) = Promise::new_yield(
                    "on_execution_response",
                    args,
                    Gas::from_tgas(10),
                    GasWeight(0),
                );
                self.yields.insert(id, yield_id);
                let _ = promise.as_return();
            }
        }
    }

    /// The failed promise a `{"fail": true}` answer hands its caller.
    #[private]
    pub fn fail_as_scripted(&self) {
        env::panic_str("test stand-in: request_execution failed as scripted");
    }

    /// Answer a pending job: `output` is the job's JSON, or `None` for a refused job.
    pub fn resolve(&mut self, request_id: u64, output: Option<String>) {
        let yield_id = self.yields.remove(&request_id).expect("no pending request");
        yield_id
            .resume(output_bytes(&output))
            .expect("yield already resumed or timed out");
        if let Some(r) = self.requests.get_mut(request_id as u32) {
            r.resolved = true;
        }
    }

    /// The yield callback: hands the resumed bytes back as the job's result, and `null`
    /// on a timeout, as OutLayer does.
    #[private]
    pub fn on_execution_response(&mut self, request_id: u64) {
        #[allow(deprecated)]
        let bytes = match env::promise_result(0) {
            PromiseResult::Successful(b) => b,
            PromiseResult::Failed => {
                if self.outliving.remove(&request_id).is_some() {
                    // The first yield lapsed: open another, and hand its result on.
                    let args = serde_json::json!({ "request_id": request_id }).to_string();
                    let (promise, yield_id) = Promise::new_yield(
                        "on_execution_response",
                        args,
                        Gas::from_tgas(10),
                        GasWeight(0),
                    );
                    self.yields.insert(request_id, yield_id);
                    let _ = promise.as_return();
                    return;
                }
                b"null".to_vec()
            }
        };
        env::value_return(bytes);
    }

    #[payable]
    pub fn store_secrets(
        &mut self,
        accessor: Value,
        profile: String,
        encrypted_secrets_base64: String,
        access: Value,
        vault_id: Option<AccountId>,
    ) {
        let _ = vault_id;
        if self.fail_store {
            env::panic_str("test stand-in: store_secrets failed as scripted");
        }
        let key = format!("{}/{}", env::predecessor_account_id(), profile);
        let stores = self.secrets.get(&key).map_or(0, |s| s.stores) + 1;
        self.secrets.insert(
            key,
            Secret {
                accessor: text(&accessor),
                encrypted_secrets_base64,
                access: text(&access),
                deposit: U128(env::attached_deposit().as_yoctonear()),
                stores,
            },
        );
    }

    pub fn requests(&self) -> Vec<Request> {
        self.requests.iter().cloned().collect()
    }

    pub fn secret(&self, owner: AccountId, profile: String) -> Option<Secret> {
        self.secrets.get(&format!("{owner}/{profile}")).cloned()
    }

    /// Every stored row's key (`owner/profile`) and how many times it was written.
    pub fn secret_rows(&self) -> Vec<(String, u32)> {
        self.secrets
            .iter()
            .map(|(k, s)| (k.clone(), s.stores))
            .collect()
    }
}
