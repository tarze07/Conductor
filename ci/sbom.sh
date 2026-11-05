#!/usr/bin/env bash
# Generuje SBOM CycloneDX (JSON) dla kazdego crate'a workspace'u do katalogu ${1:-target/sbom}.
# Wymaga: cargo-cyclonedx (cargo install cargo-cyclonedx --locked).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$(repo_root)"

out="${1:-target/sbom}"
mkdir -p "$out"

if [ "$(workspace_packages)" -eq 0 ]; then
  echo "sbom: workspace nie ma jeszcze crate'ow, zapisuje pusty marker"
  printf '{"note":"workspace without crates"}\n' > "$out/EMPTY.json"
  exit 0
fi

cargo cyclonedx --version >/dev/null 2>&1 || { echo "BLAD: brak cargo-cyclonedx" >&2; exit 1; }
cargo cyclonedx --format json --spec-version 1.5
# cargo-cyclonedx zapisuje <crate>.cdx.json obok Cargo.toml kazdego crate'a; zbieramy je.
find crates -name '*.cdx.json' -print0 | while IFS= read -r -d '' f; do
  mv "$f" "$out/"
done
ls -l "$out"
