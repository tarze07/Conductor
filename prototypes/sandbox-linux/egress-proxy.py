#!/usr/bin/env python3
"""Egress Guard (prototyp): proxy HTTP CONNECT z allowlista hostow i audytem JSON lines.

Proxy dziala POZA sandboksem. Sandbox nie ma zadnego interfejsu sieciowego poza
wlasnym loopbackiem; jedyna droga na zewnatrz to unix socket tego proxy,
zamontowany do sandboksa (patrz run-sandboxed.sh i sandbox-bridge.py).

Zasady:
  * tylko metoda CONNECT (inne -> 405, zalogowane),
  * cel musi pasowac do allowlisty (host:port, opcjonalnie wildcard "*.domena"),
  * literaly IP sa odrzucane, chyba ze sa jawnie na allowliscie,
  * DNS rozwiazuje proxy, nie sandbox (sandbox nie ma resolvera),
  * po "200 Connection established" proxy czyta pierwszy rekord od klienta;
    jesli to TLS ClientHello, SNI musi byc rowne hostowi z CONNECT
    (ochrona przed domain fronting / tunelowaniem pod cudzym SNI),
  * ruch nie-TLS jest dozwolony tylko dla wpisow oznaczonych "plaintext",
  * kazda proba (dozwolona i odrzucona) trafia do audytu jako jedna linia JSON.

Format allowlisty (jedna regula na linie, '#' = komentarz):
    llm-gateway.corp.example:443
    *.git.corp.example:443
    localhost:18080 plaintext
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import fnmatch
import ipaddress
import json
import os
import signal
import socket
import struct
import sys
import time
import uuid

MAX_HEADER = 8192
HEADER_TIMEOUT = 10.0
FIRST_RECORD_TIMEOUT = 10.0
CONNECT_TIMEOUT = 10.0


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
    def __init__(self, host: str, port: int, plaintext: bool):
        self.host = host
        self.port = port
        self.plaintext = plaintext

    def matches(self, host: str, port: int) -> bool:
        if port != self.port:
            return False
        if self.host.startswith("*."):
            # "*.corp.example" pasuje do "a.corp.example", nie do "corp.example".
            return fnmatch.fnmatchcase(host, self.host) and host.count(".") >= self.host.count(".")
        return host == self.host


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
            unknown = opts - {"plaintext"}
            if unknown:
                raise SystemExit(f"{path}:{lineno}: nieznane opcje {sorted(unknown)}")
            host, port = split_authority(target, default_port=443)
            if host is None:
                raise SystemExit(f"{path}:{lineno}: niepoprawny wpis {target!r}")
            rules.append(Rule(host, port, "plaintext" in opts))
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


# --------------------------------------------------------------------------- proxy

class EgressProxy:
    def __init__(self, rules: list[Rule], audit: AuditLog):
        self.rules = rules
        self.audit = audit

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
        elif not rule.plaintext:
            await deny("", "plaintext_not_allowed")
            return

        try:
            up_reader, up_writer = await asyncio.wait_for(
                asyncio.open_connection(host, port), CONNECT_TIMEOUT)
        except (OSError, asyncio.TimeoutError) as e:
            await deny("", "upstream_connect_failed", error=type(e).__name__)
            return

        resolved = None
        try:
            resolved = up_writer.get_extra_info("peername")[0]
        except (TypeError, IndexError):
            pass
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


async def main_async(args):
    rules = load_allowlist(args.allowlist)
    audit = AuditLog(args.audit_log, args.sandbox_id)
    proxy = EgressProxy(rules, audit)

    if os.path.exists(args.listen_unix):
        os.unlink(args.listen_unix)
    server = await asyncio.start_unix_server(proxy.handle, path=args.listen_unix)
    os.chmod(args.listen_unix, 0o660)
    audit.write(event="proxy_start", pid=os.getpid(), listen=args.listen_unix,
                rules=[f"{r.host}:{r.port}{' plaintext' if r.plaintext else ''}" for r in rules])

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
    args = ap.parse_args()
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
