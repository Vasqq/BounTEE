//! Test stand-in for a proof chain's JSON-RPC endpoint (seam J, ticket #14).
//!
//! The pinned RPCs are outside the system, so the block-confirmation tests answer for
//! them with these local HTTP servers. Each answers `eth_getBlockByNumber` the way the
//! test scripts it: with a given block hash, with a JSON-RPC error, or not at all (its
//! port refuses connections). They live only in the test folder and are reached only by
//! the judge's test build (feature `test-stand-in-rpcs`), never by the attested build.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// How a test stand-in RPC answers.
#[derive(Clone)]
pub enum Answer {
    /// The block at the asked number has this hash.
    Hash(String),
    /// A JSON-RPC error, as a rate-limited or failing RPC sends.
    Error,
    /// Nothing: connections are refused.
    Down,
}

pub struct TestRpc {
    pub url: String,
    requests: Arc<AtomicUsize>,
}

impl TestRpc {
    pub fn answering(answer: Answer) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        if let Answer::Down = answer {
            drop(listener);
            return TestRpc { url, requests };
        }
        let count = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                count.fetch_add(1, Ordering::SeqCst);
                let _ = serve(stream, &answer);
            }
        });
        TestRpc { url, requests }
    }

    /// How many requests reached this stand-in.
    pub fn requests(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }
}

fn serve(stream: TcpStream, answer: &Answer) -> std::io::Result<()> {
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
    let request: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
    let number = request["params"][0].clone();
    let reply = match answer {
        Answer::Hash(hash) => serde_json::json!({
            "jsonrpc": "2.0", "id": request["id"],
            "result": { "number": number, "hash": hash },
        }),
        Answer::Error => serde_json::json!({
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
        reply.len(),
        reply
    )?;
    stream.flush()
}
