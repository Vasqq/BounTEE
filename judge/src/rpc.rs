//! JSON-RPC over `wasi:http`, the only network the judge has (OutLayer gives HTTP to
//! WASI Preview 2 jobs only; spec, judge Build). Used by block confirmation (`confirm.rs`).
//!
//! Every request carries short timeouts of its own: OutLayer cuts a request at 30 s and
//! aborts the whole job on a second such timeout, so a slow RPC must end here first and
//! count as not answering. Requests are all sent before any answer is awaited, so the
//! RPCs answer concurrently.
//!
//! Off WebAssembly (the host build that `cargo test` compiles alongside the tests) there
//! is no `wasi:http`, so every request goes unanswered; the judge only ever runs as its
//! wasm32-wasip2 build.

use serde_json::Value;

/// Post each JSON-RPC `body` to its URL, concurrently; each answer is the response's
/// `result`, or `None` for an RPC that didn't answer with one (unreachable, timed out,
/// a non-200 status, a JSON-RPC error, or a body that isn't JSON).
pub fn call_all(requests: &[(String, String)]) -> Vec<Option<Value>> {
    imp::call_all(requests)
}

#[cfg(target_os = "wasi")]
mod imp {
    use serde_json::Value;
    use wasi::http::outgoing_handler::{self, FutureIncomingResponse};
    use wasi::http::types::{
        Fields, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme,
    };
    use wasi::io::streams::StreamError;

    const SECOND_NS: u64 = 1_000_000_000;
    const CONNECT_TIMEOUT_NS: u64 = 5 * SECOND_NS;
    const FIRST_BYTE_TIMEOUT_NS: u64 = 10 * SECOND_NS;
    const BETWEEN_BYTES_TIMEOUT_NS: u64 = 5 * SECOND_NS;
    /// A header-only `eth_getBlockByNumber` answer is a few kilobytes; refuse floods.
    const MAX_BODY: usize = 1 << 20;

    pub fn call_all(requests: &[(String, String)]) -> Vec<Option<Value>> {
        let pending: Vec<Option<FutureIncomingResponse>> =
            requests.iter().map(|(url, body)| send(url, body)).collect();
        pending
            .into_iter()
            .map(|future| future.and_then(receive))
            .collect()
    }

    fn send(url: &str, body: &str) -> Option<FutureIncomingResponse> {
        let (scheme, rest) = url.split_once("://")?;
        let scheme = match scheme {
            "https" => Scheme::Https,
            "http" => Scheme::Http,
            _ => return None,
        };
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, "/"),
        };
        let headers = Fields::from_list(&[
            ("content-type".to_owned(), b"application/json".to_vec()),
            (
                "content-length".to_owned(),
                body.len().to_string().into_bytes(),
            ),
        ])
        .ok()?;
        let request = OutgoingRequest::new(headers);
        request.set_method(&Method::Post).ok()?;
        request.set_scheme(Some(&scheme)).ok()?;
        request.set_authority(Some(authority)).ok()?;
        request.set_path_with_query(Some(path)).ok()?;
        let outgoing = request.body().ok()?;
        {
            let stream = outgoing.write().ok()?;
            // blocking_write_and_flush takes at most 4096 bytes per call.
            for chunk in body.as_bytes().chunks(4096) {
                stream.blocking_write_and_flush(chunk).ok()?;
            }
        }
        OutgoingBody::finish(outgoing, None).ok()?;
        let options = RequestOptions::new();
        // A host that doesn't support a timeout refuses to set it; the request still runs.
        let _ = options.set_connect_timeout(Some(CONNECT_TIMEOUT_NS));
        let _ = options.set_first_byte_timeout(Some(FIRST_BYTE_TIMEOUT_NS));
        let _ = options.set_between_bytes_timeout(Some(BETWEEN_BYTES_TIMEOUT_NS));
        outgoing_handler::handle(request, Some(options)).ok()
    }

    fn receive(future: FutureIncomingResponse) -> Option<Value> {
        future.subscribe().block();
        let response = future.get()?.ok()?.ok()?;
        if response.status() != 200 {
            return None;
        }
        let incoming = response.consume().ok()?;
        let mut body = Vec::new();
        {
            let stream = incoming.stream().ok()?;
            loop {
                match stream.blocking_read(64 * 1024) {
                    Ok(chunk) => {
                        body.extend_from_slice(&chunk);
                        if body.len() > MAX_BODY {
                            return None;
                        }
                    }
                    Err(StreamError::Closed) => break,
                    Err(_) => return None,
                }
            }
        }
        let answer: Value = serde_json::from_slice(&body).ok()?;
        match answer.get("result") {
            Some(result) if !result.is_null() => Some(result.clone()),
            _ => None,
        }
    }
}

#[cfg(not(target_os = "wasi"))]
mod imp {
    use serde_json::Value;

    pub fn call_all(requests: &[(String, String)]) -> Vec<Option<Value>> {
        requests.iter().map(|_| None).collect()
    }
}
