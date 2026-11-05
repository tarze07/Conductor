#!/usr/bin/env python3
"""Proces startowy sandboksa (PID 1 albo 2 w nowym PID namespace).

Uruchamiany przez run-sandboxed.sh juz WEWNATRZ nowych namespace'ow
(mount, net, pid, ipc, uts, opcjonalnie user). Kroki:

  1. (backend "unshare", --setup-fs) buduje nowy root na tmpfs:
     /usr, /etc i dodatkowe toolchainy read-only, worktree read-write,
     swiezy /proc, minimalny /dev, puste /tmp i /run; potem pivot_root
     i odmontowanie starego roota (host znika z widoku procesu).
     Backend "bwrap" robi to samo samodzielnie, wtedy ten krok jest pomijany.
  2. podnosi loopback (w swiezym netns jest DOWN) i, jesli sie da,
     instaluje regule nftables: wyjscie tylko przez lo (defense in depth),
  3. ustawia limity zasobow (rlimit),
  4. uruchamia sandbox-bridge.py (127.0.0.1:3128 -> unix socket proxy),
  5. uruchamia komende agenta BEZ zadnych capabilities i z no_new_privs,
     czeka na nia i zwraca jej kod wyjscia (konczac PID ns zabija reszte).
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import fcntl
import json
import os
import platform
import resource
import select
import shutil
import socket
import struct
import subprocess
import sys

RUN_DIR = "/run/conductor"
BIN_DIR = RUN_DIR + "/bin"
EGRESS_DIR = RUN_DIR + "/egress"
STATUS_FILE = RUN_DIR + "/sandbox-status.json"
BRIDGE_LISTEN = ("127.0.0.1", 3128)

libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)

MS_RDONLY = 1
MS_NOSUID = 2
MS_NODEV = 4
MS_NOEXEC = 8
MS_REMOUNT = 32
MS_NOATIME = 1024
MS_NODIRATIME = 2048
MS_BIND = 4096
MS_REC = 16384
MS_PRIVATE = 1 << 18
MS_RELATIME = 1 << 21
MNT_DETACH = 2

ST_TO_MS = {  # statvfs f_flag -> flagi mount(2), ktore trzeba zachowac przy remount
    1: MS_RDONLY, 2: MS_NOSUID, 4: MS_NODEV, 8: MS_NOEXEC,
    1024: MS_NOATIME, 2048: MS_NODIRATIME, 4096: MS_RELATIME,
}

SYS_PIVOT_ROOT = {"x86_64": 155, "aarch64": 41}
SYS_CAPSET = {"x86_64": 126, "aarch64": 91}
PR_SET_NO_NEW_PRIVS = 38
PR_CAPBSET_DROP = 24
PR_CAP_AMBIENT = 47
PR_CAP_AMBIENT_CLEAR_ALL = 4


def log(msg: str) -> None:
    if os.environ.get("CONDUCTOR_SANDBOX_DEBUG") == "1":
        print(f"[sandbox-init] {msg}", file=sys.stderr, flush=True)


def check(rc: int, what: str) -> None:
    if rc != 0:
        e = ctypes.get_errno()
        raise OSError(e, f"{what}: {os.strerror(e)}")


def mount(src, tgt, fstype, flags, data=None) -> None:
    enc = lambda s: s.encode() if isinstance(s, str) else s
    check(libc.mount(enc(src), enc(tgt), enc(fstype), ctypes.c_ulong(flags), enc(data)),
          f"mount {src} -> {tgt}")


def bind(src: str, dst: str, readonly: bool, recursive: bool = True) -> None:
    if os.path.isdir(src):
        os.makedirs(dst, exist_ok=True)
    else:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if not os.path.exists(dst):
            open(dst, "a").close()
    mount(src, dst, None, MS_BIND | (MS_REC if recursive else 0))
    if readonly:
        keep = 0
        f = os.statvfs(dst).f_flag
        for st, ms in ST_TO_MS.items():
            if f & st:
                keep |= ms
        mount(None, dst, None, MS_BIND | MS_REMOUNT | MS_RDONLY | keep)


# ------------------------------------------------------------------ system plikow

def setup_fs(newroot: str, worktree: str, bin_src: str, egress_src: str, ro_paths: list[str]) -> None:
    mount(None, "/", None, MS_REC | MS_PRIVATE)
    os.makedirs(newroot, exist_ok=True)
    mount("tmpfs", newroot, "tmpfs", MS_NOSUID | MS_NODEV, "mode=0755,size=64m")
    R = lambda p: newroot + p

    # Toolchain i konfiguracja systemowa: tylko do odczytu.
    for p in ["/usr", "/etc"] + ro_paths:
        if os.path.exists(p):
            bind(p, R(p), readonly=True)
    # Merged-/usr: /bin, /lib, ... to zwykle symlinki; odtwarzamy je.
    for p in ["/bin", "/sbin", "/lib", "/lib64", "/lib32", "/libx32"]:
        if os.path.islink(p):
            os.symlink(os.readlink(p), R(p))
        elif os.path.isdir(p):
            bind(p, R(p), readonly=True)

    # Swiezy /proc dla nowego PID namespace (widac tylko procesy sandboksa).
    os.makedirs(R("/proc"))
    mount("proc", R("/proc"), "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC)

    # Minimalny /dev: tylko bezpieczne urzadzenia znakowe.
    os.makedirs(R("/dev"))
    mount("tmpfs", R("/dev"), "tmpfs", MS_NOSUID | MS_NOEXEC, "mode=0755,size=1m")
    for d in ["null", "zero", "full", "random", "urandom", "tty"]:
        if os.path.exists("/dev/" + d):
            bind("/dev/" + d, R("/dev/" + d), readonly=False, recursive=False)
    os.makedirs(R("/dev/pts"))
    try:  # wlasna instancja devpts: agenci CLI potrafia otwierac nowe PTY
        mount("devpts", R("/dev/pts"), "devpts", MS_NOSUID | MS_NOEXEC, "newinstance,ptmxmode=0666,mode=0620")
        os.symlink("pts/ptmx", R("/dev/ptmx"))
    except OSError as e:
        log(f"devpts pominiety: {e}")
    os.makedirs(R("/dev/shm"))
    mount("tmpfs", R("/dev/shm"), "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777,size=64m")
    for name, target in [("fd", "/proc/self/fd"), ("stdin", "/proc/self/fd/0"),
                         ("stdout", "/proc/self/fd/1"), ("stderr", "/proc/self/fd/2")]:
        os.symlink(target, R("/dev/" + name))

    # Puste, prywatne /tmp i /run: zadnych socketow hosta (docker.sock, ssh-agent, dbus).
    for p, mode in [("/tmp", "1777"), ("/run", "0755")]:
        os.makedirs(R(p), exist_ok=True)
        mount("tmpfs", R(p), "tmpfs", MS_NOSUID | MS_NODEV, f"mode={mode},size=256m")

    bind(bin_src, R(BIN_DIR), readonly=True)
    bind(egress_src, R(EGRESS_DIR), readonly=False)
    # Worktree jako jedyne miejsce zapisu trwalego. Sciezka taka sama jak na hoscie.
    bind(worktree, R(worktree), readonly=False)

    # Root nowego drzewa tylko do odczytu (zapisywalne zostaja tylko jawne mounty).
    mount(None, newroot, None, MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV)

    os.chdir(newroot)
    nr = SYS_PIVOT_ROOT.get(platform.machine())
    if nr is None:
        raise SystemExit(f"nieobslugiwana architektura: {platform.machine()}")
    check(libc.syscall(nr, b".", b"."), "pivot_root")
    check(libc.umount2(b".", MNT_DETACH), "umount starego roota")
    os.chdir("/")


# ------------------------------------------------------------------------- siec

def loopback_up() -> bool:
    SIOCGIFFLAGS, SIOCSIFFLAGS, IFF_UP = 0x8913, 0x8914, 0x1
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        ifr = struct.pack("16sH22x", b"lo", 0)
        flags = struct.unpack("16sH22x", fcntl.ioctl(s, SIOCGIFFLAGS, ifr))[1]
        if flags & IFF_UP:
            return True
        fcntl.ioctl(s, SIOCSIFFLAGS, struct.pack("16sH22x", b"lo", flags | IFF_UP))
        return True


NFT_RULES = """
table inet conductor_sandbox {
  chain output {
    type filter hook output priority 0; policy drop;
    oifname "lo" accept
    counter comment "drop: ruch poza loopback"
  }
  chain input {
    type filter hook input priority 0; policy drop;
    iifname "lo" accept
  }
}
"""


def apply_nft() -> str:
    nft = shutil.which("nft") or ("/usr/sbin/nft" if os.path.exists("/usr/sbin/nft") else None)
    if not nft:
        return "skipped: nft not found"
    r = subprocess.run([nft, "-f", "-"], input=NFT_RULES, text=True, capture_output=True)
    if r.returncode != 0:
        return "skipped: " + (r.stderr.strip().splitlines() or ["error"])[0]
    return "applied"


def list_interfaces() -> list[str]:
    try:
        return sorted(os.listdir("/sys/class/net"))
    except OSError:
        return [name for _, name in socket.if_nameindex()]


# ------------------------------------------------------------------ uprawnienia

def drop_privileges() -> None:
    """preexec_fn: zero capabilities, pusty bounding set, no_new_privs."""
    for cap in range(64):
        libc.prctl(PR_CAPBSET_DROP, cap, 0, 0, 0)  # EINVAL dla nieistniejacych - ignorujemy
    libc.prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)
    nr = SYS_CAPSET[platform.machine()]
    header = (ctypes.c_uint32 * 2)(0x20080522, 0)  # _LINUX_CAPABILITY_VERSION_3, pid 0
    data = (ctypes.c_uint32 * 6)()                 # 2 x {effective, permitted, inheritable} = 0
    if libc.syscall(nr, header, data) != 0:
        os._exit(126)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        os._exit(126)


def set_limits() -> None:
    def lower(res, value):
        soft, hard = resource.getrlimit(res)
        new = value if hard == resource.RLIM_INFINITY else min(value, hard)
        resource.setrlimit(res, (new, new))
    lower(resource.RLIMIT_CORE, 0)
    lower(resource.RLIMIT_NOFILE, int(os.environ.get("SANDBOX_NOFILE", "4096")))
    if os.environ.get("SANDBOX_NPROC"):
        lower(resource.RLIMIT_NPROC, int(os.environ["SANDBOX_NPROC"]))


# ------------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", required=True, choices=["unshare", "bwrap"])
    ap.add_argument("--worktree", required=True)
    ap.add_argument("--newroot")
    ap.add_argument("--bin-src")
    ap.add_argument("--egress-src")
    ap.add_argument("--ro-path", action="append", default=[])
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd[:1] == ["--"] else a.cmd
    if not cmd:
        print("sandbox-init: brak komendy", file=sys.stderr)
        return 2

    status = {"backend": a.backend}
    if a.backend == "unshare":
        setup_fs(a.newroot, a.worktree, a.bin_src, a.egress_src, a.ro_path)
    status["loopback"] = "up" if loopback_up() else "down"
    status["nftables"] = apply_nft()
    status["interfaces"] = list_interfaces()
    os.makedirs(RUN_DIR, exist_ok=True)
    with open(STATUS_FILE, "w") as f:
        json.dump(status, f)
    log(json.dumps(status))
    set_limits()

    py = sys.executable or "/usr/bin/python3"
    bridge = subprocess.Popen(
        [py, "-I", BIN_DIR + "/sandbox-bridge.py", "--listen", "%s:%d" % BRIDGE_LISTEN,
         "--unix", EGRESS_DIR + "/egress.sock"],
        preexec_fn=drop_privileges, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, close_fds=True)
    ready, _, _ = select.select([bridge.stdout], [], [], 5.0)
    if not ready or bridge.stdout.readline().strip() != b"ready":
        print("sandbox-init: most do proxy nie wystartowal", file=sys.stderr)
        bridge.kill()
        return 125

    os.chdir(a.worktree)
    try:
        proc = subprocess.Popen(cmd, preexec_fn=drop_privileges, close_fds=True)
    except OSError as e:
        print(f"sandbox-init: nie mozna uruchomic {cmd[0]}: {e}", file=sys.stderr)
        bridge.terminate()
        return 127
    while True:
        try:
            rc = proc.wait()
            break
        except KeyboardInterrupt:
            continue
    bridge.terminate()
    try:
        bridge.wait(timeout=2)
    except subprocess.TimeoutExpired:
        bridge.kill()
    return rc if rc >= 0 else 128 - rc


if __name__ == "__main__":
    sys.exit(main())
