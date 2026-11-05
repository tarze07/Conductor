#!/usr/bin/env python3
"""Most wewnatrz sandboksa: 127.0.0.1:<port> (TCP) -> unix socket Egress Guard.

Sandbox ma wylacznie wlasny loopback, wiec narzedzia (curl, git, npm, pip),
ktore oczekuja proxy HTTP pod adresem TCP, lacza sie z tym mostem. Most nie
podejmuje zadnych decyzji: przepisuje bajty do unix socketu proxy, ktore
dziala poza sandboksem. Zabicie mostu przez agenta odcina tylko jego samego.
"""

import argparse
import asyncio
import sys


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


async def main(listen_host, listen_port, unix_path):
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

    server = await asyncio.start_server(handle, listen_host, listen_port)
    # Sygnal gotowosci dla sandbox-init (bez probnego polaczenia, ktore trafiloby do audytu).
    print("ready", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", default="127.0.0.1:3128")
    ap.add_argument("--unix", required=True)
    a = ap.parse_args()
    host, port = a.listen.rsplit(":", 1)
    try:
        asyncio.run(main(host, int(port), a.unix))
    except KeyboardInterrupt:
        sys.exit(0)
