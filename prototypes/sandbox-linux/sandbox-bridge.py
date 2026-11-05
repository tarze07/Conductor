#!/usr/bin/env python3
"""Most wewnatrz sandboksa: 127.0.0.1:<port> (TCP) -> unix socket Egress Guard.

Sandbox ma wylacznie wlasny loopback, wiec narzedzia (curl, git, npm, pip),
ktore oczekuja proxy HTTP pod adresem TCP, lacza sie z tym mostem. Most nie
podejmuje zadnych decyzji: przepisuje bajty do unix socketu proxy, ktore
dziala poza sandboksem. Zabicie mostu przez agenta odcina tylko jego samego.

Tryb stub DNS (--dns-udp-fd/--dns-tcp-fd, gniazda otwiera sandbox-init.py,
bo port 53 wymaga uprawnien, ktorych most juz nie ma):
  * resolver UDP/TCP na 127.0.0.1:53; kazde zapytanie idzie do Egress Guard
    (metoda X-CONDUCTOR-DNS), ktory decyduje na podstawie allowlisty i zapisuje
    je w audycie POZA sandboksem,
  * nazwa z allowlisty dostaje fikcyjny adres z 127.77.0.0/16 (A), AAAA i inne
    typy dostaja pusta odpowiedz; pozostale nazwy NXDOMAIN,
  * zapytania NIGDY nie sa przekazywane do zadnego resolvera,
  * przechwytywanie: most slucha na 0.0.0.0:<port> dla portow z allowlisty
    (--intercept PORT=FD); polaczenie na fikcyjny adres jest zamieniane na
    CONNECT <nazwa>:<port> do Egress Guard, ktory stosuje wszystkie zwykle reguly.
"""

import argparse
import asyncio
import ipaddress
import socket
import struct
import sys

FAKE_NET = ipaddress.ip_network("127.77.0.0/16")
FAKE_MAX = 4096          # ile roznych nazw moze dostac adres w jednym sandboksie
DNS_TTL = 5
GUARD_TIMEOUT = 5.0
QTYPES = {1: "A", 28: "AAAA", 5: "CNAME", 15: "MX", 16: "TXT", 33: "SRV", 65: "HTTPS", 255: "ANY"}
NAME_CHARS = set(b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")


async def pipe(src, dst):
    try:
        while True:
            data = await src.read(65536)
            if not data:
                break
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


# ------------------------------------------------------------------------ stub DNS

class FakeAddresses:
    def __init__(self):
        self.by_name = {}
        self.by_addr = {}

    def assign(self, name):
        if name not in self.by_name:
            if len(self.by_name) >= FAKE_MAX:
                return None
            addr = str(FAKE_NET.network_address + len(self.by_name) + 1)
            self.by_name[name] = addr
            self.by_addr[addr] = name
        return self.by_name[name]


def parse_query(data):
    """(id, flags, nazwa, qtype, qclass, sekcja_pytania) albo None."""
    if len(data) < 12:
        return None
    qid, flags, qd, _an, _ns, _ar = struct.unpack("!6H", data[:12])
    if flags & 0x8000 or qd != 1:
        return None
    p, labels = 12, []
    while True:
        if p >= len(data):
            return None
        n = data[p]
        p += 1
        if n == 0:
            break
        if n & 0xC0 or p + n > len(data):
            return None
        labels.append(data[p:p + n])
        p += n
    if p + 4 > len(data):
        return None
    qtype, qclass = struct.unpack("!HH", data[p:p + 4])
    # Nazwa w formie prezentacyjnej; bajty spoza [A-Za-z0-9-_] jako \DDD (bez spacji).
    name = ".".join("".join(chr(b) if b in NAME_CHARS else f"\\{b:03d}" for b in lab)
                    for lab in labels).lower()
    return qid, flags, name, qtype, qclass, data[12:p + 4]


def build_response(qid, flags, question, rcode, answer_addr=None):
    out_flags = 0x8000 | (flags & 0x7800) | 0x0400 | (flags & 0x0100) | rcode
    an = 1 if answer_addr else 0
    msg = struct.pack("!6H", qid, out_flags, 1, an, 0, 0) + question
    if answer_addr:
        msg += b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, DNS_TTL, 4) + socket.inet_aton(answer_addr)
    return msg


class DnsStub:
    def __init__(self, unix_path):
        self.unix_path = unix_path
        self.fake = FakeAddresses()

    async def ask_guard(self, name, qtype):
        """True/False wg Egress Guard; None, gdy proxy jest nieosiagalne."""
        try:
            r, w = await asyncio.open_unix_connection(self.unix_path)
        except OSError:
            return None
        try:
            w.write(f"X-CONDUCTOR-DNS {name or '.'} HTTP/1.1\r\nX-Qtype: {qtype}\r\n\r\n".encode())
            await w.drain()
            head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), GUARD_TIMEOUT)
            return head.split(b"\r\n", 1)[0].split()[1:2] == [b"200"]
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError,
                ConnectionError, OSError, IndexError):
            return None
        finally:
            w.close()

    async def answer(self, data):
        q = parse_query(data)
        if q is None:
            return None
        qid, flags, name, qtype, qclass, question = q
        if (flags >> 11) & 0xF != 0:  # tylko standardowe QUERY
            return build_response(qid, flags, question, 4)  # NOTIMP
        allowed = await self.ask_guard(name, QTYPES.get(qtype, f"TYPE{qtype}"))
        if allowed is None:
            return build_response(qid, flags, question, 2)  # SERVFAIL
        if not allowed:
            return build_response(qid, flags, question, 3)  # NXDOMAIN
        if qtype == 1 and qclass == 1:
            addr = self.fake.assign(name)
            if addr is None:
                return build_response(qid, flags, question, 5)  # REFUSED: pula wyczerpana
            return build_response(qid, flags, question, 0, addr)
        return build_response(qid, flags, question, 0)  # NODATA (np. AAAA)

    async def serve_tcp(self, reader, writer):
        try:
            while True:
                hdr = await reader.readexactly(2)
                (n,) = struct.unpack("!H", hdr)
                resp = await self.answer(await reader.readexactly(n))
                if resp is None:
                    break
                writer.write(struct.pack("!H", len(resp)) + resp)
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        writer.close()

    async def intercept(self, reader, writer):
        """Polaczenie na fikcyjny adres -> CONNECT <nazwa>:<port> do Egress Guard."""
        try:
            addr, port = writer.get_extra_info("sockname")[:2]
        except (TypeError, ValueError):
            writer.close()
            return
        name = self.fake.by_addr.get(addr)
        if name is None:
            writer.close()
            return
        try:
            up_r, up_w = await asyncio.open_unix_connection(self.unix_path)
            up_w.write(f"CONNECT {name}:{port} HTTP/1.1\r\nHost: {name}:{port}\r\n\r\n".encode())
            await up_w.drain()
            head = await asyncio.wait_for(up_r.readuntil(b"\r\n\r\n"), GUARD_TIMEOUT * 4)
        except (OSError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError):
            writer.close()
            return
        if head.split(b"\r\n", 1)[0].split()[1:2] != [b"200"]:
            writer.close()
            up_w.close()
            return
        await asyncio.gather(pipe(reader, up_w), pipe(up_r, writer))
        writer.close()
        up_w.close()


class UdpProto(asyncio.DatagramProtocol):
    def __init__(self, stub):
        self.stub = stub
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        async def reply():
            resp = await self.stub.answer(data)
            if resp is not None:
                self.transport.sendto(resp, addr)  # zawsze < 512 B (jedno pytanie, max jedna odpowiedz A)
        asyncio.ensure_future(reply())


# ---------------------------------------------------------------------------- main

async def main(listen_host, listen_port, unix_path, dns_udp_fd=None, dns_tcp_fd=None, intercept=()):
    async def handle(reader, writer):
        try:
            up_reader, up_writer = await asyncio.open_unix_connection(unix_path)
        except OSError:
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            writer.close()
            return
        await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))
        writer.close()
        up_writer.close()

    servers = [await asyncio.start_server(handle, listen_host, listen_port)]
    if dns_udp_fd is not None:
        stub = DnsStub(unix_path)
        loop = asyncio.get_running_loop()
        await loop.create_datagram_endpoint(
            lambda: UdpProto(stub), sock=socket.socket(fileno=dns_udp_fd))
        servers.append(await asyncio.start_server(stub.serve_tcp, sock=socket.socket(fileno=dns_tcp_fd)))
        for fd in intercept:
            servers.append(await asyncio.start_server(stub.intercept, sock=socket.socket(fileno=fd)))
    # Sygnal gotowosci dla sandbox-init (bez probnego polaczenia, ktore trafiloby do audytu).
    print("ready", flush=True)
    await asyncio.gather(*(s.serve_forever() for s in servers))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", default="127.0.0.1:3128")
    ap.add_argument("--unix", required=True)
    ap.add_argument("--dns-udp-fd", type=int)
    ap.add_argument("--dns-tcp-fd", type=int)
    ap.add_argument("--intercept-fd", type=int, action="append", default=[],
                    help="nasluchujace gniazdo TCP do przechwytywania (fikcyjne adresy)")
    a = ap.parse_args()
    if (a.dns_udp_fd is None) != (a.dns_tcp_fd is None):
        ap.error("--dns-udp-fd i --dns-tcp-fd podaje sie razem")
    host, port = a.listen.rsplit(":", 1)
    try:
        asyncio.run(main(host, int(port), a.unix, a.dns_udp_fd, a.dns_tcp_fd, a.intercept_fd))
    except KeyboardInterrupt:
        sys.exit(0)
