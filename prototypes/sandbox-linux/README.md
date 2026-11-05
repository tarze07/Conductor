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
| `test.sh` | Testy (offline, deterministyczne). Na końcu uruchamia `test-hardening.sh`. |
| `sandbox-cgroup.sh` | Limity cgroup v2 per przebieg, wczytywany przez `run-sandboxed.sh` (issue #15). |
| `test-hardening.sh` | Testy filtra seccomp, polityk cgroups i komunikatu o zablokowanych user namespaces (issue #15). |
| `apparmor/conductor-bwrap` | Przykładowy profil AppArmor dla Ubuntu 24.04+ (nieinstalowany). |

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

## Seccomp i cgroups (issue #15)

### Filtr seccomp

`sandbox-init.py` buduje ręcznie program seccomp-bpf (`struct sock_filter`, ctypes, bez
libseccomp) i instaluje go przez `prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER)` w procesie
potomnym tuż przed `exec` mostu i komendy agenta, po odebraniu capabilities i po
`no_new_privs`. Init sandboksa (podnoszenie `lo`, reguła nft) działa wcześniej i bez
filtra, więc oba kroki działają jak dotąd. Tak samo w obu backendach. Opis filtra trafia do
`/run/conductor/sandbox-status.json` (klucz `seccomp`).

Kolejność reguł:

1. `seccomp_data.arch` musi być `AUDIT_ARCH_X86_64` albo `AUDIT_ARCH_AARCH64` (zgodnie z
   architekturą init-a). Inna ABI, np. i386 przez `int 0x80` na x86_64, kończy się
   `SECCOMP_RET_KILL_PROCESS`.
2. Na x86_64 numery z bitem `__X32_SYSCALL_BIT` (ABI x32) dostają `EPERM`.
3. Denylista z `EPERM` (poza `clone3`):

| Syscalle | Dlaczego |
|----------|----------|
| `ptrace`, `process_vm_readv`, `process_vm_writev`, `pidfd_getfd` | Czytanie i zmiana pamięci oraz deskryptorów innych procesów (w tym mostu do proxy); długa historia błędów jądra. Kosztem jest brak `strace`/`gdb` w sandboksie. |
| `unshare`, `setns`, `clone` z dowolną flagą `CLONE_NEW*` (filtr argumentu) | Zagnieżdżone user namespaces dają agentowi „roota” w nowym userns i otwierają kod jądra osiągalny normalnie tylko z `CAP_SYS_ADMIN`/`CAP_NET_ADMIN` (nft, mounty). To częste źródło eskalacji. |
| `clone3` (zwraca `ENOSYS`) | BPF nie zajrzy do struktury `clone_args` w pamięci, więc nie da się filtrować flag. `ENOSYS` sprawia, że glibc (wątki, `posix_spawn`) spada na `clone`, gdzie flagi są w rejestrze. |
| `mount`, `umount2`, `pivot_root`, `move_mount`, `open_tree`, `fsopen`, `fsconfig`, `fsmount`, `fspick`, `mount_setattr` | Zmiana widoku systemu plików. Bez capabilities i tak by nie przeszły; filtr to druga warstwa na wypadek błędu w odbieraniu uprawnień. |
| `bpf`, `perf_event_open`, `userfaultfd` | Typowe prymitywy exploitów jądra (weryfikator BPF, perf, wyścigi z userfaultfd). |
| `keyctl`, `add_key`, `request_key` | Keyring jądra nie jest izolowany przez namespace'y; mógłby ujawnić klucze sesji użytkownika. |
| `io_uring_setup`, `io_uring_enter`, `io_uring_register` | Duża powierzchnia ataku, operacje z kolejki nie przechodzą przez filtr seccomp. libuv/Node i inne biblioteki spadają wtedy na epoll. |
| `kexec_load`, `kexec_file_load`, `init_module`, `finit_module`, `delete_module`, `reboot`, `swapon`, `swapoff`, `acct`, `quotactl`, `quotactl_fd`, `syslog`, `iopl`, `ioperm`, `uselib` | Operacje administracyjne lub przestarzałe (bez capabilities i tak odrzucane); blokada jako druga warstwa. `iopl`/`ioperm`/`uselib` tylko na x86_64. |
| `name_to_handle_at`, `open_by_handle_at` | Uchwyty plików pozwalają otwierać pliki z pominięciem ścieżki (znany atak „shocker” na kontenery). |
| `personality` poza `0`, `PER_LINUX32`, `UNAME26`, `UNAME26 \| PER_LINUX32` i zapytaniem `0xffffffff` | Np. `ADDR_NO_RANDOMIZE` wyłącza ASLR, `READ_IMPLIES_EXEC` czyni stos i stertę wykonywalnymi. |
| `socket` z rodziną inną niż `AF_UNIX`, `AF_INET`, `AF_INET6` | `AF_NETLINK` (konfiguracja sieci, dużo kodu jądra), `AF_PACKET` (surowe ramki), `AF_VSOCK` (kanał do hypervisora w WSL2/Lima, poza network namespace) oraz rzadkie rodziny z błędami w przeszłości (`AF_ALG`, `AF_RDS`, `AF_BLUETOOTH` itd.). |

Numery syscalli pochodzą z nagłówków UAPI jądra 6.8 (x86_64: `asm/unistd_64.h`,
aarch64: `asm-generic/unistd.h`). `test-hardening.sh` porównuje tabele z nagłówkami
przez `gcc -E` (89 wpisów dla obu architektur).

**Dlaczego denylista, a nie allowlista.** Agent uruchamia dowolne toolchainy dewelopera:
kompilatory, JVM, Node, przeglądarki do testów, narzędzia buildów. Allowlista (jak w
Chromium albo `SystemCallFilter=` w systemd) wymaga znajomości wszystkich syscalli tych
programów i psuje się przy aktualizacji glibc albo jądra (np. przejście glibc na `clone3`,
`rseq`, `faccessat2`, `statx`). Błąd w allowliście oznacza losowe awarie buildów, które
zespoły „naprawiają” wyłączeniem sandboksa. Denylista zamyka znane, rzadko potrzebne
i ryzykowne interfejsy, podobnie jak domyślny profil Dockera i Podmana. Granicą
bezpieczeństwa pozostają namespace'y, brak capabilities, `no_new_privs` i Egress Guard;
seccomp zmniejsza powierzchnię ataku na jądro.

**Co pozostaje ryzykiem:**

- syscalle dodane po 6.8 (np. `open_tree_attr`, rodzina `*xattrat`, `mseal`) i przyszłe są
  przepuszczane, dopóki nie trafią do tabeli (allowlista odrzuciłaby je domyślnie),
- dostępna zostaje reszta jądra: systemy plików, stos TCP/IP i unix sockety, `memfd`,
  `mmap`, futexy itd.; błąd w nich to nadal ścieżka eskalacji, dlatego ADR-002 wymaga
  aktualnego jądra,
- `socketpair`, `ioctl` i `prctl` nie są filtrowane po argumentach,
- brak `strace`/`gdb`: tryb debugowania włączany polityką (ADR-002) nie jest zaimplementowany,
- filtr obejmuje most i komendę agenta, nie init sandboksa (działa przed agentem i nie
  wykonuje jego kodu).

### Limity cgroup v2

Opcje launchera (i zmienne `SANDBOX_CGROUPS`, `SANDBOX_PIDS_MAX`, `SANDBOX_MEMORY_MAX`,
`SANDBOX_MEMORY_SWAP_MAX`, `SANDBOX_CPU_MAX`, `SANDBOX_CGROUP_PARENT`):
`--cgroups required|best-effort|off` (domyślnie `best-effort`), `--pids-max N`,
`--memory-max SIZE` (np. `8G`), `--memory-swap-max SIZE` (domyślnie `0`, ustawiane razem
z `memory.max`), `--cpu-max "QUOTA PERIOD"` (np. `"200000 100000"` = 2 CPU),
`--cgroup-parent DIR`. Wartość `max` (albo `none`) oznacza brak limitu. Sam launcher
domyślnie limitów nie narzuca; robi to wywołujący. `conductord` przekazuje zawsze swoje
wartości domyślne: `pids.max=4096`, `memory.max=8G`, `memory.swap.max=0`, `cpu.max=max`
(zmieniane opcjami `--sandbox-*`).

Działanie (`sandbox-cgroup.sh`):

1. Katalog nadrzędny: `--cgroup-parent` albo własny cgroup launchera (wpis `0::` z
   `/proc/self/cgroup` i punkt montowania `cgroup2` z `/proc/self/mountinfo`; w trybie
   hybrydowym bywa to `/sys/fs/cgroup/unified`). Musi być zapisywalny: korzeń
   hierarchii (root) albo cgroup delegowany, np.
   `systemd-run --user --scope -p Delegate=yes ./run-sandboxed.sh ...`.
2. Potrzebne kontrolery (tylko dla ustawionych limitów) muszą być w `cgroup.controllers`.
   W korzeniu hierarchii launcher nie zmienia `cgroup.subtree_control` (to byłaby zmiana
   konfiguracji całego hosta). W cgroup delegowanym włącza je sam, a gdy przeszkadza
   reguła „no internal processes”, przenosi procesy rodzica do liścia `supervisor`.
3. Podgrupa per przebieg (`conductor-sbx-<pid>-<losowe>`): najpierw limity, potem proces
   sandboksa (`unshare`/`bwrap`) przenosi się do niej tuż przed `exec`. Trafia tam cały
   sandbox (init, most, agent); launcher i Egress Guard zostają poza nią.
4. Po zakończeniu: raport z `pids.events`/`memory.events` na stderr („limit pids.max
   osiągnięty”, „OOM killer zabił N proces(y)”), `cgroup.kill` i `rmdir` podgrupy.
   To samo przy przerwaniu (trap `EXIT`).

Gdy cgroup v2 z potrzebnymi kontrolerami nie jest dostępne: `best-effort` wypisuje
ostrzeżenie na stderr, uruchamia komendę i zapisuje
`"cgroups": {"status": "unavailable", "reason": ...}` w `sandbox-status.json`;
`required` kończy się kodem 125 bez uruchamiania komendy; `off` pomija cgroups.
Bez żadnego limitu `best-effort` daje `status: not_requested`, a `required` tworzy pustą
podgrupę (rozliczanie i sprzątanie przez `cgroup.kill`).

**RLIMIT_NPROC** (`SANDBOX_NPROC`) zostaje jako opcja zapasowa, ale limit procesów
zapewnia `pids.max`: `RLIMIT_NPROC` liczy procesy danego uid na całym hoście (także poza
sandboksem), a root w init userns jest z niego zwolniony.

Co sprawdzono w kontenerze deweloperskim: `/sys/fs/cgroup` to tmpfs z hierarchiami
cgroup v1 (`pids`, `memory`, `cpu` itd.) i `cgroup2` w `/sys/fs/cgroup/unified` z jedynym
kontrolerem `hugetlb`. `mount -t cgroup2` w prywatnym mount namespace działa, ale to ta
sama hierarchia: kontrolerów `pids`/`memory`/`cpu` nie da się włączyć, bo są przypięte do
v1. Testy przechodzą więc ścieżkę „niedostępne” (`best-effort`, `required`, `off`) oraz
prawdziwy cykl życia podgrupy w `/sys/fs/cgroup/unified` (utworzenie, procesy sandboksa
w podgrupie, launcher i proxy poza nią, usunięcie). Testy fork bomby (`pids.max`) i
alokacji ponad `memory.max` są w `test-hardening.sh`, ale tutaj są pomijane (SKIP);
ścieżka z włączaniem kontrolerów w cgroup delegowanym (`supervisor`) nie była uruchomiona.

### Ubuntu 24.04+ i AppArmor

Bez roota launcher najpierw sprawdza, czy da się utworzyć user namespace (próbny
`bwrap --unshare-user` albo `unshare --user`). Jeśli nie, kończy się kodem 125 i wypisuje
przyczynę z wartościami `kernel.apparmor_restrict_unprivileged_userns`,
`kernel.unprivileged_userns_clone` i `user.max_user_namespaces` (tymi, które istnieją), a
przy blokadzie przez AppArmor wskazuje profil z `apparmor/`. Przykładowy profil
`apparmor/conductor-bwrap` pozwala na user namespaces tylko programowi `/usr/bin/bwrap`
(instalacja i uwagi w komentarzu pliku; launcher go nie instaluje). Dla backendu `unshare`
profilu nie przewidujemy: zniósłby ograniczenie dla każdego wywołania `unshare(1)`.
W kontenerze deweloperskim nie ma AppArmor (plik
`/proc/sys/kernel/apparmor_restrict_unprivileged_userns` nie istnieje, brak
`apparmor_parser`), więc profil nie był ładowany. Test symuluje blokadę, uruchamiając
launcher jako uid 65534 pod filtrem seccomp Conductora (`unshare(CLONE_NEWUSER)` zwraca
wtedy `EPERM`) i sprawdza kod 125 oraz komunikat.

Wynik `test-hardening.sh` w kontenerze deweloperskim (root, oba backendy plus uid 65534):
102 PASS, 0 FAIL, 2 SKIP (fork bomb i OOM, brak kontrolerów cgroup v2).

## Czego prototyp jeszcze nie robi (uczciwie)

- **Seccomp to denylista**, nie allowlista (uzasadnienie i ryzyka w sekcji
  „Seccomp i cgroups”). Syscalle dodane w jądrze po 6.8 (wersja nagłówków, z których
  pochodzą numery) są przepuszczane; `ptrace` jest zablokowany, trybu debugowania brak.
- **Limity cgroup v2 wymagają zapisywalnej, delegowanej hierarchii** z kontrolerami
  `pids`/`memory`/`cpu` (root na hoście z cgroup v2 albo `systemd-run --user --scope -p
  Delegate=yes`); launcher sam nie uruchamia `systemd-run`. W kontenerze deweloperskim
  kontrolery są przypięte do cgroup v1, więc egzekwowania limitów (fork bomb, OOM) nie
  dało się sprawdzić; przetestowane są polityki `off`/`best-effort`/`required` i cykl
  życia podgrupy. Po `SIGKILL` launchera podgrupa zostaje (sprząta ją trap `EXIT`, którego `SIGKILL` nie wywoła).
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
