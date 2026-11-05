# LLM Gateway (on-prem): wdrożenie testowe i wybór modeli do pilotażu

Dokument realizuje issue #13 i rozwija sekcje 3 (architektura), 4 (model bezpieczeństwa)
i 7 (ryzyka) z [PLAN.md](PLAN.md). Konfiguracja leży w `deploy/llm-gateway/`.
Stan na 5 listopada 2026. Część informacji o modelach pochodzi z agregatorów i blogów
(patrz "Źródła i stopień weryfikacji"), więc liczby sprzętowe i licencje trzeba
potwierdzić na kartach modeli przed zakupem GPU.

## 1. Architektura

```
 stacja dewelopera                                  sieć firmowa (serwer z GPU)
┌──────────────────────────┐   mTLS    ┌────────────────────────────────────────────────────┐
│ agent CLI (sandbox)      │           │ edge        gateway (internal)    backend (internal)│
│   | HTTP localhost       │           │ ┌──────┐     ┌─────────┐          ┌──────────────┐ │
│ sidecar / Egress Guard ──┼──────────►│ │nginx │────►│ LiteLLM │─────────►│ vLLM (gpu)   │ │
│   (cert klienta)         │  :8443    │ │ mTLS │     │  proxy  │    │     │ Ollama (cpu) │ │
└──────────────────────────┘           │ └──────┘     └─────────┘    │     └──────────────┘ │
                                       │                             └────►┌──────────────┐ │
                                       │                                   │ Postgres (db)│ │
                                       │                                   └──────────────┘ │
                                       └────────────────────────────────────────────────────┘
```

* **nginx** terminuje mTLS (klient bez certyfikatu z naszego CA jest odrzucany) i jest
  jedynym kontenerem z siecią `edge` i opublikowanym portem.
* **LiteLLM** wystawia API zgodne z OpenAI (`/v1/chat/completions`, `/v1/responses`,
  `/v1/embeddings`) oraz z Anthropic (`/v1/messages`). Mapuje aliasy ról
  (`conductor-planner`, `conductor-coder`, `conductor-reviewer`, `conductor-fast`) na backendy,
  stosuje klucze wirtualne, limity RPM/TPM i budżety.
* **vLLM** (profil `gpu`) lub **Ollama** (profil `cpu`, tylko do testów lokalnych) to backendy.
  Siec `backend` ma `internal: true`: kontenery modeli, LiteLLM i Postgres nie mają trasy do
  internetu. Wagi modeli trafiają tam z wewnętrznego rejestru lub z nośnika (vLLM działa
  w trybie offline: `HF_HUB_OFFLINE=1`).
* **Postgres** (profil `db`) przechowuje klucze wirtualne, zespoły, budżety i logi zapytań.
  Bez niego działa tylko master key (bez budżetów i kluczy per zespół).

Wyjątek od izolacji: jednorazowy job `ollama-pull` (profil `cpu-pull`) ma dostęp do internetu,
żeby pobrać mały model testowy. W środowisku firmowym zastąp go mirrorem lub nośnikiem.

## 2. Pliki

| Plik | Rola |
|------|------|
| `deploy/llm-gateway/docker-compose.yml` | nginx, LiteLLM, vLLM, Ollama, Postgres; przypięte tagi obrazów; sieci internal |
| `deploy/llm-gateway/litellm-config.yaml` | aliasy ról, budżety, limity, logowanie, brak zewnętrznych callbacków |
| `deploy/llm-gateway/nginx/nginx.conf` | mTLS, dziennik dostępu JSON z DN certyfikatu klienta |
| `deploy/llm-gateway/tls/` | `gen-dev-certs.sh`, `README.md`, `.gitignore` (klucze nie trafiają do repo) |
| `deploy/llm-gateway/smoke-test.sh` | test `/health` i jednego chat completion przez mTLS |

Tagi obrazów są nadpisywalne zmiennymi (`LITELLM_IMAGE`, `VLLM_IMAGE`, `OLLAMA_IMAGE`,
`POSTGRES_IMAGE`, `NGINX_IMAGE`). Domyślne wartości to `litellm main-v1.108.0`,
`vllm v0.33.0`, `ollama 0.12.11`, `postgres 16.9-alpine`, `nginx 1.27.5-alpine`.
**Wersje LiteLLM i vLLM dobrano po numerach z PyPI; istnienia tagów w rejestrach
(ghcr.io, Docker Hub) nie dało się sprawdzić z sandboxa (HTTP 403), a tag Ollamy jest
oszacowany.** Przed użyciem potwierdź tagi i przypnij digesty z wewnętrznego rejestru.

## 3. Uruchomienie

```bash
cd deploy/llm-gateway
export LITELLM_MASTER_KEY="sk-$(openssl rand -hex 24)"
export POSTGRES_PASSWORD="$(openssl rand -hex 16)"
export DATABASE_URL="postgresql://litellm:${POSTGRES_PASSWORD}@postgres:5432/litellm"
./tls/gen-dev-certs.sh ./tls
```

### 3.1 Test lokalny bez GPU (Ollama)

```bash
docker compose --profile cpu-pull run --rm ollama-pull       # jednorazowo, wymaga internetu
docker compose --profile cpu --profile db up -d
LITELLM_API_KEY="$LITELLM_MASTER_KEY" ./smoke-test.sh
```

Wszystkie cztery aliasy wskazują wtedy na mały model `qwen2.5-coder:1.5b`. To służy
wyłącznie sprawdzeniu instalacji, nie jakości.

### 3.2 Pilotaż na GPU (vLLM)

Wagi pobierz wcześniej (z wewnętrznego mirrora lub na stacji z dostępem) do `${MODELS_DIR}`
(domyślnie `./models`), np. `Qwen3.6-27B/` i `Qwen3.6-35B-A3B/`. Potem:

```bash
export MODELS_DIR=/srv/models
export CODER_API_BASE=http://vllm-coder:8000/v1   CODER_MODEL=hosted_vllm/coder
export REVIEWER_API_BASE=$CODER_API_BASE          REVIEWER_MODEL=$CODER_MODEL
export PLANNER_API_BASE=$CODER_API_BASE           PLANNER_MODEL=$CODER_MODEL   # do czasu dużego serwera
export FAST_API_BASE=http://vllm-fast:8000/v1     FAST_MODEL=hosted_vllm/fast
docker compose --profile gpu --profile db up -d
```

Serwisy `vllm-coder` i `vllm-fast` rezerwują po jednym GPU (`CODER_GPU_IDS`, `FAST_GPU_IDS`).
Parser narzędzi (`--tool-call-parser`) i długość kontekstu są nadpisywalne zmiennymi; parser
`qwen3_coder` jest założeniem opartym na rodzinie Qwen3 i wymaga potwierdzenia w karcie modelu
oraz w dokumentacji używanej wersji vLLM. Prefiks `hosted_vllm/` jest celowy: z prefiksem
`openai/` LiteLLM kieruje wywołania `/v1/messages` (Anthropic) na endpoint `/v1/responses`
backendu (sprawdzone, patrz sekcja 9), czego nie każdy backend obsługuje.

### 3.3 Klucze, zespoły i budżety (wymaga profilu `db`)

Koszt on-prem wynosi 0 USD, więc `litellm-config.yaml` ustawia umowną cenę za token
("kredyty"), dzięki czemu `max_budget` działa jak kwota tokenowa. Zespół i klucz:

```bash
curl -s --cacert tls/ca.crt --cert tls/client.crt --key tls/client.key \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'Content-Type: application/json' \
  https://localhost:8443/team/new -d '{"team_alias":"platforma","max_budget":2000,
  "budget_duration":"30d","tpm_limit":500000,"rpm_limit":300}'
# odpowiedź zawiera team_id; klucz per użytkownik w zespole:
curl -s ... https://localhost:8443/key/generate -d '{"team_id":"<team_id>",
  "key_alias":"jan.kowalski","max_budget":100,"budget_duration":"30d"}'
```

Domyślne parametry nowych kluczy i ich górne ograniczenia są w `litellm-config.yaml`
(`default_key_generate_params`, `upperbound_key_generate_params`). Master key służy tylko
administratorowi; conductord dostaje klucze wirtualne per użytkownik/sesja.
Przy braku bazy LiteLLM loguje ostrzeżenie, że budżet globalny nie jest egzekwowany.

## 4. Podpięcie agentów CLI

conductord ustawia zmienne środowiskowe procesu agenta (sandbox ma sieć tylko do
Egress Guard, który przepuszcza wyłącznie adres gateway'a). Agent nie zna certyfikatu klienta:
mTLS realizuje sidecar conductord (np. Envoy/stunnel na `127.0.0.1:<port>`), który
dokłada certyfikat z keychaina hosta. Dla agenta jest to zwykły HTTP po localhost.

| Agent / SDK | Zmienne ustawiane przez conductord |
|-------------|-----------------------------------|
| Klienci OpenAI (Codex CLI, aider, SDK) | `OPENAI_BASE_URL=http://127.0.0.1:<port>/v1`, `OPENAI_API_KEY=<klucz wirtualny sesji>`, model `conductor-coder` |
| Klienci Anthropic (np. Claude Code) | `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` (bez `/v1`), `ANTHROPIC_AUTH_TOKEN=<klucz wirtualny>`, `ANTHROPIC_MODEL=conductor-coder`, `ANTHROPIC_SMALL_FAST_MODEL=conductor-fast` |
| Wyłączenie telemetrii agentów | m.in. `DISABLE_TELEMETRY=1`, `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (nazwy zależą od agenta i wersji) |

Nazwy zmiennych poszczególnych agentów trzeba zweryfikować dla zatwierdzonych wersji
(lista agentów z konfiguracją bez telemetrii, sekcja 7 PLAN.md). Ostateczną barierą pozostaje
izolacja sieciowa sandboksa. Rola w Policy Engine decyduje, który alias dostaje dany agent:
planista `conductor-planner`, implementer `conductor-coder`, recenzent `conductor-reviewer`,
pomocnicze wywołania `conductor-fast`. Klucz wirtualny powinien być wydawany per sesja agenta
(krótki TTL) i ograniczony do aliasów dozwolonych dla roli.

## 5. Telemetria i brak wyjścia na zewnątrz

W `docker-compose.yml` ustawiono (sprawdzone w kodzie LiteLLM 1.108.0):

* `LITELLM_TELEMETRY_DISABLED=true`: weto administratora dla telemetrii użycia (w tej wersji
  jest ona opt-in; zmienna blokuje także włączenie z UI). `LITELLM_TELEMETRY=False` dla starszych wersji.
* `LITELLM_LOCAL_MODEL_COST_MAP=True`, `LITELLM_LOCAL_BLOG_POSTS=True`,
  `LITELLM_LOCAL_ANTHROPIC_BETA_HEADERS=True`: bez pobierania plików z GitHub przy starcie.
* `NO_DOCS`, `NO_REDOC`, `DISABLE_ADMIN_UI`: bez Swaggera z CDN i bez UI admina.
* `callbacks`, `success_callback`, `failure_callback`, `service_callback` puste; brak kluczy
  zewnętrznych providerów; w `model_list` tylko aliasy lokalne, bez wildcardów;
  fallbacki tylko między aliasami lokalnymi.
* vLLM: `VLLM_NO_USAGE_STATS=1`, `DO_NOT_TRACK=1`, tryb offline.

Konfiguracja programowa jest tylko jedną warstwą. Gwarancją jest sieć: LiteLLM jest w
sieciach `gateway` i `backend` (obie `internal`), więc nawet błąd konfiguracji nie wyśle
danych na zewnątrz. Zalecane jest dodatkowo wymuszenie na hoście (nftables) i test egress w CI.

## 6. Logowanie i audyt

* LiteLLM: logi JSON na stdout (`json_logs`); z profilem `db` także tabela logów zużycia z treścią
  zapytań i odpowiedzi (`store_prompts_in_spend_logs`), retencja 30 dni
  (`maximum_spend_logs_retention_period`). Treść promptów to dane wrażliwe: ogranicz dostęp do
  bazy, szyfruj wolumen i ustal retencję zgodnie z polityką firmy. Jeśli audyt ma przechowywać
  tylko metadane, ustaw `store_prompts_in_spend_logs: false`.
* nginx: dziennik dostępu JSON (DN certyfikatu klienta, ścieżka, status, czasy) na stdout.
* Docelowo oba strumienie eksportuj do SIEM; pełny, niezmienialny audyt promptów po stronie
  klienta prowadzi Audit Log conductord (PLAN.md 3.1).

## 7. DLP po stronie gateway'a

Pierwsza linia obrony to Secret Scanner/DLP w conductord (przed wysłaniem). Gateway jest
drugą linią: obejmuje też klientów, którzy ominęli conductord, i wymusza politykę centralnie.

**Co oferuje LiteLLM** (w pakiecie 1.108.0 są m.in. hooki guardrails: `presidio`,
`litellm_content_filter`, `generic_guardrail_api`, `custom_guardrail`, `lakera`, `guardrails_ai`,
`aporia`, `pillar` i inne; guardrails przypisuje się globalnie, per klucz lub per zespół):

* **Presidio** (Microsoft, self-hosted): wykrywanie i maskowanie PII w promptach
  (`mode: pre_call`, tryby maskowania lub blokady); wymaga uruchomienia kontenerów
  `presidio-analyzer` i `presidio-anonymizer` w sieci `backend`. Jest nastawiony na dane
  osobowe, nie na kod i sekrety.
* **Content filter** (`litellm_content_filter`): wbudowane filtry oparte o wzorce/regex
  i słowa zakazane.
* **Własny guardrail** (klasa `CustomGuardrail`, `async_pre_call_hook`/`async_post_call_success_hook`)
  oraz **`generic_guardrail_api`**: wywołanie zewnętrznej usługi DLP w sieci firmowej.
* Wykrywanie sekretów ("secret detection/redaction") bywa w LiteLLM funkcją
  wersji Enterprise; **sprawdź licencję i aktualny status przed założeniem, że jest dostępne**.

**Czego nie dostarcza ta konfiguracja i co trzeba dopisać:**

1. Reguły sekretów w stylu gitleaks (klucze chmurowe, tokeny, klucze prywatne, connection stringi)
   jako guardrail `pre_call` z akcją `block` (domyślnie) lub `mask`; wspólny zestaw reguł z Secret
   Scannerem conductord, żeby oba miejsca zachowywały się tak samo.
2. Reguły firmowe: wzorce numerów klientów, identyfikatorów wewnętrznych, nazw projektów
   o wysokiej klasyfikacji.
3. Klasyfikacja repozytoriów: klucz/zespół przypisany do klasy danych dopuszcza tylko
   określone aliasy (np. "ściśle tajne" tylko modele lokalne) i określony zestaw guardrails.
4. Skanowanie odpowiedzi (`post_call`) i wyników narzędzi wklejonych do kontekstu.
   Uwaga: maskowanie odpowiedzi w trybie streamingu jest ograniczone; dla streamingu
   rozważ blokadę na wejściu zamiast maskowania na wyjściu.
5. Testy: korpus promptów z sekretami (true positives) i zwykłym kodem (false positives);
   metryki blokad w SIEM. Zbyt agresywne maskowanie psuje kod (zmienione stałe), więc domyślnie blokuj.
6. Decyzja o fail-open/fail-closed dla guardrail (zalecane fail-closed).

W tej konfiguracji guardrails **nie są włączone** (wymagają dodatkowych usług i decyzji
o regułach); to osobne zadanie po wyborze podejścia.

## 8. Rekomendacja modeli open-weight do pilotażu

Kryteria: wynik na zadaniach agentowych (SWE-bench, Terminal-Bench), licencja bez ograniczeń
komercyjnych, dojrzałość serwowania w vLLM, koszt GPU. Liczby benchmarków pochodzą od
producentów i agregatorów i **nie zastępują własnego benchmarku** (sekcja 10).
Szacunki VRAM: waga ≈ liczba parametrów × bajty na parametr (BF16 2, FP8 1, 4-bit 0,5)
plus 10-20% i pamięć na KV cache zależną od kontekstu i liczby równoległych sesji.

| Poziom | Model | Parametry | Licencja | Kwantyzacja i VRAM (waga, szacunek) | Sprzęt na pilotaż | Rola |
|--------|-------|-----------|----------|--------------------------------------|-------------------|------|
| S | **Qwen3.6-35B-A3B** (MoE) | 35B, 3B aktywnych | Apache-2.0 wg metadanych karty (źródła rozbieżne, patrz niżej) | FP8 ok. 35 GB, 4-bit ok. 20 GB; BF16 ok. 70 GB | 1x GPU 48 GB (FP8) lub 1x 24 GB (4-bit, krótki kontekst) | `conductor-fast`; kandydat na `reviewer` przy dużym ruchu |
| M | **Qwen3.6-27B** (gęsty) | 27B | Apache-2.0 | FP8 ok. 27 GB, 4-bit 16-18 GB; BF16 ok. 54 GB | 1x GPU 48-80 GB (FP8, kontekst 64K i kilka sesji), 1x 24 GB (4-bit) | `conductor-coder`, początkowo także `conductor-reviewer` |
| L | **DeepSeek V4.1 Flash** (MoE) | ok. 552B (źródła podają też 763B z pamięcią Engram), ok. 16B aktywnych | MIT (kod i wagi wg źródeł) | FP8 ok. 510 GB (checkpoint), 4-bit ok. 314 GB + KV | węzeł 8x GPU 141 GB (FP8) lub 4-8x 80 GB (4-bit) | `conductor-planner` |

Uzasadnienie:

* **Qwen3.6-27B** ma w publikowanych zestawieniach 77,2% na SWE-bench Verified (jedno źródło
  podaje 68,9%; wynik producenta, nie niezależny) przy sprzęcie dostępnym w każdej firmie
  (jedna karta). To najlepszy stosunek jakości do kosztu dla implementera i podstawa pilotażu.
* **Qwen3.6-35B-A3B** (73,4% SWE-bench Verified, 80,4% LiveCodeBench v6 wg karty modelu
  w kopiach) aktywuje tylko 3B parametrów, więc jest szybki i tani: dobry do wielu małych
  wywołań (`fast`) i autouzupełniania.
* **DeepSeek V4.1 Flash** jest wskazywany jako najmocniejszy otwarty model do kodu, ale wymaga
  węzła wielo-GPU. Do czasu zakupu planista używa tego samego backendu co `coder`
  (z trybem rozumowania) - dlatego pilotaż może ruszyć na 2 kartach (po jednej na `coder` i `fast`).
  Wsparcie architektury V4.1 w używanej wersji vLLM trzeba zweryfikować.

**Licencje, na które trzeba uważać** (wykluczone z rekomendacji lub warunkowe):

* **Devstral 2 (123B)**: zmodyfikowana MIT z progiem przychodu (ok. 20 mln USD miesięcznie
  według relacji z premiery), obejmuje pochodne i fine-tuny; **Devstral Small 2 (24B)** jest Apache-2.0.
* **GLM-5.3** (ok. 744-753B, ok. 40B aktywnych): własna licencja "GLM-5.3" z warunkami
  (m.in. przegląd bezpieczeństwa Z.ai przy przychodzie powyżej 10 mld USD rocznie i ograniczenia
  dla hostowania jako usługi); **GLM-5.3-Flash** jest opisywany jako MIT, ale źródła są
  niespójne. Czytać plik LICENSE w repozytorium modelu.
* **Kimi K3** i podobne: własne licencje (zmodyfikowana MIT); weryfikacja warunków przed użyciem.
* **Rodzina Llama**: Llama Community License (próg 700 mln aktywnych użytkowników miesięcznie,
  wymogi nazewnictwa i polityka dozwolonego użycia). To wiedza ogólna, nie sprawdzona w tym
  badaniu; traktować jako licencję ograniczającą.
* **Qwen3.6-35B-A3B**: metadane karty podają Apache-2.0, a jedna strona dostawcy wskazuje
  licencję "Qwen". **Przed pilotażem przeczytaj plik LICENSE w repozytorium modelu.**

Zasada: zatwierdzaj model dopiero po przeglądzie prawnym pliku LICENSE z konkretnej rewizji
wag; licencje i warianty zmieniają się między wydaniami (np. Flash vs pełny model).

## 9. Co zweryfikowano, a czego nie

Środowisko, w którym przygotowano konfigurację: brak GPU, brak działającego demona Docker,
rejestry kontenerów zablokowane (HTTP 403), PyPI dostępne.

Zweryfikowano:

* `docker compose config -q` dla profili: domyślnego, `cpu`, `gpu`+`db`, `cpu-pull`
  (poprawna składnia, interpolacja, wymagane zmienne), oraz poprawność YAML obu plików.
* `bash -n` dla `gen-dev-certs.sh` i `smoke-test.sh`.
* `gen-dev-certs.sh` do katalogu tymczasowego: `openssl verify` serwera i klienta zwraca OK;
  git ignoruje wygenerowane `.crt`/`.key` w `tls/` (sprawdzone przez skopiowanie i `git status`).
* Realny LiteLLM 1.108.0 (z PyPI, uruchomiony poza Dockerem) z `litellm-config.yaml`, zmiennymi
  telemetrii i atrapą backendu zgodną z OpenAI (prosty serwer Python), za nginx z
  `nginx/nginx.conf` (lokalny nginx, który nie zna dyrektywy `http2 on`, więc w teście
  usunięto tę jedną linię) i certyfikatami z `gen-dev-certs.sh`:
  `smoke-test.sh` przeszedł w całości (odrzucenie klienta bez certyfikatu kodem 400,
  `/health/liveliness` 200 przez mTLS, chat completion `conductor-coder`), dziennik nginx
  zawiera DN klienta, a endpoint Anthropic `/v1/messages` dla `conductor-planner` zwrócił
  poprawną odpowiedź.
* Wykryty w teście problem: z modelem `openai/...` wywołania `/v1/messages` trafiały do
  `/v1/responses` backendu i kończyły się błędem; dlatego użyto prefiksu `hosted_vllm/`
  (z nim `/v1/messages` jest tłumaczone na chat completions).

* Drugi wykryty problem: pusty `DATABASE_URL` w środowisku LiteLLM przerywa start
  ("unsupported scheme"), dlatego w compose zmienna jest przekazywana z shella tylko wtedy,
  gdy jest ustawiona (`DATABASE_URL:` bez wartości; `docker compose config` renderuje ją
  jako `null`, a z ustawioną wartością przekazuje ją dalej). Działanie przekazania w `up` nie było testowane na demonie.

Nie zweryfikowano (wymaga docelowego środowiska):

* Pobrania i startu obrazów (tagi, `internal: true` w praktyce, healthchecki w kontenerach,
  limit `read_only` nginx), profili `gpu` i `cpu` na prawdziwym vLLM/Ollama oraz realnej
  jakości odpowiedzi.
* Postgresa: klucze wirtualne, zespoły, budżety, `store_prompts_in_spend_logs`,
  retencja (w teście działał tryb bez bazy; LiteLLM ostrzegł, że budżet globalny nie jest egzekwowany).
* Parserów narzędzi i flag vLLM dla modeli Qwen3.6 i DeepSeek V4.1 oraz zapotrzebowania na VRAM.
* Guardrails/DLP (sekcja 7) i zmiennych środowiskowych konkretnych agentów CLI (sekcja 4).

## 10. Plan wstępnego benchmarku na zadaniach firmowych

Cel: wybrać model dla każdej roli i ustalić, czy jakość on-prem wystarcza (ryzyko z sekcji 7 PLAN.md).

1. **Zbiór zadań (2 tygodnie przygotowań).** 30-50 zadań z własnych repozytoriów o niskiej
   klasyfikacji, odtwarzalnych: historyczne PR-y/issue z testem, który padał przed zmianą
   i przechodzi po niej (styl SWE-bench). Zróżnicowane: bugfix, mała funkcja, refaktor,
   dopisanie testów, migracja, review gotowego diffu (z wstrzykniętymi błędami). Języki proporcjonalnie
   do firmy. Zadania zamrozić w repozytorium (commit bazowy, opis, test akceptacyjny).
2. **Warunki.** Te same agenty i prompty, ten sam harness (conductord w sandboksie), jeden
   model na przebieg; po 3 przebiegi na zadanie (zmienność). Limity: kroków, tokenów i czasu.
   Jako punkt odniesienia opcjonalnie model chmurowy na repozytoriach jawnych
   (poza regułami danych firmy) lub wyniki publiczne.
3. **Kandydaci.** Qwen3.6-27B (FP8 i 4-bit, by zmierzyć koszt kwantyzacji), Qwen3.6-35B-A3B,
   DeepSeek V4.1 Flash (jeśli sprzęt dostępny); opcjonalnie modele z sekcji 8 o licencjach
   warunkowych tylko w trybie ewaluacji po zgodzie działu prawnego.
4. **Metryki.** Odsetek zadań rozwiązanych (testy akceptacyjne przechodzą) pass@1 i pass@3;
   odsetek poprawnych wywołań narzędzi; liczba kroków i tokenów na zadanie; czas do wyniku;
   latencja (TTFT, tokeny/s) przy 1, 4 i 16 równoległych sesjach (przepustowość vLLM i VRAM
   na KV cache); wykryte regresje/niepożądane zmiany w diffie; dla review: precyzja i czułość
   wykrytych wstrzykniętych błędów; ocena ręczna próbki 20% diffów (skala 1-5) przez dwóch
   seniorów (zgodność ocen).
5. **Role.** Planner oceniany jakością dekompozycji (czy podzadania da się wykonać i się nie
   pokrywają); coder - pass@k; reviewer - czułość/precyzja; fast - dokładność na krótkich
   zadaniach (nazwy commitów, podsumowania) i latencja.
6. **Kryteria decyzji (do uzgodnienia przed startem).** Np. coder: pass@1 co najmniej 60%
   wyniku modelu odniesienia, p95 latencji interaktywnej poniżej 20 s, mieści się w 1 GPU;
   zmiana modelu roli tylko przy poprawie o co najmniej 5 punktów procentowych.
7. **Wyniki i koszty.** Raport z tabelą jakość/koszt GPU na zadanie; powtórzenie przy każdej
   nowej generacji modeli (kwartalnie), bo oferta zmienia się szybko.

## Źródła i stopień weryfikacji

Źródła to głównie agregatory i blogi; strony kart modeli (huggingface.co) były niedostępne
z sandboxa, więc brak potwierdzenia w pierwotnych kartach i plikach LICENSE.

* [Best LLM for Coding (November 2026): SWE-bench & LiveCodeBench Ranked (BenchLM)](https://benchlm.ai/coding)
* [The 11 Best Open-Source LLMs in November 2026 (Geotoolbox)](https://geotoolbox.ai/blog/best-open-source-llms)
* [Kilo: Best Open-Weight AI Models for Coding (2026)](https://kilo.ai/open-source-models)
* [The 10 best open-weight and open-source LLMs for coding in 2026 (Hashnode)](https://hashnode.com/blog/best-open-weight-llms)
* [Qwen3.6-27B (bestllmfor.com)](https://bestllmfor.com/catalog/qwen36-27b/), [ai2.work o Qwen 3.6-27B](https://ai2.work/blog/alibaba-s-qwen-3-6-27b-dense-model-matches-frontier-ai-at-scale), [localaimaster.com (rozbieżny wynik 68,9%)](https://localaimaster.com/models/qwen-3-6-27b)
* [Qwen3.6-35B-A3B (NYU Shanghai RITS)](https://rits.shanghai.nyu.edu/ai/qwen3-6-35b-a3b-alibaba-open-sources-a-frontier-class-agentic-coder/), [DeepInfra (licencja "Qwen")](https://deepinfra.com/Qwen/Qwen3.6-35B-A3B)
* [Self-host DeepSeek V4.1 Flash (Qovery)](https://www.qovery.com/blog/self-host-deepseek-v4-1-flash-gpu-setup-own-cloud), [getdeploying: DeepSeek V4.1 Flash](https://getdeploying.com/llms/deepseek-v4.1-flash), [Yotta Labs: wymagania sprzętowe](https://www.yottalabs.ai/post/deepseek-v4-flash-hardware-requirements-gpu-memory-2026)
* [GLM-5.3: weights, licence (noze.it)](https://www.noze.it/en/insights/glm-5-3-weights-licence-benchmark-method/), [The New Stack o licencji wag Z.ai](https://thenewstack.io/zai-glm-weights-license/), [GLM-5.3 Flash MIT (LetsDataScience)](https://letsdatascience.com/news/zai-releases-glm-53-under-conditional-license-fa46b61b)
* [Devstral 2 (The Decoder)](https://the-decoder.com/?p=29873), [Mistral Releases Devstral 2 (LetsDataScience)](https://letsdatascience.com/news/mistral-releases-devstral-2-for-code-agents-2e24c245)
* [Qwen3-Coder-30B-A3B AWQ (QuantTrio, Hugging Face)](https://huggingface.co/QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ) (uwagi o utracie jakości przy 4-bit)
* LiteLLM 1.108.0: zachowanie zmiennych środowiskowych i endpointów sprawdzone w kodzie
  pakietu z PyPI oraz testem uruchomieniowym (sekcja 9). Llama Community License: wiedza ogólna.
