#!/usr/bin/env python3
"""Udawany forge do testow (issue #16): HTTPS + `git http-backend` (smart HTTP).

Uzywany przez test-egress.sh i crates/conductord/tests/sandbox.rs. Kazde zadanie
HTTP jest dopisywane do --log jako linia JSON {"method", "path"}, wiec test moze
sprawdzic, ze push (git-receive-pack) w ogole nie dotarl do forge.

  test-forge.py --gen-certs DIR --hostname forge.corp.test   # CA + certyfikat serwera
  test-forge.py --certs DIR --repos DIR --port-file F --log F [--listen 127.0.0.1:0]

Tylko do testow: brak uwierzytelniania, jeden proces, http-backend przez subprocess.
"""

import argparse
import http.server
import json
import os
import shutil
import ssl
import subprocess
import sys
import threading


def gen_certs(d, hostname):
    openssl = shutil.which("openssl")
    if not openssl:
        sys.exit("test-forge: brak openssl")
    os.makedirs(d, exist_ok=True)

    def run(*a):
        subprocess.run([openssl, *a], check=True, capture_output=True)
    run("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-keyout", f"{d}/ca.key", "-out", f"{d}/ca.crt", "-days", "2", "-subj", "/CN=Test forge CA",
        "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign")
    run("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", f"{d}/server.key")
    run("req", "-new", "-key", f"{d}/server.key", "-subj", f"/CN={hostname}", "-out", f"{d}/server.csr")
    with open(f"{d}/server.ext", "w") as f:
        f.write(f"subjectAltName=DNS:{hostname},IP:127.0.0.1\nextendedKeyUsage=serverAuth\n")
    run("x509", "-req", "-in", f"{d}/server.csr", "-CA", f"{d}/ca.crt", "-CAkey", f"{d}/ca.key",
        "-set_serial", "1", "-days", "2", "-extfile", f"{d}/server.ext", "-out", f"{d}/server.crt")


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    repos = "."
    log_path = None
    lock = threading.Lock()

    def log_message(self, *a):
        pass

    def body(self):
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            out = b""
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip(), 16)
                if size == 0:
                    while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                        pass
                    return out
                out += self.rfile.read(size)
                self.rfile.readline()
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def handle_any(self):
        with self.lock, open(self.log_path, "a") as f:
            f.write(json.dumps({"method": self.command, "path": self.path}) + "\n")
        path, _, query = self.path.partition("?")
        data = self.body()
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "GIT_PROJECT_ROOT": self.repos, "GIT_HTTP_EXPORT_ALL": "1",
            "REQUEST_METHOD": self.command, "PATH_INFO": path, "QUERY_STRING": query,
            "CONTENT_TYPE": self.headers.get("Content-Type", ""),
            "CONTENT_LENGTH": str(len(data)), "REMOTE_ADDR": "127.0.0.1",
            "GATEWAY_INTERFACE": "CGI/1.1", "SERVER_PROTOCOL": "HTTP/1.1",
        }
        for h in ("Git-Protocol", "Content-Encoding"):
            if self.headers.get(h):
                env["HTTP_" + h.upper().replace("-", "_")] = self.headers[h]
        r = subprocess.run(["git", "http-backend"], input=data, env=env, capture_output=True)
        out = r.stdout
        sep = out.find(b"\r\n\r\n")
        sep_len = 4
        if sep < 0:
            sep, sep_len = out.find(b"\n\n"), 2
        head, payload = (out[:sep], out[sep + sep_len:]) if sep >= 0 else (b"", out)
        status, headers = 200, []
        for line in head.decode("latin-1").splitlines():
            k, _, v = line.partition(":")
            if k.lower() == "status":
                status = int(v.strip().split()[0])
            elif k:
                headers.append((k, v.strip()))
        if r.returncode != 0 and not head:
            status, payload = 500, r.stderr
        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    do_GET = do_POST = handle_any


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gen-certs")
    ap.add_argument("--hostname", default="localhost")
    ap.add_argument("--certs")
    ap.add_argument("--repos")
    ap.add_argument("--port-file")
    ap.add_argument("--log")
    ap.add_argument("--listen", default="127.0.0.1:0")
    a = ap.parse_args()
    if a.gen_certs:
        gen_certs(a.gen_certs, a.hostname)
        return 0
    Handler.repos, Handler.log_path = os.path.abspath(a.repos), a.log
    host, port = a.listen.rsplit(":", 1)
    srv = http.server.ThreadingHTTPServer((host, int(port)), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(f"{a.certs}/server.crt", f"{a.certs}/server.key")
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    with open(a.port_file + ".tmp", "w") as f:
        f.write(str(srv.server_address[1]))
    os.replace(a.port_file + ".tmp", a.port_file)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
