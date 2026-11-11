# Conductor

**Conductor** to środowisko sterowania agentami kodującymi (*agent harness control surface*) inspirowane architekturą [pingdotgg/t3code](https://github.com/pingdotgg/t3code), zaprojektowane specjalnie do działania **w wewnętrznych sieciach firmowych (Intranet / Air-Gapped)** bez dostępu do publicznego internetu.

## Kluczowe założenia

- **100% Offline / Intranet-First (`Zero-Internet Guarantee`):** Wbudowany strażnik sieciowy (`NetworkGuard`) blokuje wszelki ruch wychodzący poza sieci prywatne RFC 1918 i jawną białą listę hostów firmowych. Wszystkie czcionki, ikony i gramatyki kolorowania składni są wbudowane lokalnie.
- **Lokalne modele LLM i agenci On-Premise:** Natywna integracja z wewnętrznymi serwerami **vLLM**, **Ollama**, **LiteLLM Proxy**, **TGI** oraz **llama.cpp**, a także obsługa **Agent Client Protocol (ACP)** i lokalnych serwerów **MCP**.
- **Architektura Event-Sourced (`Orchestrator v2` + `SQLite`):** Trwały zapis zdarzeń, projekcji i efektów ubocznych (`outbox`) w jednej transakcji SQLite, zapewniający idempotentność komend i bezstratne wznawianie sesji po zerwaniu połączenia WebSocket.
- **Bezpieczne checkpointy Git:** Po każdej turze agenta stan przestrzeni roboczej zapisywany jest pod ukrytą referencją `refs/conductor/checkpoints/*`, co pozwala na natychmiastowy podgląd diffów oraz atomowy rollback zmian w kodzie i historii rozmowy.
- **Integracje On-Premise:** Wsparcie dla **GitLab Self-Managed**, **Gitea / Forgejo**, **GitHub Enterprise Server**, **Bitbucket Data Center**, korporacyjnego **OIDC / Keycloak**, **HashiCorp Vault**, wewnętrznego PKI (własne certyfikaty CA) oraz audytu SIEM (`AuditLogger` z łańcuchem SHA-256).

## Szybki start (Instalacja i Budowanie)

### Instalacja z gotowego wydania (Linux & Windows Air-Gapped)
- **Linux (`.tar.gz` / `.deb`):**
  ```bash
  tar -xzf conductor-v0.1.0-linux-x64-airgap.tar.gz
  cd conductor-v0.1.0-linux-x64-airgap
  sudo bash ./install-airgap.sh
  ```
- **Windows (`.zip` + PowerShell):**
  ```powershell
  Expand-Archive -Path .\conductor-v0.1.0-win-x64-airgap.zip -DestinationPath .\conductor-airgap -Force
  powershell -ExecutionPolicy Bypass -File .\conductor-airgap\conductor-v0.1.0-win-x64-airgap\install-airgap.ps1
  ```

### Budowanie ze źródeł i testy E2E (`--network=none`)
```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm package:offline
pnpm package:release
pnpm test:e2e:airgap
```

## Dokumentacja

- **[INSTALL.md](./INSTALL.md)** — szczegółowa instrukcja instalacji dla systemów **Linux**, **Windows**, **Docker (`internal: true`)**, konfiguracji lokalnych modeli LLM oraz wydawania wersji.
- **[PLAN.md](./PLAN.md)** — pełny plan architektury i harmonogram implementacji (Fazy 1–6).
- **[.github/workflows/release.yml](./.github/workflows/release.yml)** — automatyczny pipeline wydawniczy GitHub Actions dla Linux i Windows.
