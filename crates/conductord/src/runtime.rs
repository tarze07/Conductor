//! Agent Runtime: uruchamianie agenta CLI w PTY (albo na pipe'ach), buforowanie
//! wyjścia, przyjmowanie inputu, kod wyjścia i zatrzymywanie grupy procesów.
//!
//! Na każdy przebieg przypadają dwa wątki:
//! - czytelnik: `read()` z mastera PTY / pipe'a -> ring buffer, budzi czekających,
//! - waiter: `child.wait()` -> zapisuje kod wyjścia (po odczytaniu wyjścia do końca
//!   albo po [`DRAIN_TIMEOUT`], gdy np. proces w tle trzyma terminal otwarty).

use crate::ffi;
use crate::log::{log_debug, log_info, log_warn};
use crate::ring::{Chunk, RingBuffer};
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

/// Ile waiter czeka na domknięcie wyjścia po zakończeniu procesu.
pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
/// Rozmiar terminala przydzielanego agentowi.
pub const PTY_ROWS: u16 = 40;
pub const PTY_COLS: u16 = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TtyMode {
    Pty,
    Pipe,
}

impl TtyMode {
    pub fn as_str(self) -> &'static str {
        match self {
            TtyMode::Pty => "pty",
            TtyMode::Pipe => "pipe",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

struct State {
    buf: RingBuffer,
    exit: Option<ExitInfo>,
    eof: bool,
}

pub struct Agent {
    pub pid: u32,
    pub mode: TtyMode,
    state: Mutex<State>,
    cond: Condvar,
    input: Mutex<Option<Box<dyn Write + Send>>>,
}

pub struct SpawnSpec<'a> {
    pub argv: &'a [String],
    pub cwd: &'a Path,
    pub env: Vec<(String, String)>,
    pub mode: TtyMode,
    pub ring_bytes: usize,
    /// Etykieta do logów (np. `r1`).
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopOutcome {
    pub exit: Option<ExitInfo>,
    pub killed: bool,
    pub already_exited: bool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Agent {
    /// Uruchamia agenta. W trybie PTY, gdy nie da się otworzyć pseudoterminala,
    /// spada na pipe'y (i loguje ostrzeżenie).
    pub fn spawn(spec: SpawnSpec<'_>) -> io::Result<Arc<Agent>> {
        let (prog, args) = spec
            .argv
            .split_first()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty agent_cmd"))?;
        let mut cmd = Command::new(prog);
        cmd.args(args)
            .current_dir(spec.cwd)
            .envs(spec.env.iter().cloned());

        let pty = match spec.mode {
            TtyMode::Pty => match ffi::open_pty(PTY_ROWS, PTY_COLS) {
                Ok(p) => Some(p),
                Err(e) => {
                    log_warn!(
                        "{}: cannot open PTY ({e}), falling back to pipes",
                        spec.label
                    );
                    None
                }
            },
            TtyMode::Pipe => None,
        };

        let (child, reader, input, mode): (Child, Box<dyn Read + Send>, Box<dyn Write + Send>, _) =
            match pty {
                Some((master, slave_path)) => {
                    let slave = OpenOptions::new()
                        .read(true)
                        .write(true)
                        .custom_flags(ffi::O_NOCTTY)
                        .open(&slave_path)?;
                    cmd.stdin(slave.try_clone()?)
                        .stdout(slave.try_clone()?)
                        .stderr(slave)
                        .env("TERM", "xterm-256color");
                    ffi::configure_pty_child(&mut cmd);
                    let child = cmd.spawn()?;
                    // Zamknij kopie slave w daemonie: inaczej master nigdy nie dostanie EOF/EIO.
                    drop(cmd);
                    let input = master.try_clone()?;
                    (child, Box::new(master), Box::new(input), TtyMode::Pty)
                }
                None => {
                    let (r, w) = io::pipe()?;
                    cmd.stdin(Stdio::piped())
                        .stdout(w.try_clone()?)
                        .stderr(w)
                        .env("TERM", "dumb");
                    ffi::configure_pipe_child(&mut cmd);
                    let mut child = cmd.spawn()?;
                    drop(cmd);
                    let stdin = child
                        .stdin
                        .take()
                        .ok_or_else(|| io::Error::other("child stdin missing"))?;
                    (child, Box::new(r), Box::new(stdin), TtyMode::Pipe)
                }
            };

        let agent = Arc::new(Agent {
            pid: child.id(),
            mode,
            state: Mutex::new(State {
                buf: RingBuffer::new(spec.ring_bytes),
                exit: None,
                eof: false,
            }),
            cond: Condvar::new(),
            input: Mutex::new(Some(input)),
        });

        let a = Arc::clone(&agent);
        let label = spec.label.clone();
        std::thread::Builder::new()
            .name(format!("out-{label}"))
            .spawn(move || a.reader_loop(reader, &label))?;
        let a = Arc::clone(&agent);
        let label = spec.label;
        std::thread::Builder::new()
            .name(format!("wait-{label}"))
            .spawn(move || a.waiter(child, &label))?;
        Ok(agent)
    }

    fn reader_loop(&self, mut reader: Box<dyn Read + Send>, label: &str) {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    lock(&self.state).buf.push(&buf[..n]);
                    self.cond.notify_all();
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                // Linux: master PTY zwraca EIO, gdy wszystkie deskryptory slave są zamknięte.
                Err(e) if e.raw_os_error() == Some(ffi::EIO) => break,
                Err(e) => {
                    log_warn!("{label}: output read error: {e}");
                    break;
                }
            }
        }
        lock(&self.state).eof = true;
        self.cond.notify_all();
        log_debug!("{label}: output EOF");
    }

    fn waiter(&self, mut child: Child, label: &str) {
        let info = match child.wait() {
            Ok(st) => ExitInfo {
                code: st.code(),
                signal: st.signal(),
            },
            Err(e) => {
                log_warn!("{label}: wait failed: {e}");
                ExitInfo {
                    code: None,
                    signal: None,
                }
            }
        };
        let guard = lock(&self.state);
        let (mut guard, _) = self
            .cond
            .wait_timeout_while(guard, DRAIN_TIMEOUT, |s| !s.eof)
            .unwrap_or_else(|p| p.into_inner());
        guard.exit = Some(info);
        drop(guard);
        self.cond.notify_all();
        log_info!(
            "{label}: agent pid {} exited (code {:?}, signal {:?})",
            self.pid,
            info.code,
            info.signal
        );
    }

    pub fn exit_info(&self) -> Option<ExitInfo> {
        lock(&self.state).exit
    }

    pub fn output_end(&self) -> u64 {
        lock(&self.state).buf.end()
    }

    /// Czyta wyjście od `since`. Gdy nic nowego nie ma i proces żyje, czeka do `wait`.
    pub fn read_output(&self, since: u64, max: usize, wait: Duration) -> (Chunk, Option<ExitInfo>) {
        let mut st = lock(&self.state);
        if !wait.is_zero() {
            st = self
                .cond
                .wait_timeout_while(st, wait, |s| s.buf.end() <= since && s.exit.is_none())
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        (st.buf.read_from(since, max), st.exit)
    }

    pub fn write_input(&self, data: &[u8]) -> io::Result<usize> {
        if self.exit_info().is_some() {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "agent has already exited",
            ));
        }
        let mut input = lock(&self.input);
        let w = input
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "input closed"))?;
        w.write_all(data)?;
        w.flush()?;
        Ok(data.len())
    }

    /// Czeka na zakończenie procesu najwyżej `timeout`.
    pub fn wait_exit(&self, timeout: Duration) -> Option<ExitInfo> {
        let st = lock(&self.state);
        self.cond
            .wait_timeout_while(st, timeout, |s| s.exit.is_none())
            .unwrap_or_else(|p| p.into_inner())
            .0
            .exit
    }

    /// SIGTERM do grupy procesów, po `timeout` SIGKILL.
    ///
    /// Znane ograniczenie: między zakończeniem procesu a zapisaniem `exit` istnieje
    /// krótkie okno, w którym PID mógłby zostać ponownie użyty; w praktyce pomijalne
    /// (PID-y są przydzielane cyklicznie), do usunięcia po przejściu na pidfd.
    pub fn stop(&self, timeout: Duration, label: &str) -> StopOutcome {
        if let Some(exit) = self.exit_info() {
            return StopOutcome {
                exit: Some(exit),
                killed: false,
                already_exited: true,
            };
        }
        log_info!("{label}: sending SIGTERM to process group {}", self.pid);
        if let Err(e) = ffi::kill_process_group(self.pid, ffi::SIGTERM) {
            log_warn!("{label}: SIGTERM failed: {e}");
        }
        if let Some(exit) = self.wait_exit(timeout) {
            return StopOutcome {
                exit: Some(exit),
                killed: false,
                already_exited: false,
            };
        }
        log_warn!(
            "{label}: still running after {} ms, sending SIGKILL",
            timeout.as_millis()
        );
        if let Err(e) = ffi::kill_process_group(self.pid, ffi::SIGKILL) {
            log_warn!("{label}: SIGKILL failed: {e}");
        }
        StopOutcome {
            exit: self.wait_exit(DRAIN_TIMEOUT + Duration::from_secs(3)),
            killed: true,
            already_exited: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spawn(mode: TtyMode, script: &str) -> Arc<Agent> {
        let argv = vec!["sh".to_string(), "-c".to_string(), script.to_string()];
        Agent::spawn(SpawnSpec {
            argv: &argv,
            cwd: Path::new("/"),
            env: vec![("FOO".into(), "bar".into())],
            mode,
            ring_bytes: 4096,
            label: "test".into(),
        })
        .unwrap()
    }

    fn all_output(a: &Agent) -> String {
        let exit = a.wait_exit(Duration::from_secs(10));
        assert!(exit.is_some(), "agent did not exit");
        let (c, _) = a.read_output(0, usize::MAX, Duration::ZERO);
        String::from_utf8_lossy(&c.data).into_owned()
    }

    #[test]
    fn pty_output_env_and_exit_code() {
        let a = spawn(
            TtyMode::Pty,
            "echo out-$FOO; echo err >&2; [ -t 0 ] && echo tty; exit 7",
        );
        assert_eq!(a.mode, TtyMode::Pty);
        let out = all_output(&a);
        assert!(out.contains("out-bar\r\n"), "{out:?}");
        assert!(out.contains("err"), "{out:?}");
        assert!(out.contains("tty"), "{out:?}");
        assert_eq!(a.exit_info().unwrap().code, Some(7));
    }

    #[test]
    fn pipe_merges_stderr() {
        let a = spawn(
            TtyMode::Pipe,
            "echo one; echo two >&2; [ -t 0 ] || echo notty",
        );
        assert_eq!(a.mode, TtyMode::Pipe);
        let out = all_output(&a);
        assert_eq!(out, "one\ntwo\nnotty\n");
        assert_eq!(a.exit_info().unwrap().code, Some(0));
    }

    #[test]
    fn input_is_delivered() {
        for mode in [TtyMode::Pty, TtyMode::Pipe] {
            let a = spawn(mode, "read line; echo got:$line");
            a.write_input(b"hello\n").unwrap();
            let out = all_output(&a);
            assert!(out.contains("got:hello"), "{mode:?}: {out:?}");
            assert!(a.write_input(b"x").is_err());
        }
    }

    #[test]
    fn stop_terminates_process_group() {
        for mode in [TtyMode::Pty, TtyMode::Pipe] {
            // Proces potomny w tej samej grupie też musi zginąć.
            let a = spawn(mode, "sleep 300 & echo started; wait");
            let (c, _) = a.read_output(0, 100, Duration::from_secs(5));
            assert!(!c.data.is_empty());
            let out = a.stop(Duration::from_secs(5), "test");
            assert!(!out.already_exited);
            assert!(!out.killed, "{mode:?}");
            assert_eq!(out.exit.unwrap().signal, Some(ffi::SIGTERM), "{mode:?}");
            let again = a.stop(Duration::from_secs(1), "test");
            assert!(again.already_exited);
        }
    }

    #[test]
    fn stop_escalates_to_sigkill() {
        let a = spawn(
            TtyMode::Pipe,
            "trap '' TERM; echo ready; while :; do sleep 0.1; done",
        );
        let (c, _) = a.read_output(0, 100, Duration::from_secs(5));
        assert!(!c.data.is_empty());
        let out = a.stop(Duration::from_millis(300), "test");
        assert!(out.killed);
        assert_eq!(out.exit.unwrap().signal, Some(ffi::SIGKILL));
    }

    #[test]
    fn long_poll_wakes_on_output() {
        let a = spawn(TtyMode::Pipe, "sleep 0.3; echo late");
        let t = std::time::Instant::now();
        let (c, _) = a.read_output(0, 100, Duration::from_secs(10));
        assert_eq!(c.data, b"late\n");
        assert!(t.elapsed() < Duration::from_secs(5));
    }
}
