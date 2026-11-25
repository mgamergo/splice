#!/usr/bin/env bash
# Rebuilds the compositor WebAssembly that apps/web imports as `opencut-wasm`.
# The built files are committed, so only changes to rust/ need this.
#
# Needs: Rust with the wasm32-unknown-unknown target, wasm-bindgen-cli 0.2.116
# (the version in Cargo.lock) and binaryen's wasm-opt, all on PATH.
set -euo pipefail
cd "$(dirname "$0")"
target="${CARGO_TARGET_DIR:-target}"
cargo build --release --target wasm32-unknown-unknown -p opencut-wasm
wasm-bindgen --target bundler --out-dir . "$target/wasm32-unknown-unknown/release/opencut_wasm.wasm"
rm -f opencut_wasm_bg.wasm.d.ts
# wasm-pack's default optimization, which the published package used.
wasm-opt -O --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
	--enable-mutable-globals --enable-reference-types --enable-multivalue \
	opencut_wasm_bg.wasm -o opencut_wasm_bg.wasm
