# Conductor

**Conductor** to środowisko sterowania agentami kodującymi (*agent harness control surface*) inspirowane architekturą [pingdotgg/t3code](https://github.com/pingdotgg/t3code), zaprojektowane specjalnie do działania **w wewnętrznych sieciach firmowych (Intranet / Air-Gapped)** bez dostępu do publicznego internetu.

## Kluczowe założenia

- **100% Offline / Intranet-First (`Zero-Internet Guarantee`):** Wbudowany strażnik sieciowy (`NetworkGuard`) blokuje wszelki ruch wychodzący poza sieci prywatne RFC 1918 i jawną białą listę hostów firmowych. Wszystkie czcionki, ikony i gramatyki kolorowania składni są wbudowane lokalnie.
- **Lokalne modele LLM i agenci On-Premise:** Natywna integracja z wewnętrznymi serwerami **vLLM**, **Ollama**, **LiteLLM Proxy**, **TGI** oraz **llama.cpp**, a także obsługa **Agent Client Protocol (ACP)** i lokalnych serwerów **MCP**.
- **Architektura Event-Sourced (`Orchestrator v2` + `SQLite`):** Trwały zapis zdarzeń, projekcji i efektów ubocznych (`outbox`) w jednej transakcji SQLite, zapewniający idempotentność komend i bezstratne wznawianie sesji po zerwaniu połączenia WebSocket.
- **Bezpieczne checkpointy Git:** Po każdej turze agenta stan przestrzeni roboczej zapisywany jest pod ukrytą referencją `refs/conductor/checkpoints/*`, co pozwala na natychmiastowy podgląd diffów oraz atomowy rollback zmian w kodzie i historii rozmowy.
- **Integracje On-Premise:** Wsparcie dla **GitLab Self-Managed**, **Gitea / Forgejo**, **GitHub Enterprise Server**, korporacyjnego **OIDC / Keycloak / LDAP**, wewnętrznego PKI (własne certyfikaty CA) oraz audytu SIEM.

## Dokumentacja i Plan Wdrożenia

Pełny plan architektury i harmonogram implementacji znajduje się w pliku **[PLAN.md](./PLAN.md)**.
