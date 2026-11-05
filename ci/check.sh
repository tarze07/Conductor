#!/usr/bin/env bash
# Pelny zestaw kontroli: fmt, clippy, test, cargo-deny, cargo-audit.
# Uzycie: ci/check.sh [fmt|clippy|test|deny|audit|all]   (domyslnie: all)
# Zmienna REQUIRE_TOOLS=1 (ustawiana w CI) powoduje blad, gdy brakuje cargo-deny/cargo-audit.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$(repo_root)"

step="${1:-all}"
pkgs="$(workspace_packages)"
echo "Pakiety w workspace: ${pkgs}"

# Uwaga: przy pustym crates/ sam cargo konczy sie bledem ("failed to load manifest for
# workspace member crates/*"), wiec wszystkie kroki cargo sa wtedy pomijane.
run_fmt() {
  [ "$pkgs" -gt 0 ] || { echo "fmt: brak crate'ow, pomijam"; return 0; }
  cargo fmt --all -- --check
}
run_clippy() {
  [ "$pkgs" -gt 0 ] || { echo "clippy: brak crate'ow, pomijam"; return 0; }
  cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
}
run_test() {
  [ "$pkgs" -gt 0 ] || { echo "test: brak crate'ow, pomijam"; return 0; }
  cargo test --workspace --all-features --locked
}
run_tool() {
  local sub="$1"; shift
  if ! cargo "$sub" --version >/dev/null 2>&1; then
    if [ "${REQUIRE_TOOLS:-0}" = "1" ]; then echo "BLAD: brak cargo-${sub}" >&2; return 1; fi
    echo "UWAGA: brak cargo-${sub}, pomijam (ustaw REQUIRE_TOOLS=1, aby wymusic)"; return 0
  fi
  "$@"
}
run_deny() {
  # Bez Cargo.lock (brak crate'ow) cargo-deny --locked by sie wywrocil.
  [ -f Cargo.lock ] || { echo "deny: brak Cargo.lock (pusty workspace), pomijam"; return 0; }
  run_tool deny cargo deny --locked check
}
run_audit() {
  [ -f Cargo.lock ] || { echo "audit: brak Cargo.lock (pusty workspace), pomijam"; return 0; }
  run_tool audit cargo audit --deny warnings
}

case "$step" in
  fmt) run_fmt ;;
  clippy) run_clippy ;;
  test) run_test ;;
  deny) run_deny ;;
  audit) run_audit ;;
  all) run_fmt; run_clippy; run_test; run_deny; run_audit ;;
  *) echo "Nieznany krok: $step" >&2; exit 2 ;;
esac
echo "OK: ${step}"
