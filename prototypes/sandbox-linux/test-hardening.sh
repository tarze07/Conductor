#!/usr/bin/env bash
# test-hardening.sh - testy filtra seccomp i limitow cgroup v2 (issue #15).
#
# Dla kazdego dostepnego backendu (unshare, bwrap):
#   1. numery syscalli w sandbox-init.py zgadzaja sie z naglowkami jadra,
#   2. komenda agenta ma aktywny filtr seccomp (Seccomp: 2), a status sandboksa go opisuje,
#   3. zablokowane syscalle zwracaja EPERM (clone3: ENOSYS): unshare/clone z CLONE_NEWUSER,
#      mount, ptrace, process_vm_readv, socket AF_NETLINK/AF_PACKET/AF_VSOCK, bpf, keyctl,
#      add_key, io_uring_setup, perf_event_open, userfaultfd, setns, name_to_handle_at,
#      syslog, personality(ADDR_NO_RANDOMIZE), na x86_64 takze ABI x32 i iopl,
#   4. narzedzia dzialaja dalej: sh, python3 (watki, fork, subprocess), ps, git commit,
#      curl i python przez proxy, sockety AF_UNIX/AF_INET/AF_INET6,
#   5. cgroups: polityki off / best-effort / required; jesli cgroup v2 z kontrolerami
#      jest dostepne: fork bomb ograniczona pids.max i alokacja ponad memory.max,
#      a jesli jest tylko hierarchia bez kontrolerow: cykl zycia podgrupy (utworzenie,
#      proces w podgrupie, usuniecie),
#   6. rootless (uid 65534): filtr dziala tak samo; czytelny blad, gdy user namespaces
#      sa zablokowane (symulacja: launcher uruchomiony pod filtrem seccomp),
#   7. po wszystkim nie zostaja procesy, katalogi stanu ani podgrupy cgroup.
#
# Uzycie: ./test-hardening.sh       (TEST_BACKENDS jak w test.sh)
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$DIR/run-sandboxed.sh"
PY="$(command -v python3)"

if [[ -z "${TEST_BACKENDS:-}" ]]; then
  TEST_BACKENDS="unshare"
  command -v bwrap >/dev/null 2>&1 && TEST_BACKENDS="unshare bwrap"
fi

PASS=0; FAIL=0; SKIP=0
pass() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$1"; [[ -n "${2:-}" ]] && printf '        %s\n' "$2"; }
skip() { SKIP=$((SKIP + 1)); printf '  SKIP  %s\n' "$1"; }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }
check_not() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$name"; else pass "$name"; fi; }

# Podgrupy cgroup utworzone przez launcher (do weryfikacji sprzatania).
cg_mounts() { awk '{for (i = 7; i <= NF; i++) if ($i == "-") { if ($(i+1) == "cgroup2") print $5; break }}' /proc/self/mountinfo; }
cg_leftovers() { local m; for m in $(cg_mounts); do find "$m" -maxdepth 3 -type d -name 'conductor-sbx-*' 2>/dev/null; done; }
snapshot_host() {
  echo "proxies:$(pgrep -fc 'egress-proxy.py' || true)"
  echo "|state:$(ls -d "${TMPDIR:-/tmp}"/conductor-sbx.* 2>/dev/null | wc -l)"
  echo "|cgroups:$(cg_leftovers | wc -l)"
}
HOST_BEFORE="$(snapshot_host)"

T="$(mktemp -d "${TMPDIR:-/tmp}/conductor-hardening-test.XXXXXX")"
HTTP_PID=""
cleanup() {
  [[ -n "$HTTP_PID" ]] && { kill "$HTTP_PID" 2>/dev/null; wait "$HTTP_PID" 2>/dev/null; }
  find "$T" -depth -delete 2>/dev/null
}
trap cleanup EXIT

PORT="$("$PY" -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
mkdir -p "$T/www"; echo "hello-from-gateway" > "$T/www/hello.txt"
"$PY" -m http.server "$PORT" --bind 127.0.0.1 --directory "$T/www" >/dev/null 2>&1 &
HTTP_PID=$!
for _ in $(seq 1 100); do curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.05; done
echo "localhost:$PORT plaintext loopback" > "$T/allowlist.txt"

# --- sonda syscalli (uruchamiana w sandboksie): drukuje "nazwa=wynik" ---------------------
# Numery syscalli sa niezalezne od tabel w sandbox-init.py (te sprawdza krok 1).
cat > "$T/probe.py" <<'EOF'
import ctypes, errno, os, platform, socket, sys
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
NR = {
    "x86_64": dict(ptrace=101, process_vm_readv=310, unshare=272, clone=56, clone3=435, mount=165,
                   bpf=321, keyctl=250, add_key=248, io_uring_setup=425, perf_event_open=298,
                   userfaultfd=323, setns=308, name_to_handle_at=303, syslog=103, personality=135,
                   getpid=39, iopl=172),
    "aarch64": dict(ptrace=117, process_vm_readv=270, unshare=97, clone=220, clone3=435, mount=40,
                    bpf=280, keyctl=219, add_key=217, io_uring_setup=425, perf_event_open=241,
                    userfaultfd=282, setns=268, name_to_handle_at=264, syslog=116, personality=92,
                    getpid=172),
}[platform.machine()]

def sc(name, *args, nr=None):
    ctypes.set_errno(0)
    r = libc.syscall(ctypes.c_long(NR[name] if nr is None else nr), *[ctypes.c_long(a) for a in args])
    return "ok" if r >= 0 else errno.errorcode.get(ctypes.get_errno(), str(ctypes.get_errno()))

out = {}
out["ptrace"] = sc("ptrace", 2, 4194303, 0, 0)                # PEEKDATA, nieistniejacy pid: bez filtra ESRCH
buf = ctypes.create_string_buffer(8)
iov = (ctypes.c_void_p * 2)(ctypes.addressof(buf), 8)
out["process_vm_readv"] = sc("process_vm_readv", os.getpid(), ctypes.addressof(iov), 1, ctypes.addressof(iov), 1, 0)
ctypes.set_errno(0)                                            # clone(CLONE_NEWUSER | SIGCHLD)
r = libc.syscall(ctypes.c_long(NR["clone"]), ctypes.c_long(0x10000000 | 17), *[ctypes.c_long(0)] * 4)
if r == 0:
    os._exit(0)                                                # dziecko (tylko bez filtra)
if r > 0:
    os.waitpid(r, 0)
out["clone_newuser"] = "ok" if r > 0 else errno.errorcode.get(ctypes.get_errno(), "?")
out["unshare_newns"] = sc("unshare", 0x00020000)              # przed NEWUSER: po nim brak mapowania uid
out["unshare_newuser"] = sc("unshare", 0x10000000)
out["clone3"] = sc("clone3", 0, 0)
out["mount"] = sc("mount", 0, 0, 0, 0, 0)
for fam, name in [(socket.AF_NETLINK, "netlink"), (socket.AF_PACKET, "packet"), (40, "vsock")]:
    try:
        socket.socket(fam, socket.SOCK_RAW if fam != 40 else socket.SOCK_STREAM, 0).close(); out["socket_" + name] = "ok"
    except OSError as e:
        out["socket_" + name] = errno.errorcode.get(e.errno, str(e.errno))
for fam, name in [(socket.AF_UNIX, "unix"), (socket.AF_INET, "inet"), (socket.AF_INET6, "inet6")]:
    try:
        socket.socket(fam, socket.SOCK_STREAM).close(); out["socket_" + name] = "ok"
    except OSError as e:
        out["socket_" + name] = errno.errorcode.get(e.errno, str(e.errno))
out["bpf"] = sc("bpf", 0, 0, 0)
out["keyctl"] = sc("keyctl", 0, -3 & 0xFFFFFFFF, 0)            # KEYCTL_GET_KEYRING_ID(SESSION)
out["add_key"] = sc("add_key", 0, 0, 0, 0, 0)
out["io_uring_setup"] = sc("io_uring_setup", 1, 0)
out["perf_event_open"] = sc("perf_event_open", 0, 0, -1, -1, 0)
out["userfaultfd"] = sc("userfaultfd", 0)
out["setns"] = sc("setns", -1, 0)
out["name_to_handle_at"] = sc("name_to_handle_at", -100, 0, 0, 0, 0)
out["syslog"] = sc("syslog", 10, 0, 0)                          # SYSLOG_ACTION_SIZE_BUFFER
out["personality_query"] = sc("personality", 0xFFFFFFFF)
out["personality_no_aslr"] = sc("personality", 0x0040000)
if platform.machine() == "x86_64":
    out["x32_getpid"] = sc("getpid", nr=0x40000000 | 39)
    out["iopl"] = sc("iopl", 3)
for k, v in out.items():
    print(f"{k}={v}")
EOF

# --- (1) numery syscalli vs naglowki jadra ---------------------------------------------
echo "Conductor sandbox-linux: testy seccomp i cgroups (backendy: $TEST_BACKENDS)"
echo
echo "== (1) numery syscalli w sandbox-init.py"
if command -v gcc >/dev/null 2>&1; then
  out="$("$PY" -I - "$DIR/sandbox-init.py" <<'EOF'
import importlib.util, platform, subprocess, sys
sys.dont_write_bytecode = True  # bez __pycache__ w katalogu prototypu
spec = importlib.util.spec_from_file_location("sandbox_init", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
heads = {"x86_64": "#include <asm/unistd_64.h>\n" if platform.machine() == "x86_64" else None,
         "aarch64": "#define __BITS_PER_LONG 64\n#define __ARCH_WANT_SYS_CLONE3\n#include <asm-generic/unistd.h>\n"}
if platform.machine() == "aarch64":
    heads["aarch64"] = "#include <asm/unistd.h>\n"
bad = checked = 0
for arch, head in heads.items():
    if head is None:
        print(f"SKIP {arch}: brak naglowkow tej architektury"); continue
    table = dict(m.SECCOMP_DENY[arch]); table.update(m.SECCOMP_SPECIAL[arch])
    src = head + "".join(f"{n}=__NR_{n}\n" for n in table)
    cpp = subprocess.run(["gcc", "-E", "-P", "-x", "c", "-"], input=src, capture_output=True, text=True, check=True)
    for line in cpp.stdout.split():
        if "=" not in line: continue
        n, v = line.split("=", 1)
        checked += 1
        if not v.isdigit() or int(v) != table[n]:
            bad += 1; print(f"MISMATCH {arch} {n}: tabela {table[n]}, naglowek {v}")
print(f"checked={checked} bad={bad}")
sys.exit(1 if bad or not checked else 0)
EOF
)"; rc=$?
  echo "$out" | sed 's/^/        /'
  if [[ $rc -eq 0 ]]; then pass "numery syscalli zgodne z naglowkami (x86_64: asm/unistd_64.h, aarch64: asm-generic/unistd.h)"
  else fail "numery syscalli zgodne z naglowkami"; fi
else
  skip "brak gcc: nie mozna porownac numerow syscalli z naglowkami"
fi

expect() {  # expect <wynik sondy> <klucz> <oczekiwane> <opis>
  local got; got="$(grep -m1 "^$2=" <<< "$1" | cut -d= -f2)"
  if [[ "$got" == "$3" ]]; then pass "$4 -> $3"; else fail "$4 -> $3" "otrzymano: ${got:-brak}"; fi
}

run_probe_checks() {  # run_probe_checks <wynik sondy>
  local p="$1"
  expect "$p" ptrace EPERM "ptrace(PTRACE_PEEKDATA)"
  expect "$p" process_vm_readv EPERM "process_vm_readv(self)"
  expect "$p" unshare_newuser EPERM "unshare(CLONE_NEWUSER)"
  expect "$p" unshare_newns EPERM "unshare(CLONE_NEWNS)"
  expect "$p" clone_newuser EPERM "clone(CLONE_NEWUSER)"
  expect "$p" clone3 ENOSYS "clone3 (libc spada na clone)"
  expect "$p" mount EPERM "mount"
  expect "$p" socket_netlink EPERM "socket(AF_NETLINK)"
  expect "$p" socket_packet EPERM "socket(AF_PACKET)"
  expect "$p" socket_vsock EPERM "socket(AF_VSOCK)"
  expect "$p" socket_unix ok "socket(AF_UNIX)"
  expect "$p" socket_inet ok "socket(AF_INET)"
  local v6; v6="$(grep -m1 '^socket_inet6=' <<< "$p" | cut -d= -f2)"
  # Jadro bez IPv6 (jak w tym kontenerze) daje EAFNOSUPPORT; wazne, ze filtr nie zwraca EPERM.
  if [[ "$v6" == ok || "$v6" == EAFNOSUPPORT ]]; then pass "socket(AF_INET6) przepuszczony przez filtr ($v6)"
  else fail "socket(AF_INET6) przepuszczony przez filtr" "otrzymano: $v6"; fi
  expect "$p" bpf EPERM "bpf"
  expect "$p" keyctl EPERM "keyctl(KEYCTL_GET_KEYRING_ID)"
  expect "$p" add_key EPERM "add_key"
  expect "$p" io_uring_setup EPERM "io_uring_setup"
  expect "$p" perf_event_open EPERM "perf_event_open"
  expect "$p" userfaultfd EPERM "userfaultfd"
  expect "$p" setns EPERM "setns"
  expect "$p" name_to_handle_at EPERM "name_to_handle_at"
  expect "$p" syslog EPERM "syslog"
  expect "$p" personality_query ok "personality(0xffffffff) (zapytanie)"
  expect "$p" personality_no_aslr EPERM "personality(ADDR_NO_RANDOMIZE)"
  if [[ "$(uname -m)" == x86_64 ]]; then
    expect "$p" x32_getpid EPERM "syscall ABI x32 (getpid | __X32_SYSCALL_BIT)"
    expect "$p" iopl EPERM "iopl"
  fi
}

# Kontrola: ta sama sonda poza sandboksem (bez filtra). Pokazuje, ze EPERM w sandboksie
# pochodzi z filtra, a nie np. z braku capabilities (tylko informacyjnie).
echo
echo "== kontrola: sonda poza sandboksem (bez filtra, root na hoscie)"
"$PY" -I "$T/probe.py" 2>&1 | tr '\n' ' ' | fold -w 110 | sed 's/^/        /'; echo

for B in $TEST_BACKENDS; do
  echo
  echo "== backend: $B"
  WT="$T/$B/worktree"; AUDIT="$T/$B/audit.jsonl"
  mkdir -p "$WT"; cp "$T/probe.py" "$WT/probe.py"
  sbx() { "$RUN" --backend "$B" --allowlist "$T/allowlist.txt" --audit-log "$AUDIT" --id "hard-$B" "$WT" -- "$@"; }

  echo "-- (2) filtr aktywny"
  check "Seccomp: 2 i jeden filtr w /proc/self/status" sbx sh -c 'grep -q "^Seccomp:[[:space:]]*2$" /proc/self/status && grep -q "^Seccomp_filters:[[:space:]]*1$" /proc/self/status'
  check "sandbox-status.json: seccomp mode=denylist, wpis cgroups" sbx python3 -I -c '
import json, platform, sys
s = json.load(open("/run/conductor/sandbox-status.json"))
sys.exit(not (s["seccomp"]["mode"] == "denylist" and s["seccomp"]["arch"] == platform.machine() and "status" in s["cgroups"]))'

  echo "-- (3) zablokowane syscalle"
  probe="$(sbx python3 -I probe.py 2>&1)"
  run_probe_checks "$probe"
  check_not "unshare -U true (util-linux) sie nie udaje" sbx unshare -U true
  out="$(sbx unshare -U true 2>&1)"
  if [[ "$out" == *"Operation not permitted"* ]]; then pass "unshare -U: komunikat 'Operation not permitted'"; else fail "unshare -U: komunikat 'Operation not permitted'" "$out"; fi
  out="$(sbx strace -f true 2>&1)"
  if [[ $? -ne 0 && "$out" == *"Operation not permitted"* ]]; then pass "strace (ptrace) sie nie udaje"; else fail "strace (ptrace) sie nie udaje" "$out"; fi
  check_not "mount -t tmpfs sie nie udaje" sbx mount -t tmpfs none /tmp

  echo "-- (4) typowe narzedzia dzialaja"
  check "sh: potok i podstawienia" sbx sh -c 'x=$(echo abc | tr a-c A-C); [ "$x" = ABC ]'
  check "python3: 8 watkow, fork, subprocess" sbx python3 -I -c '
import os, subprocess, threading
res = []
ts = [threading.Thread(target=lambda i=i: res.append(i)) for i in range(8)]
[t.start() for t in ts]; [t.join() for t in ts]
assert sorted(res) == list(range(8))
pid = os.fork()
if pid == 0: os._exit(7)
assert os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]) == 7
assert subprocess.run(["sh", "-c", "exit 3"]).returncode == 3'
  check "ps widzi procesy sandboksa" sbx sh -c 'ps -e -o pid,comm | grep -q ps'
  check "git init + commit w worktree" sbx sh -c '
    git init -q repo && cd repo && echo x > f && git add f &&
    git -c user.name=a -c user.email=a@b.invalid commit -qm init && git log --oneline | grep -q init'
  out="$(sbx curl -sS -m 10 -p "http://localhost:$PORT/hello.txt" 2>&1)"
  if [[ "$out" == "hello-from-gateway" ]]; then pass "curl -p przez proxy"; else fail "curl -p przez proxy" "$out"; fi
  check "python: CONNECT przez proxy i getaddrinfo(localhost, AI_ADDRCONFIG)" sbx python3 -I -c '
import socket, sys
socket.getaddrinfo("localhost", 80, flags=socket.AI_ADDRCONFIG)  # glibc bez netlinku
s = socket.create_connection(("127.0.0.1", 3128), timeout=5)
s.sendall(b"CONNECT localhost:'"$PORT"' HTTP/1.1\r\nHost: localhost\r\n\r\n")
assert b" 200" in s.recv(4096).split(b"\r\n")[0]
s.sendall(b"GET /hello.txt HTTP/1.0\r\nHost: localhost\r\n\r\n")
data = b""
while True:
    chunk = s.recv(4096)
    if not chunk: break
    data += chunk
sys.exit(b"hello-from-gateway" not in data)'
done

# --- (5) cgroups ---------------------------------------------------------------------------
echo
echo "== (5) cgroup v2"
B="${TEST_BACKENDS%% *}"
WT="$T/cg/worktree"; mkdir -p "$WT"
csbx() { "$RUN" --backend "$B" --allowlist "$T/allowlist.txt" --audit-log "$T/cg/audit.jsonl" --id cg "$@"; }
cg_state() { csbx "$@" "$WT" -- python3 -I -c 'import json; print(json.load(open("/run/conductor/sandbox-status.json"))["cgroups"]["status"])' 2>/dev/null; }

echo "        hierarchie cgroup2: $(cg_mounts | tr '\n' ' ')"
for m in $(cg_mounts); do echo "        $m/cgroup.controllers: $(cat "$m/cgroup.controllers" 2>/dev/null)"; done
LIMITS_OK=0
out="$(csbx --cgroups required --pids-max 64 --memory-max 64M "$WT" -- true 2>&1)" && LIMITS_OK=1
echo "        required + pids/memory: $([[ $LIMITS_OK -eq 1 ]] && echo dostepne || echo "niedostepne: $out")"

s="$(csbx --cgroups off --pids-max 64 "$WT" -- python3 -I -c 'import json; print(json.load(open("/run/conductor/sandbox-status.json"))["cgroups"]["status"])' 2>&1)"
if [[ "$s" == off ]]; then pass "--cgroups off: status off, bez ostrzezenia"; else fail "--cgroups off: status off, bez ostrzezenia" "$s"; fi
s="$(cg_state --cgroups best-effort)"
if [[ "$s" == not_requested ]]; then pass "best-effort bez limitow: status not_requested"; else fail "best-effort bez limitow: status not_requested" "$s"; fi

if [[ $LIMITS_OK -eq 0 ]]; then
  out="$(csbx --cgroups best-effort --pids-max 64 "$WT" -- sh -c 'echo agent-ran' 2>"$T/cg/stderr")"; rc=$?
  if [[ $rc -eq 0 && "$out" == agent-ran ]]; then pass "best-effort, cgroups niedostepne: komenda dziala"; else fail "best-effort, cgroups niedostepne: komenda dziala" "rc=$rc $out"; fi
  check "best-effort: ostrzezenie na stderr" grep -q 'limity cgroup .* nie zostana zastosowane' "$T/cg/stderr"
  s="$(cg_state --cgroups best-effort --pids-max 64)"
  if [[ "$s" == unavailable ]]; then pass "best-effort: sandbox-status.json cgroups.status=unavailable"; else fail "best-effort: status unavailable" "$s"; fi
  csbx --cgroups required --pids-max 64 "$WT" -- sh -c 'touch required-ran' >/dev/null 2>"$T/cg/stderr"; rc=$?
  if [[ $rc -eq 125 && ! -e "$WT/required-ran" ]]; then pass "required, cgroups niedostepne: kod 125, komenda nieuruchomiona"
  else fail "required, cgroups niedostepne: kod 125, komenda nieuruchomiona" "rc=$rc"; fi
  check "required: komunikat z przyczyna" grep -q 'cgroup v2 wymagane' "$T/cg/stderr"
  skip "fork bomb ograniczona pids.max (brak kontrolera pids w cgroup v2 w tym srodowisku)"
  skip "alokacja ponad memory.max (brak kontrolera memory w cgroup v2 w tym srodowisku)"
else
  # Fork bomb: procesy sie rozmnazaja, ale pids.max je zatrzymuje; host i launcher zyja.
  out="$(timeout 60 csbx --cgroups required --pids-max 64 "$WT" -- python3 -I -c '
import os, time
n = fails = 0
for _ in range(500):
    try:
        if os.fork() == 0:
            time.sleep(3); os._exit(0)
        n += 1
    except OSError:
        fails += 1
print(f"forked={n} fails={fails}")' 2>&1)"; rc=$?
  echo "        $out" | head -3
  if [[ $rc -eq 0 && "$out" == *"fails="* && "$out" != *"fails=0"* && "$out" == *"pids.max osiagniety"* ]]; then
    pass "fork bomb zatrzymana przez pids.max (EAGAIN), launcher konczy sie normalnie"
  else fail "fork bomb zatrzymana przez pids.max" "rc=$rc"; fi
  # Pamiec: 256 MiB przy memory.max=64M i swap 0 -> OOM kill w obrebie sandboksa.
  out="$(timeout 60 csbx --cgroups required --memory-max 64M --memory-swap-max 0 "$WT" -- python3 -I -c '
b = bytearray(256 * 1024 * 1024)
for i in range(0, len(b), 4096): b[i] = 1
print("allocated")' 2>&1)"; rc=$?
  if [[ $rc -ne 0 && "$out" != *allocated* && "$out" == *"OOM killer"* ]]; then pass "alokacja ponad memory.max konczy sie OOM kill (rc=$rc)"
  else fail "alokacja ponad memory.max konczy sie OOM kill" "rc=$rc $out"; fi
fi

# Cykl zycia podgrupy (dziala tez w hierarchii bez kontrolerow): required bez limitow.
if [[ -n "$(cg_mounts)" ]] && csbx --cgroups required "$WT" -- true >/dev/null 2>&1; then
  marker="$WT/cg-started"
  csbx --cgroups required "$WT" -- sh -c "touch '$marker'; sleep 2" >/dev/null 2>&1 &
  CPID=$!
  for _ in $(seq 1 100); do [[ -e "$marker" ]] && break; sleep 0.05; done
  leaf="$(cg_leftovers | head -1)"
  if [[ -n "$leaf" && -n "$(cat "$leaf/cgroup.procs")" ]]; then pass "podgrupa per przebieg istnieje i zawiera procesy sandboksa ($leaf: $(wc -l < "$leaf/cgroup.procs") proc.)"
  else fail "podgrupa per przebieg istnieje i zawiera procesy sandboksa" "${leaf:-brak}"; fi
  if [[ -n "$leaf" ]] && ! grep -qx "$CPID" "$leaf/cgroup.procs" && ! grep -qx "$(pgrep -f "egress-proxy.py.*--sandbox-id cg" | head -1)" "$leaf/cgroup.procs"; then
    pass "launcher i egress-proxy poza podgrupa agenta"
  else fail "launcher i egress-proxy poza podgrupa agenta"; fi
  wait "$CPID"
  if [[ -z "$(cg_leftovers)" ]]; then pass "podgrupa usunieta po zakonczeniu przebiegu"; else fail "podgrupa usunieta po zakonczeniu przebiegu" "$(cg_leftovers)"; fi
else
  skip "cykl zycia podgrupy: brak zapisywalnej hierarchii cgroup v2"
fi

# --- (6) rootless ----------------------------------------------------------------------------
if [[ $EUID -eq 0 ]] && command -v setpriv >/dev/null 2>&1; then
  RL="$T/rootless"; mkdir -p "$RL/wt"; cp "$T/allowlist.txt" "$T/probe.py" "$RL/"; cp "$T/probe.py" "$RL/wt/"
  chown -R 65534:65534 "$RL"; chmod 755 "$T"
  as_nobody() { setpriv --reuid=65534 --regid=65534 --clear-groups env TMPDIR="$RL" HOME="$RL" "$@"; }
  for B in $TEST_BACKENDS; do
    echo
    echo "== (6) rootless (uid 65534), backend: $B"
    rsbx() { as_nobody "$RUN" --backend "$B" --allowlist "$RL/allowlist.txt" --audit-log "$RL/audit-$B.jsonl" "$RL/wt" -- "$@"; }
    probe="$(rsbx python3 -I probe.py 2>&1)"
    expect "$probe" unshare_newuser EPERM "unshare(CLONE_NEWUSER) (zagniezdzony userns)"
    expect "$probe" clone_newuser EPERM "clone(CLONE_NEWUSER)"
    expect "$probe" socket_netlink EPERM "socket(AF_NETLINK)"
    expect "$probe" ptrace EPERM "ptrace"
    check "python3: watki i fork" rsbx python3 -I -c '
import os, threading
t = threading.Thread(target=lambda: None); t.start(); t.join()
pid = os.fork()
if pid == 0: os._exit(0)
os.waitpid(pid, 0)'
    s="$(rsbx python3 -I -c 'import json; print(json.load(open("/run/conductor/sandbox-status.json"))["cgroups"]["status"])' 2>/dev/null)"
    echo "        cgroups bez roota (bez limitow): $s"
    s="$(as_nobody "$RUN" --backend "$B" --allowlist "$RL/allowlist.txt" --audit-log "$RL/audit-$B.jsonl" --pids-max 64 "$RL/wt" -- true 2>&1)"
    if [[ "$s" == *"nie zostana zastosowane"* ]]; then pass "best-effort bez delegacji: ostrzezenie (${s:0:90}...)"
    else fail "best-effort bez delegacji: ostrzezenie" "$s"; fi
  done

  echo
  echo "== (6) user namespaces zablokowane: czytelny komunikat"
  # Symulacja Ubuntu/AppArmor: launcher jako uid 65534 pod filtrem seccomp Conductora,
  # wiec unshare(CLONE_NEWUSER) zwraca EPERM tak jak przy zablokowanych userns.
  for B in $TEST_BACKENDS; do
    out="$(as_nobody "$PY" -I -c '
import importlib.util, os, sys
sys.dont_write_bytecode = True  # bez __pycache__ w katalogu prototypu
spec = importlib.util.spec_from_file_location("sandbox_init", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.prepare_seccomp()
assert m.libc.prctl(m.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0 and m.apply_seccomp() == 0
os.execv(sys.argv[2], sys.argv[2:])' "$DIR/sandbox-init.py" "$RUN" --backend "$B" --allowlist "$RL/allowlist.txt" \
      --audit-log "$RL/audit-ns.jsonl" "$RL/wt" -- sh -c 'echo should-not-run' 2>&1)"; rc=$?
    if [[ $rc -eq 125 && "$out" == *"nie mozna utworzyc user namespace"* && "$out" != *should-not-run* ]]; then
      pass "[$B] userns zablokowane: kod 125 i komunikat"
    else fail "[$B] userns zablokowane: kod 125 i komunikat" "rc=$rc $out"; fi
  done
  echo "$out" | sed 's/^/        /'
  if [[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]]; then
    echo "        kernel.apparmor_restrict_unprivileged_userns=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)"
  else
    echo "        kernel.apparmor_restrict_unprivileged_userns: brak (jadro bez tej opcji AppArmor)"
  fi
fi

echo
echo "== (7) sprzatanie"
kill "$HTTP_PID" 2>/dev/null; wait "$HTTP_PID" 2>/dev/null; HTTP_PID=""
HOST_AFTER="$(snapshot_host)"
if [[ "$HOST_BEFORE" == "$HOST_AFTER" ]]; then pass "host bez zmian: procesy proxy, katalogi stanu, podgrupy cgroup ($HOST_AFTER)"
else fail "host bez zmian" "przed: $HOST_BEFORE / po: $HOST_AFTER"; fi

echo
echo "Wynik (hardening): $PASS PASS, $FAIL FAIL, $SKIP SKIP"
[[ $FAIL -eq 0 ]]
