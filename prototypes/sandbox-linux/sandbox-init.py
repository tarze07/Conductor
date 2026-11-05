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
  5. uruchamia komende agenta BEZ zadnych capabilities, z no_new_privs
     i filtrem seccomp (denylista, patrz sekcja "seccomp"),
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

def setup_fs(newroot: str, worktree: str, bin_src: str, egress_src: str,
             mounts: list[tuple[str, str]], etc_mode: str, etc_entries: list[str]) -> None:
    mount(None, "/", None, MS_REC | MS_PRIVATE)
    os.makedirs(newroot, exist_ok=True)
    mount("tmpfs", newroot, "tmpfs", MS_NOSUID | MS_NODEV, "mode=0755,size=64m")
    R = lambda p: newroot + p

    # Toolchain i konfiguracja systemowa: tylko do odczytu.
    bind("/usr", R("/usr"), readonly=True)
    if etc_mode == "full":
        bind("/etc", R("/etc"), readonly=True)
    else:
        # Minimalny /etc: tylko wybrane wpisy (lista w run-sandboxed.sh).
        os.makedirs(R("/etc"))
        for e in etc_entries:
            src = "/etc/" + e
            if os.path.lexists(src) and not os.path.islink(src):
                bind(src, R(src), readonly=True)
            elif os.path.islink(src):
                os.symlink(os.readlink(src), R(src))
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
    # Dodatkowe montowania w podanej kolejnosci (pozniejsze nadpisuja wczesniejsze),
    # np. metadane git worktree: .git repo (ro), objects/ i refs agenta (rw), plik .git (ro).
    for mode, path in mounts:
        bind(path, R(path), readonly=(mode == "ro"))

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
    if apply_seccomp() != 0:  # filtr seccomp (issue #15): zawsze po no_new_privs
        os.write(2, b"sandbox-init: nie mozna zainstalowac filtra seccomp\n")
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


# ---------------------------------------------------------------------- seccomp
#
# Filtr seccomp-bpf (issue #15) instalowany w procesie potomnym tuz przed exec mostu
# i komendy agenta, po no_new_privs. Model: denylista (domyslnie ALLOW), bo agent
# uruchamia dowolne toolchainy (kompilatory, JVM, node, przegladarki testowe), ktorych
# zbioru syscalli nie znamy z gory; allowlista lamalaby je przy kazdej nowej wersji
# libc/jadra. Blokujemy syscalle, ktore daja nowa powierzchnie ataku na jadro albo
# omijaja izolacje (namespace'y, mounty, debugowanie innych procesow, BPF, keyring,
# io_uring, rodziny socketow poza IP i unix). Pelne uzasadnienie: ADR-002 i README.
#
# Numery syscalli z naglowkow jadra 6.8 (Linux UAPI): x86_64 z asm/unistd_64.h,
# aarch64 z asm-generic/unistd.h. test-hardening.sh porownuje je z naglowkami.

SECCOMP_ARCH = {"x86_64": 0xC000003E, "aarch64": 0xC00000B7}  # AUDIT_ARCH_*
X32_SYSCALL_BIT = 0x40000000

# Syscalle odrzucane bezwarunkowo z EPERM.
SECCOMP_DENY = {
    "x86_64": {
        "ptrace": 101, "process_vm_readv": 310, "process_vm_writev": 311, "pidfd_getfd": 438,
        "bpf": 321, "perf_event_open": 298, "userfaultfd": 323,
        "keyctl": 250, "add_key": 248, "request_key": 249,
        "kexec_load": 246, "kexec_file_load": 320,
        "init_module": 175, "finit_module": 313, "delete_module": 176,
        "mount": 165, "umount2": 166, "pivot_root": 155, "move_mount": 429, "open_tree": 428,
        "fsopen": 430, "fsconfig": 431, "fsmount": 432, "fspick": 433, "mount_setattr": 442,
        "unshare": 272, "setns": 308,
        "io_uring_setup": 425, "io_uring_enter": 426, "io_uring_register": 427,
        "swapon": 167, "swapoff": 168, "reboot": 169, "acct": 163,
        "quotactl": 179, "quotactl_fd": 443,
        "name_to_handle_at": 303, "open_by_handle_at": 304,
        "syslog": 103, "iopl": 172, "ioperm": 173, "uselib": 134,
    },
    "aarch64": {
        "ptrace": 117, "process_vm_readv": 270, "process_vm_writev": 271, "pidfd_getfd": 438,
        "bpf": 280, "perf_event_open": 241, "userfaultfd": 282,
        "keyctl": 219, "add_key": 217, "request_key": 218,
        "kexec_load": 104, "kexec_file_load": 294,
        "init_module": 105, "finit_module": 273, "delete_module": 106,
        "mount": 40, "umount2": 39, "pivot_root": 41, "move_mount": 429, "open_tree": 428,
        "fsopen": 430, "fsconfig": 431, "fsmount": 432, "fspick": 433, "mount_setattr": 442,
        "unshare": 97, "setns": 268,
        "io_uring_setup": 425, "io_uring_enter": 426, "io_uring_register": 427,
        "swapon": 224, "swapoff": 225, "reboot": 142, "acct": 89,
        "quotactl": 60, "quotactl_fd": 443,
        "name_to_handle_at": 264, "open_by_handle_at": 265,
        "syslog": 116,
    },
}
# Syscalle filtrowane po argumencie albo z innym errno.
SECCOMP_SPECIAL = {
    "x86_64": {"clone": 56, "clone3": 435, "socket": 41, "personality": 135},
    "aarch64": {"clone": 220, "clone3": 435, "socket": 198, "personality": 92},
}
# clone(): wszystkie flagi CLONE_NEW* mieszczace sie w fladze clone() (bez CLONE_NEWTIME,
# ktora koliduje z CSIGNAL i jest dostepna tylko przez unshare/clone3, oba zablokowane).
CLONE_NEW_MASK = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000
SOCKET_FAMILIES_ALLOWED = (1, 2, 10)  # AF_UNIX, AF_INET, AF_INET6
# personality(): PER_LINUX, PER_LINUX32, UNAME26, UNAME26|PER_LINUX32, zapytanie (0xffffffff).
# Odrzucane m.in. ADDR_NO_RANDOMIZE (wylaczenie ASLR) i READ_IMPLIES_EXEC.
PERSONALITY_ALLOWED = (0x0, 0x8, 0x20000, 0x20008, 0xFFFFFFFF)

SECCOMP_RET_KILL_PROCESS = 0x80000000
SECCOMP_RET_ERRNO = 0x00050000
SECCOMP_RET_ALLOW = 0x7FFF0000
EPERM, ENOSYS = 1, 38
PR_SET_SECCOMP = 22
SECCOMP_MODE_FILTER = 2
# Klasyczne BPF: ld w abs, jeq k, jge k, jset k, ret k
BPF_LD_W_ABS, BPF_JEQ_K, BPF_JGE_K, BPF_JSET_K, BPF_RET_K = 0x20, 0x15, 0x35, 0x45, 0x06
SECCOMP_DATA_NR, SECCOMP_DATA_ARCH, SECCOMP_DATA_ARG0_LO = 0, 4, 16  # little-endian


class _SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_void_p)]


def build_seccomp_filter(machine: str) -> list[tuple[int, int, int, int]]:
    """Zwraca program BPF jako liste (code, jt, jf, k). Skoki do etykiet sa
    rozwiazywane na koncu (jt/jf to przesuniecia wzgledne, max 255)."""
    if machine not in SECCOMP_ARCH:
        raise SystemExit(f"seccomp: nieobslugiwana architektura: {machine}")
    special = SECCOMP_SPECIAL[machine]
    prog: list[list] = []      # [code, jt, jf, k]; jt/jf: int albo nazwa etykiety
    labels: dict[str, int] = {}

    def op(code, k=0, jt=0, jf=0):
        prog.append([code, jt, jf, k])

    def label(name):
        labels[name] = len(prog)

    op(BPF_LD_W_ABS, SECCOMP_DATA_ARCH)
    op(BPF_JEQ_K, SECCOMP_ARCH[machine], jt=0, jf="kill")   # inna ABI (np. i386 przez int 0x80)
    op(BPF_LD_W_ABS, SECCOMP_DATA_NR)
    if machine == "x86_64":
        op(BPF_JGE_K, X32_SYSCALL_BIT, jt="eperm", jf=0)    # ABI x32
    for nr in sorted(SECCOMP_DENY[machine].values()):
        op(BPF_JEQ_K, nr, jt="eperm", jf=0)
    op(BPF_JEQ_K, special["clone3"], jt="enosys", jf=0)     # libc spada na clone()
    op(BPF_JEQ_K, special["clone"], jt="clone", jf=0)
    op(BPF_JEQ_K, special["socket"], jt="socket", jf=0)
    op(BPF_JEQ_K, special["personality"], jt="personality", jf=0)
    op(BPF_RET_K, SECCOMP_RET_ALLOW)

    label("clone")
    op(BPF_LD_W_ABS, SECCOMP_DATA_ARG0_LO)
    op(BPF_JSET_K, CLONE_NEW_MASK, jt="eperm", jf="allow")
    label("socket")
    op(BPF_LD_W_ABS, SECCOMP_DATA_ARG0_LO)                  # int domain: jadro bierze 32 bity
    for fam in SOCKET_FAMILIES_ALLOWED:
        op(BPF_JEQ_K, fam, jt="allow", jf=0)
    op(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM)
    label("personality")
    op(BPF_LD_W_ABS, SECCOMP_DATA_ARG0_LO)                  # unsigned int persona
    for p in PERSONALITY_ALLOWED:
        op(BPF_JEQ_K, p, jt="allow", jf=0)
    op(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM)

    label("allow")
    op(BPF_RET_K, SECCOMP_RET_ALLOW)
    label("eperm")
    op(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM)
    label("enosys")
    op(BPF_RET_K, SECCOMP_RET_ERRNO | ENOSYS)
    label("kill")
    op(BPF_RET_K, SECCOMP_RET_KILL_PROCESS)

    out = []
    for i, (code, jt, jf, k) in enumerate(prog):
        jt = labels[jt] - i - 1 if isinstance(jt, str) else jt
        jf = labels[jf] - i - 1 if isinstance(jf, str) else jf
        if not (0 <= jt <= 255 and 0 <= jf <= 255):
            raise SystemExit("seccomp: skok poza zakresem BPF")
        out.append((code, jt, jf, k))
    return out


SECCOMP_FILTER = None  # (bufor, sock_fprog) przygotowane przed fork, uzywane w preexec_fn


def prepare_seccomp(machine: str | None = None) -> dict:
    """Buduje filtr dla biezacej architektury; zwraca opis do sandbox-status.json."""
    global SECCOMP_FILTER
    machine = machine or platform.machine()
    prog = build_seccomp_filter(machine)
    buf = ctypes.create_string_buffer(b"".join(struct.pack("=HBBI", *ins) for ins in prog))
    SECCOMP_FILTER = (buf, _SockFprog(len(prog), ctypes.addressof(buf)))
    return {"mode": "denylist", "arch": machine, "instructions": len(prog),
            "denied_syscalls": sorted(SECCOMP_DENY[machine]),
            "filtered": ["clone(CLONE_NEW*)", "clone3(ENOSYS)", "socket(family)",
                         "personality(persona)"]}


def apply_seccomp() -> int:
    """Instaluje przygotowany filtr w biezacym procesie (wymaga no_new_privs). 0 = OK."""
    if SECCOMP_FILTER is None:
        return -1
    return libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER,
                      ctypes.c_void_p(ctypes.addressof(SECCOMP_FILTER[1])), 0, 0)


def hardening_status(cgroup_status: str | None) -> dict:
    """Przygotowuje seccomp i zwraca wpisy "seccomp" i "cgroups" do sandbox-status.json."""
    try:
        cgroups = json.loads(cgroup_status) if cgroup_status else {"status": "unknown"}
    except ValueError:
        cgroups = {"status": "unknown", "raw": cgroup_status}
    return {"seccomp": prepare_seccomp(), "cgroups": cgroups}


# ------------------------------------------------------------------------- PID 1

def wait_main(main_pid: int) -> int:
    """Czeka na komende agenta. Jako PID 1 (backend unshare) zbiera tez osierocone
    procesy (zombie), ktore jadro przepina na init PID namespace'u."""
    reap_all = os.getpid() == 1
    while True:
        try:
            pid, status = os.waitpid(-1 if reap_all else main_pid, 0)
        except KeyboardInterrupt:
            continue
        except ChildProcessError:
            return 125
        if pid == main_pid:
            return os.waitstatus_to_exitcode(status)
        # inny proces (osierocony potomek albo most): po prostu zebrany


# ------------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", required=True, choices=["unshare", "bwrap"])
    ap.add_argument("--worktree", required=True)
    ap.add_argument("--newroot")
    ap.add_argument("--bin-src")
    ap.add_argument("--egress-src")
    ap.add_argument("--mount", action="append", default=[],
                    help="ro:PATH albo rw:PATH, w kolejnosci montowania")
    ap.add_argument("--etc", default="minimal", choices=["minimal", "full"])
    ap.add_argument("--etc-entry", action="append", default=[])
    ap.add_argument("--cgroup-status", help="JSON ze stanem cgroup od launchera")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd[:1] == ["--"] else a.cmd
    if not cmd:
        print("sandbox-init: brak komendy", file=sys.stderr)
        return 2

    mounts = []
    for m in a.mount:
        mode, _, path = m.partition(":")
        if mode not in ("ro", "rw") or not path.startswith("/"):
            print(f"sandbox-init: zle montowanie: {m}", file=sys.stderr)
            return 2
        mounts.append((mode, path))
    status = {"backend": a.backend, "etc": a.etc}
    if a.backend == "unshare":
        setup_fs(a.newroot, a.worktree, a.bin_src, a.egress_src, mounts, a.etc, a.etc_entry)
    status["loopback"] = "up" if loopback_up() else "down"
    status["nftables"] = apply_nft()
    status["interfaces"] = list_interfaces()
    status.update(hardening_status(a.cgroup_status))
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
    rc = wait_main(proc.pid)
    bridge.terminate()
    try:
        bridge.wait(timeout=2)
    except subprocess.TimeoutExpired:
        bridge.kill()
    return rc if rc >= 0 else 128 - rc


if __name__ == "__main__":
    sys.exit(main())
