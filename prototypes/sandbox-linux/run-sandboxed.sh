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
#   --ro PATH          (SANDBOX_RO_PATHS, lista rozdzielona ':') dodatkowa sciezka read-only
#   --rw PATH          dodatkowa sciezka read-write (np. metadane git worktree)
#                      --ro/--rw sa montowane w podanej kolejnosci PO worktree, wiec
#                      pozniejszy wpis moze nadpisac wczesniejszy (np. --ro <wt>/.git)
#   --etc MODE         (SANDBOX_ETC)        minimal (domyslnie) | full: widoczny /etc
#   --pass-env NAME    (SANDBOX_PASS_ENV, lista ':') zmienne przekazywane do sandboksa
#   --id NAME          (SANDBOX_ID)         identyfikator sandboksa w audycie
#   Egress Guard (#16):
#   --upstream-proxy URL        (SANDBOX_UPSTREAM_PROXY)  http://host:port proxy nadrzednego
#   --upstream-proxy-allow LIST (SANDBOX_UPSTREAM_PROXY_ALLOW) loopback,private: klasy adresow
#                      dopuszczone dla proxy nadrzednego (domyslnie: tylko adres publiczny)
#   --upstream-ca FILE (SANDBOX_UPSTREAM_CA)  CA do weryfikacji forge w regulach "git"
#   --dns MODE         (SANDBOX_DNS)        none (domyslnie) | stub: resolver w sandboksie
#                      odpowiadajacy tylko dla nazw z allowlisty (fikcyjne adresy 127.77/16)
#
# Limity zasobow, cgroup v2 (issue #15; szczegoly w sandbox-cgroup.sh i README):
#   --cgroups MODE     (SANDBOX_CGROUPS)    required | best-effort (domyslnie) | off
#   --pids-max N       (SANDBOX_PIDS_MAX)   pids.max          (domyslnie: bez limitu)
#   --memory-max SIZE  (SANDBOX_MEMORY_MAX) memory.max, np. 8G (domyslnie: bez limitu)
#   --memory-swap-max SIZE (SANDBOX_MEMORY_SWAP_MAX) memory.swap.max (domyslnie 0)
#   --cpu-max "Q P"    (SANDBOX_CPU_MAX)    cpu.max, np. "200000 100000" = 2 CPU
#   --cgroup-parent DIR (SANDBOX_CGROUP_PARENT) delegowany cgroup nadrzedny
#   best-effort: gdy cgroup v2 niedostepne, ostrzezenie na stderr i wpis "cgroups"
#   w /run/conductor/sandbox-status.json; required: blad (kod 125) bez uruchamiania komendy.
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

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 2; }

ALLOWLIST="${SANDBOX_ALLOWLIST:-$SCRIPT_DIR/allowlist.txt}"
AUDIT_LOG="${SANDBOX_AUDIT_LOG:-}"
BACKEND="${SANDBOX_BACKEND:-auto}"
ETC_MODE="${SANDBOX_ETC:-minimal}"
SANDBOX_ID="${SANDBOX_ID:-}"
IFS=':' read -r -a _RO_ENV <<< "${SANDBOX_RO_PATHS:-}"
MOUNTS=()   # "ro:PATH" / "rw:PATH", w kolejnosci
for p in "${_RO_ENV[@]}"; do [[ -n "$p" ]] && MOUNTS+=("ro:$p"); done
IFS=':' read -r -a PASS_ENV <<< "${SANDBOX_PASS_ENV:-}"
# shellcheck source=sandbox-cgroup.sh
source "$SCRIPT_DIR/sandbox-cgroup.sh"
CG_MODE="${SANDBOX_CGROUPS:-best-effort}"; CG_PIDS_MAX="${SANDBOX_PIDS_MAX:-}"
CG_MEMORY_MAX="${SANDBOX_MEMORY_MAX:-}"; CG_SWAP_MAX="${SANDBOX_MEMORY_SWAP_MAX:-0}"
CG_CPU_MAX="${SANDBOX_CPU_MAX:-}"; CG_PARENT="${SANDBOX_CGROUP_PARENT:-}"
UPSTREAM_PROXY="${SANDBOX_UPSTREAM_PROXY:-}"
UPSTREAM_PROXY_ALLOW="${SANDBOX_UPSTREAM_PROXY_ALLOW:-}"
UPSTREAM_CA="${SANDBOX_UPSTREAM_CA:-}"
DNS_MODE="${SANDBOX_DNS:-none}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allowlist) ALLOWLIST="$2"; shift 2 ;;
    --audit-log) AUDIT_LOG="$2"; shift 2 ;;
    --backend)   BACKEND="$2"; shift 2 ;;
    --ro)        MOUNTS+=("ro:$2"); shift 2 ;;
    --rw)        MOUNTS+=("rw:$2"); shift 2 ;;
    --etc)       ETC_MODE="$2"; shift 2 ;;
    --pass-env)  PASS_ENV+=("$2"); shift 2 ;;
    --id)        SANDBOX_ID="$2"; shift 2 ;;
    --cgroups)   CG_MODE="$2"; shift 2 ;;
    --pids-max)  CG_PIDS_MAX="$2"; shift 2 ;;
    --memory-max) CG_MEMORY_MAX="$2"; shift 2 ;;
    --memory-swap-max) CG_SWAP_MAX="$2"; shift 2 ;;
    --cpu-max)   CG_CPU_MAX="$2"; shift 2 ;;
    --cgroup-parent) CG_PARENT="$2"; shift 2 ;;
    --upstream-proxy)       UPSTREAM_PROXY="$2"; shift 2 ;;
    --upstream-proxy-allow) UPSTREAM_PROXY_ALLOW="$2"; shift 2 ;;
    --upstream-ca)          UPSTREAM_CA="$2"; shift 2 ;;
    --dns)                  DNS_MODE="$2"; shift 2 ;;
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
case "$ETC_MODE" in minimal|full) ;; *) echo "nieznany tryb /etc: $ETC_MODE" >&2; exit 2 ;; esac
cg_validate || exit 2

# --- user namespaces (bez roota): czytelny blad zamiast niejasnego "Permission denied" ---
# Ubuntu 23.10+/24.04 blokuje nieuprzywilejowane user namespaces przez AppArmor
# (kernel.apparmor_restrict_unprivileged_userns=1), Debian starszy niz 11 przez
# kernel.unprivileged_userns_clone=0, inne systemy przez user.max_user_namespaces=0.
userns_preflight() {
  local probe out sysctl v info=""
  if [[ "$BACKEND" == bwrap ]]; then probe=(bwrap --unshare-user --unshare-net --ro-bind / / true)
  else probe=(unshare --user --map-root-user --net true); fi
  out="$("${probe[@]}" 2>&1)" && return 0
  for sysctl in kernel/apparmor_restrict_unprivileged_userns kernel/unprivileged_userns_clone user/max_user_namespaces; do
    [[ -r "/proc/sys/$sysctl" ]] && v="$(cat "/proc/sys/$sysctl")" && info+=" ${sysctl//\//.}=$v"
  done
  echo "sandbox: nie mozna utworzyc user namespace (backend $BACKEND, uid $EUID): ${out:-blad}" >&2
  echo "sandbox: ustawienia jadra:${info:- brak danych}" >&2
  if [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" == 1 ]]; then
    echo "sandbox: AppArmor blokuje nieuprzywilejowane user namespaces. Zainstaluj profil" \
         "z $SCRIPT_DIR/apparmor/ (opis w pliku profilu) albo uruchom jako root." >&2
  else
    echo "sandbox: user namespaces sa zablokowane (sysctl, polityka hardeningu albo seccomp" \
         "rodzica); patrz README, sekcja Seccomp i cgroups." >&2
  fi
  return 1
}
if [[ $EUID -ne 0 ]]; then userns_preflight || exit 125; fi
case "$DNS_MODE" in none|stub) ;; *) echo "nieznany tryb DNS: $DNS_MODE" >&2; exit 2 ;; esac
[[ -z "$UPSTREAM_CA" ]] || UPSTREAM_CA="$(realpath -e "$UPSTREAM_CA")"

# Sciezki montowan rozwiazane z gory (blad, jesli nie istnieja).
RESOLVED_MOUNTS=()
for m in "${MOUNTS[@]}"; do
  RESOLVED_MOUNTS+=("${m%%:*}:$(realpath -e "${m#*:}")")
done

# Minimalny /etc: tylko to, czego potrzebuja typowe narzedzia (libc, TLS, git, python).
# Bez /etc/gitconfig, /etc/ssh, /etc/sudoers, /etc/shadow, konfiguracji uslug itp.
ETC_ENTRIES=(passwd group hosts nsswitch.conf host.conf localtime protocols services
             mime.types ld.so.cache ld.so.conf ld.so.conf.d alternatives ssl
             ca-certificates ca-certificates.conf pki crypto-policies terminfo inputrc
             os-release debian_version login.defs python3 xdg)

# --- katalog stanu (prywatny, usuwany przy wyjsciu) --------------------------------
STATE="$(mktemp -d "${TMPDIR:-/tmp}/conductor-sbx.XXXXXX")"
chmod 700 "$STATE"
mkdir -m 700 "$STATE/egress" "$STATE/root" "$STATE/tls"
PROXY_PID=""
cleanup() {
  cgroup_cleanup
  if [[ -n "$PROXY_PID" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill -TERM "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
  rm -rf "$STATE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- cgroup v2 (przed proxy: proxy nie trafia do cgroup agenta) ----------------------
CG_NAME="conductor-sbx-$$-${STATE##*.}"
cgroup_setup || exit 125

# --- Egress Guard ------------------------------------------------------------------
# Klucz CA sandboksa (reguly "git") powstaje w $STATE/tls (0700, poza sandboksem);
# do sandboksa trafia tylko certyfikat publiczny w $STATE/egress.
PROXY_OPTS=(--tls-state-dir "$STATE/tls" --ca-public-dir "$STATE/egress")
[[ -n "$UPSTREAM_PROXY" ]] && PROXY_OPTS+=(--upstream-proxy "$UPSTREAM_PROXY")
[[ -n "$UPSTREAM_PROXY_ALLOW" ]] && PROXY_OPTS+=(--upstream-proxy-allow "$UPSTREAM_PROXY_ALLOW")
[[ -n "$UPSTREAM_CA" ]] && PROXY_OPTS+=(--upstream-ca "$UPSTREAM_CA")
[[ "$DNS_MODE" == stub ]] && PROXY_OPTS+=(--dns-stub --dns-ports-out "$STATE/dns-ports")
"$PYTHON" -I "$SCRIPT_DIR/egress-proxy.py" \
  --listen-unix "$STATE/egress/egress.sock" \
  --allowlist "$ALLOWLIST" --audit-log "$AUDIT_LOG" --sandbox-id "$SANDBOX_ID" \
  "${PROXY_OPTS[@]}" </dev/null &
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
if [[ -f "$STATE/egress/ca-bundle.crt" ]]; then   # reguly "git": agent ufa CA sandboksa
  _CA=/run/conductor/egress
  ENV_ARGS+=("SSL_CERT_FILE=$_CA/ca-bundle.crt" "GIT_SSL_CAINFO=$_CA/ca-bundle.crt"
             "CURL_CA_BUNDLE=$_CA/ca-bundle.crt" "REQUESTS_CA_BUNDLE=$_CA/ca-bundle.crt"
             "NODE_EXTRA_CA_CERTS=$_CA/sandbox-ca.crt")
fi
for name in "${PASS_ENV[@]}"; do
  [[ -n "$name" && -n "${!name+x}" ]] && ENV_ARGS+=("$name=${!name}")
done

INIT_ARGS=(--worktree "$WORKTREE" --etc "$ETC_MODE" --cgroup-status "$CG_STATUS")
for m in "${RESOLVED_MOUNTS[@]}"; do INIT_ARGS+=(--mount "$m"); done
INIT_ARGS+=(--dns "$DNS_MODE")
if [[ "$DNS_MODE" == stub ]]; then
  while read -r p; do [[ -n "$p" ]] && INIT_ARGS+=(--dns-port "$p"); done < "$STATE/dns-ports"
  printf '# conductor dns stub (issue #16): odpowiada tylko dla nazw z allowlisty\nnameserver 127.0.0.1\noptions timeout:2 attempts:2\n' > "$STATE/resolv.conf"
fi

rc=0
if [[ "$BACKEND" == bwrap ]]; then
  BWRAP=(bwrap --unshare-all --die-with-parent --new-session --ro-bind /usr /usr)
  if [[ "$ETC_MODE" == full ]]; then
    BWRAP+=(--ro-bind /etc /etc)
  else
    BWRAP+=(--dir /etc)
    for e in "${ETC_ENTRIES[@]}"; do
      [[ -e "/etc/$e" ]] && BWRAP+=(--ro-bind "/etc/$e" "/etc/$e")
    done
  fi
  for p in /bin /sbin /lib /lib64 /lib32 /libx32; do
    if [[ -L "$p" ]]; then BWRAP+=(--symlink "$(readlink "$p")" "$p")
    elif [[ -d "$p" ]]; then BWRAP+=(--ro-bind "$p" "$p"); fi
  done
  BWRAP+=(--proc /proc --dev /dev --tmpfs /tmp --tmpfs /run
          --ro-bind "$SCRIPT_DIR" /run/conductor/bin
          --bind "$STATE/egress" /run/conductor/egress
          --bind "$WORKTREE" "$WORKTREE")
  for m in "${RESOLVED_MOUNTS[@]}"; do
    if [[ "${m%%:*}" == rw ]]; then BWRAP+=(--bind "${m#*:}" "${m#*:}")
    else BWRAP+=(--ro-bind "${m#*:}" "${m#*:}"); fi
  done
  [[ "$DNS_MODE" == stub ]] && BWRAP+=(--ro-bind "$STATE/resolv.conf" /etc/resolv.conf)
  BWRAP+=(--remount-ro / --chdir "$WORKTREE")
  # Jako root dajemy init-owi tylko CAP_NET_ADMIN (regula nft w netns sandboksa)
  # i CAP_SETPCAP (zeby mogl wyczyscic bounding set). Init odbiera wszystkie
  # capabilities przed uruchomieniem mostu i komendy agenta.
  if [[ $EUID -eq 0 ]]; then BWRAP+=(--cap-drop ALL --cap-add CAP_NET_ADMIN --cap-add CAP_SETPCAP); fi
  # Stub DNS: init otwiera port 53 (i porty < 1024 do przechwytywania), potem odbiera wszystko.
  # Bez roota bwrap z --dev tworzy zagniezdzony userns dla uid != 0, a capabilities z niego
  # nie dzialaja w netns sandboksa; dlatego w tym trybie sandbox dziala jako uid 0 w swoim
  # userns (jak backend unshare bez roota), nadal bez capabilities po starcie agenta.
  if [[ "$DNS_MODE" == stub ]]; then
    BWRAP+=(--cap-add CAP_NET_BIND_SERVICE)
    if [[ $EUID -ne 0 ]]; then BWRAP+=(--cap-add CAP_SETPCAP --uid 0 --gid 0); fi
  fi
  "${CG_EXEC[@]}" env -i "${ENV_ARGS[@]}" "${BWRAP[@]}" -- \
    "$PYTHON" -I /run/conductor/bin/sandbox-init.py --backend bwrap "${INIT_ARGS[@]}" -- "$@" || rc=$?
else
  UNSHARE=(unshare --mount --net --pid --fork --ipc --uts --kill-child)
  # Bez roota: user namespace z mapowaniem na "root" wewnatrz (rootless).
  if [[ $EUID -ne 0 ]]; then UNSHARE+=(--user --map-root-user); fi
  "${CG_EXEC[@]}" env -i "${ENV_ARGS[@]}" "${UNSHARE[@]}" -- \
    "$PYTHON" -I "$SCRIPT_DIR/sandbox-init.py" --backend unshare "${INIT_ARGS[@]}" \
      --newroot "$STATE/root" --bin-src "$SCRIPT_DIR" --egress-src "$STATE/egress" \
      "${ETC_ENTRIES[@]/#/--etc-entry=}" \
      -- "$@" || rc=$?
fi
exit "$rc"
