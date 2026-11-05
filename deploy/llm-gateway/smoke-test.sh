#!/usr/bin/env bash
# Smoke test LLM Gateway przez mTLS: /health oraz jedno wywolanie chat completion.
#
# Zmienne:
#   GATEWAY_URL   (domyslnie https://localhost:8443)
#   TLS_DIR       (domyslnie katalog tls/ obok skryptu; wymaga ca.crt client.crt client.key)
#   LITELLM_API_KEY  klucz wirtualny lub master key (wymagany)
#   MODEL         (domyslnie conductor-coder)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_URL="${GATEWAY_URL:-https://localhost:8443}"
TLS_DIR="${TLS_DIR:-$HERE/tls}"
MODEL="${MODEL:-conductor-coder}"
: "${LITELLM_API_KEY:?ustaw LITELLM_API_KEY}"

for f in ca.crt client.crt client.key; do
  [[ -r "$TLS_DIR/$f" ]] || { echo "BRAK $TLS_DIR/$f (uruchom tls/gen-dev-certs.sh)" >&2; exit 2; }
done

CURL=(curl -sS --max-time 120 --cacert "$TLS_DIR/ca.crt" --cert "$TLS_DIR/client.crt" --key "$TLS_DIR/client.key")
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "[1/3] mTLS: wywolanie bez certyfikatu klienta powinno zostac odrzucone"
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 --cacert "$TLS_DIR/ca.crt" \
  "$GATEWAY_URL/health/liveliness" 2>/dev/null || true)
# Zaleznie od wersji TLS: blad handshake (kod 000) albo 400/496 z nginx.
case "$code" in 000|400|496) echo "  OK (kod $code)";; *) fail "polaczenie bez certyfikatu klienta przeszlo (kod $code)";; esac

echo "[2/3] /health/liveliness przez mTLS"
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$GATEWAY_URL/health/liveliness") || fail "brak polaczenia"
[[ "$code" == "200" ]] || fail "/health/liveliness zwrocil $code"
echo "  OK (200)"

echo "[3/3] chat completion, model $MODEL"
resp=$("${CURL[@]}" -H "Authorization: Bearer $LITELLM_API_KEY" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: pong\"}]}" \
  "$GATEWAY_URL/v1/chat/completions") || fail "zapytanie nie powiodlo sie"
content=$(printf '%s' "$resp" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["choices"][0]["message"]["content"])' 2>/dev/null) \
  || fail "nieprawidlowa odpowiedz: $resp"
echo "  OK, odpowiedz modelu: ${content:0:80}"
echo "Smoke test zakonczony powodzeniem."
