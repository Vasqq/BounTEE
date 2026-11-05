//! Test stand-in for a covered chain's JSON-RPC endpoint (seam J, ticket #17).
//!
//! The posting check reads each covered chain through the RPCs pinned in the judge's
//! build, which are outside the system, so these local HTTP servers answer for them. Each
//! holds its own scripted chain: a head block number, and per address its code, its
//! balance, and who (if anyone) may call `pause()` on it. A stand-in can also answer every
//! request with a JSON-RPC error, or refuse connections, as a failing RPC does. Two
//! stand-ins with different chains are two RPCs that disagree.
//!
//! It answers `eth_blockNumber`, `eth_getCode`, `eth_getBalance` and `eth_call` the way a
//! node does: a call to an address with no code succeeds with empty output, and a
//! reverting call is a JSON-RPC error with code 3, "execution reverted". It records every
//! request so a test can check what the judge asked. Lives only in the test folder and is
//! reached only by the judge's test build (feature `test-stand-in-rpcs`).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

/// One scripted contract or account.
#[derive(Clone, Default)]
pub struct Account {
    /// Whether the address holds code.
    pub code: bool,
    /// Wei.
    pub balance: u128,
    /// The address `pause()` succeeds from, if any (the pause-role holder).
    pub pauser: Option<String>,
}

/// A scripted chain as one RPC sees it.
#[derive(Clone, Default)]
pub struct Chain {
    pub head: u64,
    pub accounts: HashMap<String, Account>,
}

impl Chain {
    pub fn at(head: u64) -> Self {
        Chain {
            head,
            accounts: HashMap::new(),
        }
    }

    /// A contract whose `pause()` succeeds only from `pauser` (`None`: from nobody).
    pub fn contract(mut self, address: &str, pauser: Option<&str>) -> Self {
        self.accounts.insert(
            address.to_lowercase(),
            Account {
                code: true,
                balance: 0,
                pauser: pauser.map(str::to_lowercase),
            },
        );
        self
    }

    pub fn balance(mut self, address: &str, wei: u128) -> Self {
        self.accounts
            .entry(address.to_lowercase())
            .or_default()
            .balance = wei;
        self
    }
}

/// How a test stand-in RPC answers.
#[derive(Clone)]
pub enum Answer {
    Chain(Chain),
    /// A JSON-RPC error for every request, as a rate-limited RPC sends.
    Error,
    /// Nothing: connections are refused.
    Down,
}

pub struct TestChainRpc {
    pub url: String,
    requests: Arc<Mutex<Vec<Value>>>,
}

impl TestChainRpc {
    pub fn answering(answer: Answer) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        if let Answer::Down = answer {
            drop(listener);
            return TestChainRpc { url, requests };
        }
        let log = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = serve(stream, &answer, &log);
            }
        });
        TestChainRpc { url, requests }
    }

    /// Every JSON-RPC request this stand-in received.
    pub fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }
}

fn hex(n: u128) -> String {
    format!("{n:#x}")
}

fn reply(chain: &Chain, request: &Value) -> Value {
    let params = &request["params"];
    let account = |a: &Value| {
        chain
            .accounts
            .get(&a.as_str().unwrap_or_default().to_lowercase())
            .cloned()
            .unwrap_or_default()
    };
    let result = match request["method"].as_str().unwrap_or_default() {
        "eth_blockNumber" => json!(hex(chain.head.into())),
        "eth_getCode" => json!(if account(&params[0]).code {
            "0x6080604052"
        } else {
            "0x"
        }),
        "eth_getBalance" => json!(hex(account(&params[0]).balance)),
        "eth_call" => {
            let call = &params[0];
            let callee = account(&call["to"]);
            let from = call["from"].as_str().unwrap_or_default().to_lowercase();
            if callee.code && callee.pauser.as_deref() != Some(from.as_str()) {
                return json!({
                    "jsonrpc": "2.0", "id": request["id"],
                    "error": { "code": 3, "message": "execution reverted", "data": "0x" },
                });
            }
            json!("0x")
        }
        _ => {
            return json!({
                "jsonrpc": "2.0", "id": request["id"],
                "error": { "code": -32601, "message": "method not found" },
            })
        }
    };
    json!({ "jsonrpc": "2.0", "id": request["id"], "result": result })
}

fn serve(stream: TcpStream, answer: &Answer, log: &Mutex<Vec<Value>>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut length = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        if line == "\r\n" || line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let request: Value = serde_json::from_slice(&body).unwrap_or_default();
    log.lock().unwrap().push(request.clone());
    let answer = match answer {
        Answer::Chain(chain) => reply(chain, &request),
        Answer::Error => json!({
            "jsonrpc": "2.0", "id": request["id"],
            "error": { "code": -32005, "message": "rate limited" },
        }),
        Answer::Down => unreachable!(),
    }
    .to_string();
    let mut stream = stream;
    write!(
        stream,
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        answer.len(),
        answer
    )?;
    stream.flush()
}
