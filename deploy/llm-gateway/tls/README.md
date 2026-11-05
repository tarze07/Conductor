# TLS i mTLS dla testowego LLM Gateway

Ten katalog zawiera narzedzia do **testowego** mTLS. Wygenerowane klucze i certyfikaty
sa ignorowane przez git (`.gitignore` w tym katalogu przepuszcza tylko `README.md`,
`.gitignore` i `gen-dev-certs.sh`). Nigdy nie commituj kluczy.

## Generowanie

```bash
cd deploy/llm-gateway
./tls/gen-dev-certs.sh ./tls          # CA, serwer, klient
```

Powstaja: `ca.crt`/`ca.key` (testowe CA), `server.crt`/`server.key` (SAN: `llm-gateway.local`,
`localhost`, `127.0.0.1`), `client.crt`/`client.key` (EKU `clientAuth`, CN `conductord-dev`).
Zmienne: `SERVER_CN`, `CLIENT_CN`, `DAYS`. Skrypt konczy sie `openssl verify` obu certyfikatow.

## Gdzie konczy sie mTLS

```
conductord --(mTLS, TLS 1.2/1.3)--> nginx :8443 --(HTTP, siec internal "gateway")--> LiteLLM :4000
```

* `nginx/nginx.conf` ma `ssl_verify_client on` i `ssl_client_certificate ca.crt`:
  klient bez certyfikatu podpisanego przez to CA nie dojdzie do LiteLLM.
* DN certyfikatu klienta trafia do dziennika dostepu nginx i do LiteLLM w naglowku
  `X-Client-DN` (do audytu). Autoryzacja do modeli i budzetow to nadal klucz wirtualny LiteLLM.
* LiteLLM nie wystawia portu na zewnatrz; siec `gateway` jest `internal: true`.

Zamiast nginx mozna uzyc Envoy (`require_client_certificate: true` w `DownstreamTlsContext`
oraz `match_typed_subject_alt_names`/`validation_context` z `trusted_ca`) albo balansera
firmowego z mTLS; wazne, zeby LiteLLM nie byl osiagalny inaczej niz przez ten punkt.

## Uzycie po stronie klienta

```bash
curl --cacert tls/ca.crt --cert tls/client.crt --key tls/client.key \
     https://localhost:8443/health/liveliness
```

Agenci CLI zwykle nie maja natywnego mTLS (czesc obsluguje zmienne typu
`CLAUDE_CODE_CLIENT_CERT`/`CLAUDE_CODE_CLIENT_KEY` - sprawdz dla uzywanej wersji). Dlatego
conductord powinien uruchamiac lokalny sidecar (np. Envoy lub stunnel na `127.0.0.1`), ktory
dokleja certyfikat klienta, a agentowi podawac adres sidecara. Klucz klienta zostaje
w keychainie hosta i nie trafia do sandboksu agenta (patrz `docs/llm-gateway.md`).

## Produkcja

Ten zestaw jest tylko do testow. W produkcji: certyfikaty z firmowego PKI, krotkie
terminy waznosci i automatyczna rotacja, certyfikat klienta per uzytkownik/stacja
(wydawany po logowaniu OIDC), CRL/OCSP albo krotkozyjace certyfikaty, a `ca.key` poza
dyskiem hosta (HSM/Vault).
