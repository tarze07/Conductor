#!/usr/bin/env bash
# run-sandboxed.sh - uruchamia komende agenta w sandboksie z siecia tylko przez Egress Guard.
#
# Uzycie:
#   run-sandboxed.sh [opcje] <worktree_dir> -- <komenda> [arg...]
#
# Opcje (albo zmienne srodowiskowe):
#   --allowlist FILE   (SANDBOX_ALLOWLIST)  domyslnie ./allowlist.txt obok skryptu
#   --audit-log FILE   (SANDBOX_AUDIT_LOG)  domyslnie <worktree>/../egress-audit.jsonl
#   --backend NAME     (SANDBOX_BACKEND)    auto | bwrap | unshare  (domyslnie auto)
#   --ro PATH          (SANDBOX_RO_PATHS, lista rozdzielona ':') dodatkowe toolchainy read-only
#   --pass-env NAME    (SANDBOX_PASS_ENV, lista ':') zmienne przekazywane do sandboksa
#   --id NAME          (SANDBOX_ID)         identyfikator sandboksa w audycie
#
# Co sie dzieje:
#   1. na hoscie startuje egress-proxy.py na unix sockecie w prywatnym katalogu stanu,
#   2. komenda startuje w nowych namespace'ach: net (tylko lo), mount, pid, ipc, uts
#      (+ user, gdy skrypt nie jest uruchomiony jako root),
#   3. w sandboksie widac: /usr i /etc (ro), dodatkowe --ro, worktree (rw), puste /tmp i /run,
#   4. jedyne wyjscie sieciowe: HTTPS_PROXY=http://127.0.0.1:3128 -> most -> unix socket -> proxy,
#   5. srodowisko jest czyszczone (env -i); przekazywane sa tylko zmienne z --pass-env,
#   6. po zakonczeniu komendy proxy jest zatrzymywane, katalog stanu usuwany.
#      Namespace'y znikaja razem z procesami; skrypt nie tworzy niczego w netns hosta.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-$(command -v python3)}"

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

ALLOWLIST="${SANDBOX_ALLOWLIST:-$SCRIPT_DIR/allowlist.txt}"
AUDIT_LOG="${SANDBOX_AUDIT_LOG:-}"
BACKEND="${SANDBOX_BACKEND:-auto}"
SANDBOX_ID="${SANDBOX_ID:-}"
IFS=':' read -r -a RO_PATHS <<< "${SANDBOX_RO_PATHS:-}"
IFS=':' read -r -a PASS_ENV <<< "${SANDBOX_PASS_ENV:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allowlist) ALLOWLIST="$2"; shift 2 ;;
    --audit-log) AUDIT_LOG="$2"; shift 2 ;;
    --backend)   BACKEND="$2"; shift 2 ;;
    --ro)        RO_PATHS+=("$2"); shift 2 ;;
    --pass-env)  PASS_ENV+=("$2"); shift 2 ;;
    --id)        SANDBOX_ID="$2"; shift 2 ;;
    -h|--help)   usage ;;
    --) usage ;;
    -*) echo "nieznana opcja: $1" >&2; usage ;;
    *) break ;;
  esac
done
[[ $# -ge 3 && "$2" == "--" ]] || usage
WORKTREE="$(realpath -e "$1")"; shift 2
[[ -d "$WORKTREE" ]] || { echo "worktree nie jest katalogiem: $WORKTREE" >&2; exit 2; }
ALLOWLIST="$(realpath -e "$ALLOWLIST")"
AUDIT_LOG="${AUDIT_LOG:-$(dirname "$WORKTREE")/egress-audit.jsonl}"
SANDBOX_ID="${SANDBOX_ID:-$(basename "$WORKTREE")-$$}"

if [[ "$BACKEND" == auto ]]; then
  if command -v bwrap >/dev/null 2>&1; then BACKEND=bwrap; else BACKEND=unshare; fi
fi
case "$BACKEND" in bwrap|unshare) ;; *) echo "nieznany backend: $BACKEND" >&2; exit 2 ;; esac

# --- katalog stanu (prywatny, usuwany przy wyjsciu) --------------------------------
STATE="$(mktemp -d "${TMPDIR:-/tmp}/conductor-sbx.XXXXXX")"
chmod 700 "$STATE"
mkdir -m 700 "$STATE/egress" "$STATE/root"
PROXY_PID=""
cleanup() {
  if [[ -n "$PROXY_PID" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill -TERM "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
  rm -rf "$STATE"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# --- Egress Guard ------------------------------------------------------------------
"$PYTHON" -I "$SCRIPT_DIR/egress-proxy.py" \
  --listen-unix "$STATE/egress/egress.sock" \
  --allowlist "$ALLOWLIST" --audit-log "$AUDIT_LOG" --sandbox-id "$SANDBOX_ID" \
  </dev/null &
PROXY_PID=$!
for _ in $(seq 1 100); do
  [[ -S "$STATE/egress/egress.sock" ]] && break
  kill -0 "$PROXY_PID" 2>/dev/null || { echo "egress-proxy nie wystartowal" >&2; exit 125; }
  sleep 0.05
done
[[ -S "$STATE/egress/egress.sock" ]] || { echo "egress-proxy: brak socketu" >&2; exit 125; }

# --- srodowisko sandboksa (allowlista zmiennych, bez sekretow hosta) ---------------
PROXY_URL="http://127.0.0.1:3128"
ENV_ARGS=(
  "PATH=/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"
  "HOME=/tmp" "TMPDIR=/tmp" "LANG=${LANG:-C.UTF-8}" "TERM=${TERM:-dumb}"
  "HTTPS_PROXY=$PROXY_URL" "https_proxy=$PROXY_URL"
  "HTTP_PROXY=$PROXY_URL" "http_proxy=$PROXY_URL"
  "ALL_PROXY=$PROXY_URL" "all_proxy=$PROXY_URL"
  "NO_PROXY=" "no_proxy="
  "CONDUCTOR_SANDBOX=1" "CONDUCTOR_SANDBOX_ID=$SANDBOX_ID"
)
[[ -n "${CONDUCTOR_SANDBOX_DEBUG:-}" ]] && ENV_ARGS+=("CONDUCTOR_SANDBOX_DEBUG=$CONDUCTOR_SANDBOX_DEBUG")
for name in "${PASS_ENV[@]}"; do
  [[ -n "$name" && -n "${!name+x}" ]] && ENV_ARGS+=("$name=${!name}")
done

INIT_ARGS=(--worktree "$WORKTREE")
for p in "${RO_PATHS[@]}"; do [[ -n "$p" ]] && INIT_ARGS+=(--ro-path "$(realpath -e "$p")"); done

rc=0
if [[ "$BACKEND" == bwrap ]]; then
  BWRAP=(bwrap --unshare-all --die-with-parent --new-session
         --ro-bind /usr /usr --ro-bind /etc /etc)
  for p in /bin /sbin /lib /lib64 /lib32 /libx32; do
    if [[ -L "$p" ]]; then BWRAP+=(--symlink "$(readlink "$p")" "$p")
    elif [[ -d "$p" ]]; then BWRAP+=(--ro-bind "$p" "$p"); fi
  done
  for p in "${RO_PATHS[@]}"; do [[ -n "$p" ]] && BWRAP+=(--ro-bind "$(realpath -e "$p")" "$(realpath -e "$p")"); done
  BWRAP+=(--proc /proc --dev /dev --tmpfs /tmp --tmpfs /run
          --ro-bind "$SCRIPT_DIR" /run/conductor/bin
          --bind "$STATE/egress" /run/conductor/egress
          --bind "$WORKTREE" "$WORKTREE"
          --remount-ro /
          --chdir "$WORKTREE")
  # Jako root dajemy init-owi tylko CAP_NET_ADMIN (regula nft w netns sandboksa)
  # i CAP_SETPCAP (zeby mogl wyczyscic bounding set). Init odbiera wszystkie
  # capabilities przed uruchomieniem mostu i komendy agenta.
  if [[ $EUID -eq 0 ]]; then BWRAP+=(--cap-drop ALL --cap-add CAP_NET_ADMIN --cap-add CAP_SETPCAP); fi
  env -i "${ENV_ARGS[@]}" "${BWRAP[@]}" -- \
    "$PYTHON" -I /run/conductor/bin/sandbox-init.py --backend bwrap "${INIT_ARGS[@]}" -- "$@" || rc=$?
else
  UNSHARE=(unshare --mount --net --pid --fork --ipc --uts --kill-child)
  # Bez roota: user namespace z mapowaniem na "root" wewnatrz (rootless).
  if [[ $EUID -ne 0 ]]; then UNSHARE+=(--user --map-root-user); fi
  env -i "${ENV_ARGS[@]}" "${UNSHARE[@]}" -- \
    "$PYTHON" -I "$SCRIPT_DIR/sandbox-init.py" --backend unshare "${INIT_ARGS[@]}" \
      --newroot "$STATE/root" --bin-src "$SCRIPT_DIR" --egress-src "$STATE/egress" \
      -- "$@" || rc=$?
fi
exit "$rc"
