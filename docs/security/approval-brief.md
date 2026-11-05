# Materiał do zatwierdzenia: Conductor, plan i profil bezpieczeństwa

| | |
|---|---|
| **Dotyczy** | issue #7 |
| **Źródło** | `docs/PLAN.md`, sekcje 1, 3, 4, 5, 7 i 9 |
| **Status** | Do decyzji działu bezpieczeństwa IT |
| **Data** | 2026-11-05 |

> **Stan projektu:** w repozytorium jest szkielet (workspace Cargo, szablon ADR). Zabezpieczenia opisane w tym dokumencie są zobowiązaniami do wdrożenia. Nie są jeszcze zaimplementowane ani przetestowane.

---

## 1. Streszczenie dla kadry

Conductor to desktopowe środowisko pracy (IDE i orkiestrator), w którym programista nadzoruje wielu agentów AI pracujących równolegle nad jednym repozytorium. Każdy agent działa we własnym git worktree i sandboksie, a każde połączenie sieciowe przechodzi przez Egress Guard z listą dozwolonych hostów. W domyślnym profilu firmowym zapytania do modeli językowych trafiają wyłącznie do LLM Gateway działającego w sieci firmowej, na modelach open-weight. Dane kodu, promptów, diffów i kontekstu pozostają w firmie: płyną między stacją roboczą, sandboksami, LLM Gateway, wewnętrznym forge i CI, rejestrem artefaktów oraz systemem audytu (SIEM). Poza siecią firmową dane mogą trafić tylko w opcjonalnym profilu hybrydowym, za zgodą działu bezpieczeństwa, przez prywatny endpoint zatwierdzonego dostawcy, z DLP i wyłącznie dla repozytoriów o niskiej klasyfikacji. Profil air-gapped nie ma żadnego wyjścia, a aktualizacje przychodzą z nośnika lub wewnętrznego rejestru. Zgodnie z zobowiązaniem zespołu aplikacja nie zawiera telemetrii, crash reporterów ani automatycznych aktualizacji z internetu. Profil ustawia administrator w podpisanej polityce zarządzanej centralnie (MDM lub GPO), której użytkownik nie może osłabić. Projekt jest na wczesnym etapie, więc opisane zabezpieczenia są zobowiązaniami do wdrożenia, a nie stanem zrealizowanym. Zatwierdzenie planu i profilu należy do działu bezpieczeństwa IT, a dokument zawiera listę decyzji do podjęcia.

---

## 2. Diagram przepływu danych

Granice zaufania: **A** stacja robocza, **B** sandbox agenta, **C** sieć firmowa, **D** zewnętrzny dostawca LLM (tylko profil hybrydowy).

```
=========================== GRANICA A: stacja robocza dewelopera ===========================
  Conductor UI  (edytor, panel agentow, diff review, terminale)
     |  lokalne IPC: unix socket / named pipe, uwierzytelnione
     v
  conductord  (daemon: Orchestrator, Workspace Manager, Policy Engine,
               Secret Scanner/DLP, Audit Log, MCP Hub, Egress Guard)
     |                          |                           |
     v  worktree 1              v  worktree 2   ...         v  worktree N
  [Sandbox 1]                 [Sandbox 2]                 [Sandbox N]
  ===== GRANICA B: izolacja systemu plikow, procesow i sieci (namespace, nftables) =====
     |  jedyne wyjscie sieciowe sandboksa: Egress Guard (allowlista hostow)
     v
=================================== GRANICA C: siec firmowa ===================================
  LLM Gateway (on-prem; kwoty, DLP po stronie serwera, logi)
     -> vLLM / Ollama / TGI (modele open-weight)
  Wewnetrzny forge (GitLab, Gitea, Bitbucket Server lub GHES) + CI
  Rejestr artefaktow (aktualizacje, wtyczki, modele; Artifactory/Nexus)
  IdP (OIDC/SAML)     SIEM (eksport audytu)     Serwer kolaboracji (opcjonalnie, faza 4)
  Wewnetrzne serwery MCP (tylko zatwierdzony katalog)

     |  (tylko profil hybrydowy, opcjonalnie) zapytania po DLP przez LLM Gateway
     v
================================ GRANICA D: zewnetrzny dostawca LLM ================================
  Zatwierdzony dostawca przez prywatny endpoint / VPC
  Tylko repozytoria o niskiej klasyfikacji, za zgoda bezpieczenstwa.
  W profilu firmowym i air-gapped to polaczenie nie istnieje.
```

| # | Przepływ | Dane | Granica | Profil firmowy |
|---|----------|------|---------|----------------|
| F1 | Conductor UI do conductord | Polecenia, stan, decyzje człowieka | A (IPC lokalne) | Tak, lokalnie |
| F2 | conductord do sandboksu agenta | Worktree (kod), polecenia | A do B | Tak, lokalnie |
| F3 | Sandbox do LLM Gateway (przez Egress Guard) | Prompty, kontekst, diffy po skanie DLP | B do C | Tak, w sieci firmowej |
| F4 | LLM Gateway do modeli on-prem | Zapytania do modeli | C | Tak |
| F5 | Sandbox lub conductord do forge i CI | Gałęzie, PR-y, statusy CI | B do C | Tak, w sieci firmowej |
| F6 | Rejestr artefaktów do stacji roboczej | Aktualizacje, wtyczki, modele | C do A | Tak, tylko wewnętrznie |
| F7 | Audit log do SIEM | Zdarzenia audytu | A do C | Tak, w sieci firmowej |
| F8 | LLM Gateway do zewnętrznego dostawcy | Zapytania po DLP | C do D | Nie (tylko profil hybrydowy) |

---

## 3. Profile wdrożenia

| Cecha | Air-gapped | Firmowy (**domyślny**) | Hybrydowy (opcjonalny) |
|-------|------------|-------------------------|------------------------|
| Modele | Wyłącznie lokalne | LLM Gateway on-prem, modele open-weight (vLLM / Ollama / TGI) | Jak firmowy, plus zatwierdzony dostawca przez prywatny endpoint |
| Wyjście sieciowe | Brak jakiegokolwiek wyjścia | Tylko do usług firmowych (Gateway, forge, rejestr) przez Egress Guard | Jak firmowy, plus prywatny endpoint dostawcy z DLP |
| Repozytoria | Wszystkie klasy wyłącznie na modelach lokalnych | Dostęp do modeli wg klasyfikacji (decyzje D3 i D4) | Dla repozytoriów o niskiej klasyfikacji (decyzja D2) |
| Aktualizacje | Nośnik lub wewnętrzny rejestr | Wewnętrzny rejestr (Artifactory / Nexus), bez auto-update z internetu | Jak firmowy |
| Mirrory pakietów | Wewnętrzne, jeśli dotyczy | Wewnętrzne (npm, PyPI, Maven, crates) | Jak firmowy |
| Wymagana zgoda | Brak dodatkowej | Standardowa akceptacja planu | Osobna zgoda działu bezpieczeństwa |

**Rekomendacja zespołu:** profil **firmowy** jako domyślny, zgodnie z `docs/PLAN.md`, sekcja 4.3. Profil hybrydowy nie jest domyślny i wymaga osobnej zgody.

**Uwaga o ryzyku (plan, sekcja 7):** modele on-prem mogą być słabsze od chmurowych, co wpływa na jakość pracy agentów we wszystkich profilach bez zewnętrznego dostawcy. Plan ogranicza to przez porównywanie wyników (fan-out), pipeline z recenzentem i wewnętrzny benchmark modeli.

---

## 4. Pytania i decyzje dla działu bezpieczeństwa

Każdą pozycję należy zaznaczyć i wpisać decyzję.

- [ ] **D1. Domyślny profil wdrożenia.** Opcje: firmowy (rekomendacja zespołu) / air-gapped / inny (jaki?).
  - Decyzja: ___

- [ ] **D2. Dopuszczalność profilu hybrydowego.** Opcje: (a) niedopuszczalny; (b) dopuszczalny tylko dla repozytoriów o niskiej klasyfikacji, z DLP, za zgodą działu bezpieczeństwa; (c) dopuszczalny na innych warunkach. Pytania uzupełniające: kto zatwierdza konkretnego dostawcę i jaki jest proces przeglądu.
  - Decyzja: ___

- [ ] **D3. Klasyfikacja repozytoriów.** Plan podaje przykłady („ściśle tajne”, „niska klasyfikacja”), ale nie definiuje pełnej skali. Do ustalenia: nazwy i liczba klas, kto przypisuje klasę, jaka klasa domyślna dla nowego repozytorium, czy klasa może się zmieniać.
  - Decyzja: ___

- [ ] **D4. Mapowanie klasa do dozwolonych modeli.** Propozycja do potwierdzenia lub zmiany:

  | Klasa repozytorium | Dozwolone modele | Decyzja |
  |--------------------|------------------|---------|
  | Ściśle tajne | Tylko modele lokalne (on-prem), wg planu | ___ |
  | Pozostałe klasy (wg schematu z D3) | Do ustalenia | ___ |
  | Niska klasyfikacja | Modele on-prem; dostawca zewnętrzny tylko jeśli D2 to dopuszcza | ___ |

  - Decyzja: ___

- [ ] **D5. Retencja logów audytu.** Plan nie określa okresu przechowywania. Do ustalenia: okres, sposób archiwizacji, usuwanie po upływie okresu.
  - Decyzja: ___

- [ ] **D6. Format logów audytu i eksportu.** Plan przewiduje dziennik append-only z łańcuchem hashy. Do ustalenia: czy wystarczy format wewnętrzny, czy wymagany jest standard (np. JSON Lines lub CEF), oraz sposób weryfikacji łańcucha.
  - Decyzja: ___

- [ ] **D7. Integracja z SIEM.** Plan przewiduje eksport audytu do SIEM. Do ustalenia: który SIEM, sposób dostarczania (push, pull), wymagane pola zdarzeń, kto monitoruje alerty.
  - Decyzja: ___

- [ ] **D8. Podpisywanie paczek.** Plan wymienia dwie opcje: firmowe PKI albo Sigstore/cosign w trybie offline. Do ustalenia: wybór, kto zarządza kluczami i procedura rotacji.
  - Decyzja: ___

- [ ] **D9. Dystrybucja i konfiguracja.** Paczki MSI, PKG, DEB lub RPM z wewnętrznego rejestru. Polityka przez MDM lub GPO. Do ustalenia: które narzędzie dla których systemów (Windows, macOS, Linux) oraz kto utrzymuje podpisany plik polityki.
  - Decyzja: ___

- [ ] **D10. Katalog zatwierdzonych agentów CLI i serwerów MCP.** Plan wymaga listy zatwierdzonych agentów z wyłączoną telemetrią oraz serwerów MCP tylko z wewnętrznego, podpisanego katalogu. Do ustalenia: kto zatwierdza wpisy, jakie warunki konfiguracji są obowiązkowe i jak często katalog jest przeglądany.
  - Decyzja: ___

---

## 5. Zobowiązania techniczne zespołu

Weryfikacja to test automatyczny w CI, test penetracyjny lub audyt, jak wskazano w każdym wierszu. Kolumna „Faza” odwołuje się do planu realizacji (sekcja 6).

| # | Zobowiązanie | Jak weryfikowane | Faza (wg planu) |
|---|--------------|------------------|-----------------|
| Z1 | **Deny by default:** bez jawnej konfiguracji aplikacja nie łączy się z niczym poza localhost. | Test egress w CI, uruchomienie z domyślną konfiguracją i brak połączeń zewnętrznych. Audyt konfiguracji domyślnej. | 1 (Egress Guard) |
| Z2 | **Zero telemetrii:** brak klienta telemetrii, crash reporterów i zewnętrznych CDN. Fonty, ikony, gramatyki tree-sitter i serwery LSP zbundlowane lub z rejestru wewnętrznego. | Test egress w CI wykrywający połączenia wychodzące podczas uruchomienia i testów. Przegląd zależności i zasobów w buildzie (`cargo-deny`). | Od fazy 0 (CI) |
| Z3 | **Brak auto-update z internetu:** aktualizacje tylko z wewnętrznego rejestru. | Test egress, audyt konfiguracji kanału aktualizacji, test instalacji z rejestru wewnętrznego. | Do potwierdzenia |
| Z4 | **Egress Guard:** jedyne wyjście sandboksa, allowlista hostów (zwykle LLM Gateway i wewnętrzny forge). | Test penetracyjny „czy agent może wysłać dane na zewnątrz”. Wynik negatywny jest kryterium wyjścia fazy 1. Testy egress w CI. | 1 |
| Z5 | **Izolacja agenta:** tylko własny worktree, sieć z allowlisty, komendy wg polityki roli. | Testy izolacji systemu plików, procesów i sieci w sandboksie (Linux). Testy polityk Policy Engine. | 1 (sandbox), 2 (Policy Engine) |
| Z6 | **Człowiek w pętli:** zgoda na push, merge, zmiany w CI, zależnościach i plikach wrażliwych (`.env`, `secrets/`, `infra/`). | Testy Policy Engine: próba push lub zmiany w `.env` bez zgody kończy się blokadą. Audyt zgód w logu. | 2 |
| Z7 | **Secret scanner i DLP** przed każdym wywołaniem modelu. | Testy w CI na zestawie sztucznych sekretów (fixtures): każdy wykryty sekret jest zablokowany lub zamaskowany. Pilotaż. | 1 (podstawowy scanner), 3 (pełne DLP) |
| Z8 | **Tokeny krótkotrwałe:** wydawane przez daemon per sesja, nigdy w kontekście modelu, przechowywane w systemowym keychainie. | Test: token nie występuje w promptach ani w logach. Audyt miejsca przechowywania. | Do potwierdzenia |
| Z9 | **Audit log append-only** z łańcuchem hashy, eksport do SIEM. | Test wykrywania modyfikacji (zmieniony wpis psuje łańcuch). Audyt próbkowy: każde połączenie sieciowe z logu odpowiada wpisowi Egress Guard. | 1 (lokalny), 3 (SIEM) |
| Z10 | **Łańcuch dostaw:** reproducible builds, SBOM (CycloneDX), podpisy, `cargo-deny` i `cargo-audit` w CI, vendoring zależności. | Kontrola w CI (`cargo-deny`, `cargo-audit`). Weryfikacja SBOM i podpisu przy każdym wydaniu. Test powtarzalności buildu. | 0 |
| Z11 | **Rollback:** snapshot worktree przed każdym krokiem agenta. | Test przywrócenia stanu worktree po kroku agenta. | Do potwierdzenia |

---

## 6. Podpisy / akceptacja

Dokument nie stanowi akceptacji, dopóki nie zostanie podpisany przez osoby wskazane poniżej.

| Rola | Imię i nazwisko | Decyzja (zatwierdzam / zatwierdzam z warunkami / odrzucam) | Data | Podpis |
|------|-----------------|------------------------------------------------------------|------|--------|
| Dział bezpieczeństwa IT (przedstawiciel) | | | | |
| Lider zespołu Conductor | | | | |
| Sponsor biznesowy | | | | |

**Warunki (jeśli dotyczy):** ______________________________________________

**Uwagi działu bezpieczeństwa:** ______________________________________________
