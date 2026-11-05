# Conductor — plan budowy aplikacji

> Plan do zadania #1: aplikacja łącząca najlepsze elementy **Orca** i **Zed**. Ma działać w sieci firmowej bez wycieku danych do internetu i służyć do pracy w środowisku wieloagentowym AI.

---

## 1. Cel i założenia

**Conductor** to desktopowe środowisko pracy (IDE + orkiestrator), w którym programista prowadzi i nadzoruje wielu agentów AI pracujących równolegle nad jednym repozytorium. Dostaje przy tym szybki, natywny edytor i przegląd zmian.

Wymagania, których nie negocjujemy:

| # | Wymaganie | Co to znaczy w praktyce |
|---|-----------|------------------------|
| W1 | **Bezpieczeństwo danych** | Domyślnie zero ruchu wychodzącego poza sieć firmową. Brak telemetrii, auto-update z internetu i usług w chmurze. Każde połączenie sieciowe jest jawnie skonfigurowane i zapisane w logu audytowym. |
| W2 | **Wieloagentowość** | Wielu agentów naraz (różne modele i role), każdy w izolowanym środowisku, z koordynacją i przeglądem wyników przez człowieka. |
| W3 | **Praca offline / air-gap** | Instalacja i aktualizacje z wewnętrznego repozytorium artefaktów. Modele LLM hostowane on-premise. |
| W4 | **Wydajność edytora** | Edycja i nawigacja na poziomie Zed: natywny rendering, duże repozytoria, LSP, tree-sitter. |
| W5 | **Otwartość** | Dowolny agent CLI (jak w Orca) oraz otwarte protokoły: ACP, MCP i LSP. |

---

## 2. Co bierzemy z Orca, a co z Zed

### Z Orca (orkiestracja agentów)
- **Jeden agent = jeden git worktree + własny terminal.** Agenci pracują równolegle i nie muszą przełączać gałęzi ani robić stash.
- **Agent-agnostyczność.** Działa każdy agent CLI uruchamiany w terminalu, np. Claude Code, Codex, Gemini CLI, Aider czy OpenCode.
- **Ten sam prompt dla N agentów.** Wyniki można porównać obok siebie i scalić najlepszy.
- **Wbudowany przegląd zmian (diff review).** Zmiany agentów przeglądamy, komentujemy i akceptujemy przed merge.
- **Integracja z forge.** PR-y i statusy CI są powiązane z worktree. U nas to **wewnętrzny** GitLab, Gitea, Bitbucket Server lub GitHub Enterprise Server.
- **Powiadomienia.** Agent sygnalizuje, że skończył albo czeka na decyzję.
- **Zdalne wykonanie po SSH.** Agenci mogą działać na firmowych serwerach z GPU lub w buildfarmie.

### Z Zed (edytor i protokoły)
- **Natywny, wydajny edytor.** Rust, tree-sitter, LSP, multibuffery (edycja wielu fragmentów i plików w jednym widoku), szybkie wyszukiwanie.
- **Agent Client Protocol (ACP).** Ustandaryzowana komunikacja edytor ↔ agent: strumień zdarzeń, propozycje edycji, prośby o zgodę.
- **Panel agenta z edycjami inline.** Zmiany agenta widać jako diff w buforze z akcjami „akceptuj / odrzuć” per hunk.
- **Model uprawnień narzędzi.** Agent prosi o zgodę na wykonanie komendy lub zapis pliku. Zgody mogą wynikać z polityki.
- **Współpraca w czasie rzeczywistym (CRDT).** W Conductorze służy do wspólnego bufora człowieka i agentów, a w fazie 4 także do współpracy kilku osób przez **wewnętrzny** serwer kolaboracji.
- **Remote development.** Lekki klient, a ciężka praca (indeksowanie, LSP, agenci) na serwerze.

### Czego świadomie NIE bierzemy
- Usług chmurowych Zed: logowania, kolaboracji przez serwery Zed, hostowanych modeli, telemetrii i auto-update.
- Komponentów Orca zależnych od internetu: aplikacji mobilnej przez zewnętrzny relay i integracji z github.com.
- **Forka kodu Zed.** Edytor Zed jest na licencji GPL-3.0, a serwer na AGPL-3.0. Fork wymagałby udostępniania kodu na tych licencjach i usuwania wielu ścieżek komunikacji z chmurą. Bierzemy **koncepcje i otwarte protokoły** (ACP, LSP), a z bibliotek tylko te na licencjach permisywnych, np. GPUI (Apache-2.0) jako opcję.

---

## 3. Architektura

```
┌──────────────────────────── Stacja robocza dewelopera ────────────────────────────┐
│                                                                                    │
│  ┌──────────────────────── Conductor UI (klient) ───────────────────────┐          │
│  │ Edytor (tree-sitter, LSP, multibuffer) │ Panel agentów │ Diff review │          │
│  │ Terminale per agent │ Tablica zadań (orchestrator view) │ Audyt      │          │
│  └───────────────▲──────────────────────────────────────────────────────┘          │
│                  │ lokalne IPC (unix socket / named pipe, uwierzytelnione)         │
│  ┌───────────────┴──────────── conductord (daemon, Rust) ───────────────────────┐  │
│  │ Orchestrator  │ Workspace Mgr (worktrees) │ Agent Runtime (ACP + PTY)        │  │
│  │ Policy Engine │ Egress Guard │ Secret Scanner │ Audit Log │ MCP Hub          │  │
│  └───────┬──────────────────────┬───────────────────────────────┬──────────────┘  │
│          │                      │                               │                  │
│   ┌──────▼──────┐        ┌──────▼──────────┐             ┌──────▼──────┐           │
│   │ Sandbox A   │        │ Sandbox B       │    ...      │ Sandbox N   │           │
│   │ worktree A  │        │ worktree B      │             │ worktree N  │           │
│   │ agent CLI   │        │ agent ACP       │             │ agent CLI   │           │
│   └──────┬──────┘        └──────┬──────────┘             └──────┬──────┘           │
└──────────┼──────────────────────┼───────────────────────────────┼──────────────────┘
           │   jedyna dozwolona ścieżka sieciowa: przez Egress Guard / proxy          
           ▼                      ▼                               ▼
┌──────────────────────────────── Sieć firmowa ─────────────────────────────────────┐
│  LLM Gateway (on-prem)  →  vLLM / Ollama / TGI z modelami open-weight             │
│                         →  (opcjonalnie) zatwierdzony dostawca przez prywatny      │
│                            endpoint / VPC, z DLP i maskowaniem                     │
│  Wewnętrzny Git forge + CI  │  Rejestr artefaktów (aktualizacje, wtyczki, modele) │
│  SIEM (audyt)  │  IdP (OIDC/SAML, SSO)  │  Serwer kolaboracji (opcjonalnie)        │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Komponenty

| Komponent | Odpowiedzialność |
|-----------|------------------|
| **Conductor UI** | Edytor, panele agentów, diff review, terminale, widok orkiestracji. Cienki klient, który całą logikę deleguje do daemona. |
| **conductord** | Proces w tle (Rust, tokio). Zarządza worktree, sandboksami, agentami, politykami i audytem. Może działać lokalnie albo na serwerze zdalnym przez SSH, co odpowiada trybowi remote dev z Zed. |
| **Workspace Manager** | Tworzy i usuwa worktree (`git worktree`), nazywa gałęzie (`agent/<zadanie>/<agent>`), śledzi stan i rozwiązuje konflikty przy scalaniu. |
| **Agent Runtime** | Dwa tryby: **ACP** (pełna integracja z edytorem: edycje inline, prośby o zgodę) oraz **PTY** (dowolny agent CLI w terminalu, jak w Orca). Adaptery dla popularnych agentów. |
| **Orchestrator** | Rozdziela zadania między agentów: fan-out jednego promptu na N agentów, pipeline'y ról (planista → implementer → tester → recenzent), kolejki, limity współbieżności, zależności między zadaniami. |
| **Policy Engine** | Deklaratywne polityki (np. OPA/Rego lub własny DSL w TOML/YAML): które komendy, ścieżki, hosty i modele są dozwolone dla danej roli agenta, projektu i klasy danych. |
| **Egress Guard** | Wymusza politykę sieciową sandboksów. Dopuszcza wyłącznie hosty z allowlisty, zwykle tylko LLM Gateway i wewnętrzny forge. |
| **Secret Scanner / DLP** | Skanuje prompty, kontekst i diffy przed wysłaniem do modelu (gitleaks-like reguły + reguły firmowe). Blokuje lub maskuje sekrety i dane osobowe. |
| **MCP Hub** | Lokalny broker serwerów MCP (narzędzia dla agentów: wyszukiwanie w kodzie, dokumentacja wewnętrzna, Jira, baza wiedzy). Każdy serwer MCP podlega politykom. |
| **Audit Log** | Niezmienialny (append-only, z łańcuchem hashy) dziennik każdego promptu, wywołania narzędzia, komendy, połączenia sieciowego i decyzji człowieka. Eksport do SIEM. |
| **LLM Gateway** | Usługa w sieci firmowej z jednym API zgodnym z OpenAI/Anthropic. Routing do modeli on-prem, limity, kwoty per zespół, cache, logowanie, DLP po stronie serwera. |

### 3.2 Stos technologiczny (rekomendacja)

| Warstwa | Wybór | Uzasadnienie |
|---------|-------|--------------|
| Daemon | **Rust** (tokio, git2/gitoxide, portable-pty, tree-sitter) | Wydajność, bezpieczeństwo pamięci, ten sam ekosystem co Zed. |
| UI – MVP | **Tauri 2** + TypeScript + **CodeMirror 6** (lub Monaco, w pełni zbundlowane offline) + xterm.js | Najkrótsza droga do działającego produktu. Tauri ma rygorystyczny model uprawnień i CSP i nie ładuje niczego z sieci. |
| UI – docelowo (opcja) | **GPUI** (Apache-2.0) | Natywny rendering na GPU jak w Zed, jeśli MVP pokaże, że wydajność edytora jest wąskim gardłem. Decyzja na koniec fazy 2. |
| Protokoły | **ACP** (agenci), **MCP** (narzędzia), **LSP** (języki), JSON-RPC po lokalnym sockecie | Otwarte standardy, brak vendor lock-in. |
| Sandbox | Linux: **bubblewrap/namespaces + seccomp + nftables per sandbox** albo **rootless Podman**. macOS: kontener w lekkiej VM (np. Lima). Windows: WSL2 lub kontener. | Izolacja systemu plików (tylko własny worktree), procesów i sieci. |
| Modele | **vLLM / Ollama / TGI** z modelami open-weight do kodu, za LLM Gateway (np. LiteLLM) | Dane nie opuszczają firmy. |
| Uwierzytelnianie | OIDC/SAML z firmowym IdP. mTLS do gateway'a. | SSO, rozliczalność per użytkownik. |
| Dystrybucja | Podpisane paczki (MSI/PKG/DEB/RPM), aktualizacje z wewnętrznego rejestru (Artifactory/Nexus), SBOM | Brak auto-update z internetu, kontrola łańcucha dostaw. |

---

## 4. Model bezpieczeństwa

### 4.1 Zasady
1. **Deny by default.** Bez jawnej konfiguracji aplikacja nie łączy się z niczym poza localhost.
2. **Zero telemetrii.** W kodzie nie ma klienta telemetrii, crash reporterów ani zewnętrznych CDN. Wszystkie zasoby (fonty, ikony, gramatyki tree-sitter, serwery LSP) są zbundlowane albo pochodzą z wewnętrznego rejestru.
3. **Najmniejsze uprawnienia dla agentów.** Agent widzi tylko swój worktree, ma tylko sieć z allowlisty i tylko komendy dozwolone polityką roli.
4. **Człowiek w pętli.** Działania o wysokim ryzyku zawsze wymagają zgody człowieka: push, merge, zmiany w CI, w zależnościach i w plikach wrażliwych (`.env`, `secrets/`, `infra/`).
5. **Pełna rozliczalność.** Każde działanie agenta da się odtworzyć z audytu.

### 4.2 Zagrożenia i mitygacje

| Zagrożenie | Mitygacja |
|------------|-----------|
| Wyciek kodu lub sekretów do zewnętrznego LLM | Modele wyłącznie on-prem lub przez zatwierdzony prywatny endpoint. DLP i secret scanning przed każdym wywołaniem. Klasyfikacja repozytoriów (np. „ściśle tajne” = tylko modele lokalne). |
| Agent omija aplikację i łączy się bezpośrednio z internetem (curl, pip, npm) | Izolacja sieci sandboksa (nftables/namespace). Jedyne wyjście prowadzi przez Egress Guard. Mirrory pakietów (npm, PyPI, Maven, crates) wewnątrz firmy. |
| Prompt injection z treści repozytorium, issue lub dokumentacji | Rozdział instrukcji od danych, polityki narzędzi niezależne od treści promptu, zgoda człowieka na akcje wysokiego ryzyka, ograniczony zestaw narzędzi per rola. |
| Złośliwy lub skompromitowany serwer MCP / wtyczka | Wtyczki i serwery MCP tylko z wewnętrznego, podpisanego katalogu, każdy w osobnym sandboksie z własną polityką. |
| Destrukcyjne działania agenta (rm -rf, force push) | Agent działa tylko w swoim worktree. Komendy git przechodzą przez wrapper z polityką. Snapshoty worktree przed każdym krokiem agenta pozwalają na rollback. |
| Kradzież tokenów | Tokeny krótkotrwałe, wydawane przez daemon per sesja agenta. Nigdy nie trafiają do kontekstu modelu. Przechowywanie w systemowym keychainie. |
| Atak na łańcuch dostaw samej aplikacji | Reproducible builds, SBOM (CycloneDX), podpisy (Sigstore/cosign w trybie offline lub firmowe PKI), `cargo-deny` i `cargo-audit` w CI, vendoring zależności. |

### 4.3 Profile wdrożenia
- **Air-gapped:** wyłącznie modele lokalne, brak jakiegokolwiek wyjścia, aktualizacje przez nośnik lub wewnętrzny rejestr.
- **Firmowy (domyślny):** LLM Gateway w sieci firmowej, wewnętrzny forge, mirrory pakietów.
- **Hybrydowy (opcjonalny, za zgodą bezpieczeństwa):** gateway może przekazywać wybrane zapytania do zatwierdzonego dostawcy przez prywatny endpoint, z DLP i tylko dla repozytoriów o niskiej klasyfikacji.

Profil ustawia administrator przez **politykę zarządzaną centralnie** (podpisany plik polityki dystrybuowany przez MDM lub GPO). Użytkownik nie może jej osłabić.

---

## 5. Model pracy wieloagentowej

### 5.1 Pojęcia
- **Zadanie (Task):** jednostka pracy z opisem, kryteriami akceptacji i powiązanym issue.
- **Przebieg (Run):** wykonanie zadania przez konkretnego agenta w konkretnym worktree.
- **Rola:** profil agenta (model, prompt systemowy, dozwolone narzędzia i komendy, limity).
- **Playbook:** zdefiniowany przepływ ról (YAML) wersjonowany w repozytorium, np. `.conductor/playbooks/feature.yaml`.

### 5.2 Wzorce orkiestracji
1. **Fan-out / porównanie (Orca):** jedno zadanie trafia do N agentów lub modeli. UI pokazuje diffy obok siebie z wynikami testów i metrykami, a człowiek wybiera lub scala.
2. **Pipeline ról:** `planista → implementer → tester → recenzent`. Każdy krok dostaje artefakty poprzedniego, a recenzent może odesłać pracę do poprawki (pętla z limitem iteracji).
3. **Dekompozycja:** agent-planista dzieli duże zadanie na podzadania (DAG). Orchestrator uruchamia je równolegle w osobnych worktree, a potem scala, wykrywając konflikty.
4. **Supervisor:** jeden agent nadzoruje innych przez narzędzia MCP udostępniane przez daemon (`list_runs`, `read_diff`, `send_message`, `stop_run`). Zawsze obowiązują polityki i limity budżetu.

### 5.3 Koordynacja i współdzielony kontekst
- **Szyna zdarzeń** w daemonie (pub/sub). Agenci i UI subskrybują zdarzenia przebiegów.
- **Wspólna pamięć projektu:** lokalny indeks kodu (tree-sitter + embeddingi liczone **lokalnie**) udostępniony agentom przez MCP.
- **Blokady miękkie na pliki i moduły:** ostrzegają, gdy dwa przebiegi edytują ten sam obszar.
- **Budżety:** limity tokenów, czasu i liczby kroków per przebieg i per zadanie. Kwoty pilnuje LLM Gateway.

### 5.4 UX (kluczowe widoki)
- **Tablica przebiegów:** kafelki agentów ze statusem (pracuje / czeka na zgodę / gotowe / błąd), podglądem terminala i kosztem.
- **Skrzynka zgód:** kolejka próśb o zgodę od wszystkich agentów z kontekstem i akcjami zbiorczymi.
- **Diff review:** multibuffer (jak w Zed) ze zmianami jednego lub wielu przebiegów, akceptacja per hunk, komentarze wracające do agenta jako feedback.
- **Edytor:** pełne IDE z możliwością przejęcia pracy od agenta albo pracy w tym samym worktree co agent (CRDT).

---

## 6. Plan realizacji (fazy)

Szacunki dotyczą zespołu 4–6 osób (2–3 Rust, 1–2 frontend, 1 security/DevOps).

### Faza 0 — Fundamenty (3–4 tyg.)
- Decyzje architektoniczne (ADR): Tauri vs GPUI, format polityk, sandbox per OS.
- Repozytorium, CI na wewnętrznej infrastrukturze, `cargo-deny`, SBOM, podpisywanie.
- Prototyp `conductord`: IPC, tworzenie worktree, uruchomienie agenta CLI w PTY.
- Postawienie testowego LLM Gateway (LiteLLM + vLLM/Ollama) w sieci firmowej.

**Kryterium wyjścia:** demo „3 agentów CLI w 3 worktree, sterowanych z prostego UI”.

### Faza 1 — MVP orkiestratora (6–8 tyg.)
- UI: tablica przebiegów, terminale (xterm.js), diff review, prosty edytor (CodeMirror + LSP).
- Fan-out jednego promptu do N agentów i porównanie wyników.
- Sandbox Linux (bubblewrap + izolacja sieci) i Egress Guard z allowlistą.
- Audit log (lokalny, append-only) i podstawowy secret scanner.
- Integracja z wewnętrznym forge: tworzenie gałęzi i PR, status CI.

**Kryterium wyjścia:** pilotaż z jednym zespołem. Test penetracyjny „czy agent może wysłać dane na zewnątrz” kończy się wynikiem negatywnym.

### Faza 2 — Integracja ACP i edytor (6–8 tyg.)
- Pełna obsługa ACP: edycje inline, akceptacja per hunk, prośby o zgodę w UI.
- Policy Engine (role, playbooki, polityki zarządzane centralnie).
- MCP Hub z katalogiem zatwierdzonych serwerów MCP.
- Multibuffer, wyszukiwanie projektowe, lokalny indeks kodu.
- Sandbox dla macOS i Windows.
- **Decyzja:** czy migrować UI edytora na GPUI (benchmarki na dużych repozytoriach).

### Faza 3 — Zaawansowana orkiestracja (6–8 tyg.)
- Pipeline'y ról i dekompozycja na DAG zadań, agent-supervisor.
- Budżety i kwoty zintegrowane z LLM Gateway.
- Tryb zdalny: `conductord` na serwerze z GPU lub w buildfarmie, UI jako cienki klient przez SSH.
- Eksport audytu do SIEM, SSO (OIDC/SAML).

### Faza 4 — Skalowanie i współpraca (ciągła)
- Wewnętrzny serwer kolaboracji (CRDT): wspólne sesje ludzi i agentów.
- Panel administracyjny: polityki, kwoty, raporty użycia i jakości (np. odsetek zaakceptowanych zmian per model).
- Ewaluacja modeli on-prem na firmowych zadaniach (benchmark wewnętrzny).
- Ewentualna migracja edytora na GPUI.

---

## 7. Ryzyka

| Ryzyko | Wpływ | Mitygacja |
|--------|-------|-----------|
| Modele on-prem słabsze od chmurowych | Niższa jakość pracy agentów | Fan-out i porównywanie, pipeline z recenzentem i testami, wewnętrzny benchmark do wyboru modeli, profil hybrydowy dla repozytoriów o niskiej klasyfikacji. |
| Koszt GPU on-prem | Budżet | Współdzielony LLM Gateway z kwotami, mniejsze modele do prostych ról, cache. |
| Agenci CLI z własną telemetrią lub auto-update | Wyciek danych | Izolacja sieciowa sandboksa jest ostateczną barierą. Lista zatwierdzonych agentów z konfiguracją wyłączającą telemetrię. Testy egress w CI. |
| Złożoność sandboksów na 3 systemach | Opóźnienia | Linux jako platforma pierwszej klasy, a macOS i Windows przez kontener lub VM. Docelowo zalecany tryb zdalny (daemon na serwerze Linux). |
| Szybka ewolucja ACP i MCP | Prace adaptacyjne | Warstwa adapterów i testy kontraktowe protokołów. |
| Licencje (GPL/AGPL Zed) | Ryzyko prawne | Brak kopiowania kodu Zed (poza bibliotekami Apache-2.0). Przegląd licencji zależności w CI (`cargo-deny`). |

---

## 8. Metryki sukcesu
- **0** nieautoryzowanych połączeń wychodzących w testach egress i audycie.
- Czas od zadania do zaakceptowanego PR krótszy o X% względem pracy bez agentów (wartość X ustalona w pilotażu).
- Odsetek zmian agentów zaakceptowanych bez poprawek oraz średnia liczba iteracji recenzji.
- Wydajność edytora: otwarcie repozytorium o 1 mln linii w < 2 s, opóźnienie wpisywania < 16 ms.
- Adopcja: liczba aktywnych zespołów i przebiegów agentów tygodniowo.

---

## 9. Najbliższe kroki
1. Zatwierdzenie planu i profilu bezpieczeństwa z działem bezpieczeństwa IT.
2. Wybór modeli on-prem do pilotażu i postawienie LLM Gateway.
3. Utworzenie ADR-001 (UI: Tauri vs GPUI) i ADR-002 (sandbox).
4. Rozpisanie fazy 0 na issues w repozytorium.
