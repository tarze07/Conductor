#!/usr/bin/env python3
"""Egress Guard (prototyp): proxy HTTP CONNECT z allowlista hostow i audytem JSON lines.

Proxy dziala POZA sandboksem. Sandbox nie ma zadnego interfejsu sieciowego poza
wlasnym loopbackiem; jedyna droga na zewnatrz to unix socket tego proxy,
zamontowany do sandboksa (patrz run-sandboxed.sh i sandbox-bridge.py).

Zasady:
  * tylko metoda CONNECT (inne -> 405, zalogowane); wyjatek: zapytania stub DNS
    z mostu (metoda X-CONDUCTOR-DNS, tylko przy --dns-stub),
  * cel musi pasowac do allowlisty (host:port, opcjonalnie wildcard "*.domena"),
  * literaly IP sa odrzucane, chyba ze sa jawnie na allowliscie,
  * DNS rozwiazuje proxy, nie sandbox (sandbox nie ma resolvera),
  * po rozwiazaniu nazwy kazdy adres przechodzi przez filtr adresow specjalnych
    (loopback, link-local/metadata, prywatne, multicast, ...); proxy laczy sie
    z TYM SAMYM sprawdzonym adresem, bez ponownego rozwiazywania (bez TOCTOU),
  * po "200 Connection established" proxy czyta pierwszy rekord od klienta;
    jesli to TLS ClientHello, SNI musi byc rowne hostowi z CONNECT
    (ochrona przed domain fronting / tunelowaniem pod cudzym SNI),
  * ruch nie-TLS jest dozwolony tylko dla wpisow oznaczonych "plaintext",
  * dla wpisow oznaczonych "git" proxy terminuje TLS (CA generowane per sandbox),
    przepuszcza tylko odczyt smart HTTP (git-upload-pack), a git-receive-pack
    (push) odrzuca z audytem; do forge laczy sie wlasnym TLS z weryfikacja certyfikatu,
  * opcjonalnie laczy sie z celem przez proxy nadrzedne (--upstream-proxy),
  * kazda proba (dozwolona i odrzucona) trafia do audytu jako jedna linia JSON.

Format allowlisty (jedna regula na linie, '#' = komentarz):
    host[:port] [plaintext] [loopback] [private] [git]

    llm-gateway.corp.example:443
    *.git.corp.example:443
    git.corp.example:443 git          # tylko fetch/clone, push odrzucany
    localhost:18080 plaintext loopback
    10.20.0.5:8443 private            # literal IP z sieci prywatnej

Flagi:
    plaintext  ruch bez TLS w tunelu (domyslnie tylko TLS z SNI == host),
    loopback   nazwa moze sie rozwiazac na 127.0.0.0/8 / ::1,
    private    nazwa moze sie rozwiazac na RFC1918, CGNAT 100.64/10, ULA fc00::/7,
    git        terminacja TLS i kontrola operacji git (nie laczy sie z plaintext).
Adresow link-local (w tym 169.254.169.254), unspecified, multicast, broadcast
i zarezerwowanych nie da sie dopuscic zadna flaga.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import fnmatch
import ipaddress
import json
import os
import re
import shutil
import signal
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid

MAX_HEADER = 8192
HTTP_HEAD_LIMIT = 65536
HEADER_TIMEOUT = 10.0
FIRST_RECORD_TIMEOUT = 10.0
CONNECT_TIMEOUT = 10.0
TLS_TIMEOUT = 10.0
RESPONSE_TIMEOUT = 300.0

FLAGS = ("plaintext", "loopback", "private", "git")
DNS_METHOD = "X-CONDUCTOR-DNS"


# --------------------------------------------------------------------------- audyt

class AuditLog:
    def __init__(self, path: str, sandbox_id: str):
        self.path = path
        self.sandbox_id = sandbox_id
        # O_APPEND: kazdy zapis to jedna linia dopisana na koniec.
        self.fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)

    def write(self, **fields) -> None:
        rec = {
            "ts": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds"),
            "component": "egress-guard",
            "sandbox": self.sandbox_id,
        }
        rec.update(fields)
        line = json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n"
        os.write(self.fd, line.encode())
        os.fsync(self.fd)


# ---------------------------------------------------------------------- allowlista

class Rule:
    def __init__(self, host: str, port: int, flags: set[str]):
        self.host = host
        self.port = port
        self.flags = frozenset(flags)

    plaintext = property(lambda self: "plaintext" in self.flags)
    git = property(lambda self: "git" in self.flags)

    def matches_host(self, host: str) -> bool:
        if self.host.startswith("*."):
            # "*.corp.example" pasuje do "a.corp.example", nie do "corp.example".
            return fnmatch.fnmatchcase(host, self.host) and host.count(".") >= self.host.count(".")
        return host == self.host

    def matches(self, host: str, port: int) -> bool:
        return port == self.port and self.matches_host(host)

    def render(self) -> str:
        return " ".join([f"{self.host}:{self.port}"] + [f for f in FLAGS if f in self.flags])


def normalize_host(host: str) -> str:
    host = host.strip().lower()
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    return host.rstrip(".")


def is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def load_allowlist(path: str) -> list[Rule]:
    rules = []
    with open(path, encoding="utf-8") as f:
        for lineno, raw in enumerate(f, 1):
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            parts = line.split()
            target, opts = parts[0], set(parts[1:])
            unknown = opts - set(FLAGS)
            if unknown:
                raise SystemExit(f"{path}:{lineno}: nieznane opcje {sorted(unknown)}")
            if {"git", "plaintext"} <= opts:
                raise SystemExit(f"{path}:{lineno}: 'git' wymaga TLS, nie laczy sie z 'plaintext'")
            host, port = split_authority(target, default_port=443)
            if host is None:
                raise SystemExit(f"{path}:{lineno}: niepoprawny wpis {target!r}")
            rules.append(Rule(host, port, opts))
    return rules


def split_authority(authority: str, default_port: int | None = None):
    """'host:port' / '[v6]:port' -> (host, port) albo (None, None)."""
    a = authority.strip()
    if a.startswith("["):
        end = a.find("]")
        if end < 0:
            return None, None
        host, rest = a[1:end], a[end + 1:]
        port_s = rest[1:] if rest.startswith(":") else ""
    elif a.count(":") == 1:
        host, port_s = a.split(":")
    elif a.count(":") == 0:
        host, port_s = a, ""
    else:
        return None, None  # goly IPv6 bez nawiasow - niejednoznaczne
    if not port_s:
        if default_port is None:
            return None, None
        port = default_port
    else:
        if not port_s.isdigit():
            return None, None
        port = int(port_s)
    if not (0 < port < 65536) or not host:
        return None, None
    return normalize_host(host), port


# ------------------------------------------------------ filtr adresow (rebinding)

# (siec, klasa, szczegol). Klasa "loopback"/"private" moze byc dopuszczona flaga
# reguly o tej samej nazwie; pozostale klasy sa zawsze odrzucane.
_V4 = [
    ("0.0.0.0/8", "unspecified", "this_network"),
    ("127.0.0.0/8", "loopback", "loopback"),
    ("169.254.0.0/16", "link_local", "link_local"),  # w tym 169.254.169.254 (metadata)
    ("10.0.0.0/8", "private", "rfc1918"),
    ("172.16.0.0/12", "private", "rfc1918"),
    ("192.168.0.0/16", "private", "rfc1918"),
    ("100.64.0.0/10", "private", "cgnat"),
    ("224.0.0.0/4", "multicast", "multicast"),
    ("255.255.255.255/32", "broadcast", "broadcast"),
    ("240.0.0.0/4", "reserved", "reserved"),
]
_V6 = [
    ("::/128", "unspecified", "unspecified"),
    ("::1/128", "loopback", "loopback"),
    ("fe80::/10", "link_local", "link_local"),
    ("fec0::/10", "private", "site_local"),
    ("fc00::/7", "private", "ula"),
    ("ff00::/8", "multicast", "multicast"),
]
SPECIAL_V4 = [(ipaddress.ip_network(n), c, d) for n, c, d in _V4]
SPECIAL_V6 = [(ipaddress.ip_network(n), c, d) for n, c, d in _V6]
NAT64 = ipaddress.ip_network("64:ff9b::/96")
SIX_TO_FOUR = ipaddress.ip_network("2002::/16")
V4_COMPAT = ipaddress.ip_network("::/96")
ALLOWABLE_CLASSES = {"loopback", "private"}


def classify_address(addr: str):
    """Zwraca (klasa, szczegol) dla adresu specjalnego albo None dla publicznego.
    Adresy IPv6 z osadzonym IPv4 (mapped, NAT64, 6to4, compat) sa oceniane po IPv4."""
    ip = ipaddress.ip_address(addr.split("%", 1)[0])
    if ip.version == 6:
        embedded, how = None, None
        if ip.ipv4_mapped is not None:
            embedded, how = ip.ipv4_mapped, "ipv4_mapped"
        elif ip in NAT64:
            embedded, how = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF), "nat64"
        elif ip in SIX_TO_FOUR:
            embedded, how = ipaddress.IPv4Address((int(ip) >> 80) & 0xFFFFFFFF), "6to4"
        elif ip in V4_COMPAT and int(ip) > 1:
            embedded, how = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF), "ipv4_compat"
        if embedded is not None:
            inner = classify_address(str(embedded))
            return (inner[0], f"{how}:{inner[1]}") if inner else None
        table = SPECIAL_V6
    else:
        table = SPECIAL_V4
    for net, cls, detail in table:
        if ip in net:
            return cls, detail
    return None


def address_allowed(addr: str, allow: frozenset | set):
    """(ok, klasa, szczegol). `allow` to podzbior {"loopback", "private"}."""
    c = classify_address(addr)
    if c is None:
        return True, None, None
    return (c[0] in ALLOWABLE_CLASSES and c[0] in allow), c[0], c[1]


class Denied(Exception):
    def __init__(self, reason: str, status: str = "", **extra):
        super().__init__(reason)
        self.reason = reason
        self.status = status
        self.extra = extra


async def resolve_checked(host: str, port: int, allow, *, reason: str, what: str):
    """Rozwiazuje nazwe i sprawdza WSZYSTKIE adresy. Jeden niedozwolony adres
    odrzuca cala nazwe (fail closed: odpowiedz DNS mieszajaca adres publiczny
    i 127.0.0.1 tez jest odrzucana). Zwraca liste sprawdzonych adresow."""
    loop = asyncio.get_running_loop()
    try:
        infos = await asyncio.wait_for(
            loop.getaddrinfo(host, port, type=socket.SOCK_STREAM), CONNECT_TIMEOUT)
    except (OSError, asyncio.TimeoutError) as e:
        raise Denied(f"{what}dns_failed", "502 Bad Gateway", error=type(e).__name__)
    addrs = []
    for fam, _, _, _, sa in infos:
        if fam in (socket.AF_INET, socket.AF_INET6) and sa[0] not in addrs:
            addrs.append(sa[0])
    if not addrs:
        raise Denied(f"{what}dns_failed", "502 Bad Gateway")
    for a in addrs:
        ok, cls, detail = address_allowed(a, allow)
        if not ok:
            raise Denied(reason, "403 Forbidden", resolved=addrs, address=a,
                         address_class=cls, address_detail=detail)
    return addrs


async def connect_addrs(addrs: list[str], port: int):
    """Laczy sie z pierwszym osiagalnym z JUZ SPRAWDZONYCH adresow (bez DNS)."""
    last = None
    for a in addrs:
        try:
            r, w = await asyncio.wait_for(asyncio.open_connection(a, port), CONNECT_TIMEOUT)
            return r, w, a
        except (OSError, asyncio.TimeoutError) as e:
            last = e
    raise Denied("upstream_connect_failed", error=type(last).__name__ if last else "none")


# ------------------------------------------------------------------ proxy nadrzedne

class UpstreamProxy:
    """Proxy nadrzedne (np. firmowe). Tylko http://host:port, bez uwierzytelniania.
    Jego adres przechodzi przez ten sam filtr adresow; dopuszczenie loopback/private
    pochodzi z konfiguracji launchera (--upstream-proxy-allow), nie z allowlisty agenta."""

    def __init__(self, url: str, allow: set[str]):
        u = urllib.parse.urlsplit(url)
        if u.scheme != "http" or not u.hostname or u.path not in ("", "/") or u.query \
                or u.username or u.password:
            raise SystemExit(f"--upstream-proxy: oczekiwano http://host:port, jest {url!r}")
        self.host = normalize_host(u.hostname)
        self.port = u.port or 3128
        self.allow = frozenset(allow)

    def label(self) -> str:
        return f"{self.host}:{self.port}"

    async def tunnel(self, host: str, port: int, ev: dict):
        addrs = await resolve_checked(self.host, self.port, self.allow,
                                      reason="upstream_proxy_special_address",
                                      what="upstream_proxy_")
        try:
            r, w, addr = await connect_addrs(addrs, self.port)
        except Denied as d:
            raise Denied("upstream_proxy_connect_failed", **d.extra)
        ev.update(via="upstream", upstream=self.label(), upstream_addr=addr)
        authority = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
        w.write(f"CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n".encode())
        try:
            await w.drain()
            head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), HEADER_TIMEOUT)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError,
                asyncio.TimeoutError, ConnectionError, OSError) as e:
            w.close()
            raise Denied("upstream_proxy_bad_response", error=type(e).__name__)
        line = head.split(b"\r\n", 1)[0].decode("latin-1")
        parts = line.split(None, 2)
        status = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else None
        if status != 200:
            w.close()
            raise Denied("upstream_proxy_refused", "502 Bad Gateway",
                         upstream_status=status, upstream_line=line[:200])
        return r, w


# ------------------------------------------------------------------------- TLS SNI

def parse_sni(record: bytes):
    """Zwraca (is_tls, sni|None). Parsuje pojedynczy rekord TLS z ClientHello."""
    if len(record) < 5 or record[0] != 0x16:
        return False, None
    try:
        body = record[5:]
        if body[0] != 0x01:  # handshake type ClientHello
            return True, None
        p = 4                     # typ (1) + dlugosc (3)
        p += 2 + 32               # client_version + random
        p += 1 + body[p]          # session_id
        (cs_len,) = struct.unpack_from("!H", body, p)
        p += 2 + cs_len           # cipher_suites
        p += 1 + body[p]          # compression_methods
        (ext_total,) = struct.unpack_from("!H", body, p)
        p += 2
        end = p + ext_total
        while p + 4 <= end:
            ext_type, ext_len = struct.unpack_from("!HH", body, p)
            p += 4
            if ext_type == 0:  # server_name
                q = p + 2  # server_name_list length
                while q + 3 <= p + ext_len:
                    name_type = body[q]
                    (name_len,) = struct.unpack_from("!H", body, q + 1)
                    name = body[q + 3:q + 3 + name_len]
                    if name_type == 0:
                        return True, normalize_host(name.decode("ascii"))
                    q += 3 + name_len
                return True, None
            p += ext_len
        return True, None
    except (IndexError, struct.error, UnicodeDecodeError):
        return True, None


# ------------------------------------------------- terminacja TLS (tryb "git")

SAFE_CERT_NAME = re.compile(r"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$")


class SandboxCA:
    """CA generowane przy starcie proxy (openssl CLI), jedno na sandbox.

    Klucz prywatny CA i klucz liscia leza w `state_dir` (prywatny katalog stanu
    launchera, 0700, NIE montowany do sandboksa). Do sandboksa trafia tylko
    certyfikat publiczny (`public_dir/sandbox-ca.crt`) i paczka systemowe CA +
    CA sandboksa (`public_dir/ca-bundle.crt`). Certyfikaty lisci sa krotkie
    (2 dni) i wystawiane na zadanie dla nazwy z allowlisty (po sprawdzeniu SNI).
    """

    def __init__(self, state_dir: str, public_dir: str, sandbox_id: str):
        self.openssl = shutil.which("openssl")
        if not self.openssl:
            raise SystemExit("egress-proxy: reguly 'git' wymagaja openssl (terminacja TLS)")
        self.dir = state_dir
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        os.chmod(self.dir, 0o700)
        self.ca_key = os.path.join(self.dir, "ca.key")
        self.ca_crt = os.path.join(self.dir, "ca.crt")
        self.leaf_key = os.path.join(self.dir, "leaf.key")
        cn = "Conductor sandbox CA " + re.sub(r"[^A-Za-z0-9._-]", "_", sandbox_id)[:40]
        self._run("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
                  "-nodes", "-keyout", self.ca_key, "-out", self.ca_crt, "-days", "2",
                  "-subj", f"/CN={cn}",
                  "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
                  "-addext", "keyUsage=critical,keyCertSign,cRLSign")
        self._run("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256",
                  "-out", self.leaf_key)
        with open(self.ca_crt, "rb") as f:
            ca_pem = f.read()
        os.makedirs(public_dir, exist_ok=True)
        self.public_ca = os.path.join(public_dir, "sandbox-ca.crt")
        self.public_bundle = os.path.join(public_dir, "ca-bundle.crt")
        system = b""
        sys_bundle = system_ca_bundle()
        if sys_bundle:
            with open(sys_bundle, "rb") as f:
                system = f.read().rstrip(b"\n") + b"\n"
        for path, data in ((self.public_ca, ca_pem), (self.public_bundle, system + ca_pem)):
            with open(path + ".tmp", "wb") as f:
                f.write(data)
            os.chmod(path + ".tmp", 0o644)
            os.replace(path + ".tmp", path)
        self.contexts: dict[str, ssl.SSLContext] = {}

    def _run(self, *args) -> None:
        old = os.umask(0o077)
        try:
            r = subprocess.run([self.openssl, *args], stdin=subprocess.DEVNULL,
                               capture_output=True, text=True)
        finally:
            os.umask(old)
        if r.returncode != 0:
            raise RuntimeError(f"openssl {args[0]}: {r.stderr.strip()[:300]}")

    def _issue(self, host: str) -> ssl.SSLContext:
        if not (SAFE_CERT_NAME.match(host) or is_ip_literal(host)):
            raise RuntimeError(f"niedozwolona nazwa dla certyfikatu: {host!r}")
        san = f"IP:{host}" if is_ip_literal(host) else f"DNS:{host}"
        base = os.path.join(self.dir, "leaf-" + uuid.uuid4().hex[:12])
        with open(base + ".ext", "w") as f:
            f.write(f"subjectAltName={san}\nbasicConstraints=critical,CA:FALSE\n"
                    "keyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n")
        cn = host if len(host) <= 64 else "conductor-sandbox"
        self._run("req", "-new", "-key", self.leaf_key, "-subj", f"/CN={cn}", "-out", base + ".csr")
        self._run("x509", "-req", "-in", base + ".csr", "-CA", self.ca_crt, "-CAkey", self.ca_key,
                  "-set_serial", str(int.from_bytes(os.urandom(8), "big")), "-days", "2",
                  "-extfile", base + ".ext", "-out", base + ".crt")
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(base + ".crt", self.leaf_key)
        ctx.set_alpn_protocols(["http/1.1"])  # bez HTTP/2: proxy parsuje HTTP/1.1
        return ctx

    async def server_context(self, host: str) -> ssl.SSLContext:
        if host not in self.contexts:
            loop = asyncio.get_running_loop()
            self.contexts[host] = await loop.run_in_executor(None, self._issue, host)
        return self.contexts[host]


def system_ca_bundle() -> str | None:
    paths = ssl.get_default_verify_paths()
    for p in (os.environ.get("SSL_CERT_FILE"), paths.cafile, paths.openssl_cafile,
              "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt",
              "/etc/ssl/cert.pem"):
        if p and os.path.isfile(p):
            return p
    return None


class TLSStream:
    """TLS nad strumieniem asyncio przez ssl.MemoryBIO. Pozwala dokonczyc handshake
    z ClientHello, ktory proxy juz przeczytalo (sprawdzenie SNI)."""

    def __init__(self, ctx, reader, writer, *, server_side, server_hostname=None, initial=b""):
        self._in, self._out = ssl.MemoryBIO(), ssl.MemoryBIO()
        self.obj = ctx.wrap_bio(self._in, self._out, server_side=server_side,
                                server_hostname=server_hostname)
        self.reader, self.writer = reader, writer
        self._eof = False
        if initial:
            self._in.write(initial)

    async def _flush(self):
        data = self._out.read()
        if data:
            self.writer.write(data)
            await self.writer.drain()

    async def _run(self, fn, *args):
        while True:
            try:
                res = fn(*args)
            except ssl.SSLWantReadError:
                await self._flush()
                if self._eof:
                    raise ConnectionResetError("TLS: nieoczekiwany koniec strumienia")
                data = await self.reader.read(65536)
                if data:
                    self._in.write(data)
                else:
                    self._eof = True
                    self._in.write_eof()
                continue
            await self._flush()
            return res

    async def handshake(self):
        await self._run(self.obj.do_handshake)

    async def read(self, n: int = 65536) -> bytes:
        try:
            return await self._run(self.obj.read, n)
        except (ssl.SSLZeroReturnError, ssl.SSLEOFError, ConnectionResetError):
            return b""

    async def write(self, data: bytes):
        view = memoryview(data)
        while view:
            n = await self._run(self.obj.write, view)
            view = view[n:]

    async def close(self):
        try:
            self.obj.unwrap()
        except (ssl.SSLError, OSError, ValueError):
            pass
        try:
            await self._flush()
        except (ConnectionError, OSError):
            pass
        self.writer.close()


class HTTPError(Exception):
    pass


class Buffered:
    def __init__(self, stream):
        self.s = stream
        self.buf = bytearray()

    async def _fill(self) -> bool:
        d = await self.s.read(65536)
        if not d:
            return False
        self.buf += d
        return True

    async def read_until(self, sep: bytes, limit: int) -> bytes:
        while True:
            i = self.buf.find(sep)
            if i >= 0:
                out = bytes(self.buf[:i + len(sep)])
                del self.buf[:i + len(sep)]
                return out
            if len(self.buf) > limit:
                raise HTTPError("header_too_large")
            if not await self._fill():
                raise EOFError

    async def read_some(self, n: int) -> bytes:
        if not self.buf and not await self._fill():
            return b""
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out

    async def read_exactly(self, n: int) -> bytes:
        while len(self.buf) < n:
            if not await self._fill():
                raise EOFError
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out


TOKEN = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
HOP_BY_HOP = {"connection", "keep-alive", "proxy-connection", "proxy-authorization",
              "proxy-authenticate", "te", "upgrade", "trailer"}


def parse_head(raw: bytes):
    body = raw[:-4]
    # Gole CR/LF i NUL odrzucamy: inaczej forge moglby zobaczyc doklejony naglowek
    # (np. drugi Host), ktorego proxy nie sprawdzilo.
    if b"\x00" in body or b"\r" in body.replace(b"\r\n", b"") or b"\n" in body.replace(b"\r\n", b""):
        raise HTTPError("bad_header")
    lines = body.decode("latin-1").split("\r\n")
    headers = []
    for line in lines[1:]:
        name, sep, value = line.partition(":")
        if not sep or not TOKEN.match(name):  # w tym obs-fold (linia od spacji)
            raise HTTPError("bad_header")
        headers.append((name, value.strip()))
    return lines[0], headers


def header_values(headers, name):
    return [v for n, v in headers if n.lower() == name]


def body_framing(headers, *, status=None):
    if status is not None and (100 <= status < 200 or status in (204, 304)):
        return "none", 0
    te, cl = header_values(headers, "transfer-encoding"), header_values(headers, "content-length")
    if te:
        if cl:
            raise HTTPError("both_te_and_cl")
        if len(te) != 1 or te[0].lower() != "chunked":
            raise HTTPError("unsupported_transfer_encoding")
        return "chunked", None
    if cl:
        if len({v for v in cl}) != 1 or not cl[0].isdigit():
            raise HTTPError("bad_content_length")
        return "length", int(cl[0])
    return ("close", None) if status is not None else ("none", 0)


async def forward_body(src: Buffered, dst: TLSStream, framing, counter: list):
    kind, n = framing
    if kind == "length":
        while n > 0:
            d = await src.read_some(min(n, 65536))
            if not d:
                raise EOFError
            await dst.write(d)
            counter[0] += len(d)
            n -= len(d)
    elif kind == "chunked":
        while True:
            line = await src.read_until(b"\r\n", 4096)
            size_s = line[:-2].split(b";", 1)[0].strip()
            if not size_s or not re.fullmatch(rb"[0-9A-Fa-f]{1,16}", size_s):
                raise HTTPError("bad_chunk")
            size = int(size_s, 16)
            await dst.write(line)
            if size == 0:
                while True:  # trailery az do pustej linii
                    t = await src.read_until(b"\r\n", 8192)
                    await dst.write(t)
                    if t == b"\r\n":
                        return
            chunk = await src.read_exactly(size + 2)
            if chunk[-2:] != b"\r\n":
                raise HTTPError("bad_chunk")
            await dst.write(chunk)
            counter[0] += size
    elif kind == "close":
        while True:
            d = await src.read_some(65536)
            if not d:
                return
            await dst.write(d)
            counter[0] += len(d)


GIT_PATH = re.compile(r"^/[A-Za-z0-9._~@+,=:/-]*$")


def classify_git_request(method: str, target: str):
    """Zwraca (operacja, powod_odmowy|None). Dozwolony jest tylko odczyt smart HTTP:
    GET .../info/refs?service=git-upload-pack i POST .../git-upload-pack."""
    path, _, query = target.partition("?")
    lowered = urllib.parse.unquote(target).lower()
    # Push rozpoznajemy najpierw i na zdekodowanym celu: odmowa ma miec wlasciwy powod.
    if "git-receive-pack" in lowered:
        return "push", "git_push_requires_approval"
    if (not GIT_PATH.match(path) or "//" in path
            or any(seg in (".", "..") for seg in path.split("/"))):
        return "invalid", "git_bad_target"
    if method == "GET" and path.endswith("/info/refs") and query == "service=git-upload-pack":
        return "fetch", None
    if method == "POST" and path.endswith("/git-upload-pack") and query == "":
        return "fetch", None
    return "other", "git_request_not_allowed"


class GitPushApproval:
    """Punkt rozszerzenia: zgoda czlowieka na `git push` (Policy Engine, issue #20).

    Na tym etapie push jest zawsze odrzucany. Integracja z Policy Engine ma tu
    zapytac conductord (np. przez osobny socket kontrolny) o decyzje dla
    {sandbox, host, path} i poczekac na zgode z UI, z limitem czasu.
    """

    async def request(self, sandbox_id: str, host: str, port: int, path: str) -> bool:
        return False


# --------------------------------------------------------------------------- proxy

class EgressProxy:
    def __init__(self, rules: list[Rule], audit: AuditLog, *, upstream: UpstreamProxy | None = None,
                 ca: SandboxCA | None = None, upstream_tls: ssl.SSLContext | None = None,
                 dns_stub: bool = False, approval: GitPushApproval | None = None):
        self.rules = rules
        self.audit = audit
        self.upstream = upstream
        self.ca = ca
        self.upstream_tls = upstream_tls
        self.dns_stub = dns_stub
        self.approval = approval or GitPushApproval()

    def lookup(self, host: str, port: int):
        for r in self.rules:
            if r.matches(host, port):
                return r
        return None

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        conn_id = uuid.uuid4().hex[:12]
        started = time.monotonic()
        peer = self.peer_info(writer)
        ev = {"conn": conn_id, "peer": peer}

        async def deny(status: str, reason: str, **extra):
            self.audit.write(event="connect", decision="deny", reason=reason, **ev, **extra)
            try:
                if status:
                    writer.write(f"HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
                    await writer.drain()
            except (ConnectionError, OSError):
                pass
            writer.close()

        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), HEADER_TIMEOUT)
        except asyncio.IncompleteReadError as e:
            await deny("400 Bad Request", "bad_request_header" if e.partial else "client_closed")
            return
        except (asyncio.LimitOverrunError, asyncio.TimeoutError, ConnectionError):
            await deny("400 Bad Request", "bad_request_header")
            return

        request_line = head.split(b"\r\n", 1)[0].decode("latin-1")
        parts = request_line.split()
        if len(parts) != 3:
            await deny("400 Bad Request", "bad_request_line", request=request_line[:200])
            return
        method, target, _version = parts

        if method == DNS_METHOD and self.dns_stub:
            await self.handle_dns(target, head, writer, peer)
            return

        ev.update(method=method, target=target[:300])

        if method.upper() != "CONNECT":
            await deny("405 Method Not Allowed", "method_not_allowed")
            return

        host, port = split_authority(target)
        if host is None:
            await deny("400 Bad Request", "bad_authority")
            return
        ev.update(host=host, port=port)

        rule = self.lookup(host, port)
        if rule is None:
            reason = "ip_literal" if is_ip_literal(host) else "not_in_allowlist"
            await deny("403 Forbidden", reason)
            return
        ev.update(rule=rule.render())

        # Filtr adresow PRZED odpowiedzia 200: nazwa jest rozwiazywana raz, a polaczenie
        # idzie potem dokladnie na sprawdzone adresy. Przy proxy nadrzednym cel rozwiazuje
        # proxy nadrzedne; sprawdzany jest wtedy adres samego proxy nadrzednego.
        addrs = None
        try:
            if self.upstream is None:
                addrs = await resolve_checked(host, port, rule.flags & ALLOWABLE_CLASSES,
                                              reason="resolved_to_special_address", what="")
            else:
                await resolve_checked(self.upstream.host, self.upstream.port, self.upstream.allow,
                                      reason="upstream_proxy_special_address",
                                      what="upstream_proxy_")
        except Denied as d:
            await deny(d.status, d.reason, **d.extra)
            return

        # Tunel zestawiamy dopiero po sprawdzeniu pierwszego rekordu od klienta,
        # zeby przy niezgodnym SNI nie otwierac w ogole polaczenia do celu.
        writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        await writer.drain()

        try:
            first = await asyncio.wait_for(reader.read(5), FIRST_RECORD_TIMEOUT)
            if len(first) == 5 and first[0] == 0x16:
                (rec_len,) = struct.unpack("!H", first[3:5])
                first += await asyncio.wait_for(reader.readexactly(rec_len), FIRST_RECORD_TIMEOUT)
        except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError):
            await deny("", "client_closed_before_data")
            return

        is_tls, sni = parse_sni(first)
        ev.update(tls=is_tls, sni=sni)
        if is_tls:
            if sni is None:
                await deny("", "tls_without_sni")
                return
            if sni != host:
                await deny("", "sni_mismatch")
                return
        elif rule.git:
            await deny("", "git_requires_tls")
            return
        elif not rule.plaintext:
            await deny("", "plaintext_not_allowed")
            return

        if rule.git:
            await self.git_session(reader, writer, first, host, port, addrs, ev, started)
            return

        try:
            up_reader, up_writer, resolved = await self.open_upstream(host, port, addrs, ev)
        except Denied as d:
            await deny("", d.reason, **d.extra)
            return
        self.audit.write(event="connect", decision="allow", reason="allowlist", resolved=resolved, **ev)

        up_writer.write(first)
        counters = {"up": len(first), "down": 0}

        async def pipe(src, dst, key):
            try:
                while True:
                    data = await src.read(65536)
                    if not data:
                        break
                    counters[key] += len(data)
                    dst.write(data)
                    await dst.drain()
            except (ConnectionError, OSError):
                pass
            finally:
                try:
                    if dst.can_write_eof():
                        dst.write_eof()
                except (OSError, RuntimeError):
                    pass

        await asyncio.gather(pipe(reader, up_writer, "up"), pipe(up_reader, writer, "down"))
        for w in (writer, up_writer):
            w.close()
        self.audit.write(event="close", conn=conn_id, host=host, port=port,
                         bytes_up=counters["up"], bytes_down=counters["down"],
                         duration_ms=int((time.monotonic() - started) * 1000))

    async def open_upstream(self, host, port, addrs, ev):
        """Surowe polaczenie do celu: bezposrednio na sprawdzony adres albo tunelem
        CONNECT przez proxy nadrzedne. Zwraca (reader, writer, resolved)."""
        if self.upstream is not None:
            r, w = await self.upstream.tunnel(host, port, ev)
            return r, w, None
        r, w, addr = await connect_addrs(addrs, port)
        return r, w, addr

    # ---------------------------------------------------------------- tryb git

    async def git_session(self, reader, writer, first, host, port, addrs, ev, started):
        """Terminacja TLS dla forge: jedno zadanie HTTP na tunel (Connection: close)."""
        conn_id = ev["conn"]

        def audit(event, decision, reason, **extra):
            self.audit.write(event=event, decision=decision, reason=reason, mode="git", **ev, **extra)

        try:
            ctx = await self.ca.server_context(host)
        except (RuntimeError, OSError, ssl.SSLError) as e:
            audit("connect", "deny", "tls_cert_issue_failed", error=str(e)[:200])
            writer.close()
            return
        client = TLSStream(ctx, reader, writer, server_side=True, initial=first)
        try:
            await asyncio.wait_for(client.handshake(), TLS_TIMEOUT)
        except (ssl.SSLError, ConnectionError, OSError, asyncio.TimeoutError) as e:
            audit("connect", "deny", "client_tls_failed", error=type(e).__name__)
            writer.close()
            return
        cbuf = Buffered(client)

        async def respond(status: str, text: str):
            body = text.encode()
            try:
                await client.write(f"HTTP/1.1 {status}\r\nContent-Type: text/plain\r\n"
                                   f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
            except (ConnectionError, OSError, ssl.SSLError):
                pass
            await client.close()

        try:
            raw = await asyncio.wait_for(cbuf.read_until(b"\r\n\r\n", HTTP_HEAD_LIMIT), HEADER_TIMEOUT)
            start, headers = parse_head(raw)
            parts = start.split(" ")
            if len(parts) != 3 or not parts[2].startswith("HTTP/1."):
                raise HTTPError("bad_request_line")
            method, rtarget, version = parts
        except (HTTPError, EOFError, asyncio.TimeoutError, ConnectionError, ssl.SSLError) as e:
            reason = str(e) if isinstance(e, HTTPError) else "client_closed"
            audit("git_request", "deny", f"git_{reason}")
            await respond("400 Bad Request", "conductor egress guard: bad request\n")
            return

        req = {"http_method": method, "path": rtarget[:500]}
        op, reason = classify_git_request(method, rtarget)
        hosts = header_values(headers, "host")
        if reason is None and (len(hosts) != 1 or split_authority(hosts[0], 443) != (host, port)):
            op, reason = "invalid", "git_host_mismatch"
        if op == "push":
            if await self.approval.request(self.audit.sandbox_id, host, port, rtarget):
                reason = None
        if reason is not None:
            audit("git_request", "deny", reason, op=op, **req)
            msg = ("conductor egress guard: git push requires human approval "
                   "(push is blocked in the sandbox)\n" if op == "push"
                   else f"conductor egress guard: request not allowed ({reason})\n")
            await respond("403 Forbidden", msg)
            return
        try:
            framing = body_framing(headers)
        except HTTPError as e:
            audit("git_request", "deny", f"git_{e}", op=op, **req)
            await respond("400 Bad Request", "conductor egress guard: bad request framing\n")
            return

        # Dopiero teraz polaczenie do forge (sprawdzony adres albo proxy nadrzedne)
        # i wlasny TLS z weryfikacja certyfikatu forge.
        try:
            up_r, up_w, resolved = await self.open_upstream(host, port, addrs, ev)
        except Denied as d:
            audit("git_request", "deny", d.reason, op=op, **req, **d.extra)
            await respond("502 Bad Gateway", "conductor egress guard: upstream unavailable\n")
            return
        upstream = TLSStream(self.upstream_tls, up_r, up_w, server_side=False, server_hostname=host)
        try:
            await asyncio.wait_for(upstream.handshake(), TLS_TIMEOUT)
        except (ssl.SSLError, ConnectionError, OSError, asyncio.TimeoutError) as e:
            audit("git_request", "deny", "upstream_tls_failed", op=op, resolved=resolved,
                  error=f"{type(e).__name__}: {e}"[:300], **req)
            up_w.close()
            await respond("502 Bad Gateway", "conductor egress guard: forge TLS verification failed\n")
            return
        audit("git_request", "allow", "git_read_only", op=op, resolved=resolved, **req)

        out = [f"{method} {rtarget} {version}"]
        out += [f"{n}: {v}" for n, v in headers if n.lower() not in HOP_BY_HOP]
        out.append("Connection: close")
        up_bytes, down_bytes = [0], [0]
        ubuf = Buffered(upstream)

        async def request_body():
            await upstream.write(("\r\n".join(out) + "\r\n\r\n").encode("latin-1"))
            await forward_body(cbuf, upstream, framing, up_bytes)

        async def response():
            while True:
                rhead = await asyncio.wait_for(ubuf.read_until(b"\r\n\r\n", HTTP_HEAD_LIMIT),
                                               RESPONSE_TIMEOUT)
                status_line, rheaders = parse_head(rhead)
                sp = status_line.split(" ", 2)
                status = int(sp[1]) if len(sp) >= 2 and sp[1].isdigit() else 0
                if status == 101 or not 100 <= status < 600:
                    raise HTTPError("bad_or_upgrade_response")
                if status < 200:  # 100 Continue itp.: przekazujemy i czekamy na wlasciwa odpowiedz
                    await client.write(rhead)
                    continue
                lines = [status_line] + [f"{n}: {v}" for n, v in rheaders
                                         if n.lower() not in ("connection", "keep-alive")]
                lines.append("Connection: close")
                await client.write(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
                await forward_body(ubuf, client, body_framing(rheaders, status=status), down_bytes)
                return status

        t_req = asyncio.ensure_future(request_body())
        t_resp = asyncio.ensure_future(response())
        try:
            await asyncio.wait([t_req, t_resp], return_when=asyncio.FIRST_COMPLETED)
            # Zadanie wyslane w calosci: czekamy na odpowiedz. W kazdym innym przypadku
            # (blad po ktorejkolwiek stronie, wczesna odpowiedz forge) konczymy oba kierunki.
            if t_req.done() and not t_req.cancelled() and t_req.exception() is None \
                    and not t_resp.done():
                await asyncio.wait([t_resp])
        finally:
            for t in (t_req, t_resp):
                if not t.done():
                    t.cancel()
            results = await asyncio.gather(t_req, t_resp, return_exceptions=True)
            await upstream.close()
            await client.close()
        status = results[1] if isinstance(results[1], int) else None
        errs = [r for r in results if isinstance(r, BaseException)
                and not isinstance(r, asyncio.CancelledError)]
        if errs:
            self.audit.write(event="git_error", conn=conn_id, error=type(errs[0]).__name__,
                             detail=str(errs[0])[:200])
        self.audit.write(event="close", conn=conn_id, host=host, port=port, mode="git",
                         http_status=status, bytes_up=up_bytes[0], bytes_down=down_bytes[0],
                         duration_ms=int((time.monotonic() - started) * 1000))

    # ---------------------------------------------------------------- stub DNS

    async def handle_dns(self, name: str, head: bytes, writer, peer):
        """Zapytanie stub DNS z mostu w sandboksie. Odpowiedz: 200 + porty z allowlisty
        dla nazwy albo 404. Proxy niczego nie rozwiazuje i niczego nie przekazuje dalej."""
        qtype = "?"
        for line in head.decode("latin-1").split("\r\n")[1:]:
            k, _, v = line.partition(":")
            if k.strip().lower() == "x-qtype":
                qtype = v.strip()[:16]
        name = normalize_host(name)[:255]
        ports = sorted({r.port for r in self.rules
                        if not is_ip_literal(r.host) and r.matches_host(name)})
        allowed = bool(ports) and not is_ip_literal(name)
        self.audit.write(event="dns", decision="allow" if allowed else "deny",
                         reason="allowlist" if allowed else "not_in_allowlist",
                         name=name, qtype=qtype, peer=peer)
        if allowed:
            resp = f"HTTP/1.1 200 OK\r\nX-Ports: {','.join(map(str, ports))}\r\nContent-Length: 0\r\n\r\n"
        else:
            resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"
        try:
            writer.write(resp.encode())
            await writer.drain()
        except (ConnectionError, OSError):
            pass
        writer.close()

    @staticmethod
    def peer_info(writer):
        """Dla unix socketu: pid/uid procesu po drugiej stronie (SO_PEERCRED)."""
        sock = writer.get_extra_info("socket")
        if sock is not None and sock.family == socket.AF_UNIX:
            try:
                creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
                pid, uid, gid = struct.unpack("3i", creds)
                return {"transport": "unix", "pid": pid, "uid": uid}
            except OSError:
                return {"transport": "unix"}
        peer = writer.get_extra_info("peername")
        return {"transport": "tcp", "addr": str(peer)}


def parse_allow_classes(value: str | None) -> set[str]:
    out = {v.strip() for v in (value or "").split(",") if v.strip()}
    bad = out - ALLOWABLE_CLASSES
    if bad:
        raise SystemExit(f"--upstream-proxy-allow: nieznane klasy {sorted(bad)} (dozwolone: loopback, private)")
    return out


async def main_async(args):
    rules = load_allowlist(args.allowlist)
    audit = AuditLog(args.audit_log, args.sandbox_id)
    upstream = UpstreamProxy(args.upstream_proxy, parse_allow_classes(args.upstream_proxy_allow)) \
        if args.upstream_proxy else None
    ca = upstream_tls = None
    if any(r.git for r in rules):
        if not args.tls_state_dir or not args.ca_public_dir:
            raise SystemExit("egress-proxy: reguly 'git' wymagaja --tls-state-dir i --ca-public-dir")
        loop = asyncio.get_running_loop()
        ca = await loop.run_in_executor(None, SandboxCA, args.tls_state_dir,
                                        args.ca_public_dir, args.sandbox_id)
        upstream_tls = ssl.create_default_context(cafile=args.upstream_ca) if args.upstream_ca \
            else ssl.create_default_context()
        upstream_tls.set_alpn_protocols(["http/1.1"])
    if args.dns_ports_out:
        ports = sorted({r.port for r in rules if not is_ip_literal(r.host)})
        with open(args.dns_ports_out, "w") as f:
            f.write("".join(f"{p}\n" for p in ports))
    proxy = EgressProxy(rules, audit, upstream=upstream, ca=ca, upstream_tls=upstream_tls,
                        dns_stub=args.dns_stub)

    if os.path.exists(args.listen_unix):
        os.unlink(args.listen_unix)
    server = await asyncio.start_unix_server(proxy.handle, path=args.listen_unix)
    os.chmod(args.listen_unix, 0o660)
    audit.write(event="proxy_start", pid=os.getpid(), listen=args.listen_unix,
                rules=[r.render() for r in rules],
                upstream_proxy=upstream.label() if upstream else None,
                upstream_proxy_allow=sorted(upstream.allow) if upstream else None,
                git_tls=ca is not None, upstream_ca=args.upstream_ca, dns_stub=args.dns_stub)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    async with server:
        await stop.wait()
    audit.write(event="proxy_stop", pid=os.getpid())
    try:
        os.unlink(args.listen_unix)
    except FileNotFoundError:
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--listen-unix", required=True, help="sciezka unix socketu proxy")
    ap.add_argument("--allowlist", required=True, help="plik allowlisty")
    ap.add_argument("--audit-log", required=True, help="plik audytu (JSON lines, dopisywany)")
    ap.add_argument("--sandbox-id", default="unknown")
    ap.add_argument("--upstream-proxy", help="http://host:port proxy nadrzednego (bez uwierzytelniania)")
    ap.add_argument("--upstream-proxy-allow", help="klasy adresow dopuszczone dla proxy nadrzednego: "
                    "loopback,private (domyslnie zadne: proxy musi miec adres publiczny)")
    ap.add_argument("--upstream-ca", help="plik CA do weryfikacji forge w trybie git "
                    "(domyslnie systemowe CA)")
    ap.add_argument("--tls-state-dir", help="prywatny katalog na klucz CA sandboksa (poza sandboksem)")
    ap.add_argument("--ca-public-dir", help="katalog widoczny w sandboksie: sandbox-ca.crt, ca-bundle.crt")
    ap.add_argument("--dns-stub", action="store_true", help="obsluguj zapytania stub DNS z mostu")
    ap.add_argument("--dns-ports-out", help="zapisz porty z allowlisty (dla przechwytywania w moscie)")
    args = ap.parse_args()
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
