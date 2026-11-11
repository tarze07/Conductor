# Instrukcja Instalacji i Wdrożenia — Conductor (Linux, Windows, Docker Air-Gapped)

Niniejszy dokument opisuje krok po kroku proces instalacji, konfiguracji oraz weryfikacji systemu **Conductor** na stacjach roboczych oraz serwerach w sieciach wewnętrznych (**Intranet / Air-Gapped**) bez dostępu do publicznego internetu.

---

## Spis treści

1. [Wymagania systemowe](#1-wymagania-systemowe)
2. [Instalacja na systemie Linux (Paczka Offline `.tar.gz`, `.deb`, `.rpm`, `systemd`)](#2-instalacja-na-systemie-linux)
3. [Instalacja na systemie Windows 10/11 i Windows Server (`.zip`, PowerShell, `.msi`)](#3-instalacja-na-systemie-windows)
4. [Wdrożenie kontenerowe Docker / Podman (`docker-compose.intranet.yml`)](#4-wdrożenie-kontenerowe-docker--podman)
5. [Budowanie ze źródeł i generowanie własnej paczki Air-Gapped](#5-budowanie-ze-źródeł-i-generowanie-paczki-air-gapped)
6. [Konfiguracja po instalacji (Lokalne LLM, PKI/Root CA, GitLab/Forgejo, OIDC)](#6-konfiguracja-po-instalacji)
7. [Weryfikacja izolacji sieciowej (`conductor doctor --verify-offline`)](#7-weryfikacja-izolacji-sieciowej)
8. [Wydawanie nowych wersji (GitHub Actions Release dla Linux i Windows)](#8-wydawanie-nowych-wersji-release-workflow)

---

## 1. Wymagania systemowe

| Komponent | Wymaganie minimalne | Uwagi dla środowisk Air-Gapped |
| :--- | :--- | :--- |
| **System operacyjny** | **Linux** (Debian 12+, Ubuntu 22.04+, RHEL/Rocky/AlmaLinux 9+) lub **Windows** (10/11 x64, Windows Server 2022) | Brak wymagań dostępu do repozytoriów online podczas instalacji z paczki Air-Gap |
| **Środowisko uruchomieniowe** | **Node.js >= 22.5.0 LTS** (lub **Node.js 24 LTS**) | Wbudowany moduł `node:sqlite` (tryb WAL) — brak zewnętrznych baz danych |
| **System kontroli wersji** | **Git >= 2.38** | Wymagany na hoście do obsługi ukrytych referencji `refs/conductor/checkpoints/*` |
| **Pamięć RAM i Dysk** | Min. 2 GB RAM dla serwera Conductor, 500 MB wolnego miejsca | Modele LLM mogą działać na osobnej maszynie GPU w sieci LAN (`vLLM` / `Ollama`) |

---

## 2. Instalacja na systemie Linux

### Wariant 2A: Instalacja z paczki Air-Gapped `.tar.gz` (Zalecany dla dowolnej dystrybucji)

1. Pobierz plik `conductor-v<WERSJA>-linux-x64-airgap.tar.gz` oraz `conductor-v<WERSJA>-linux-x64-airgap.tar.gz.sha256` z wewnętrznego serwera artefaktów lub zakładki **Releases** na GitHubie i przenieś na maszynę docelową.
2. Zweryfikuj sumę kontrolną archiwum:
   ```bash
   sha256sum -c conductor-v0.1.0-linux-x64-airgap.tar.gz.sha256
   ```
3. Rozpakuj archiwum i uruchom skrypt instalacyjny offline (`install-airgap.sh`), który automatycznie sprawdza integralność wszystkich plików z `SHA256SUMS`:
   ```bash
   tar -xzf conductor-v0.1.0-linux-x64-airgap.tar.gz
   cd conductor-v0.1.0-linux-x64-airgap

   # Instalacja w /opt/conductor (lub własnym katalogu przez CONDUCTOR_INSTALL_PREFIX)
   sudo CONDUCTOR_INSTALL_PREFIX=/opt/conductor bash ./install-airgap.sh
   ```
4. *(Opcjonalnie)* Aktywuj usługę systemową `systemd`:
   ```bash
   sudo useradd -r -s /usr/sbin/nologin -d /opt/conductor conductor || true
   sudo chown -R conductor:conductor /opt/conductor
   sudo cp /opt/conductor/systemd/conductor-server.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now conductor-server.service
   ```

### Wariant 2B: Instalacja z pakietu Debian / Ubuntu (`.deb`)

1. Zweryfikuj sumę kontrolną pakietu `.deb` i zainstaluj go lokalnie przy użyciu `dpkg` (bez dostępu do internetu):
   ```bash
   sha256sum -c conductor-intranet_0.1.0_amd64.deb.sha256
   sudo dpkg -i conductor-intranet_0.1.0_amd64.deb
   ```
2. Pliki zostaną zainstalowane w `/opt/conductor`.

---

## 3. Instalacja na systemie Windows

### Wariant 3A: Instalacja z archiwum `.zip` przez PowerShell (`install-airgap.ps1`)

1. Przenieś plik `conductor-v<WERSJA>-win-x64-airgap.zip` oraz `.sha256` na stację roboczą Windows.
2. Otwórz **PowerShell** i zweryfikuj sumę kontrolną pobranego archiwum:
   ```powershell
   $Expected = (Get-Content .\conductor-v0.1.0-win-x64-airgap.zip.sha256).Split(" ")[0]
   $Actual   = (Get-FileHash .\conductor-v0.1.0-win-x64-airgap.zip -Algorithm SHA256).Hash.ToLower()
   if ($Expected -ne $Actual) { throw "Błąd sumy kontrolnej SHA-256!" }
   ```
3. Rozpakuj archiwum i uruchom instalator `install-airgap.ps1`:
   ```powershell
   Expand-Archive -Path .\conductor-v0.1.0-win-x64-airgap.zip -DestinationPath .\conductor-airgap -Force
   cd .\conductor-airgap\conductor-v0.1.0-win-x64-airgap

   # Instalacja w %LOCALAPPDATA%\Programs\Conductor (lub własnej ścieżce -Prefix)
   powershell -ExecutionPolicy Bypass -File .\install-airgap.ps1 -Prefix "C:\Conductor"
   ```
   Skrypt automatycznie:
   - weryfikuje sumy SHA-256 wszystkich komponentów z pliku `SHA256SUMS`,
   - kopiuje zasoby 100% Offline Web UI oraz manifesty do `C:\Conductor`,
   - ustawia zmienne środowiskowe użytkownika wymuszające tryb offline (`CONDUCTOR_OFFLINE_MODE=1`, `HF_HUB_OFFLINE=1`, `CONDUCTOR_ALLOW_PUBLIC_EGRESS=0`).

### Wariant 3B: Budowa instalatora korporacyjnego `.msi` (WiX Toolset)

W katalogu `packages/msi/conductor.wxs` znajduje się manifest dla **WiX Toolset**, pozwalający zespołom IT wygenerować podpisany pakiet `.msi` do masowej dystrybucji przez **Active Directory GPO / SCCM / Intune**.

---

## 4. Wdrożenie kontenerowe Docker / Podman

W repozytorium znajduje się gotowy plik [`docker-compose.intranet.yml`](./docker-compose.intranet.yml), który tworzy całkowicie odizolowaną sieć mostkową `conductor_intranet` z flagą **`internal: true`** (kontenery są fizycznie pozbawione bramy domyślnej do internetu):

```bash
# Budowa i uruchomienie całego stosu intranetowego (Conductor + lokalny serwer LLM + Forgejo)
docker compose -f docker-compose.intranet.yml up -d --build

# Uruchomienie automatycznych testów E2E z flagą network_mode: "none"
docker compose -f docker-compose.intranet.yml run --rm conductor-e2e-runner
```

---

## 5. Budowanie ze źródeł i generowanie paczki Air-Gapped

Jeśli przygotowujesz paczkę na maszynie w strefie DMZ (z dostępem do wewnętrznego mirroru `npm`/`pnpm`), wykonaj:

```bash
# 1. Instalacja zależności (z lockfile)
pnpm install --frozen-lockfile

# 2. Sprawdzenie typów, testy jednostkowe/integracyjne i kompilacja
pnpm typecheck
pnpm test
pnpm build

# 3. Wygenerowanie i weryfikacja katalogu paczki Air-Gapped (dist/offline-bundle)
pnpm package:offline

# 4. Wygenerowanie gotowych archiwów wydania (.tar.gz / .deb / .zip + .sha256) w dist/release
pnpm package:release
```

---

## 6. Konfiguracja po instalacji

Conductor jest sterowany zmiennymi środowiskowymi oraz konfiguracją instancji providerów:

| Zmienna środowiskowa | Domyślna wartość | Opis |
| :--- | :--- | :--- |
| `CONDUCTOR_OFFLINE_MODE` | `1` | Wymusza ścisły tryb offline i blokadę ruchu poza RFC 1918 |
| `CONDUCTOR_ALLOW_PUBLIC_EGRESS` | `0` | Gdy `0`, `NetworkGuard` odrzuca każdy pakiet do publicznego IP |
| `CONDUCTOR_CA_BUNDLE_PATH` | *(brak)* | Ścieżka do pliku PEM z wewnętrznym firmowym certyfikatem Root CA |
| `CONDUCTOR_LOCAL_LLM_BASE_URL` | `http://127.0.0.1:11434/v1` | Adres lokalnego serwera **Ollama**, **vLLM** lub **LiteLLM Proxy** |
| `CONDUCTOR_INTERNAL_REGISTRY_URL` | *(brak / wyłączony)* | Adres wewnętrznego serwera Nexus/Artifactory dla `DesktopAutoUpdater` |

---

## 7. Weryfikacja izolacji sieciowej

Przed dopuszczeniem instalacji do pracy produkcyjnej uruchom diagnostykę `conductor doctor --verify-offline` oraz zestaw testów E2E Air-Gap:

```bash
pnpm test:e2e:airgap
```

Narzędzie sprawdza 6 punktów kontrolnych:
1. Blokadę ruchu wychodzącego do publicznego internetu (`8.8.8.8`).
2. Dostępność sieci loopback (`127.0.0.1`) oraz podsieci prywatnych RFC 1918 (`10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`).
3. Sanityzację zmiennych środowiskowych procesów potomnych (usuwanie kluczy chmurowych i telemetrii).
4. Poprawność wewnętrznego certyfikatu Root CA (jeśli skonfigurowano).
5. Brak jakichkolwiek zewnętrznych URL-i w zasobach Web UI oraz obecność nagłówka `STRICT_OFFLINE_CSP`.
6. Integralność kryptograficznego łańcucha skrótów SHA-256 w dzienniku audytu (`AuditLogger`).

---

## 8. Wydawanie nowych wersji (Release Workflow)

W repozytorium skonfigurowany jest automatyczny pipeline GitHub Actions [`.github/workflows/release.yml`](./.github/workflows/release.yml), który buduje, testuje i publikuje paczki dla **Linux (`x64`)** oraz **Windows (`x64`)**:

### Sposób 1: Wypchnięcie taga Git (`v*.*.*`)
```bash
git tag v0.1.0
git push origin v0.1.0
```

### Sposób 2: Ręczne uruchomienie z interfejsu GitHub (`workflow_dispatch`)
1. Przejdź do zakładki **Actions → Release (Linux & Windows Air-Gapped Bundles)** na GitHubie.
2. Kliknij **Run workflow**, wpisz numer wersji (np. `v0.1.0`) i zatwierdź.
3. Workflow automatycznie:
   - uruchomi pełny zestaw testów i weryfikację E2E (`verify`),
   - zbuduje paczki dla systemu **Linux** (`.tar.gz` oraz `.deb`),
   - zbuduje paczki dla systemu **Windows** (`.zip` oraz `.tar.gz`),
   - wygeneruje zbiorczy plik sum kontrolnych `SHA256SUMS.txt` i opublikuje **GitHub Release**.
