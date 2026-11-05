# Przykładowe polityki Conductor (Cedar)

Przykłady do [ADR-003](../../docs/adr/003-policies.md). Format: Cedar. Pliki nie zostały jeszcze zwalidowane narzędziem `cedar` (to zadanie prototypu silnika); traktuj je jako specyfikację zamiarów.

## Układ

| Plik | Warstwa | Opis |
|------|---------|------|
| `schema.cedarschema` | wspólny | Typy: `Agent`, `Repo`, akcje i ich kontekst |
| `org/corporate.cedar` | org | Profil „firmowy”: zakazy twarde i uprawnienia bazowe |
| `org/roles/{planner,implementer,tester,reviewer}.cedar` | org | Uprawnienia per rola |
| `org/manifest.example.toml` | org | Wersja, numer seryjny, skróty plików, podpis |
| `project/payments-service.cedar` | projekt | Zaostrzenia dla repo klasy 2 (poufne) |
| `user/example-user.cedar` | użytkownik | Osobiste zaostrzenia |

## Model żądania

Każda akcja agenta to zapytanie `(principal, action, resource, context)`:

- `principal`: `Agent` z atrybutami `role` i `run_id`.
- `resource`: `Repo` z atrybutami `project` i `data_class` (0 publiczne, 1 wewnętrzne, 2 poufne, 3 ściśle tajne).
- `action`: `exec`, `fs_read`, `fs_write`, `net_connect`, `llm_call`, `mcp_call`, `git_push`, `git_merge`.
- `context`: pola zależne od akcji (komenda, ścieżka, host, model, narzędzie MCP, gałąź), patrz schemat.

Wejście normalizuje `conductord`, nie polityka: ścieżki są względne wobec worktree i bez `..`, komendy złożone (`|`, `;`, `&&`, `$(...)`) są rozbijane na składniki i oceniane osobno albo odrzucane. Wzorce `like` mają tylko `*`, więc `"cargo test*"` pasuje też do `cargo testfoo`; dlatego przykłady zapisują `== "cargo test" || like "cargo test *"`.

## Adnotacje

- `@id("warstwa.zakres.nazwa")`: stabilny identyfikator reguły, trafia do audit logu.
- `@reason("...")`: uzasadnienie dla człowieka, kopiowane do rekordu decyzji.
- `@approval("human")`: na regule `permit` oznacza, że akcja jest dozwolona dopiero po zgodzie człowieka.

## Semantyka łączenia warstw

Warstwy: **org > projekt > użytkownik**. Niższa warstwa może tylko zaostrzać.

1. **Każda warstwa jest oceniana osobno** przez zwykłe reguły Cedar: `forbid` wygrywa z `permit`, brak pasującego `permit` oznacza odmowę.
2. **Warstwa org** jest sufitem uprawnień i jedyną, która musi zawierać `permit` (są w `org/`).
3. **Warstwy projekt i użytkownik** dostają od `conductord` niejawny `permit (principal, action, resource)`. Dzięki temu zawierają głównie `forbid`, a ich zwykłe `permit` niczego nie poszerzają (org i tak musi zezwolić; narzędzie `lint` ostrzega o takich regułach).
4. **Wynik końcowy = iloczyn warstw.** Akcja jest dozwolona tylko wtedy, gdy zezwalają wszystkie warstwy. Jedno `forbid` w dowolnej warstwie kończy sprawę odmową.
5. **Zgoda człowieka jest sumą.** Jeśli którakolwiek spełniona reguła `permit` w dowolnej warstwie ma `@approval("human")`, akcja wymaga zgody. Niższa warstwa może więc dodać wymóg zgody (zob. `project.payments.approve-payments-code`), ale nie może go zdjąć: reguła bez `@approval` w niższej warstwie nie znosi `@approval` z org.
6. **Nie ma `@approval` na `forbid`.** Odmowa jest odmową.
7. **Błąd ewaluacji = odmowa**, a pakiet, który nie przechodzi walidacji schematu, podpisu lub numeru seryjnego, nie jest ładowany (zostaje ostatni dobry pakiet).

### Przykłady rozstrzygnięć

| Żądanie | Org | Projekt (payments) | Użytkownik | Wynik |
|---------|-----|--------------------|------------|-------|
| implementer: `fs_write src/lib.rs` | permit | permit (niejawny) | permit | dozwolone |
| implementer: `fs_write src/payments/x.rs` | permit | permit z `@approval` | permit | dozwolone po zgodzie |
| implementer: `fs_write .github/ci.yml` | permit z `@approval` | permit | permit | dozwolone po zgodzie |
| implementer: `git_push origin main` | brak permit | permit | permit | odmowa (org) |
| implementer: `git_push origin agent/t1` | permit z `@approval` | permit | permit | dozwolone po zgodzie |
| reviewer: `git_merge agent/t1 -> feature/x` | permit z `@approval` | forbid | permit | odmowa (projekt) |
| tester: `llm_call corp-coder-small` | permit | forbid | permit | odmowa (projekt) |
| każdy: `exec curl ...` | forbid | permit | permit | odmowa (org) |
| implementer: `exec git commit -m x` | permit | permit | permit z `@approval` | dozwolone po zgodzie |
| implementer: `mcp_call jira.read` | permit | permit | forbid | odmowa (użytkownik) |

## Rekord decyzji (audyt)

Dla każdego żądania `conductord` zapisuje do Audit Log rekord (kanoniczny JSON, w łańcuchu hashy):

```json
{
  "request_id": "01JC...",
  "request": {"principal": "Agent::\"run-42\"", "role": "implementer", "action": "fs_write",
              "resource": "Repo::\"payments-service\"", "context": {"path": "src/payments/x.rs"}},
  "decision": "allow_with_approval",
  "layers": [
    {"layer": "org", "bundle": "1.0.0+1", "result": "allow", "determining": ["role.implementer.write-code"]},
    {"layer": "project", "bundle": "0.3.0+7", "result": "allow", "determining": ["project.payments.approve-payments-code", "layer.implicit-allow"]},
    {"layer": "user", "bundle": "local", "result": "allow", "determining": ["layer.implicit-allow"]}
  ],
  "approval_required_by": ["project.payments.approve-payments-code"],
  "reasons": ["Zmiany w src/payments/ wymagaja zgody czlowieka."]
}
```

## Podpisy i wersjonowanie

Pakiet warstwy to katalog z plikami `.cedar`, schematem i manifestem (`org/manifest.example.toml`). Manifest zawiera `version` (semver), rosnący `serial` (ochrona przed cofnięciem do starszej, słabszej polityki), okres ważności, skróty SHA-256 plików i podpis. Warstwę org podpisuje klucz firmowy (zaufany klucz zaszyty w pakiecie instalacyjnym lub w magazynie MDM), warstwę projektu klucz właścicieli projektu dopuszczony przez org. Warstwa użytkownika nie wymaga podpisu, bo może tylko zaostrzać. Wartość podpisu w przykładzie jest znacznikiem miejsca.
