//! Minimalne FFI do libc. JEDYNY moduł crate'a z `unsafe`.
//!
//! libc jest i tak linkowane przez std, więc deklarujemy tylko potrzebne symbole,
//! struktury i stałe. Wartości stałych są poprawne dla Linuksa na x86_64 i aarch64
//! (oba używają "generic" ABI dla ioctl/fcntl/sygnałów) z glibc. Na innych platformach
//! kompilacja jest przerywana, zamiast ryzykować złe stałe. Po migracji na crate
//! `libc`/`nix`/`portable-pty` ten moduł znika (patrz README).

#[cfg(not(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
)))]
compile_error!("conductord prototype supports only Linux x86_64/aarch64 (see README)");

use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::raw::{c_char, c_int, c_ulong, c_void};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

#[allow(non_camel_case_types)]
type pid_t = i32;
#[allow(non_camel_case_types)]
type uid_t = u32;
#[allow(non_camel_case_types)]
type gid_t = u32;
#[allow(non_camel_case_types)]
type socklen_t = u32;

/// `struct ucred` z `<sys/socket.h>` (Linux).
#[repr(C)]
#[derive(Default)]
struct Ucred {
    pid: pid_t,
    uid: uid_t,
    gid: gid_t,
}

/// `struct winsize` z `<sys/ioctl.h>`.
#[repr(C)]
struct Winsize {
    ws_row: u16,
    ws_col: u16,
    ws_xpixel: u16,
    ws_ypixel: u16,
}

/// `sigset_t` w glibc: 1024 bity (16 x unsigned long na 64-bit).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct SigSet {
    _val: [c_ulong; 16],
}

const SOL_SOCKET: c_int = 1;
const SO_PEERCRED: c_int = 17;
const O_RDWR: c_int = 0o2;
pub const O_NOCTTY: c_int = 0o400;
const O_CLOEXEC: c_int = 0o2_000_000;
const F_GETFD: c_int = 1;
const F_SETFD: c_int = 2;
const FD_CLOEXEC: c_int = 1;
const TIOCSCTTY: c_ulong = 0x540E;
const TIOCSWINSZ: c_ulong = 0x5414;
const SIG_BLOCK: c_int = 0;
const SIG_SETMASK: c_int = 2;
const ESRCH: i32 = 3;
/// `EIO`: odczyt z mastera PTY po zamknięciu wszystkich deskryptorów slave.
pub const EIO: i32 = 5;

pub const SIGHUP: i32 = 1;
pub const SIGINT: i32 = 2;
pub const SIGKILL: i32 = 9;
pub const SIGTERM: i32 = 15;

extern "C" {
    fn getsockopt(
        fd: c_int,
        level: c_int,
        name: c_int,
        val: *mut c_void,
        len: *mut socklen_t,
    ) -> c_int;
    fn geteuid() -> uid_t;
    fn posix_openpt(flags: c_int) -> c_int;
    fn grantpt(fd: c_int) -> c_int;
    fn unlockpt(fd: c_int) -> c_int;
    fn ptsname_r(fd: c_int, buf: *mut c_char, len: usize) -> c_int;
    fn fcntl(fd: c_int, cmd: c_int, ...) -> c_int;
    fn ioctl(fd: c_int, request: c_ulong, ...) -> c_int;
    fn setsid() -> pid_t;
    fn kill(pid: pid_t, sig: c_int) -> c_int;
    fn sigemptyset(set: *mut SigSet) -> c_int;
    fn sigaddset(set: *mut SigSet, sig: c_int) -> c_int;
    fn pthread_sigmask(how: c_int, set: *const SigSet, old: *mut SigSet) -> c_int;
    fn sigwait(set: *const SigSet, sig: *mut c_int) -> c_int;
}

fn cvt(r: c_int) -> io::Result<c_int> {
    if r == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(r)
    }
}

/// Efektywny UID daemona.
pub fn effective_uid() -> u32 {
    // SAFETY: geteuid nie ma warunków wstępnych i zawsze się udaje (POSIX).
    unsafe { geteuid() }
}

/// UID procesu po drugiej stronie połączonego socketu unix (`SO_PEERCRED`).
pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut cred = Ucred::default();
    let mut len = std::mem::size_of::<Ucred>() as socklen_t;
    // SAFETY: fd jest poprawnym, otwartym deskryptorem socketu (pożyczonym przez
    // `stream` na czas wywołania); `cred` to zainicjalizowany bufor o rozmiarze `len`
    // z układem `struct ucred`, którego jądro oczekuje dla SO_PEERCRED.
    let r = unsafe {
        getsockopt(
            stream.as_raw_fd(),
            SOL_SOCKET,
            SO_PEERCRED,
            (&mut cred as *mut Ucred).cast::<c_void>(),
            &mut len,
        )
    };
    cvt(r)?;
    if len as usize != std::mem::size_of::<Ucred>() {
        return Err(io::Error::other("SO_PEERCRED returned unexpected size"));
    }
    Ok(cred.uid)
}

/// Otwiera parę PTY. Zwraca master (z `O_CLOEXEC`) i ścieżkę urządzenia slave.
pub fn open_pty(rows: u16, cols: u16) -> io::Result<(File, PathBuf)> {
    // SAFETY: posix_openpt przyjmuje flagi i zwraca nowy deskryptor albo -1.
    // O_CLOEXEC jest przekazywane do open(2) przez glibc.
    let fd = cvt(unsafe { posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC) })?;
    // SAFETY: `fd` to świeżo otwarty deskryptor, którego nikt inny nie posiada;
    // File przejmuje go na własność i zamknie przy drop (także na ścieżkach błędu niżej).
    let master = unsafe { File::from_raw_fd(fd) };

    // Upewnij się, że CLOEXEC jest ustawione (na wypadek libc ignorującej flagę),
    // żeby master nie wyciekał do innych procesów potomnych.
    // SAFETY: F_GETFD/F_SETFD na poprawnym deskryptorze; trzeci argument to int.
    unsafe {
        let flags = cvt(fcntl(fd, F_GETFD))?;
        if flags & FD_CLOEXEC == 0 {
            cvt(fcntl(fd, F_SETFD, flags | FD_CLOEXEC))?;
        }
    }
    // SAFETY: grantpt/unlockpt na deskryptorze mastera PTY, wynik sprawdzany.
    cvt(unsafe { grantpt(fd) })?;
    // SAFETY: jak wyżej.
    cvt(unsafe { unlockpt(fd) })?;

    let mut buf = [0 as c_char; 128];
    // SAFETY: bufor ma `buf.len()` bajtów; ptsname_r zapisuje w nim string zakończony
    // NUL albo zwraca kod błędu (nie ustawia errno w sposób wymagany przez POSIX).
    let r = unsafe { ptsname_r(fd, buf.as_mut_ptr(), buf.len()) };
    if r != 0 {
        return Err(io::Error::from_raw_os_error(r));
    }
    // SAFETY: ptsname_r zwrócił 0, więc `buf` zawiera string zakończony NUL.
    let name = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr()) };
    let path = PathBuf::from(std::ffi::OsStr::new(
        std::str::from_utf8(name.to_bytes()).map_err(io::Error::other)?,
    ));

    let ws = Winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: TIOCSWINSZ czyta `struct winsize` spod przekazanego wskaźnika, który
    // wskazuje na poprawnie zainicjalizowaną strukturę żyjącą do końca wywołania.
    cvt(unsafe { ioctl(fd, TIOCSWINSZ, &ws as *const Winsize) })?;
    Ok((master, path))
}

fn empty_sigset() -> SigSet {
    let mut set = SigSet { _val: [0; 16] };
    // SAFETY: `set` to poprawnie wyrównany, zapisywalny sigset_t.
    unsafe { sigemptyset(&mut set) };
    set
}

/// Konfiguruje dziecko działające w PTY: nowa sesja (pgid = pid), slave jako terminal
/// sterujący, odblokowane sygnały. Wymaga, żeby stdin dziecka był slave PTY.
pub fn configure_pty_child(cmd: &mut Command) {
    let empty = empty_sigset();
    // SAFETY: closure wykonuje się w dziecku po fork() a przed exec(); wywołuje wyłącznie
    // funkcje async-signal-safe (setsid, ioctl, pthread_sigmask/sigprocmask), nie alokuje
    // i nie bierze blokad. `empty` jest skopiowane do closure przed forkiem.
    unsafe {
        cmd.pre_exec(move || {
            cvt(setsid())?;
            // std ustawił już fd 0 na slave PTY (dup2 przed pre_exec).
            cvt(ioctl(0, TIOCSCTTY, 0 as c_int))?;
            let r = pthread_sigmask(SIG_SETMASK, &empty, std::ptr::null_mut());
            if r != 0 {
                return Err(io::Error::from_raw_os_error(r));
            }
            Ok(())
        });
    }
}

/// Konfiguruje dziecko w trybie pipe: własna grupa procesów i odblokowane sygnały.
pub fn configure_pipe_child(cmd: &mut Command) {
    cmd.process_group(0);
    let empty = empty_sigset();
    // SAFETY: jak w `configure_pty_child`: tylko async-signal-safe pthread_sigmask.
    unsafe {
        cmd.pre_exec(move || {
            let r = pthread_sigmask(SIG_SETMASK, &empty, std::ptr::null_mut());
            if r != 0 {
                return Err(io::Error::from_raw_os_error(r));
            }
            Ok(())
        });
    }
}

/// Wysyła sygnał do całej grupy procesów. `Ok(false)`, gdy grupa już nie istnieje.
pub fn kill_process_group(pgid: u32, sig: i32) -> io::Result<bool> {
    let pgid = pid_t::try_from(pgid).map_err(io::Error::other)?;
    if pgid <= 1 {
        // kill(-1) / kill(0) trafiłyby we wszystkie procesy / własną grupę.
        return Err(io::Error::other("refusing to signal pgid <= 1"));
    }
    // SAFETY: kill nie ma warunków wstępnych dotyczących pamięci; ujemny pid oznacza
    // grupę procesów, pgid > 1 sprawdzone wyżej.
    match cvt(unsafe { kill(-pgid, sig) }) {
        Ok(_) => Ok(true),
        Err(e) if e.raw_os_error() == Some(ESRCH) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Blokuje SIGTERM/SIGINT/SIGHUP w bieżącym wątku (i wątkach tworzonych później),
/// żeby odebrać je synchronicznie przez [`wait_for_signal`]. Wywołać w `main`
/// przed utworzeniem jakiegokolwiek wątku.
pub fn block_shutdown_signals() -> io::Result<SigSet> {
    let mut set = empty_sigset();
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        // SAFETY: `set` jest zainicjalizowany przez sigemptyset, numery sygnałów poprawne.
        cvt(unsafe { sigaddset(&mut set, sig) })?;
    }
    // SAFETY: `set` żyje do końca wywołania; stara maska nie jest potrzebna (NULL).
    let r = unsafe { pthread_sigmask(SIG_BLOCK, &set, std::ptr::null_mut()) };
    if r != 0 {
        return Err(io::Error::from_raw_os_error(r));
    }
    Ok(set)
}

/// Czeka (blokująco) na jeden z sygnałów z `set` i zwraca jego numer.
pub fn wait_for_signal(set: &SigSet) -> io::Result<i32> {
    let mut sig: c_int = 0;
    // SAFETY: `set` i `sig` to poprawne wskaźniki na czas wywołania.
    let r = unsafe { sigwait(set, &mut sig) };
    if r != 0 {
        return Err(io::Error::from_raw_os_error(r));
    }
    Ok(sig)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn peer_uid_matches_self() {
        let (a, _b) = UnixStream::pair().unwrap();
        assert_eq!(peer_uid(&a).unwrap(), effective_uid());
    }

    #[test]
    fn pty_roundtrip() {
        let (mut master, slave_path) = open_pty(24, 80).unwrap();
        assert!(slave_path.starts_with("/dev/pts"));
        let mut slave = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&slave_path)
            .unwrap();
        slave.write_all(b"ping\n").unwrap();
        let mut buf = [0u8; 16];
        let n = master.read(&mut buf).unwrap();
        // Dyscyplina linii zamienia \n na \r\n (ONLCR).
        assert_eq!(&buf[..n], b"ping\r\n");
        drop(slave);
    }

    #[test]
    fn kill_refuses_dangerous_pgids() {
        assert!(kill_process_group(0, 0).is_err());
        assert!(kill_process_group(1, 0).is_err());
    }
}
