# Prototyp: izolacja sieci sandboksa agenta (Linux)

Prototyp do [ADR-002](../../docs/adr/002-sandbox.md) (issue #9). Pokazuje, że da się
uruchomić dowolną komendę agenta CLI tak, żeby:

- widziała tylko swój worktree (zapis) oraz `/usr` i `/etc` (odczyt),
- nie miała żadnej drogi do sieci poza Egress Guardem (proxy z allowlistą),
- każda próba połączenia, dozwolona i odrzucona, trafiała do audytu (JSON lines),
- działało to także bez uprawnień administratora (user namespaces).

To jest prototyp w Pythonie i Bashu. Docelowa implementacja ma być częścią
`conductord` (Rust); patrz sekcja "Czego prototyp jeszcze nie robi".

## Pliki

| Plik | Rola |
|------|------|
| `run-sandboxed.sh` | Punkt wejścia: `run-sandboxed.sh [opcje] <worktree_dir> -- <komenda>`. Startuje proxy na hoście, tworzy namespace'y, czyści środowisko, sprząta po sobie. Opcje `--ro`/`--rw` (montowania w kolejności, po worktree) i `--etc minimal|full`. Używany przez `conductord` (issue #14). |
| `egress-proxy.py` | Egress Guard: proxy HTTP CONNECT na unix sockecie, allowlista `host:port`, sprawdzanie SNI, audyt JSON lines. Działa poza sandboksem. |
| `sandbox-bridge.py` | Most wewnątrz sandboksa: `127.0.0.1:3128` (TCP) -> unix socket proxy. Nie podejmuje decyzji. |
| `sandbox-init.py` | Pierwszy proces w sandboksie: (backend `unshare`) buduje nowy root i robi `pivot_root`, podnosi `lo`, ustawia regułę nft, rlimity, odbiera capabilities, uruchamia most i komendę. |
| `allowlist.txt` | Przykładowa allowlista. |
| `test.sh` | Testy (offline, deterministyczne). |

## Jak to działa

```
 host (netns hosta)                          sandbox (nowe ns: net, mount, pid, ipc, uts [, user])
 ───────────────────                         ──────────────────────────────────────────────────────
                                             agent CLI ──HTTPS_PROXY──> 127.0.0.1:3128
 egress-proxy.py  <── unix socket ─────────  sandbox-bridge.py (tylko lo, brak tras, brak DNS)
   │ allowlista host:port + SNI              /run/conductor/egress/egress.sock (bind mount)
   │ DNS rozwiązuje proxy
   ▼ audyt: egress-audit.jsonl
 LLM Gateway / forge (tylko z allowlisty)
```

Kluczowa decyzja: **sandbox nie dostaje żadnego interfejsu poza własnym loopbackiem**
(nie ma veth, trasy domyślnej ani resolvera). Jedyny kanał na zewnątrz to unix socket
proxy zamontowany do sandboksa. Dzięki temu:

- bezpośrednie połączenia (IPv4, IPv6, loopback hosta, UDP/53) kończą się `ENETUNREACH`,
  niezależnie od reguł firewalla,
- nie trzeba niczego konfigurować w netns hosta, więc nie ma czego sprzątać i nie są
  potrzebne uprawnienia administratora (veth do netns hosta wymaga `CAP_NET_ADMIN` na hoście),
- abstrakcyjne unix sockety hosta (`@/tmp/.X11-unix`, część D-Bus) są niewidoczne, bo
  są przypisane do network namespace.

Reguła nftables w netns sandboksa (wyjście tylko przez `lo`) jest dodatkową warstwą
(defense in depth), na wypadek gdyby ktoś w przyszłości dołożył interfejs.

Dwa backendy z tym samym zachowaniem:

- `bwrap`: bubblewrap tworzy namespace'y i system plików, `sandbox-init.py` robi resztę,
- `unshare`: `unshare(1)` z util-linux, a system plików buduje `sandbox-init.py`
  (tmpfs jako nowy root, bind mounty, `pivot_root`, odmontowanie starego roota).
  Działa bez bubblewrapa. Bez roota używa `--user --map-root-user`.

`auto` (domyślnie) wybiera `bwrap`, jeśli jest zainstalowany.

## Uruchomienie

Wymagania: Linux z user namespaces, `python3` (3.9+), `unshare` z util-linux,
opcjonalnie `bwrap` i `nft`. Nie są potrzebne `ip`, `iptables` ani root.

```bash
# komenda agenta w sandboksie, allowlista z pliku
./run-sandboxed.sh --allowlist allowlist.txt ~/work/repo-wt/agent-1 -- claude --help

# audyt (domyślnie <worktree>/../egress-audit.jsonl)
./run-sandboxed.sh --audit-log /var/tmp/audit.jsonl ~/wt/a1 -- curl -p https://llm-gateway.corp.example/v1/models

# dodatkowy toolchain tylko do odczytu, przekazanie wybranej zmiennej
./run-sandboxed.sh --ro /opt/jdk-21 --pass-env JAVA_HOME ~/wt/a1 -- ./gradlew test

# testy
./test.sh                      # oba backendy, jeśli jest bwrap
TEST_BACKENDS=unshare ./test.sh
```

Opcje mają odpowiedniki w zmiennych środowiskowych: `SANDBOX_ALLOWLIST`,
`SANDBOX_AUDIT_LOG`, `SANDBOX_BACKEND`, `SANDBOX_RO_PATHS`, `SANDBOX_PASS_ENV`,
`SANDBOX_ID`, `SANDBOX_NOFILE`, `SANDBOX_NPROC`. `CONDUCTOR_SANDBOX_DEBUG=1` wypisuje
stan sandboksa na stderr.

Format allowlisty (jedna reguła na linię):

```
llm-gateway.corp.example:443      # port domyślny 443
*.mirror.corp.example:443         # wildcard tylko jako pierwszy człon
localhost:18080 plaintext         # ruch bez TLS dopuszczony jawnie (tu: test)
```

Przykładowy wpis audytu:

```json
{"ts":"2026-11-05T14:56:55.045+00:00","component":"egress-guard","sandbox":"test-unshare","event":"connect","decision":"deny","reason":"not_in_allowlist","conn":"dc96503cd32a","peer":{"transport":"unix","pid":2936,"uid":0},"method":"CONNECT","target":"example.com:443","host":"example.com","port":443}
```

Powody odmowy: `not_in_allowlist`, `ip_literal`, `sni_mismatch`, `tls_without_sni`,
`plaintext_not_allowed`, `method_not_allowed`, `bad_request_*`, `client_closed*`,
`upstream_connect_failed`. Dla tuneli dozwolonych jest też zdarzenie `close`
z liczbą bajtów i czasem trwania.

## Co prototyp gwarantuje (i co sprawdza `test.sh`)

Sprawdzone w kontenerze deweloperskim (kernel 6.18, root i uid 65534), backendy
`unshare` i `bwrap`, 79 asercji:

1. Połączenie do hosta z allowlisty przez proxy działa (lokalny serwer HTTP na hoście
   udaje LLM Gateway, więc test nie potrzebuje internetu). Zdarzenia `allow` i `close` w audycie.
2. Odrzucane i logowane: host spoza allowlisty, literał IP (`CONNECT 1.1.1.1:443`),
   niezgodne SNI (CONNECT do dozwolonego hosta z ClientHello dla `example.com`, czyli
   domain fronting), metoda inna niż CONNECT.
3. Nie działa ominięcie proxy: TCP na `1.1.1.1:443`, IPv6 `[2606:4700:4700::1111]:443`,
   loopback hosta (`127.0.0.1:<port>`, gdzie jest też proxy firmowe), rozwiązywanie
   nazw i UDP na `8.8.8.8:53`. W sandboksie jest tylko interfejs `lo`.
4. System plików: zapis w worktree działa i jest widoczny na hoście; `/`, `/etc`, `/usr`
   są tylko do odczytu; pliki hosta spoza worktree (w tym `$HOME`) są niewidoczne;
   `/tmp` i `/run` są prywatne (tmpfs). Uwaga: katalogi nadrzędne worktree leżące pod
   `/tmp` są w sandboksie w prywatnym tmpfs, więc zapis "obok" worktree się udaje,
   ale nie trafia na hosta.
5. Komenda agenta ma `CapEff=0`, `CapBnd=0`, `NoNewPrivs=1`; nie może przemontować `/`
   ani zmienić reguł nft; ma własny PID namespace (procesy hosta, w tym proxy, są niewidoczne).
6. Środowisko jest czyszczone (`env -i`): `GH_TOKEN`, `AWS_*`, `SSH_AUTH_SOCK` itd. nie
   przechodzą; socket ssh-agent hosta, `docker.sock` i `/run/user` są niewidoczne.
7. Audyt to poprawne JSON lines.
8. Punkty 1-4 działają także dla użytkownika bez uprawnień (uid 65534) w obu backendach.
9. Po testach host jest bez zmian: interfejsy, reguły nft, procesy proxy, katalogi stanu.

Narzut startu w tym kontenerze: około 0,28 s na `run-sandboxed.sh ... -- true`
(oba backendy). Większość to start trzech interpreterów Pythona (proxy, init, most);
w Ruście będzie to pojedyncze milisekundy plus czas `clone`/mount.

## Czego prototyp jeszcze nie robi (uczciwie)

- **Brak seccomp.** Komenda ma pełny zestaw syscalli. W docelowej wersji filtr seccomp
  (patrz ADR-002): m.in. blokada `AF_VSOCK`, `AF_PACKET`, `AF_NETLINK` poza route,
  zagnieżdżonych user namespaces, `bpf`, `perf_event_open`, `keyctl`, `io_uring`, `ptrace`.
- **Brak cgroups.** Limity to tylko rlimity (`NOFILE`, `CORE`, opcjonalnie `NPROC`) i PID
  namespace. `RLIMIT_NPROC` jest liczony per uid na całym hoście, a root w init userns jest
  z niego zwolniony. Docelowo: cgroup v2 (`pids.max`, `memory.max`, `cpu.max`) przez
  delegację systemd (`systemd-run --user --scope`).
- **nftables w bwrap bez roota** jest pomijane (brak `CAP_NET_ADMIN`), co widać w
  `sandbox-status.json`. Izolacji to nie osłabia: w netns i tak jest tylko `lo`.
- **Tylko CONNECT.** Zwykłe żądania HTTP przez proxy (absolute-form) są odrzucane.
  Narzędzia muszą używać tunelu (`curl -p`) albo HTTPS. Brak terminacji TLS, więc proxy
  nie widzi ścieżek ani metod wewnątrz tunelu (np. nie odróżni `git fetch` od `git push`).
- **Brak DNS w sandboksie.** Celowo: nazwy rozwiązuje proxy. Narzędzia, które same
  rozwiązują nazwy przed użyciem proxy, nie zadziałają. Wariant ze stub-resolverem
  odpowiadającym tylko dla nazw z allowlisty jest opisany w ADR-002, niezaimplementowany.
- **Brak proxy nadrzędnego.** Proxy łączy się z celem bezpośrednio; nie łańcuchuje do
  firmowego proxy z `HTTPS_PROXY`. W tym kontenerze nie da się więc przetestować
  dozwolonego połączenia do prawdziwego hosta w internecie (dlatego test używa lokalnego serwera).
- **Brak filtra adresów po rozwiązaniu nazwy.** Nazwa z allowlisty wskazująca na
  loopback lub link-local (DNS rebinding) zostałaby połączona; ADR-002 przewiduje odrzucanie
  adresów specjalnych.
- **Metadane git** montuje wywołujący (`--ro`/`--rw`, issue #14): `conductord` podaje
  `.git` repo read-only i do zapisu tylko to, czego potrzebuje commit na gałęzi agenta
  (patrz `crates/conductord/README.md`). Sam launcher bez tych opcji git nie obsłuży.
- **Minimalny `/etc`** jest domyślny (`--etc minimal`, lista w `run-sandboxed.sh`:
  `passwd`, `group`, `hosts`, `nsswitch.conf`, certyfikaty CA, `ld.so.*`,
  `alternatives` i kilka innych); pełny `/etc` read-only przez `--etc full`.
  Narzędzia czytające nietypowe pliki z `/etc` mogą tego wymagać.
- **Init jako PID 1** (backend `unshare`) zbiera osierocone procesy; w `bwrap` robi to bwrap.
- **Audyt nie ma łańcucha hashy** ani podpisu; to zalążek formatu, nie Audit Log z PLAN.md.
- **Uwierzytelnienie do proxy** opiera się na tym, że socket jest w prywatnym katalogu
  sandboksa. Docelowo: osobny socket per sandbox (jak tu) plus `SO_PEERCRED` w decyzjach.
- **Tylko Linux.** macOS (Lima) i Windows (WSL2) to w ADR-002 ten sam mechanizm
  uruchomiony wewnątrz maszyny wirtualnej z Linuksem; nie ma na nie prototypu.
- **Środowisko testowe:** kontener deweloperski jako root, z dostępem do
  `unshare`, user namespaces i `pivot_root`. Na dystrybucjach, które ograniczają
  nieuprzywilejowane user namespaces (Ubuntu 24.04+: AppArmor
  `kernel.apparmor_restrict_unprivileged_userns`), tryb bez roota wymaga profilu AppArmor
  dla `bwrap`/`conductord`. Nie było tego jak sprawdzić w tym kontenerze.
