# Łańcuch dostaw i budowanie

Dokument opisuje, jak budujemy Conductor w sposób kontrolowany i weryfikowalny (zob. `docs/PLAN.md`, sekcje 3.2 i 4.2). Konfiguracja startowa: `rust-toolchain.toml`, `deny.toml`, `ci/`, `.github/workflows/ci.yml`.

## 1. Zasada: te same skrypty wszędzie

Logika CI siedzi w `ci/*.sh`, a workflow GitHub Actions tylko je wywołuje. Dzięki temu ten sam zestaw uruchomimy lokalnie, na GitLab CI i w Jenkinsie:

```sh
ci/check.sh            # fmt, clippy -D warnings, test, cargo-deny, cargo-audit
ci/check.sh deny       # pojedynczy krok
REQUIRE_TOOLS=1 ci/check.sh   # brak cargo-deny/audit = błąd (tak działa CI)
ci/sbom.sh target/sbom # SBOM CycloneDX
```

Skrypty tolerują pusty workspace (brak crate'ów w `crates/`): sam cargo kończy się wtedy błędem przy ładowaniu `members = ["crates/*"]`, więc fmt, clippy i test są pomijane, a deny/audit czekają na `Cargo.lock`. GitHub Actions to punkt startowy; docelowo CI działa na wewnętrznych runnerach bez dostępu do internetu.

## 2. Vendoring zależności

Vendoring daje budowanie bez sieci i niezmienny, przeglądalny zestaw źródeł.

```sh
cargo vendor --locked vendor/ > vendor-config.toml
```

Wynik polecenia (fragment konfiguracji) wklej do `.cargo/config.toml`. Domyślnie plik NIE jest w repozytorium, więc vendoring jest wyłączony. Przykład:

```toml
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "vendor"

[net]
offline = true   # opcjonalnie: wymusza brak dostępu do sieci
```

Zalecenia:
- Katalog `vendor/` commitujemy do osobnego repozytorium lub gałęzi wydań (zależnie od rozmiaru), nie do `main`.
- Przegląd zmian w `vendor/` jest częścią review aktualizacji zależności (zmiany w pliku `.cargo-checksum.json` bez zmian źródeł to sygnał alarmowy).
- Build wydania: `cargo build --release --locked --offline`.
- Po włączeniu vendoringu `deny.toml` w sekcji `[sources]` nadal opisuje dozwolone źródła; weryfikacja dotyczy `Cargo.lock`.

## 3. Mirror crates.io i npm

Profil firmowy zakłada wewnętrzny mirror (Artifactory lub Nexus) zamiast bezpośredniego dostępu do internetu.

Crates (sparse registry), `.cargo/config.toml` lub `~/.cargo/config.toml` na runnerach:

```toml
[source.crates-io]
replace-with = "corp-mirror"

[source.corp-mirror]
registry = "sparse+https://artifactory.example.corp/artifactory/api/cargo/crates-remote/index/"

[registries.corp-mirror]
token = "..."   # lepiej przez CARGO_REGISTRIES_CORP_MIRROR_TOKEN / credential provider
```

Następnie w `deny.toml` zmień `[sources].allow-registry` na adres mirrora (komentarz w pliku wskazuje miejsce).

npm (UI na Tauri): `.npmrc` z `registry=https://artifactory.example.corp/artifactory/api/npm/npm-remote/`, instalacja wyłącznie przez `npm ci` z zatwierdzonym `package-lock.json` (z sumami integrity) i `--ignore-scripts`, o ile skrypt instalacyjny nie jest jawnie dopuszczony.

Toolchain Rusta: ustaw `RUSTUP_DIST_SERVER` i `RUSTUP_UPDATE_ROOT` na wewnętrzny mirror, aby wersja z `rust-toolchain.toml` była instalowalna offline. Baza advisory RustSec: lustro repozytorium `rustsec/advisory-db` w wewnętrznym forge'u i wskazanie go w `deny.toml` (`db-urls`) oraz `cargo audit --db`.

Zasady mirrora: remote repository z cache, blokada pobierania paczek spoza proxy, skanowanie (Xray, Nexus IQ) przed udostępnieniem, retencja wersji użytych w wydaniach.

## 4. Podpisywanie artefaktów

Podpisujemy każdy artefakt wydania (MSI/PKG/DEB/RPM, archiwa, SBOM) oraz sumy kontrolne. Dwie ścieżki zgodne z planem:

**Firmowe PKI (zalecane w profilu air-gapped).** Klucz podpisujący w HSM lub KMS, certyfikat z wewnętrznego CA. Podpis pakietów natywnymi narzędziami (signtool, productsign, `rpmsign`, `dpkg-sig`) oraz podpis odłączony plików: `openssl dgst -sha256 -sign ... -out artefakt.sig artefakt`. Klucz publiczny/łańcuch CA jest dystrybuowany przez MDM/GPO razem z polityką.

**cosign w trybie offline, bez Rekor.** Bez publicznego logu przejrzystości i bez Fulcio:

```sh
cosign generate-key-pair --kms <uri-kms>      # albo klucz z pliku w HSM/KMS
cosign sign-blob --key <klucz> --tlog-upload=false \
  --output-signature artefakt.sig artefakt
cosign verify-blob --key cosign.pub --insecure-ignore-tlog=true \
  --signature artefakt.sig artefakt
```

Uwaga: `--insecure-ignore-tlog` oznacza brak publicznego dowodu czasu podpisania; kompensujemy to własnym, wewnętrznym rejestrem podpisów (log append-only w forge/Artifactory) i znacznikiem czasu z firmowej TSA. Klucze rotujemy zgodnie z polityką PKI; podpisujemy tylko z zaufanego, odizolowanego runnera wydań.

## 5. Reproducible builds

Cel: niezależne zbudowanie z tego samego commita daje identyczne bajty.

- Przypięty toolchain: `rust-toolchain.toml` (obecnie 1.97.0).
- `--locked` (oraz `--offline` przy vendoringu) w każdym buildzie wydania: `Cargo.lock` jest źródłem prawdy.
- `SOURCE_DATE_EPOCH` ustawiony na czas commita wydania: `export SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)`. Używaj go także przy tworzeniu archiwów (`tar --sort=name --mtime=@$SOURCE_DATE_EPOCH --owner=0 --group=0 --numeric-owner`) i pakietów.
- Usunięcie ścieżek lokalnych z binariów: `RUSTFLAGS="--remap-path-prefix=$PWD=/build --remap-path-prefix=$CARGO_HOME=/cargo --remap-path-prefix=$HOME/.rustup=/rustup"`. Na nightly dodatkowo `-Zremap-path-prefix` bywa potrzebne dla ścieżek std; na stable wystarcza `--remap-path-prefix`.
- Stałe środowisko: budowanie w kontenerze z przypiętym digestem obrazu, stały `LANG`/`TZ=UTC`, ta sama ścieżka katalogu roboczego.
- Weryfikacja: dwa niezależne buildy (różne runnery) i porównanie `sha256sum`; rozbieżność blokuje wydanie.

## 6. SBOM CycloneDX i jego weryfikacja

`ci/sbom.sh` uruchamia `cargo cyclonedx` (format JSON, CycloneDX 1.5) i zbiera pliki `*.cdx.json` do `target/sbom/`; CI publikuje je jako artefakt `sbom-cyclonedx`. Wydanie dołącza SBOM i jego podpis (sekcja 4).

Weryfikacja:
1. Podpis SBOM zgadza się z kluczem firmowym.
2. Schemat: `cyclonedx validate --input-file x.cdx.json` (cyclonedx-cli) lub walidacja JSON Schema CycloneDX 1.5.
3. Zgodność z `Cargo.lock`: zestaw `components` (nazwa + wersja) równa się zestawowi pakietów z `cargo metadata --locked`; różnica blokuje wydanie.
4. Skan podatności z SBOM (np. Grype, Dependency-Track w sieci firmowej) jako uzupełnienie `cargo audit`.
5. Licencje w SBOM są zgodne z listą z `deny.toml`.

## 7. Polityka aktualizacji zależności

- Aktualizacje wyłącznie przez PR (dotyczy też agentów: zmiany w zależnościach wymagają zgody człowieka, zob. PLAN 4.1). Bez `cargo update` w ramach zmian funkcjonalnych.
- Każdy PR z nową lub podbitą zależnością: wynik `ci/check.sh` (deny + audit) na zielono, przegląd licencji, opis powodu, ocena crate'a (utrzymanie, liczba maintainerów, `unsafe`, build.rs, proc-makra, zależności tranzytywne). Rozważ `cargo vet` lub `cargo crev` dla zależności krytycznych.
- Zależności bezpośrednie podajemy z dokładną wersją lub zakresem `^` w `[workspace.dependencies]`; `wildcards` jest zabronione (`deny.toml`).
- Luki: poprawka krytyczna/wysoka w ciągu 7 dni, średnia w 30. Wyjątek w `deny.toml` (`advisories.ignore`) wymaga uzasadnienia, właściciela i daty przeglądu.
- Rutynowy przegląd aktualizacji co miesiąc (zaplanowane zadanie lub dedykowany bot na wewnętrznym forge), w paczkach tematycznych; aktualizacja toolchaina co kwartał lub przy lukach, jako osobny PR zmieniający `rust-toolchain.toml`.
- Nowe źródła (rejestry, repozytoria git) są niedozwolone bez zmiany `deny.toml` zatwierdzonej przez bezpieczeństwo.
