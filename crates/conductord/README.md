# conductord: prototyp daemona (faza 0, issue #12)

Pierwszy działający prototyp `conductord` z PLAN.md (sekcje 3 i 6, faza 0): IPC,
tworzenie worktree i uruchamianie agentów CLI w PTY. Kryterium wyjścia fazy 0,
czyli demo „3 agentów CLI w 3 worktree, sterowanych z prostego UI”, spełnia CLI
`conductor` z crate'a `conductor-cli`.

Crate'y:

| Crate | Rola |
|-------|------|
| `conductor-proto` | Typy JSON-RPC 2.0, metody protokołu, własny koder/dekoder JSON, base64, synchroniczny klient. Bez `unsafe`. |
| `conductord` | Daemon: IPC, uwierzytelnianie, Workspace Manager, Agent Runtime, integracja sandboksa (`src/sandbox.rs`, issue #14). `unsafe` wyłącznie w `src/ffi.rs`. |
| `conductor-cli` | Binarka `conductor`, cienki klient protokołu (UI fazy 0). Bez `unsafe`. |

## Architektura

```
conductor (CLI) ──┐                       ┌── wątek "signals" (sigwait: TERM/INT/HUP)
UI Tauri (przyszłe)├─ JSON-RPC 2.0 / \n ──►│   pętla accept ──► wątek na połączenie
testy              ┘  unix socket 0600    │        │ auth(token) + SO_PEERCRED (UID)
                      w katalogu 0700     │        ▼
                                          │   dispatch ──► Workspace Manager (git, mutex)
                                          │           └──► Agent Runtime
                                          │                 ├─ PTY (posix_openpt, setsid, TIOCSCTTY)
                                          │                 ├─ wątek czytelnika ─► ring buffer (offsety absolutne)
                                          │                 └─ wątek waiter (kod wyjścia)
```

- **IPC.** `std::os::unix::net::UnixListener`. Socket domyślnie w
  `$XDG_RUNTIME_DIR/conductor/conductord.sock`. Gdy tej zmiennej nie ma, używany jest
  `/tmp/conductor-<uid>/conductord.sock`. Ścieżkę można zmienić przez `--socket` albo
  `$CONDUCTOR_SOCKET`. Katalog socketu ma prawa 0700 i jest sprawdzany przy starcie:
  musi należeć do nas i nie może być symlinkiem. Sam socket ma prawa 0600. Ramkowanie
  to jedna wiadomość JSON na linię, z limitem 4 MiB na ramkę. Daemon nie obsługuje
  batchy ani notyfikacji.
- **Uwierzytelnianie.** Są trzy warstwy. Pierwszą są prawa do katalogu i socketu.
  Drugą jest `SO_PEERCRED`: połączenie od innego UID jest zamykane bez odpowiedzi.
  Trzecią jest losowy token: 32 bajty z `/dev/urandom` zapisane w `<socket>.token` z
  prawami 0600 i porównywane w czasie stałym. Klient musi wywołać `auth {token}` jako
  pierwszą metodę i ma na to 10 s. Zły token albo inna metoda przed `auth` daje błąd
  `-32001` i zamknięcie połączenia. Odpowiedź na `auth` zawiera `protocol_version`.
  Gdy klient poda inną wersję, dostaje `-32004`.
- **Workspace Manager.** Daemon wywołuje `git worktree add -b agent/<task-slug>/<run-name> <ścieżka> HEAD`
  przez `std::process::Command`. Wszystkie operacje git są serializowane jednym mutexem.
  Slug zadania składa się z małych liter ASCII, cyfr i myślników, ma najwyżej 40 znaków,
  a polskie znaki są transliterowane. Nazwa przebiegu musi pasować do `[A-Za-z0-9_-]{1,32}`.
  Worktree powstają w `<repo>.worktrees/<task-slug>/<run-name>` obok repozytorium albo
  w `--worktree-root`. Jeśli agenta nie da się uruchomić, worktree i gałąź są
  wycofywane. `run.remove --delete-worktree` wykonuje `git worktree remove --force`,
  a gałąź z commitami agenta zostaje.
- **Agent Runtime.** Agent dostaje prawdziwy PTY przez FFI (`posix_openpt`, `grantpt`,
  `unlockpt`, `ptsname_r`, a w `pre_exec`: `setsid`, `ioctl(TIOCSCTTY)` i odblokowanie
  sygnałów). Terminal ma rozmiar 120x40, a `TERM` to `xterm-256color`. Gdy PTY nie da
  się otworzyć, albo przy `--no-pty`, daemon używa pipe'ów: stdout i stderr są złączone
  przez `std::io::pipe`, a agent dostaje własną grupę procesów. Wyjście trafia do ring
  buffera (domyślnie 1 MiB na przebieg). Każdy bajt ma absolutny offset, więc wielu
  klientów może niezależnie śledzić wyjście, a utrata danych jest jawna (`dropped`).
  `run.output` obsługuje long-poll (`wait_ms`). Agent dostaje zmienne `CONDUCTOR_RUN_ID`,
  `CONDUCTOR_RUN_NAME`, `CONDUCTOR_TASK`, `CONDUCTOR_BRANCH` i `CONDUCTOR_WORKTREE`.
- **Stop i shutdown.** `run.stop` wysyła SIGTERM do całej grupy procesów
  (`kill(-pgid)`), a po timeoucie (domyślnie 5 s) SIGKILL. Shutdown uruchamia
  `daemon.shutdown` albo SIGTERM/SIGINT/SIGHUP, które odbiera synchronicznie wątek
  `sigwait`. Daemon przestaje wtedy przyjmować połączenia, równolegle zatrzymuje
  wszystkich agentów, usuwa socket i token, po czym kończy się z kodem 0. Worktree
  zostają na dysku.
- **Logowanie.** Logi idą na stderr w formacie `RFC3339 POZIOM wiadomość`. `-v` włącza
  poziom DEBUG.

### Protokół (v1)

Pełna tabela metod jest w `crates/conductor-proto/src/methods.rs`. W skrócie:
`auth`, `run.start {repo, task, agent_cmd, name?}` → `{run_id, name, worktree, branch}`,
`run.list`, `run.stop {run_id, timeout_ms?}`,
`run.output {run_id, since?, max_bytes?, wait_ms?}` → `{data_b64, offset, next_offset, dropped, exited, exit_code?, signal?}`,
`run.input {run_id, data | data_b64}`, `run.remove {run_id, delete_worktree}` i
`daemon.shutdown`. W polu `run_id` można podać identyfikator (`r1`) albo nazwę (`a1`).
Wyjście terminala zawsze przychodzi jako surowe bajty w base64 (ADR-001). Nieznane pola
są ignorowane, więc dodawanie pól jest zgodne wstecz.

Kody błędów: standardowe JSON-RPC oraz `-32001` (brak autoryzacji), `-32002` (nieznany
przebieg), `-32003` (konflikt stanu), `-32004` (wersja protokołu), `-32005` (trwa
shutdown), `-32010` (git) i `-32011` (spawn).

## Sandbox agentów (issue #14)

Daemon domyślnie **wymaga** sandboksa. Bez `--sandbox-launcher` (albo
`$CONDUCTOR_SANDBOX_LAUNCHER`) nie wystartuje; uruchomienie agentów bez izolacji
wymaga jawnego `--no-sandbox` i jest głośno logowane. Przy starcie daemon robi
próbny sandbox (`/bin/sh -c 'echo sandbox-ok'`); jeśli namespace'y nie działają,
daemon kończy się błędem, zamiast uruchamiać agentów bez izolacji.

Każdy przebieg startuje przez launcher z `prototypes/sandbox-linux/run-sandboxed.sh`
(ADR-002). Daemon przekazuje mu:

| Co | Skąd / jak |
|----|------------|
| Allowlistę Egress Guard | `--egress-allowlist` (organizacja) ∩ `<repo>/.conductor/egress-allowlist.txt` (projekt, czytany z głównego checkoutu, nie z worktree agenta). Projekt może tylko zawęzić organizację (ADR-003); reguły spoza organizacji są odrzucane i logowane. Brak allowlisty organizacji = brak sieci. |
| Montowania git | `.git` repo tylko do odczytu (config, hooks, inne gałęzie); do zapisu tylko `objects/`, katalog refów i reflogów gałęzi agenta (`refs/heads/agent/<zadanie>/`) i `.git/worktrees/<id>`; pliki `commondir`, `gitdir` i plik `.git` w worktree tylko do odczytu. `git status`/`add`/`commit` działają, a agent nie przestawi `main`, nie zmieni `config` ani nie przepnie worktree na inne repo. |
| Środowisko | Launcher dostaje tylko `PATH` i locale; do agenta trafiają wyłącznie `CONDUCTOR_*`, autor git (`Conductor agent <nazwa> <nazwa@agents.conductor.invalid>`) i `gc.auto=0`. Sekrety ze środowiska daemona nie przechodzą. |
| Audit log | `<katalog socketu>/state/audit.jsonl` (0600, JSON lines): zdarzenia daemona (`run.start` z efektywną i odrzuconą allowlistą, `run.stop`, `run.remove`, `run.start_failed`) oraz wpisy Egress Guard każdego sandboksa (`sandbox` = `run_id`). Łańcuch hashy: #17. |

Opcje: `--sandbox-backend auto|bwrap|unshare`, `--sandbox-full-etc` (pełny `/etc`
zamiast minimalnego). `conductor list` pokazuje kolumnę `SANDBOX`.

Test `tests/sandbox.rs` (oba backendy) uruchamia agenta, który próbuje: połączenia do
hosta z allowlisty (działa), do hosta, którego chciał projekt, a organizacja nie
pozwala (odrzucone), bezpośredniego TCP (brak sieci), zapisu poza worktree, do
głównego checkoutu, do `.git/config` i do pliku `.git` (bez skutku na hoście),
przesunięcia `main` (odrzucone), commita na własnej gałęzi (działa), oraz sprawdza,
że sekret ze środowiska daemona nie dociera do agenta, a audit log zawiera decyzje.

Ograniczenia integracji:

- Logika sandboksa jest w launcherze (Bash + Python), nie w Ruście; narzut ~0,3 s na start.
- Agenci tego samego zadania (`refs/heads/agent/<zadanie>/`) mogą przestawiać sobie
  nawzajem gałęzie, bo dzielą katalog refów.
- Agent może zapisywać dowolne obiekty w `.git/objects` repo (nie zmienia to żadnej
  gałęzi poza jego własną).
- Backend `bwrap` tworzy nową sesję, więc `conductor stop` nie dostarcza agentowi
  łagodnego SIGTERM: sandbox jest zabijany w całości. W backendzie `unshare` agent
  dostaje SIGTERM.
- Brak seccomp i cgroups (#15), DNS, proxy nadrzędnego i kontroli `git push` (#16).

## Demo: 3 agentów w 3 worktree

```sh
cargo build                      # w sandboksie bez sieci: RUSTUP_TOOLCHAIN=stable cargo build --offline
export PATH="$PWD/target/debug:$PATH"
export CONDUCTOR_SOCKET=/tmp/conductor-demo/conductord.sock

# Sandbox (domyślnie wymagany); bez allowlisty organizacji agenci nie mają sieci.
conductord --sandbox-launcher "$PWD/prototypes/sandbox-linux/run-sandboxed.sh" \
  2>/tmp/conductor-demo.log &    # logi na stderr; --no-sandbox tylko do testów

# Repozytorium testowe
mkdir -p /tmp/demo-repo && cd /tmp/demo-repo && git init -q -b main
echo 'def add(a, b): return a - b' > calc.py && git add . && git commit -qm init

# Trzech agentów, każdy we własnym worktree i na własnej gałęzi
conductor start --repo . --task "Fix add bug" --name a1 -- \
  bash -c 'echo "def add(a, b): return a + b" > calc.py; git commit -qam "fix by a1"; echo a1 done'
conductor start --repo . --task "Fix add bug" --name a2 -- \
  bash -c 'echo "def add(a, b): return sum((a, b))" > calc.py; git commit -qam "fix by a2"; exit 3'
conductor start --repo . --task "Fix add bug" --name a3 -- \
  bash -c 'read -r -p "approve? " ans; echo "answer=$ans"; while :; do sleep 1; done'

conductor list                   # stan, kody wyjścia, gałęzie i worktree
conductor logs a1                # wyjście (surowe bajty z PTY)
conductor send a3 yes            # input na terminal agenta (z \n)
conductor logs a3 -f &           # śledzenie do zakończenia
conductor stop a3                # SIGTERM na grupę procesów, potem ewentualnie SIGKILL
git worktree list; git log --oneline --all --graph
conductor rm a1 --delete-worktree; conductor rm a2 --delete-worktree; conductor rm a3 --delete-worktree
conductor shutdown
```

Test integracyjny `tests/end_to_end.rs` przechodzi ten sam scenariusz automatycznie:
3 przebiegi z kodami wyjścia 0, 3 i 7, pliki w worktree, osobne gałęzie, input, stop,
odrzucenie złego tokenu i niezgodnej wersji protokołu, wycofanie po nieudanym spawnie
oraz sprzątanie i shutdown.

## Dlaczego tylko biblioteka standardowa

PLAN.md zakłada tokio, git2/gitoxide i portable-pty. W środowisku, w którym powstał
prototyp, polityka sieci blokuje crates.io (403), a cache rejestru jest pusty. Nie
obchodzimy tej blokady. Prototyp ma więc zero zależności zewnętrznych. Ma to dwie zalety:

- `Cargo.lock` zawiera tylko nasze trzy crate'y, więc `cargo deny` i `cargo audit` nie
  mają czego zgłaszać, a łańcuch dostaw jest pusty.
- Kontrakt na kablu (JSON-RPC v1) jest zdefiniowany i przetestowany niezależnie od
  bibliotek, na których stoi implementacja.

Koszty i ograniczenia tej decyzji:

- Daemon używa wątku na połączenie i dwóch wątków na przebieg zamiast async. Przy
  dziesiątkach agentów to wystarcza, przy tysiącach nie.
- Moduł FFI (`src/ffi.rs`) ma ręcznie zdefiniowane struktury i stałe. Działa tylko na
  Linuksie x86_64/aarch64 z glibc, a na innych platformach kompilacja jest celowo
  przerywana przez `compile_error!`.
- Własny JSON obsługuje tylko liczby całkowite. Liczby zmiennoprzecinkowe są odrzucane
  jawnie, nie gubione po cichu.

## Plan migracji (gdy sieć pozwoli)

Zasada: protokół na kablu pozostaje bez zmian (v1). Testy kontraktowe w
`conductor-proto` (`exact_wire_format`, roundtripy) oraz test end-to-end mają przejść
bez modyfikacji, bo to one pilnują tej zasady.

1. **serde + serde_json** zamiast `json.rs`. Typy z `methods.rs` dostają
   `#[derive(Serialize, Deserialize)]` z `#[serde(skip_serializing_if = "Option::is_none")]`
   i polem `data_b64` przez `serde_with`/`base64`. `Wire` zostaje jako cienka fasada,
   więc reszta kodu się nie zmienia. Testy `exact_wire_format` pilnują identycznych bajtów.
2. **tokio** zamiast wątków: `tokio::net::UnixListener`, zadanie na połączenie, zadania
   czytelnika i waitera na przebieg, `tokio::sync::Notify` zamiast `Condvar` i
   `tokio::signal` zamiast wątku `sigwait`. Przy tej okazji long-poll można zastąpić
   subskrypcjami (`run.subscribe` z notyfikacjami `run.output`) jako dodatkiem w v1,
   bez usuwania `run.output`.
3. **portable-pty** (albo `rustix`/`nix` dla samego PTY) zamiast `ffi.rs`. To da też
   macOS. `SO_PEERCRED`/`getpeereid` z `rustix` albo `nix`, a sygnały z `nix` lub
   `rustix::process`. Docelowo moduł FFI znika i crate dostaje `#![forbid(unsafe_code)]`.
4. **clap** zamiast ręcznego parsowania w `conductor-cli`. Nazwy komend i flag zostają.
5. **git2/gitoxide** zamiast `git` CLI w Workspace Managerze, za tym samym API
   (`create`, `remove`, `rollback`).

Każdy krok to osobny PR, który przechodzi ten sam zestaw testów.

## Znane braki (TODO)

- Brak Policy Engine (#20): zgody człowieka i polityki komend nie są egzekwowane.
- Sandbox: patrz ograniczenia w sekcji „Sandbox agentów”.
- Stan przebiegów żyje tylko w pamięci. Po restarcie daemona przebiegi znikają, a
  worktree i gałęzie zostają na dysku.
- Brak subskrypcji i zdarzeń (pub/sub). `run.output` to long-poll.
- Brak zmiany rozmiaru terminala (`run.resize`) i sygnałów innych niż stop.
- Między zakończeniem procesu a zapisaniem kodu wyjścia jest bardzo krótkie okno, w
  którym PID mógłby zostać ponownie użyty przed SIGTERM. Zamknie je przejście na `pidfd`.
- Jeśli proces w tle trzyma PTY otwarty po wyjściu agenta, `exited` ustawia się po
  2 s, nawet gdy wyjście nie dostało jeszcze EOF.
- Tylko Linux (x86_64/aarch64, glibc). Nie ma named pipe dla Windows ani wsparcia macOS.
