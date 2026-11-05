#!/usr/bin/env bash
# Wspolne funkcje dla skryptow ci/. Uzywane lokalnie i na dowolnym CI.
set -euo pipefail

repo_root() { cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd; }

# Liczba pakietow w workspace (0, gdy crates/ jest jeszcze pusty lub nie istnieje).
workspace_packages() {
  cargo metadata --no-deps --format-version 1 2>/dev/null \
    | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["packages"]))' 2>/dev/null \
    || echo 0
}
