# ADR-003: Format polityk: OPA/Rego vs własny DSL (TOML/YAML)

- **Status:** proponowany
- **Data:** 2026-11-05
- **Issue:** #10

## Kontekst

Policy Engine w `conductord` (PLAN.md, sekcja 3.1) decyduje, które komendy, ścieżki, hosty sieciowe, modele LLM i narzędzia MCP są dozwolone dla danej roli agenta, projektu i klasy danych repozytorium. Sekcja 4 dodaje wymagania bezpieczeństwa, które zawężają wybór formatu:

- **Deny by default** (4.1 pkt 1) i najmniejsze uprawnienia dla agentów (pkt 3).
- **Człowiek w pętli** (pkt 4): push, merge, zmiany w CI, w zależnościach i w plikach wrażliwych (`.env`, `secrets/`, `infra/`) wymagają zgody człowieka. Format musi więc wyrażać trzeci wynik poza „zezwól” i „odmów”.
- **Pełna rozliczalność** (pkt 5) i Audit Log (3.1): każda decyzja ma trafić do dziennika razem z uzasadnieniem.
- **Polityka zarządzana centralnie** (4.3): podpisany plik dystrybuowany przez MDM lub GPO, którego użytkownik nie może osłabić. Wymaga to modelu warstw **org > projekt > użytkownik**, w którym niższa warstwa może tylko zaostrzać.
- Profile wdrożenia (air-gapped, firmowy, hybrydowy) muszą dać się wyrazić jako różne zestawy polityk, bez zmian w kodzie.

Kryteria oceny:

1. Ekspresyjność i czytelność dla administratorów (nie programistów).
2. Wydajność ewaluacji i łatwość osadzenia w Rust (decyzje zapadają przy każdej komendzie, połączeniu i wywołaniu narzędzia).
3. Podpisywanie i wersjonowanie.
4. Testowalność.
5. Deterministyczność i audytowalność decyzji.
6. Wymuszenie zasady „niższa warstwa tylko zaostrza” przez konstrukcję, a nie przez konwencję.
7. Licencja i ryzyko utrzymania (zespół jest mały; kod ma przejść przeglądy bezpieczeństwa w korporacji).

Zakres reguł do wyrażenia: dozwolone komendy, ścieżki, hosty, modele LLM i narzędzia MCP per rola (planista, implementer, tester, recenzent), per projekt i per klasa danych (0 publiczne, 1 wewnętrzne, 2 poufne, 3 ściśle tajne), oraz lista akcji wymagających zgody człowieka.

## Rozważane opcje

1. **OPA/Rego, zewnętrzny proces OPA** (sidecar, REST lub WASM). Dojrzały ekosystem (`opa test`, `opa eval --explain`, Conftest), ale dodatkowy proces w Go albo runtime WASM do dystrybucji i pilnowania.
2. **Rego osadzone w Rust przez `regorus`** (interpreter Rego, Microsoft, licencja MIT). Brak dodatkowego procesu, ten sam język co w opcji 1; zgodność z OPA nie jest pełna, a część wbudowanych funkcji (np. `time.now_ns`, `http.send`) jest nieodpowiednia dla deterministycznych decyzji.
3. **Własny DSL w TOML/YAML.** Deklaratywne listy dozwolone/zabronione z ustalonym algorytmem łączenia warstw. Maksymalna czytelność i pełna kontrola nad semantyką, ale cały język, walidator, testy i narzędzia utrzymujemy sami.
4. **Cedar** (Amazon, Apache-2.0, biblioteka `cedar-policy` w Rust). Język polityk autoryzacji z schematem, walidatorem i diagnostyką decyzji.

## Porównanie

Ocena: ++ bardzo dobrze, + dobrze, 0 neutralnie, − słabo. Uwagi o wydajności to oczekiwania z publikowanych opisów projektów; mają zostać zmierzone w prototypie (kryterium akceptacji poniżej).

| Kryterium | 1. OPA zewnętrzny | 2. regorus (Rego) | 3. Własny DSL | 4. Cedar |
|-----------|-------------------|-------------------|---------------|----------|
| Ekspresyjność | ++ (pełne Rego: komprehensje, funkcje, dane) | ++ (podzbiór Rego) | − (to, co przewidzimy; pokusa rozrostu w język) | + (warunki, zbiory, `like`, bez pętli i rekurencji) |
| Czytelność dla administratorów | 0 (Rego jest zwięzłe, ale nieintuicyjne: częściowe reguły, unifikacja) | 0 (jak obok) | ++ (tabele i listy) | + (`permit`/`forbid` czyta się niemal jak zdanie) |
| Osadzenie w Rust, wydajność | − (IPC lub WASM, dodatkowy proces, wersje) | + (in-process; interpreter, wolniejszy od kompilowanego kodu) | ++ (kod własny, ale trzeba napisać) | ++ (in-process, ewaluacja zaprojektowana jako szybka i ograniczona) |
| Wbudowany wynik „zgoda człowieka” | 0 (konwencja w dokumencie wyjściowym) | 0 (j.w.) | ++ (wprost w schemacie) | + (adnotacja `@approval` na `permit`; silnik czyta ją z reguł decydujących) |
| Wymuszenie „niższa warstwa tylko zaostrza” | − (konwencja; trzeba ewaluować warstwy osobno i pilnować) | − (j.w.) | ++ (z konstrukcji: przecięcie dozwoleń) | + (ewaluacja warstw osobno, iloczyn wyników; `forbid` wygrywa) |
| Podpisywanie i wersjonowanie | 0 (bundle OPA ma podpisy JWT, ale w ekosystemie Go) | 0 (podpisujemy własny pakiet) | 0 (podpisujemy własny pakiet) | 0 (podpisujemy własny pakiet) |
| Testowalność | ++ (`opa test`, pokrycie) | + (testy przez API Rust; narzędzia OPA do `opa test` na tych samych plikach) | + (własne testy tabelaryczne) | + (CLI `cedar`, testy w Rust, walidacja ze schematem) |
| Determinizm | 0 (wbudowane funkcje nieczyste, np. czas, HTTP) | 0 (trzeba wyłączyć niedeterministyczne wbudowane funkcje) | ++ | ++ (brak I/O, brak pętli, gwarantowane zakończenie) |
| Audytowalność decyzji | + (trace, `explain`; format śladu zależny od zapytania) | + (j.w., mniej dojrzałe) | ++ (my definiujemy rekord) | ++ (diagnostyka zwraca identyfikatory reguł decydujących; adnotacje `@id`, `@reason`) |
| Analiza statyczna | 0 | 0 | − (własna) | + (walidacja ze schematem; analiza symboliczna „czy A zezwala na więcej niż B” w ekosystemie Cedar, do zweryfikowania dojrzałości) |
| Koszt utrzymania | + (cudza praca) | + (cudza praca, ryzyko niezgodności z OPA) | − (cały język i narzędzia po naszej stronie) | + (cudza praca, mniejsza powierzchnia niż Rego) |

## Decyzja

Wybieramy **opcję 4: Cedar**, osadzony w `conductord` przez bibliotekę `cedar-policy`.

Uzasadnienie:

- **Deny by default i `forbid` wygrywa** są wbudowaną semantyką, zgodną z zasadami z sekcji 4.1. Administrator czyta politykę jako listę zdań `permit`/`forbid` z warunkami.
- **Deterministyczność i audyt.** Cedar nie ma I/O, pętli ani rekurencji, więc ocena zawsze się kończy i zależy tylko od wejścia. Diagnostyka decyzji wskazuje reguły decydujące, a my przez adnotacje `@id` i `@reason` dodajemy stabilny identyfikator i uzasadnienie dla Audit Log. Przykład rekordu decyzji jest w `examples/policies/README.md`.
- **Warstwy org > projekt > użytkownik.** Każda warstwa jest osobnym zestawem polityk oceniany osobno; wynik to iloczyn warstw (odmowa w jednej warstwie wystarcza). Warstwa org zawiera uprawnienia (sufit), warstwy projektu i użytkownika dostają niejawny `permit-all` i w praktyce zawierają `forbid`. Proste i wymuszane przez kod silnika, nie przez dyscyplinę autorów polityk.
- **Zgoda człowieka** to adnotacja `@approval("human")` na regule `permit`. Wymóg zgody jest sumą po wszystkich spełnionych regułach we wszystkich warstwach, więc niższa warstwa może go dodać, a nie może zdjąć.
- **Wydajność i osadzenie.** Biblioteka Rust in-process, bez dodatkowego procesu, bez WASM, bez osobnego cyklu wydawniczego (zgodne z zerową telemetrią i prostą dystrybucją z sekcji 3.2).
- **Dlaczego nie Rego.** Rego jest mocniejsze, ale ta moc nie jest nam potrzebna (zbiory dozwoleń i warunki na polach żądania), a kosztuje czytelność dla administratorów i determinizm (nieczyste wbudowane funkcje do wyłączenia). Zewnętrzny OPA dodaje proces i wektor ataku. `regorus` jest sensownym planem B, jeśli Cedar okaże się zbyt ubogi.
- **Dlaczego nie własny DSL.** Daje najlepszą czytelność i najprostsze warstwy, ale oznacza własny parser, walidator, narzędzia testowe i analizę. Dla zespołu tej wielkości to ryzyko większe niż korzyść; do tego historycznie takie DSL-e rosną w niepełne języki programowania.

Format pakietu: katalog z plikami `.cedar`, schematem `.cedarschema` i manifestem TOML (wersja semver, rosnący `serial` przeciw cofnięciu polityki, okres ważności, skróty SHA-256 plików, podpis). Warstwę org podpisuje klucz firmowy, dystrybucja przez MDM/GPO do ścieżki tylko do odczytu dla użytkownika; warstwę projektu podpisuje klucz właścicieli projektu dopuszczony przez org; warstwa użytkownika nie wymaga podpisu, bo może tylko zaostrzać. Brak lub niepoprawny pakiet org to ostatni dobry pakiet, a gdy go nie ma, odmowa wszystkiego (zgodnie z deny by default). Przykłady w `examples/policies/`.

Profile (air-gapped, firmowy, hybrydowy) to osobne pakiety warstwy org. Przykład „firmowy” jest w `examples/policies/org/`.

## Konsekwencje

**Pozytywne**

- Jedna spójna semantyka dla wszystkich ośmiu akcji agenta (`exec`, `fs_read`, `fs_write`, `net_connect`, `llm_call`, `mcp_call`, `git_push`, `git_merge`).
- Schemat wyłapuje literówki i błędy typów przed wdrożeniem pakietu przez MDM.
- Rekord decyzji z identyfikatorami reguł i uzasadnieniem nadaje się do łańcucha hashy w Audit Log i eksportu do SIEM.

**Negatywne i ryzyka**

- **Ograniczone dopasowanie tekstu.** `like` zna tylko `*`; bez regex i bez rozumienia składni powłoki. Mitygacja: `conductord` normalizuje wejście (ścieżki względne bez `..` i symlinków, komendy rozbite na `program` i `command`, złożone polecenia powłoki rozbijane albo odrzucane), a polityki operują na znormalizowanych polach. Normalizacja jest krytyczna dla bezpieczeństwa i wymaga osobnych testów (w tym fuzzingu).
- **Brak wbudowanego pojęcia warstw i zgody człowieka.** Obie rzeczy implementujemy w silniku (ewaluacja per warstwa, odczyt adnotacji). To nasz kod, więc podlega testom własności: „dodanie warstwy nigdy nie poszerza zbioru dozwolonych akcji”.
- **Mniejsza społeczność i mniej narzędzi niż Rego** (brak odpowiednika Conftest). Pewne luki wypełnimy własnym CLI (`lint`, `test`).
- **Zależność od jednego dostawcy** biblioteki; język i implementacja są otwarte (Apache-2.0), a zakres użytych funkcji jest mały, więc wyjście do `regorus` pozostaje możliwe.
- Przykłady w `examples/policies/` nie zostały jeszcze uruchomione w walidatorze Cedar.

**Do zrobienia (osobne zadania)**

1. Prototyp silnika: ewaluacja warstw, adnotacje `@id`/`@reason`/`@approval`, rekord decyzji, walidacja przykładów ze schematem. Bez tego przykłady uznajemy za niezweryfikowane.
2. Kryteria akceptacji prototypu: p99 ewaluacji pojedynczej decyzji z pakietem rzędu setek reguł poniżej 1 ms na stacji deweloperskiej (do zmierzenia), test własności monotoniczności warstw, wszystkie przykłady przechodzą walidację schematu.
3. Moduł normalizacji komend i ścieżek wraz z zestawem testów adwersarialnych.
4. Podpisywanie i weryfikacja pakietu (wybór algorytmu i magazynu kluczy; propozycja: Ed25519 z kluczem firmowej PKI), obsługa wygasania i anti-rollback.
5. Narzędzia dla administratorów: `lint` (reguły bez efektu, np. zwykły `permit` w niższej warstwie), `test` (przypadki żądanie -> oczekiwana decyzja), `explain`.
6. Warunek rewizji decyzji: jeśli prototyp wykaże, że Cedar nie wyraża istotnych reguł lub nie spełnia budżetu wydajności, wracamy do opcji 2 (`regorus`) z ograniczeniem do czystych funkcji wbudowanych.
