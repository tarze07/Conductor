#!/usr/bin/env bash
# test.sh - testy prototypu izolacji sieci (offline, deterministyczne).
#
# Uruchamia lokalny serwer HTTP na hoscie (udaje LLM Gateway z allowlisty) i sprawdza
# dla kazdego dostepnego backendu (unshare, bwrap):
#   1. polaczenie do hosta z allowlisty przez proxy dziala i jest zalogowane,
#   2. host spoza allowlisty, literal IP, niezgodne SNI i metoda inna niz CONNECT
#      sa odrzucane i logowane,
#   3. bezposrednie polaczenia z pominieciem proxy (IPv4, IPv6, loopback hosta, DNS) nie dzialaja,
#   4. zapis poza worktree nie trafia na hosta (/, /etc, /usr sa read-only), zapis w worktree tak,
#   5. komenda nie ma capabilities, ma no_new_privs, widzi tylko swoje procesy,
#   6. sekrety ze srodowiska i sockety hosta (ssh-agent) nie trafiaja do sandboksa,
#   7. audyt to poprawne JSON lines,
#   8. to samo dziala bez uprawnien administratora (uid 65534, user namespaces),
#   9. po wszystkim nie zostaja procesy, katalogi stanu, interfejsy ani reguly nft na hoscie.
#
# Uzycie: ./test.sh            (backendy: unshare + bwrap, jesli jest zainstalowany)
#         TEST_BACKENDS=unshare ./test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$DIR/run-sandboxed.sh"
PY="$(command -v python3)"

if [[ -z "${TEST_BACKENDS:-}" ]]; then
  TEST_BACKENDS="unshare"
  command -v bwrap >/dev/null 2>&1 && TEST_BACKENDS="unshare bwrap"
fi

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; [[ -n "${2:-}" ]] && printf '        %s\n' "$2"; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }
check_not() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$name"; else pass "$name"; fi; }

# Czy w audycie jest wpis spelniajacy wszystkie warunki klucz=wartosc?
audit_has() {
  "$PY" -I - "$@" <<'EOF'
import json, sys
path, conds = sys.argv[1], dict(a.split("=", 1) for a in sys.argv[2:])
with open(path) as f:
    for line in f:
        rec = json.loads(line)
        if all(str(rec.get(k)) == v for k, v in conds.items()):
            sys.exit(0)
sys.exit(1)
EOF
}

# --- stan hosta przed testem (do weryfikacji sprzatania) ----------------------------
snapshot_host() {
  ls /sys/class/net 2>/dev/null | tr '\n' ' '
  echo "|nft:$(nft list ruleset 2>/dev/null | md5sum | cut -c1-12)"
  echo "|proxies:$(pgrep -fc 'egress-proxy.py' || true)"
  echo "|state:$(ls -d "${TMPDIR:-/tmp}"/conductor-sbx.* 2>/dev/null | wc -l)"
}
HOST_BEFORE="$(snapshot_host)"

T="$(mktemp -d "${TMPDIR:-/tmp}/conductor-sbx-test.XXXXXX")"
HTTP_PID=""; SOCK_PID=""
cleanup() {
  for p in $HTTP_PID $SOCK_PID; do kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; done
  rm -rf "$T"
}
trap cleanup EXIT

# --- lokalny "LLM Gateway" na hoscie --------------------------------------------------
PORT="$("$PY" -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
mkdir -p "$T/www"; echo "hello-from-gateway" > "$T/www/hello.txt"
"$PY" -m http.server "$PORT" --bind 127.0.0.1 --directory "$T/www" >/dev/null 2>&1 &
HTTP_PID=$!
for _ in $(seq 1 100); do curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.05; done

cat > "$T/allowlist.txt" <<EOF
# testowa allowlista: tylko lokalny gateway (bez TLS) i przykladowy host firmowy
localhost:$PORT plaintext loopback
llm-gateway.corp.example:443
EOF

# --- "sekrety" i socket hosta, ktore NIE moga trafic do sandboksa --------------------
export CONDUCTOR_FAKE_SECRET="s3cr3t-do-not-leak"
export SSH_AUTH_SOCK="$T/ssh-agent.sock"
"$PY" -c 'import socket,sys,time;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);s.listen();time.sleep(600)' "$SSH_AUTH_SOCK" &
SOCK_PID=$!
SECRET_NAMES="CONDUCTOR_FAKE_SECRET SSH_AUTH_SOCK"
for n in GH_TOKEN GITHUB_TOKEN AWS_SECRET_ACCESS_KEY AWS_ACCESS_KEY_ID; do
  [[ -n "${!n:-}" ]] && SECRET_NAMES="$SECRET_NAMES $n"
done
echo "outside" > "$T/host-file.txt"

echo "Conductor sandbox-linux: testy (backendy: $TEST_BACKENDS, gateway: localhost:$PORT)"

for B in $TEST_BACKENDS; do
  echo
  echo "== backend: $B"
  WT="$T/$B/worktree"; AUDIT="$T/$B/audit.jsonl"
  mkdir -p "$WT"; echo "kod agenta" > "$WT/README"
  sbx() { "$RUN" --backend "$B" --allowlist "$T/allowlist.txt" --audit-log "$AUDIT" --id "test-$B" "$WT" -- "$@"; }

  echo "-- (1) host z allowlisty przez proxy"
  out="$(sbx curl -sS -m 10 -p "http://localhost:$PORT/hello.txt" 2>&1)"
  if [[ "$out" == "hello-from-gateway" ]]; then pass "curl -p http://localhost:$PORT/hello.txt zwraca tresc z gatewaya"
  else fail "curl -p http://localhost:$PORT/hello.txt zwraca tresc z gatewaya" "$out"; fi
  check "audyt: allow localhost:$PORT" audit_has "$AUDIT" event=connect decision=allow host=localhost port="$PORT"
  check "audyt: zamkniecie tunelu z licznikiem bajtow" audit_has "$AUDIT" event=close host=localhost

  echo "-- (2) odrzucenia przez Egress Guard"
  check_not "CONNECT example.com:443 (spoza allowlisty) nie dziala" sbx curl -sS -m 10 -p https://example.com/
  check "audyt: deny example.com, reason=not_in_allowlist" audit_has "$AUDIT" decision=deny host=example.com reason=not_in_allowlist
  check_not "CONNECT 1.1.1.1:443 (literal IP) nie dziala" sbx curl -sS -m 10 -p https://1.1.1.1/
  check "audyt: deny 1.1.1.1, reason=ip_literal" audit_has "$AUDIT" decision=deny host=1.1.1.1 reason=ip_literal
  check_not "CONNECT na dozwolony host z SNI=example.com (fronting) nie dziala" \
    sbx curl -sS -m 10 -p --connect-to "example.com:443:localhost:$PORT" https://example.com/
  check "audyt: deny reason=sni_mismatch, sni=example.com" audit_has "$AUDIT" decision=deny reason=sni_mismatch sni=example.com
  out="$(sbx curl -sS -m 10 -o /dev/null -w '%{http_code}' "http://localhost:$PORT/hello.txt" 2>&1)"
  if [[ "$out" == "405" ]]; then pass "zwykly GET przez proxy (bez CONNECT) -> 405"; else fail "zwykly GET przez proxy (bez CONNECT) -> 405" "$out"; fi
  check "audyt: deny reason=method_not_allowed" audit_has "$AUDIT" decision=deny reason=method_not_allowed method=GET

  echo "-- (3) proby ominiecia proxy"
  check_not "bezposrednio TCP 1.1.1.1:443 nie dziala" sbx curl -sS -m 5 --noproxy '*' https://1.1.1.1/
  check_not "bezposrednio TCP [2606:4700:4700::1111]:443 (IPv6) nie dziala" sbx curl -sS -m 5 --noproxy '*' 'https://[2606:4700:4700::1111]/'
  check_not "loopback hosta 127.0.0.1:$PORT (z pominieciem proxy) nie dziala" sbx curl -sS -m 5 --noproxy '*' "http://127.0.0.1:$PORT/hello.txt"
  check "DNS: brak rozwiazywania nazw i brak UDP/53 (exfiltracja przez DNS)" sbx python3 -I -c '
import socket, sys
try:
    socket.getaddrinfo("example.com", 443); sys.exit(1)
except socket.gaierror: pass
try:
    socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b"x", ("8.8.8.8", 53)); sys.exit(1)
except OSError: pass'
  check "w sandboksie jest tylko interfejs lo" sbx python3 -I -c '
import json, sys; s = json.load(open("/run/conductor/sandbox-status.json")); sys.exit(s["interfaces"] != ["lo"])'
  status="$(sbx cat /run/conductor/sandbox-status.json 2>/dev/null)"
  echo "        status sandboksa: $status"

  echo "-- (4) system plikow"
  check "zapis w worktree dziala i jest widoczny na hoscie" sbx sh -c 'echo zmiana > agent-output.txt'
  check "plik z worktree widoczny na hoscie" grep -qx zmiana "$WT/agent-output.txt"
  # Katalogi nadrzedne worktree sa w sandboksie tylko punktami montowania: pod /tmp
  # leza w prywatnym tmpfs (zapis mozliwy, ale ulotny), poza /tmp w roocie read-only.
  sbx sh -c "echo x > '$T/outside.txt'" >/dev/null 2>&1
  check_not "zapis obok worktree ($T/outside.txt) nie trafia na hosta" test -e "$T/outside.txt"
  check_not "zapis do / sie nie udaje (root read-only)" sbx sh -c 'echo x > /conductor-probe'
  check_not "odczyt pliku hosta spoza worktree ($T/host-file.txt) sie nie udaje" sbx cat "$T/host-file.txt"
  check_not "zapis do /etc sie nie udaje (read-only)" sbx sh -c 'echo x > /etc/conductor-probe'
  check_not "zapis do /usr sie nie udaje (read-only)" sbx sh -c 'echo x > /usr/conductor-probe'
  check_not "katalog domowy hosta ($HOME) jest niewidoczny" sbx test -e "$HOME"
  sbx sh -c 'echo x > /tmp/conductor-probe-'"$B"'' >/dev/null 2>&1
  check_not "/tmp sandboksa jest prywatny (plik nie pojawia sie na hoscie)" test -e "/tmp/conductor-probe-$B"

  echo "-- (5) procesy i uprawnienia"
  check "CapEff=0, CapBnd=0, NoNewPrivs=1" sbx sh -c 'grep -q "^CapEff:[[:space:]]*0*$" /proc/self/status && grep -q "^CapBnd:[[:space:]]*0*$" /proc/self/status && grep -q "^NoNewPrivs:[[:space:]]*1$" /proc/self/status'
  check_not "mount -o remount,rw / sie nie udaje" sbx mount -o remount,rw /
  check_not "nft (zmiana regul sieci sandboksa) sie nie udaje" sbx nft flush ruleset
  check "osobny PID namespace (procesy hosta, w tym egress-proxy, niewidoczne)" sbx sh -c '
    n=0; for p in /proc/[0-9]*; do n=$((n+1)); grep -q "egress-prox[y]" "$p/cmdline" 2>/dev/null && exit 1; done; [ "$n" -le 10 ]'

  echo "-- (6) sekrety i sockety hosta"
  check "zmienne z sekretami nie przechodza ($SECRET_NAMES)" sbx sh -c "for n in $SECRET_NAMES; do env | grep -q \"^\$n=\" && exit 1; done; exit 0"
  check_not "socket ssh-agent hosta jest niewidoczny" sbx test -e "$SSH_AUTH_SOCK"
  check_not "brak /var/run/docker.sock i /run/user w sandboksie" sbx sh -c 'test -e /var/run/docker.sock || test -e /run/docker.sock || test -e /run/user'

  echo "-- (7) audyt"
  check "audyt to poprawne JSON lines" "$PY" -I -c 'import json,sys; [json.loads(l) for l in open(sys.argv[1])]' "$AUDIT"
  n_allow=$(grep -c '"decision":"allow"' "$AUDIT"); n_deny=$(grep -c '"decision":"deny"' "$AUDIT")
  echo "        wpisy w audycie: allow=$n_allow deny=$n_deny"
  echo "        przyklad (deny):"
  grep -m1 '"reason":"not_in_allowlist"' "$AUDIT" | sed 's/^/          /'
done

# --- (8) bez uprawnien administratora: te same sandboksy uruchomione jako uid 65534 ----
if [[ $EUID -eq 0 ]] && command -v setpriv >/dev/null 2>&1; then
  RL="$T/rootless"; mkdir -p "$RL/wt"; cp "$T/allowlist.txt" "$RL/allowlist.txt"
  chown -R 65534:65534 "$RL"; chmod 755 "$T"
  for B in $TEST_BACKENDS; do
    echo
    echo "== (8) rootless (uid 65534, bez sudo), backend: $B"
    rsbx() { setpriv --reuid=65534 --regid=65534 --clear-groups env TMPDIR="$RL" HOME="$RL" \
               "$RUN" --backend "$B" --allowlist "$RL/allowlist.txt" --audit-log "$RL/audit-$B.jsonl" "$RL/wt" -- "$@"; }
    out="$(rsbx curl -sS -m 10 -p "http://localhost:$PORT/hello.txt" 2>&1)"
    if [[ "$out" == "hello-from-gateway" ]]; then pass "host z allowlisty przez proxy"; else fail "host z allowlisty przez proxy" "$out"; fi
    check_not "host spoza allowlisty odrzucony" rsbx curl -sS -m 10 -p https://example.com/
    check "audyt: deny example.com" audit_has "$RL/audit-$B.jsonl" decision=deny host=example.com
    check_not "bezposrednio TCP 1.1.1.1:443 nie dziala" rsbx curl -sS -m 5 --noproxy '*' https://1.1.1.1/
    check "zapis w worktree dziala" rsbx sh -c "echo ok > rootless-$B.txt"
    check_not "zapis do /etc sie nie udaje" rsbx sh -c 'echo x > /etc/conductor-probe'
    echo "        status sandboksa: $(rsbx cat /run/conductor/sandbox-status.json 2>/dev/null)"
  done
fi

# --- testy Egress Guard z issue #16 (osobny skrypt, wyniki doliczane do sumy) ---------
echo
while IFS= read -r line; do
  printf '%s\n' "$line"
  case "$line" in "  PASS  "*) PASS=$((PASS + 1)) ;; "  FAIL  "*|"  EXIT  "[1-9]*) FAIL=$((FAIL + 1)) ;; esac
done < <(TEST_BACKENDS="$TEST_BACKENDS" bash "$DIR/test-egress.sh" 2>&1; echo "  EXIT  $?")

echo
echo "== sprzatanie"
kill "$HTTP_PID" "$SOCK_PID" 2>/dev/null; wait "$HTTP_PID" "$SOCK_PID" 2>/dev/null; HTTP_PID=""; SOCK_PID=""
HOST_AFTER="$(snapshot_host)"
if [[ "$HOST_BEFORE" == "$HOST_AFTER" ]]; then
  pass "host bez zmian: interfejsy, reguly nft, procesy proxy, katalogi stanu"
else
  fail "host bez zmian" "przed: $HOST_BEFORE / po: $HOST_AFTER"
fi

echo
echo "Wynik: $PASS PASS, $FAIL FAIL"
[[ $FAIL -eq 0 ]]
bash "$DIR/test-hardening.sh" && [[ $FAIL -eq 0 ]]   # seccomp i cgroups (issue #15); kod wyjscia: oba zestawy
