//! Helpers the seam J test files share.

use std::path::PathBuf;

/// The repository's root.
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

/// The judge's WebAssembly target: the single setting in `judge/wasm-target`.
pub fn wasm_target() -> String {
    std::fs::read_to_string(repo_root().join("judge/wasm-target"))
        .unwrap()
        .trim()
        .to_owned()
}
