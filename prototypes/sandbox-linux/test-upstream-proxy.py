#!/usr/bin/env python3
"""Udawane proxy nadrzedne (firmowe) do testow (issue #16).

Proxy CONNECT na TCP: przepuszcza tylko cele z --allow host:port, reszte odrzuca
z 403. Kazde zadanie trafia do --log jako linia JSON {"target", "decision"}.

  test-upstream-proxy.py --port-file F --log F --allow localhost:8080 [--listen 127.0.0.1:0]
"""

import argparse
import asyncio
import json
import os
import sys


async def pipe(src, dst):
    try:
        while data := await src.read(65536):
            dst.write(data)
            await dst.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            dst.write_eof()
        except (OSError, RuntimeError):
            pass


async def main(a):
    allow = set(a.allow)

    def log(**rec):
        with open(a.log, "a") as f:
            f.write(json.dumps(rec) + "\n")

    async def handle(reader, writer):
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError):
            writer.close()
            return
        parts = head.split(b"\r\n", 1)[0].decode("latin-1").split()
        target = parts[1] if len(parts) == 3 else "?"
        if len(parts) != 3 or parts[0] != "CONNECT" or target not in allow:
            log(target=target, decision="deny")
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        host, port = target.rsplit(":", 1)
        try:
            ur, uw = await asyncio.open_connection(host, int(port))
        except OSError:
            log(target=target, decision="error")
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            writer.close()
            return
        log(target=target, decision="allow")
        writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        await writer.drain()
        await asyncio.gather(pipe(reader, uw), pipe(ur, writer))
        writer.close()
        uw.close()

    host, port = a.listen.rsplit(":", 1)
    srv = await asyncio.start_server(handle, host, int(port))
    with open(a.port_file + ".tmp", "w") as f:
        f.write(str(srv.sockets[0].getsockname()[1]))
    os.replace(a.port_file + ".tmp", a.port_file)
    async with srv:
        await srv.serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", default="127.0.0.1:0")
    ap.add_argument("--port-file", required=True)
    ap.add_argument("--log", required=True)
    ap.add_argument("--allow", action="append", default=[])
    try:
        asyncio.run(main(ap.parse_args()))
    except KeyboardInterrupt:
        sys.exit(0)
