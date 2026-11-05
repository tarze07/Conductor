#!/usr/bin/env bash
# Generuje TESTOWE certyfikaty do mTLS: CA, serwer (nginx) i klient (conductord).
# Uzycie: ./gen-dev-certs.sh [katalog_wyjsciowy]   (domyslnie: katalog skryptu)
# Zmienne: SERVER_CN (domyslnie llm-gateway.local), CLIENT_CN (conductord-dev), DAYS (825)
# TYLKO DO TESTOW. W produkcji uzyj firmowego PKI.
set -euo pipefail

OUT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
SERVER_CN="${SERVER_CN:-llm-gateway.local}"
CLIENT_CN="${CLIENT_CN:-conductord-dev}"
DAYS="${DAYS:-825}"

mkdir -p "$OUT"
cd "$OUT"
umask 077

# CA
openssl genrsa -out ca.key 4096 2>/dev/null
openssl req -x509 -new -key ca.key -sha256 -days "$DAYS" \
  -subj "/O=Conductor Dev/CN=Conductor Dev CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out ca.crt

# Serwer
openssl genrsa -out server.key 2048 2>/dev/null
openssl req -new -key server.key -subj "/O=Conductor Dev/CN=${SERVER_CN}" -out server.csr
cat > server.ext <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:${SERVER_CN},DNS:localhost,IP:127.0.0.1
EXT
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -sha256 -days "$DAYS" -extfile server.ext -out server.crt 2>/dev/null

# Klient
openssl genrsa -out client.key 2048 2>/dev/null
openssl req -new -key client.key -subj "/O=Conductor Dev/CN=${CLIENT_CN}" -out client.csr
cat > client.ext <<EXT
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
EXT
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -sha256 -days "$DAYS" -extfile client.ext -out client.crt 2>/dev/null

rm -f server.csr client.csr server.ext client.ext ca.srl

# Pliki montowane do kontenera nginx musza byc czytelne dla jego uzytkownika (testowo).
# ca.key zostaje prywatny (600) - nie jest potrzebny zadnemu kontenerowi.
chmod 644 ca.crt server.crt client.crt server.key
chmod 600 ca.key client.key

echo "Wygenerowano w: $OUT"
echo "  ca.crt server.crt server.key client.crt client.key ca.key"
echo "Weryfikacja:"
openssl verify -CAfile ca.crt server.crt client.crt
