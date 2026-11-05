# ADR-002: Sandbox agenta i Egress Guard

- **Status:** proponowany
- **Data:** 2026-11-05
- **Issue:** #9

## Kontekst

Każdy agent w Conductorze działa w osobnym git worktree (PLAN.md, sekcja 3) i jest
traktowany jak kod niezaufany: może wykonać dowolną komendę, którą zaproponuje model,
a model może być celem prompt injection z treści repozytorium (PLAN.md, 4.2). Sandbox
musi więc wymuszać zasady z PLAN.md 4.1 niezależnie od tego, co robi agent.

Wymagania:

| # | Wymaganie | Uwagi |
|---|-----------|-------|
| S1 | Agent widzi tylko swój worktree (zapis) i potrzebne toolchainy (odczyt) | Bez `$HOME`, kluczy SSH, innych worktree, plików konfiguracyjnych hosta. |
| S2 | Sieć wyłącznie przez Egress Guard | Allowlista hostów: LLM Gateway, wewnętrzny forge, mirrory pakietów. Każda próba w audycie. |
| S3 | Ograniczenie procesów i syscalli | Osobne drzewo procesów, brak capabilities, `no_new_privs`, seccomp, limity zasobów. |
| S4 | Mały narzut startu | Fan-out jednego promptu na N agentów; sandbox startuje przy każdym agencie i często przy każdej komendzie. Cel: < 100 ms na Linuksie po stronie daemona. |
| S5 | Bez uprawnień administratora na stacji roboczej | Rootless, user namespaces. Jednorazowa instalacja przez IT (MSI/PKG/DEB) jest dopuszczalna, codzienna praca bez sudo. |
| S6 | Ten sam model na Linuksie, macOS i Windows | Jedna polityka (Policy Engine), jeden format audytu. |

Ataki, które sandbox musi zatrzymać (rozwinięcie wiersza "Agent omija aplikację" z PLAN.md 4.2):

- **DNS exfiltration**: dane zakodowane w nazwach (`<base32>.attacker.example`) wysyłane
  do resolvera, który rekurencyjnie przekaże je do internetu, nawet gdy TCP jest zablokowane.
- **Bezpośrednie IP**: `curl https://1.2.3.4` z pominięciem proxy albo `CONNECT 1.2.3.4:443`
  przez proxy, żeby obejść allowlistę nazw.
- **IPv6**: reguły napisane tylko dla IPv4 (iptables bez ip6tables), adresy link-local, NAT64.
- **Domain fronting / tunelowanie pod cudzym SNI**: `CONNECT dozwolony-host:443`, a w środku
  TLS do innego serwera albo dowolny protokół.
- **Unix sockety z hosta**: `docker.sock` (to jest root na hoście), `ssh-agent`
  (`SSH_AUTH_SOCK`), `gpg-agent`, D-Bus sesji, keyring, abstrakcyjne sockety X11.
  Także `AF_VSOCK` w maszynach wirtualnych (WSL2, Lima), który nie podlega network namespace.
- **Zmienne środowiskowe z sekretami**: `GITHUB_TOKEN`, `AWS_*`, `*_API_KEY`, tokeny
  odziedziczone z terminala dewelopera. Wszystko, co widzi agent, może trafić do kontekstu modelu.
- **Lokalne usługi hosta na loopbacku**: firmowe proxy na `127.0.0.1`, bazy deweloperskie,
  debuggery, endpointy metadanych (`169.254.169.254`) na maszynach w chmurze prywatnej.
- **Eskalacja przez jądro**: user namespaces zwiększają powierzchnię ataku na jądro;
  bez seccomp agent ma dostęp do wszystkich syscalli.

## Rozważane opcje

**Linux**

1. **L1: namespaces + seccomp + nftables per sandbox** (bubblewrap jako launcher albo ta
   sama logika wbudowana w `conductord`): user, mount, net, pid, ipc, uts, cgroup
   namespace; nowy root z bind mountów; filtr seccomp; reguły nft w netns sandboksa.
2. **L2: rootless Podman**: kontener OCI z obrazu z toolchainem, `--userns=keep-id`,
   sieć `--network none` albo pasta/slirp4netns.

**macOS**

3. **M1: Linux w lekkiej VM (Lima, Virtualization.framework)**: jedna trwała VM
   zarządzana przez `conductord`, w niej sandboksy L1; worktree udostępnione przez virtiofs.
4. **M2: `sandbox-exec` (Seatbelt, SBPL)**: natywny profil procesu: dostęp do plików
   i sieci (tylko `localhost:<port proxy>`). API oznaczone przez Apple jako przestarzałe
   i nieudokumentowane, choć nadal używane (m.in. przez przeglądarki i narzędzia CLI agentów).

**Windows**

5. **W1: WSL2 z dedykowaną dystrybucją Conductora**: dystrybucja importowana z
   wewnętrznego rejestru (`wsl --import`), w niej sandboksy L1.
6. **W2: kontener** (Windows containers / Hyper-V isolation albo Docker/Podman Desktop).

**Egress Guard (wspólny dla wszystkich opcji)**

7. **E1: veth + nftables**: sandbox ma interfejs veth do hosta, nft w netns hosta/sandboksa
   przepuszcza tylko ruch do proxy.
8. **E2: netns bez interfejsów + unix socket proxy**: sandbox ma tylko własny `lo`;
   proxy (w `conductord`, poza sandboksem) słucha na unix sockecie zamontowanym do
   sandboksa; w sandboksie most `127.0.0.1:3128 -> socket`.

## Porównanie

Linux:

| Kryterium | L1: namespaces + seccomp + nft | L2: rootless Podman |
|-----------|--------------------------------|---------------------|
| S1 izolacja FS | Pełna kontrola: bind mount worktree rw, wybrane ścieżki toolchainów ro, reszta nie istnieje | Obraz + volume z worktree; toolchain z obrazu, nie z hosta (inne wersje niż u dewelopera) |
| S2 sieć | Netns bez interfejsów (E2), brak ścieżki obejścia | Domyślnie pasta/slirp4netns daje internet; trzeba `--network none` i ten sam unix socket (E2) |
| S3 syscalle | Własny filtr seccomp dopasowany do agentów | Domyślny profil seccomp Podmana (dobry, ogólny); własny przez `--security-opt` |
| S3 limity | cgroup v2 przez delegację systemd (`systemd-run --user --scope`) | cgroup v2 wbudowane (`--pids-limit`, `--memory`), też wymaga delegacji |
| S4 start | Kilka ms (`clone` + mounty); prototyp w Pythonie: ok. 0,28 s z trzema interpreterami | Zwykle 0,3-1 s (conmon, OCI runtime, storage), więcej przy pierwszym obrazie |
| S5 bez admina | Tak (unprivileged user namespaces); na Ubuntu 24.04+ potrzebny profil AppArmor instalowany z paczką | Wymaga wpisów w `/etc/subuid`/`/etc/subgid` (admin) i setuid `newuidmap`; pull obrazów z wewnętrznego rejestru |
| Zależności | `bwrap` (LGPL, ok. 50 kB) albo nic (logika w Ruście) | Podman, conmon, crun, pasta, storage driver |
| Dojrzałość | bubblewrap: Flatpak, GNOME, narzędzia agentów CLI | Dojrzały, szeroko używany |
| Spójność dev/agent | Agent używa tych samych toolchainów co deweloper | Toolchain w obrazie: powtarzalny, ale osobny do utrzymania |

macOS:

| Kryterium | M1: Lima (VM z Linuksem) | M2: sandbox-exec |
|-----------|--------------------------|------------------|
| S1 izolacja FS | Do VM udostępniony tylko katalog worktree (virtiofs); w VM dodatkowo L1 | Profil SBPL: odczyt/zapis po ścieżkach; łatwo o przeoczenie (`~/Library`, keychain, XPC) |
| S2 sieć | W VM sandboksy L1 + E2; proxy osiągalne przez przekazany unix socket Limy | `(allow network-outbound (remote ip "localhost:3128"))`, brak netns; mniej warstw |
| S3 syscalle | seccomp w VM; granica VM (hypervisor) | Tylko Seatbelt; brak odpowiednika seccomp i PID namespace |
| S4 start | VM: kilka-kilkanaście s raz na sesję (VM trwała); sandbox w VM: ms | Natychmiastowy |
| S5 bez admina | Tak (Virtualization.framework, podpisana aplikacja z entitlementem) | Tak |
| Utrzymanie | Obraz VM z wewnętrznego rejestru, aktualizacje jądra VM | API przestarzałe, nieudokumentowane, może zniknąć w kolejnym macOS |
| Toolchain | Linuksowy (w VM); natywne narzędzia macOS (Xcode) niedostępne | Natywny (Xcode, Homebrew) |
| Koszt | RAM i CPU na VM (ok. 1-2 GB) | Brak |

Windows:

| Kryterium | W1: WSL2 (dedykowana dystrybucja) | W2: kontener |
|-----------|-----------------------------------|--------------|
| S1-S3 | Wewnątrz WSL2 to samo co L1 (jądro Linuksa WSL2) | Windows containers: słabsza izolacja procesów; Linux containers na Windows i tak działają w WSL2/Hyper-V |
| S2 sieć | L1 + E2 w dystrybucji; interop i automount wyłączone | Zależy od runtime'u; sieć NAT Hyper-V |
| S4 start | VM WSL2: 1-2 s raz na sesję; sandbox: ms | Kontener: sekundy |
| S5 bez admina | Włączenie WSL wymaga admina raz (IT przez Intune/GPO); `wsl --import` i praca bez admina | Hyper-V / Docker Desktop: admin, licencja Docker Desktop w firmach |
| Ryzyka specyficzne | Interop (`/init`, uruchamianie `.exe` z Linuksa), automount `/mnt/c`, `AF_VSOCK`, tryb sieci mirrored | Utrzymanie dwóch rodzajów obrazów |

Egress Guard:

| Kryterium | E1: veth + nftables | E2: netns bez interfejsów + unix socket |
|-----------|---------------------|------------------------------------------|
| Ścieżka obejścia | Istnieje trasa; bezpieczeństwo zależy od poprawności reguł (IPv4 i IPv6, ICMP, DNS) | Brak trasy; bezpośrednie połączenia kończą się `ENETUNREACH` |
| Bez admina | Nie: veth do netns hosta wymaga `CAP_NET_ADMIN` na hoście (albo pasta/slirp) | Tak |
| Sprzątanie | Interfejsy i reguły w netns hosta mogą zostać po awarii | Nic w netns hosta; wszystko znika z procesami |
| Narzędzia bez obsługi proxy | Można przezroczyście przekierować (DNAT/TPROXY) | Działają tylko narzędzia obsługujące `HTTPS_PROXY` (lub przez wrapper) |

## Decyzja

### Linux: L1, namespaces + seccomp, z Egress Guardem E2

- Sandbox to zestaw namespace'ów: **user** (gdy brak roota; mapowanie na uid dewelopera),
  **mount**, **net**, **pid**, **ipc**, **uts**, **cgroup**. Docelowo tworzone
  bezpośrednio przez `conductord` (Rust, `clone3` + mount API), z bubblewrapem jako
  pierwszą, sprawdzoną implementacją w fazie 1 (bwrap jest mały, ma licencję LGPL
  i jest dostępny w dystrybucjach). Prototyp pokazuje oba warianty z identycznym zachowaniem.
- **System plików**: nowy root na tmpfs; worktree agenta bind mount rw (ta sama ścieżka
  co na hoście, żeby ścieżki w diffach i logach się zgadzały); `/usr` i toolchainy
  wskazane w polityce (`/opt/jdk-21`, `~/.rustup` w trybie ro itp.) bind mount ro;
  kuratorowany podzbiór `/etc`; prywatne `/tmp`, `/run`, `/dev/shm`; świeży `/proc`;
  minimalny `/dev` z własną instancją `devpts`. Nie montujemy `$HOME`, `/run/user`,
  `/var/run/docker.sock`, `/sys`. Katalog `.git` głównego repozytorium (wspólny dla
  worktree) montujemy ro, poza `refs/` i `objects/` potrzebnymi do commitów na gałęzi
  agenta; push idzie przez wrapper git w daemonie (zgoda człowieka, PLAN.md 4.1 p. 4).
- **Procesy i syscalle**: komenda agenta startuje z pustym zbiorem capabilities
  (także bounding set), `no_new_privs`, w osobnym PID namespace (pierwszy proces jest
  initem sandboksa, jego śmierć kończy wszystkie procesy agenta). Filtr **seccomp**
  (denylista z akcją `EPERM`, domyślnie ALLOW; uzasadnienie w sekcji „Seccomp i cgroups”
  niżej) blokuje m.in.: `socket()` dla rodzin innych niż `AF_UNIX`/`AF_INET`/`AF_INET6`
  (w tym `AF_VSOCK`, `AF_PACKET`, `AF_NETLINK`), `unshare`/`setns`/`clone` z `CLONE_NEW*`,
  `mount`, `pivot_root`, `bpf`, `perf_event_open`, `keyctl`, `add_key`, `io_uring_*`,
  `ptrace` (z wyjątkiem trybu debugowania włączanego polityką), `kexec_*`, `init_module`;
  inna architektura (ABI) niż natywna kończy proces. Limity przez **cgroup v2** z delegacją
  systemd (`pids.max`, `memory.max`, `cpu.max` per agent) oraz rlimity jako warstwa zapasowa.
- **Rootless Podman** zostaje backendem opcjonalnym dla zespołów, które chcą toolchainu
  z obrazu (powtarzalność buildów), z wymuszonym `--network none` i tym samym Egress Guardem.
  Nie jest domyślny, bo wymaga konfiguracji `subuid/subgid` przez administratora,
  ma większy narzut startu i domyślnie daje kontenerowi dostęp do sieci.

### macOS: M1, Lima

Jedna trwała VM z Linuksem (Virtualization.framework, obraz z wewnętrznego rejestru),
uruchamiana przez `conductord` przy pierwszym agencie. Wewnątrz te same sandboksy L1.
Do VM udostępniamy przez virtiofs wyłącznie katalog z worktree agentów, nie `$HOME`.
Proxy Egress Guard działa w `conductord` na macOS, a do VM trafia jako przekazany
unix socket (port forwarding Limy dla socketów); VM nie ma własnego wyjścia sieciowego
poza tym kanałem (sieć user-mode wyłączona albo zablokowana nft w gościu).
`sandbox-exec` dopuszczamy wyłącznie jako tryb "lite" włączany polityką dla repozytoriów
niskiej klasyfikacji, gdy agent musi użyć natywnych narzędzi macOS (Xcode). Nie
traktujemy go jako granicy bezpieczeństwa równoważnej L1.

### Windows: W1, WSL2

Dedykowana dystrybucja `conductor` importowana z wewnętrznego rejestru, z
`/etc/wsl.conf`: `[interop] enabled=false, appendWindowsPath=false`,
`[automount] enabled=false`. W niej sandboksy L1; worktree leżą w systemie plików
dystrybucji (szybciej niż `/mnt/c`, bez ekspozycji dysku Windows). Proxy działa w
`conductord` uruchomionym w tej samej dystrybucji, a UI łączy się z daemonem przez
named pipe/AF_UNIX. W sandboksie dodatkowo: brak `/run/WSL` i socketu interop,
seccomp blokuje `AF_VSOCK`. Włączenie funkcji WSL to jednorazowa czynność IT.

### Egress Guard: E2, netns bez interfejsów + unix socket proxy

1. **Osobny network namespace na sandbox, w którym jest tylko `lo`.** Nie ma veth,
   trasy domyślnej ani adresów spoza loopbacku. Bezpośrednie połączenia (IPv4, IPv6,
   UDP, ICMP) kończą się `ENETUNREACH`, bez względu na reguły. Loopback sandboksa jest
   jego własny, więc usługi hosta na `127.0.0.1` (w tym firmowe proxy) są niedostępne,
   tak samo jak abstrakcyjne unix sockety hosta, bo są przypisane do netns.
   W netns sandboksa instalujemy regułę nftables `inet` (polityka drop, wyjście tylko
   przez `lo`) jako drugą warstwę, gdyby kiedyś pojawił się dodatkowy interfejs.
2. **Jedyne wyjście: lokalne proxy.** `conductord` wystawia dla każdego sandboksa osobny
   unix socket (osobny katalog, bind mount do `/run/conductor/egress/`). W sandboksie
   most `127.0.0.1:3128 -> unix socket` i zmienne `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`.
   Osobny socket per sandbox identyfikuje sandbox bez uwierzytelniania tokenem; dodatkowo
   proxy zapisuje `SO_PEERCRED` (pid/uid) w audycie.
3. **Decyzja w proxy** (HTTP CONNECT):
   - tylko metoda CONNECT; cel `host:port` musi pasować do allowlisty z polityki
     (dokładna nazwa albo `*.domena`, zawsze z portem),
   - literały IP (IPv4 i IPv6) są odrzucane, chyba że są jawnie na allowliście,
   - nazwę rozwiązuje proxy; adres docelowy jest logowany, a adresy specjalne
     (loopback, link-local, metadane, ULA spoza firmowych zakresów) są odrzucane
     (rebinding: nazwa z allowlisty nie może wskazywać na `127.0.0.1` stacji),
   - po `200 Connection established` proxy czyta pierwszy rekord: jeśli to TLS
     ClientHello, **SNI musi być równe hostowi z CONNECT**, a brak SNI oznacza odmowę;
     ruch nie-TLS tylko dla wpisów oznaczonych `plaintext` (np. SSH do forge),
   - połączenie do celu jest otwierane dopiero po tych sprawdzeniach,
   - każda próba (allow i deny, z powodem) oraz zamknięcie tunelu (bajty, czas)
     trafia do Audit Log jako JSON line; docelowo z łańcuchem hashy i eksportem do SIEM.
   Proxy może łańcuchować do firmowego proxy nadrzędnego, jeśli polityka tak stanowi.
4. **DNS.** Domyślnie sandbox **nie ma DNS**: nie ma resolvera osiągalnego z netns,
   a nazwy rozwiązuje proxy. To zamyka DNS exfiltration, bo żadne zapytanie z sandboksa
   nie dociera do rekurencyjnego resolvera. Dla narzędzi, które muszą rozwiązać nazwę
   przed użyciem proxy, przewidujemy opcjonalny **stub resolver** w sandboksie
   (przez ten sam kanał do `conductord`): odpowiada tylko dla nazw z allowlisty
   (adres zastępczy, a właściwe rozwiązanie robi proxy), dla reszty zwraca NXDOMAIN,
   **nigdy nie przekazuje zapytań dalej** i loguje każde zapytanie. Kanał
   exfiltracji przez nazwy pod domeną atakującego nie powstaje, bo nic nie jest
   rekurencyjnie rozwiązywane.
5. **Narzędzia bez obsługi proxy** (część klientów gRPC, niektóre SDK) uruchamiamy przez
   wrapper (np. `LD_PRELOAD`/natywne ustawienia) albo przez E1 z TPROXY tylko w trybie
   uprzywilejowanym (serwer buildfarmy). Nie przewidujemy E1 na stacjach roboczych.

### Odpowiedź na wymienione ataki

| Atak | Mitygacja |
|------|-----------|
| DNS exfiltration | Brak resolvera w netns; ewentualny stub odpowiada tylko dla allowlisty, bez rekurencji; nazwy rozwiązuje proxy tylko dla dozwolonych celów. |
| Bezpośrednie IP | Brak trasy w netns (`ENETUNREACH`); proxy odrzuca literały IP (`ip_literal`) i adresy specjalne po rozwiązaniu nazwy. |
| IPv6 | Netns nie ma adresów IPv6 poza `::1`; reguła nft w rodzinie `inet` obejmuje IPv4 i IPv6; proxy traktuje literały IPv6 jak IPv4. |
| Domain fronting | Porównanie SNI z hostem z CONNECT, odmowa TLS bez SNI. (ECH uniemożliwi sprawdzenie SNI: polityka może wtedy odrzucać ClientHello z rozszerzeniem ECH.) |
| Unix sockety hosta | Nie montujemy `$HOME`, `/run`, `/run/user`, `/var/run/docker.sock`, `/tmp` hosta; abstrakcyjne sockety odcina netns; `AF_VSOCK` blokuje seccomp; `SSH_AUTH_SOCK` nie przechodzi. |
| Sekrety w zmiennych | Środowisko budowane od zera (allowlista nazw z polityki); tokeny potrzebne agentowi (np. do LLM Gateway) wydaje daemon per sesja, krótkotrwałe, najlepiej wstrzykiwane przez proxy, a nie do środowiska agenta. |
| Usługi na loopbacku hosta | Własny loopback sandboksa. |
| Eksfiltracja przez dozwolone hosty | Poza zakresem sandboksa: DLP w LLM Gateway, push do forge tylko przez wrapper z zgodą człowieka; docelowo terminacja TLS dla forge (firmowe CA) i polityka per metoda/ścieżka. |
| Eskalacja przez jądro | Seccomp, zero capabilities, `no_new_privs`, blokada zagnieżdżonych user namespaces; wymaganie aktualnego jądra w polityce wdrożenia. |

### Weryfikacja prototypem

Prototyp `prototypes/sandbox-linux/` (Python + Bash, backendy `bwrap` i `unshare`)
implementuje E2 i część L1 (namespaces, `pivot_root`, zero capabilities, czyste
środowisko, audyt JSON lines). `test.sh` potwierdza w kontenerze deweloperskim,
jako root i jako uid 65534 (bez sudo): dozwolone połączenie przez proxy działa;
host spoza allowlisty, literał IP, niezgodne SNI i metoda inna niż CONNECT są
odrzucane i logowane; nie działa ominięcie proxy przez IPv4, IPv6, loopback hosta ani
DNS; zapis poza worktree nie trafia na hosta; sekrety ze środowiska i socket ssh-agent
nie są widoczne; host zostaje bez zmian. Seccomp i cgroups (issue #15) opisuje sekcja niżej.

### Seccomp i cgroups (issue #15)

**Seccomp: denylista, nie allowlista.** ADR pierwotnie zakładał allowlistę. Prototyp
używa denylisty, bo agent uruchamia dowolne toolchainy dewelopera (kompilatory, JVM,
Node, przeglądarki testowe), a allowlista wymagałaby pełnej wiedzy o ich syscallach i
psułaby się przy aktualizacjach glibc i jądra (np. `clone3`, `rseq`, `statx`). Awarie
buildów z powodu filtra prowadzą do wyłączania sandboksa, co jest gorsze niż węższy
filtr. Granicą bezpieczeństwa pozostają namespace'y, zero capabilities, `no_new_privs` i
Egress Guard; seccomp zamyka znane, ryzykowne i rzadko potrzebne interfejsy jądra,
podobnie jak domyślny profil Dockera i Podmana. Wariant allowlisty zostaje opcją na
później (np. tryb „strict” dla agentów bez buildów), gdy będziemy mieli dane z audytu.

Prototyp (`prototypes/sandbox-linux/sandbox-init.py`): program BPF budowany ręcznie
(ctypes, bez libseccomp), instalowany przez `prctl(PR_SET_SECCOMP)` po `no_new_privs`,
tuż przed `exec` mostu i komendy agenta, w obu backendach. Reguły: sprawdzenie
`AUDIT_ARCH_X86_64`/`AUDIT_ARCH_AARCH64` (inna ABI, np. i386 przez `int 0x80`, zabija
proces), odrzucenie ABI x32, `EPERM` dla: `ptrace`, `process_vm_readv/writev`,
`pidfd_getfd`, `bpf`, `perf_event_open`, `userfaultfd`, `keyctl`, `add_key`,
`request_key`, `kexec_*`, `init_module`, `finit_module`, `delete_module`, `mount`,
`umount2`, `pivot_root`, nowego mount API (`move_mount`, `open_tree`, `fsopen`,
`fsconfig`, `fsmount`, `fspick`, `mount_setattr`), `unshare`, `setns`, `clone` z
`CLONE_NEW*` (filtr argumentu), `io_uring_*`, `swapon`/`swapoff`, `reboot`, `acct`,
`quotactl`, `quotactl_fd`, `name_to_handle_at`/`open_by_handle_at`, `syslog`,
`iopl`/`ioperm`/`uselib` (x86_64), `personality` poza bezpiecznymi wartościami i
`socket` poza `AF_UNIX`/`AF_INET`/`AF_INET6`; `clone3` dostaje `ENOSYS` (BPF nie widzi
flag w `clone_args`, a glibc spada wtedy na `clone`). Numery syscalli pochodzą z
nagłówków UAPI 6.8 i są sprawdzane w teście. Ryzyka denylisty: syscalle nowsze niż
tabela są przepuszczane (wymaga to aktualizacji tabeli przy nowych jądrach), reszta
jądra (systemy plików, stos sieciowy, `ioctl`) pozostaje dostępna, `strace`/`gdb` nie
działają do czasu trybu debugowania z polityki. NETLINK jest zablokowany w całości (a nie
„`NETLINK_ROUTE` tylko do odczytu”, jak zakładał ADR), bo seccomp nie odróżni odczytu od
zapisu; glibc radzi sobie bez netlinku (`getaddrinfo` z `AI_ADDRCONFIG`), `ip` nie działa.

**cgroup v2.** Launcher tworzy podgrupę per przebieg w zapisywalnej, delegowanej
hierarchii cgroup v2 (root w korzeniu hierarchii albo `systemd-run --user --scope -p
Delegate=yes`), ustawia `pids.max`, `memory.max`, `memory.swap.max`, `cpu.max`,
przenosi do niej proces sandboksa przed `exec` (launcher i Egress Guard zostają poza nią),
a po zakończeniu raportuje zdarzenia limitów, robi `cgroup.kill` i usuwa podgrupę.
Gdy cgroup v2 nie jest dostępne, decyduje polityka `--cgroups required|best-effort|off`
(domyślnie `best-effort`: ostrzeżenie i wpis w `sandbox-status.json`). `conductord`
przekazuje swoje domyślne limity (`pids.max=4096`, `memory.max=8G`, swap 0, CPU bez
limitu), zmieniane opcjami `--sandbox-*`. `RLIMIT_NPROC` zostaje jako opcja, ale
limit procesów zapewnia `pids.max` (rlimit liczy procesy uid na całym hoście). W
kontenerze deweloperskim kontrolery `pids`/`memory`/`cpu` są przypięte do cgroup v1
(cgroup2 tylko z `hugetlb`), więc zweryfikowano polityki i cykl życia podgrupy, ale nie
egzekwowanie limitów (fork bomb, OOM); te testy są w `test-hardening.sh` i czekają na
host z cgroup v2.

**Ubuntu 24.04+.** Bez roota launcher sprawdza, czy user namespaces działają, i przy
blokadzie (np. `kernel.apparmor_restrict_unprivileged_userns=1`) kończy się czytelnym
komunikatem; przykładowy profil AppArmor dla bubblewrapa jest w
`prototypes/sandbox-linux/apparmor/` (nieinstalowany, nietestowany na Ubuntu).

### Egress Guard: rebinding, proxy nadrzędne, DNS i git (issue #16)

Prototyp (`egress-proxy.py`, `sandbox-bridge.py`, `test-egress.sh`) realizuje punkty 3-4
decyzji E2 oraz kontrolę `git push`:

- **Filtr adresów.** Proxy rozwiązuje nazwę raz, sprawdza wszystkie adresy i łączy się
  z jednym z nich (bez TOCTOU). Loopback i sieci prywatne (RFC1918, CGNAT, ULA) wymagają
  jawnej flagi reguły (`loopback`, `private`); link-local (metadata), unspecified,
  multicast, broadcast i zarezerwowane są odrzucane zawsze; IPv6 z osadzonym IPv4
  (mapped, NAT64, 6to4) jest oceniane po IPv4. Odmowa: `resolved_to_special_address`.
  Składnia allowlisty: `host[:port] [plaintext] [loopback] [private] [git]`; w
  `conductord` flagi poszerzające projektu muszą być pokryte przez organizację, a `git`
  z organizacji przechodzi na regułę projektu.
- **Proxy nadrzędne.** `--upstream-proxy http://host:port`: po pozytywnej decyzji
  tunel `CONNECT nazwa:port` przez proxy nadrzędne; filtr adresów dotyczy wtedy samego
  proxy nadrzędnego, a dopuszczenie jego klasy (zwykle `private`) daje konfiguracja
  launchera/daemona, nie allowlista agenta. Odmowa nadrzędnego: `upstream_proxy_refused`
  z kodem. Bez uwierzytelniania do proxy nadrzędnego.
- **Stub DNS** (`--dns stub`, domyślnie `none`): resolver w moście na `127.0.0.1:53`,
  decyzja i audyt każdego zapytania w Egress Guard (poza sandboksem), fikcyjne adresy
  `127.77.0.0/16` dla nazw z allowlisty, `NXDOMAIN` dla reszty, bez przekazywania zapytań.
  Połączenia na fikcyjne adresy most przechwytuje i zamienia na `CONNECT nazwa:port`.
  Test w hermetycznym netns z „szpiegiem” DNS potwierdza brak przekazywania.
- **Git.** Dla reguł `git` proxy terminuje TLS certyfikatem z CA generowanego per sandbox
  (openssl CLI; klucz w prywatnym katalogu stanu launchera, do sandboksa trafia tylko
  certyfikat), przepuszcza tylko smart HTTP `git-upload-pack`, odrzuca `git-receive-pack`
  (`git_push_requires_approval`) i łączy się z forge własnym TLS z weryfikacją (systemowe
  CA albo `--upstream-ca`). Zgoda człowieka na push to punkt rozszerzenia
  (`GitPushApproval`) dla Policy Engine (#20); dziś push jest zawsze odrzucany. Test
  używa prawdziwego `git http-backend`: clone/fetch działają, push nie dociera do forge.

Tym samym decyzja z punktu 6 „Dalszych kroków” (terminacja TLS dla forge) jest
prototypowo podjęta w wąskim zakresie: tylko hosty oznaczone `git`, tylko HTTP/1.1,
jedno żądanie na tunel. Pełny ADR o terminacji TLS (firmowe CA zamiast CA per sandbox,
LFS, HTTP/2, polityki per ścieżka dla innych hostów) nadal jest potrzebny.

## Konsekwencje

Pozytywne:
- Jeden mechanizm izolacji (L1 + E2) na wszystkich systemach; macOS i Windows uruchamiają
  go w VM z Linuksem. Jedna polityka i jeden format audytu.
- Brak ścieżki sieciowej obejścia Egress Guarda zamiast polegania na poprawności reguł
  firewalla; nic do posprzątania w netns hosta.
- Działa bez uprawnień administratora na Linuksie; na macOS i Windows wymagana jest
  tylko jednorazowa instalacja przez IT.
- Narzut startu na Linuksie rzędu milisekund, co pozwala na sandbox per komenda.

Negatywne:
- Narzędzia bez obsługi `HTTPS_PROXY` wymagają wrapperów; narzędzia, które same
  rozwiązują nazwy, wymagają stub resolvera.
- Proxy CONNECT bez terminacji TLS nie widzi treści. Dla forge (reguły `git`) proxy
  terminuje TLS własnym CA per sandbox, co oznacza utrzymanie parsera HTTP/1.1 w Egress
  Guard i zaufanie agenta do tego CA; push przez SSH nie jest kontrolowany i nie wolno
  dopuszczać go regułą `plaintext`.
- macOS: koszt VM (pamięć) i brak natywnych narzędzi Apple w sandboksie L1; tryb
  `sandbox-exec` jest słabszy i oparty na przestarzałym API.
- Windows: zależność od WSL2 i jego trybów sieci; jednorazowe włączenie funkcji przez IT.
- Unprivileged user namespaces bywają ograniczane (Ubuntu 24.04+ przez AppArmor,
  niektóre polityki hardeningu RHEL): paczka musi instalować profil AppArmor dla
  `conductord`, a dokumentacja wdrożenia musi to opisywać.
- Utrzymanie własnego filtra seccomp i listy montowanych ścieżek toolchainów.

Dalsze kroki:
1. Implementacja L1 w `conductord` (Rust): namespaces, mount API, seccomp (np. `seccompiler`),
   cgroup v2 przez systemd; bubblewrap jako backend przejściowy.
2. Egress Guard w `conductord`: allowlista z Policy Engine, socket per sandbox, filtr
   adresów specjalnych po rozwiązaniu nazwy, proxy nadrzędne (z uwierzytelnianiem),
   audyt z łańcuchem hashy (prototyp filtra i proxy nadrzędnego: issue #16).
3. Stub resolver ograniczony do allowlisty (prototyp: issue #16, `--dns stub`);
   w Ruście, z IPv6 i bez zajmowania portów sandboksa.
4. Prototyp M1 (Lima: obraz, virtiofs tylko dla worktree, przekazanie unix socketu proxy,
   brak sieci user-mode) i W1 (dystrybucja WSL2, `wsl.conf`, blokada interop i vsock).
5. Testy bezpieczeństwa w CI na każdą platformę (rozszerzony `test.sh`: seccomp, vsock,
   rebinding DNS, ECH).
6. Osobny ADR o terminacji TLS dla forge i polityce na poziomie metod HTTP
   (prototyp trybu `git` z issue #16) oraz zgoda człowieka na `git push` przez Policy Engine (#20).
