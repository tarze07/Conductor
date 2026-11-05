//! Serwer IPC: socket unix w katalogu 0700, token w pliku 0600, kontrola UID peera,
//! JSON-RPC 2.0 rozdzielany nowymi liniami, jeden wątek na połączenie.

use crate::ffi;
use crate::log::{log_debug, log_error, log_info, log_warn};
use crate::runtime::{Agent, SpawnSpec, TtyMode};
use crate::sandbox::{self, Sandbox, SandboxConfig};
use crate::workspace::{self, WorkspaceManager, Worktree};
use conductor_proto::json::Value;
use conductor_proto::methods::*;
use conductor_proto::rpc::{code, Request, Response, RpcError, MAX_FRAME_BYTES};
use std::collections::BTreeMap;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

/// Czas na uwierzytelnienie po nawiązaniu połączenia.
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
/// Maksymalny rozmiar danych w jednej odpowiedzi `run.output`.
const MAX_OUTPUT_CHUNK: usize = 256 * 1024;
/// Maksymalny czas long-pollingu `run.output`.
const MAX_WAIT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub socket: PathBuf,
    pub worktree_root: Option<PathBuf>,
    pub ring_bytes: usize,
    pub stop_timeout: Duration,
    pub tty: TtyMode,
    /// `None` = agenci bez sandboksa (wymaga jawnego `--no-sandbox`).
    pub sandbox: Option<SandboxConfig>,
}

pub struct Run {
    pub id: String,
    pub name: String,
    pub task: String,
    pub agent_cmd: Vec<String>,
    pub worktree: Worktree,
    pub agent: Arc<Agent>,
    pub sandboxed: bool,
}

impl Run {
    fn info(&self) -> RunInfo {
        let exit = self.agent.exit_info();
        RunInfo {
            run_id: self.id.clone(),
            name: self.name.clone(),
            task: self.task.clone(),
            repo: self.worktree.repo_root.display().to_string(),
            branch: self.worktree.branch.clone(),
            worktree: self.worktree.path.display().to_string(),
            agent_cmd: self.agent_cmd.clone(),
            state: if exit.is_some() { "exited" } else { "running" }.into(),
            tty: self.agent.mode.as_str().into(),
            pid: Some(self.agent.pid),
            exit_code: exit.and_then(|e| e.code),
            signal: exit.and_then(|e| e.signal),
            output_bytes: self.agent.output_end(),
            sandboxed: self.sandboxed,
        }
    }
}

#[derive(Default)]
struct RunTable {
    runs: BTreeMap<u64, Arc<Run>>,
    next_seq: u64,
}

pub struct Daemon {
    cfg: Config,
    token: String,
    workspace: WorkspaceManager,
    sandbox: Option<Sandbox>,
    runs: Mutex<RunTable>,
    /// Serializuje `run.start` (rezerwacja nazwy + worktree + spawn).
    start_lock: Mutex<()>,
    shutting_down: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn not_found(id: &str) -> RpcError {
    RpcError::new(code::NOT_FOUND, format!("no such run `{id}`"))
}

/// Porównanie w czasie niezależnym od treści (długość tokenu nie jest tajna).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 32 losowe bajty z `/dev/urandom` jako 64 znaki hex.
pub fn generate_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Tworzy katalog socketu z prawami 0700 albo weryfikuje istniejący (właściciel, prawa,
/// brak symlinku).
pub fn prepare_socket_dir(dir: &Path) -> io::Result<()> {
    match fs::symlink_metadata(dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
            Ok(())
        }
        Err(e) => Err(e),
        Ok(m) => {
            if !m.is_dir() {
                return Err(io::Error::other(format!(
                    "{} exists and is not a directory (symlinks are rejected)",
                    dir.display()
                )));
            }
            if m.uid() != ffi::effective_uid() {
                return Err(io::Error::other(format!(
                    "{} is owned by uid {}, not by us",
                    dir.display(),
                    m.uid()
                )));
            }
            if m.mode() & 0o077 != 0 {
                log_warn!(
                    "{} had mode {:o}, tightening to 0700",
                    dir.display(),
                    m.mode() & 0o777
                );
                fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
            }
            Ok(())
        }
    }
}

fn write_token_file(path: &Path, token: &str) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(token.as_bytes())?;
    f.write_all(b"\n")?;
    f.sync_all()
}

fn bind_socket(path: &Path) -> io::Result<UnixListener> {
    if let Ok(m) = fs::symlink_metadata(path) {
        if !m.file_type().is_socket() {
            return Err(io::Error::other(format!(
                "{} exists and is not a socket",
                path.display()
            )));
        }
        if UnixStream::connect(path).is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                format!(
                    "another conductord is already listening on {}",
                    path.display()
                ),
            ));
        }
        log_info!("removing stale socket {}", path.display());
        fs::remove_file(path)?;
    }
    let l = UnixListener::bind(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(l)
}

impl Daemon {
    /// Przygotowuje katalog, token i socket. Zwraca daemona i nasłuchujący socket.
    pub fn setup(cfg: Config) -> io::Result<(Arc<Daemon>, UnixListener)> {
        let dir = cfg
            .socket
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| io::Error::other("socket path has no parent directory"))?;
        prepare_socket_dir(dir)?;
        let sandbox = match &cfg.sandbox {
            Some(sc) => {
                let sb = Sandbox::new(sc.clone(), &dir.join("state")).map_err(io::Error::other)?;
                sb.self_test().map_err(io::Error::other)?;
                match sb.org_rules() {
                    Some(r) => log_info!(
                        "sandbox: enabled ({}), organization egress allowlist: {} rule(s)",
                        sc.launcher.display(),
                        r.len()
                    ),
                    None => log_info!(
                        "sandbox: enabled ({}), no organization egress allowlist: agents have NO network",
                        sc.launcher.display()
                    ),
                }
                log_info!("audit log: {}", sb.audit.path().display());
                Some(sb)
            }
            None => {
                log_warn!("sandbox: DISABLED (--no-sandbox): agents run with the daemon user's full privileges");
                None
            }
        };
        let token = generate_token()?;
        // Token zapisujemy przed bind(), więc gdy socket przyjmuje połączenia, token już jest.
        let token_path = conductor_proto::paths::token_path(&cfg.socket);
        write_token_file(&token_path, &token)?;
        let listener = match bind_socket(&cfg.socket) {
            Ok(l) => l,
            Err(e) => {
                let _ = fs::remove_file(&token_path);
                return Err(e);
            }
        };
        let workspace = WorkspaceManager::new(cfg.worktree_root.clone());
        let daemon = Arc::new(Daemon {
            cfg,
            token,
            workspace,
            sandbox,
            runs: Mutex::new(RunTable {
                next_seq: 1,
                ..Default::default()
            }),
            start_lock: Mutex::new(()),
            shutting_down: AtomicBool::new(false),
        });
        Ok((daemon, listener))
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    /// Rozpoczyna wyłączanie: ustawia flagę i budzi pętlę `accept`.
    pub fn begin_shutdown(&self, reason: &str) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        log_info!("shutdown requested ({reason})");
        // Połączenie do samego siebie wybudza blokujące accept().
        let _ = UnixStream::connect(&self.cfg.socket);
    }

    /// Pętla główna. Wraca po `begin_shutdown`, po zatrzymaniu agentów i sprzątnięciu.
    pub fn serve(self: &Arc<Self>, listener: UnixListener) {
        log_info!(
            "conductord {} listening on {} (protocol v{PROTOCOL_VERSION}, tty mode {})",
            env!("CARGO_PKG_VERSION"),
            self.cfg.socket.display(),
            self.cfg.tty.as_str()
        );
        for conn in listener.incoming() {
            if self.is_shutting_down() {
                break;
            }
            match conn {
                Ok(stream) => {
                    let d = Arc::clone(self);
                    let r = std::thread::Builder::new()
                        .name("conn".into())
                        .spawn(move || d.handle_connection(stream));
                    if let Err(e) = r {
                        log_error!("cannot spawn connection thread: {e}");
                    }
                }
                Err(e) => log_warn!("accept failed: {e}"),
            }
        }
        drop(listener);
        self.stop_all();
        let _ = fs::remove_file(&self.cfg.socket);
        let _ = fs::remove_file(conductor_proto::paths::token_path(&self.cfg.socket));
        log_info!("conductord stopped");
    }

    fn stop_all(&self) {
        let runs: Vec<Arc<Run>> = lock(&self.runs).runs.values().cloned().collect();
        let timeout = self.cfg.stop_timeout;
        let handles: Vec<_> = runs
            .into_iter()
            .filter(|r| r.agent.exit_info().is_none())
            .map(|r| {
                std::thread::spawn(move || {
                    r.agent.stop(timeout, &r.id);
                })
            })
            .collect();
        if !handles.is_empty() {
            log_info!("stopping {} running agent(s)", handles.len());
        }
        for h in handles {
            let _ = h.join();
        }
    }

    fn handle_connection(self: Arc<Self>, stream: UnixStream) {
        match ffi::peer_uid(&stream) {
            Ok(uid) if uid == ffi::effective_uid() => {}
            Ok(uid) => {
                log_warn!("rejecting connection from uid {uid}");
                return;
            }
            Err(e) => {
                log_warn!("cannot read peer credentials: {e}");
                return;
            }
        }
        if self.is_shutting_down() {
            return;
        }
        if let Err(e) = self.connection_loop(stream) {
            log_debug!("connection closed: {e}");
        }
    }

    fn connection_loop(&self, stream: UnixStream) -> io::Result<()> {
        stream.set_read_timeout(Some(AUTH_TIMEOUT))?;
        let mut writer = stream.try_clone()?;
        let mut reader = BufReader::new(stream);
        let mut authed = false;
        let mut frame = Vec::new();
        loop {
            frame.clear();
            let n = (&mut reader)
                .take(MAX_FRAME_BYTES as u64 + 1)
                .read_until(b'\n', &mut frame)?;
            if n == 0 {
                return Ok(());
            }
            if frame.len() > MAX_FRAME_BYTES {
                let resp = Response::err(
                    Value::Null,
                    RpcError::new(code::INVALID_REQUEST, "frame too large"),
                );
                writer.write_all(resp.to_line().as_bytes())?;
                return Ok(());
            }
            if frame.last() == Some(&b'\n') {
                frame.pop();
            }
            if frame.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let (resp, after) = self.handle_frame(&frame, &mut authed);
            if let Some(resp) = resp {
                writer.write_all(resp.to_line().as_bytes())?;
                writer.flush()?;
            }
            match after {
                After::Continue => {}
                After::Authenticated => reader.get_ref().set_read_timeout(None)?,
                After::Close => return Ok(()),
                After::Shutdown => {
                    self.begin_shutdown("daemon.shutdown request");
                    return Ok(());
                }
            }
        }
    }

    fn handle_frame(&self, frame: &[u8], authed: &mut bool) -> (Option<Response>, After) {
        let req = match Request::parse_line(frame) {
            Ok(r) => r,
            Err(e) => {
                // Bez uwierzytelnienia nie prowadzimy dyskusji z klientem.
                let after = if *authed {
                    After::Continue
                } else {
                    After::Close
                };
                return (Some(Response::err(e.id, e.error)), after);
            }
        };
        let Some(id) = req.id.clone() else {
            // Notyfikacje: protokół żadnych nie definiuje, a JSON-RPC zabrania odpowiedzi.
            log_debug!("ignoring notification `{}`", req.method);
            return (None, After::Continue);
        };
        let call = match Call::parse(&req.method, &req.params) {
            Ok(c) => c,
            Err(e) => {
                let after = if *authed {
                    After::Continue
                } else {
                    After::Close
                };
                return (Some(Response::err(id, e)), after);
            }
        };
        match (call, *authed) {
            (Call::Auth(p), _) => match self.auth(&p) {
                Ok(v) => {
                    *authed = true;
                    (Some(Response::ok(id, v)), After::Authenticated)
                }
                Err(e) => (Some(Response::err(id, e)), After::Close),
            },
            (_, false) => (
                Some(Response::err(
                    id,
                    RpcError::new(code::UNAUTHORIZED, "authenticate first (method `auth`)"),
                )),
                After::Close,
            ),
            (Call::DaemonShutdown, true) => (
                Some(Response::ok(
                    id,
                    Value::object([("shutting_down", Value::Bool(true))]),
                )),
                After::Shutdown,
            ),
            (call, true) => {
                let resp = match self.dispatch(call) {
                    Ok(v) => Response::ok(id, v),
                    Err(e) => Response::err(id, e),
                };
                (Some(resp), After::Continue)
            }
        }
    }

    fn auth(&self, p: &AuthParams) -> Result<Value, RpcError> {
        if !constant_time_eq(p.token.as_bytes(), self.token.as_bytes()) {
            log_warn!("authentication failed (bad token)");
            return Err(RpcError::new(code::UNAUTHORIZED, "invalid token"));
        }
        if let Some(v) = p.protocol_version {
            if v != PROTOCOL_VERSION {
                return Err(RpcError::new(
                    code::UNSUPPORTED_VERSION,
                    format!("client speaks protocol v{v}, daemon speaks v{PROTOCOL_VERSION}"),
                ));
            }
        }
        Ok(AuthResult {
            protocol_version: PROTOCOL_VERSION,
            daemon_version: env!("CARGO_PKG_VERSION").into(),
        }
        .to_value())
    }

    fn dispatch(&self, call: Call) -> Result<Value, RpcError> {
        match call {
            Call::RunStart(p) => self.run_start(p).map(|r| r.to_value()),
            Call::RunList => Ok(RunListResult {
                runs: lock(&self.runs).runs.values().map(|r| r.info()).collect(),
            }
            .to_value()),
            Call::RunStop(p) => self.run_stop(&p).map(|r| r.to_value()),
            Call::RunOutput(p) => self.run_output(&p).map(|r| r.to_value()),
            Call::RunInput(p) => {
                let run = self.find(&p.run_id)?;
                let written = run.agent.write_input(&p.data).map_err(|e| {
                    RpcError::new(code::CONFLICT, format!("cannot write input: {e}"))
                })?;
                Ok(RunInputResult {
                    written: written as u64,
                }
                .to_value())
            }
            Call::RunRemove(p) => self.run_remove(&p).map(|r| r.to_value()),
            // Obsłużone w handle_frame.
            Call::Auth(_) | Call::DaemonShutdown => Err(RpcError::new(
                code::INTERNAL_ERROR,
                "unexpected call in dispatch",
            )),
        }
    }

    /// Szuka przebiegu po identyfikatorze (`r1`) albo nazwie (`a1`).
    fn find(&self, id_or_name: &str) -> Result<Arc<Run>, RpcError> {
        let t = lock(&self.runs);
        t.runs
            .values()
            .find(|r| r.id == id_or_name)
            .or_else(|| t.runs.values().find(|r| r.name == id_or_name))
            .cloned()
            .ok_or_else(|| not_found(id_or_name))
    }

    fn run_start(&self, p: RunStartParams) -> Result<RunStartResult, RpcError> {
        if self.is_shutting_down() {
            return Err(RpcError::new(
                code::SHUTTING_DOWN,
                "daemon is shutting down",
            ));
        }
        if p.agent_cmd.first().is_none_or(|c| c.is_empty()) {
            return Err(RpcError::invalid_params("agent_cmd must not be empty"));
        }
        if p.task.trim().is_empty() {
            return Err(RpcError::invalid_params("task must not be empty"));
        }
        let _start = lock(&self.start_lock);
        let repo_root = self
            .workspace
            .repo_root(Path::new(&p.repo))
            .map_err(|e| RpcError::new(code::GIT_ERROR, e))?;

        let seq = lock(&self.runs).next_seq;
        let run_id = format!("r{seq}");
        let name = p.name.clone().unwrap_or_else(|| format!("a{seq}"));
        workspace::validate_run_name(&name).map_err(RpcError::invalid_params)?;
        {
            let t = lock(&self.runs);
            if t.runs.values().any(|r| r.name == name || r.id == name) {
                return Err(RpcError::new(
                    code::CONFLICT,
                    format!("run name `{name}` is already in use"),
                ));
            }
        }
        let task_slug = workspace::slugify(&p.task);
        let wt = self
            .workspace
            .create(&repo_root, &task_slug, &name)
            .map_err(|e| RpcError::new(code::GIT_ERROR, e))?;

        let env = vec![
            ("CONDUCTOR_RUN_ID".to_string(), run_id.clone()),
            ("CONDUCTOR_RUN_NAME".to_string(), name.clone()),
            ("CONDUCTOR_TASK".to_string(), p.task.clone()),
            ("CONDUCTOR_BRANCH".to_string(), wt.branch.clone()),
            (
                "CONDUCTOR_WORKTREE".to_string(),
                wt.path.display().to_string(),
            ),
        ];
        let fail = |what: String| {
            log_warn!("{run_id}: {what}; rolling back worktree");
            self.workspace.rollback(&wt);
            if let Some(sb) = &self.sandbox {
                sb.cleanup(&run_id);
                sb.audit.event(
                    "run.start_failed",
                    vec![
                        ("run_id", run_id.as_str().into()),
                        ("error", what.as_str().into()),
                    ],
                );
            }
        };
        let (argv, env, clear_env, prepared) = match &self.sandbox {
            Some(sb) => {
                let prepared = self
                    .workspace
                    .git_paths(&wt)
                    .and_then(|g| sb.prepare(&run_id, &name, &wt, &g, &p.agent_cmd, &env));
                match prepared {
                    Ok(pr) => (pr.argv.clone(), pr.env.clone(), true, Some(pr)),
                    Err(e) => {
                        fail(format!("cannot prepare sandbox: {e}"));
                        return Err(RpcError::new(
                            code::SPAWN_ERROR,
                            format!("cannot prepare sandbox: {e}"),
                        ));
                    }
                }
            }
            None => (p.agent_cmd.clone(), env, false, None),
        };
        let agent = match Agent::spawn(SpawnSpec {
            argv: &argv,
            cwd: &wt.path,
            env,
            clear_env,
            mode: self.cfg.tty,
            ring_bytes: self.cfg.ring_bytes,
            label: run_id.clone(),
        }) {
            Ok(a) => a,
            Err(e) => {
                fail(format!("cannot start {:?}: {e}", p.agent_cmd));
                return Err(RpcError::new(
                    code::SPAWN_ERROR,
                    format!("cannot start `{}`: {e}", p.agent_cmd[0]),
                ));
            }
        };
        log_info!(
            "{run_id}: started {:?} as pid {} ({}, {}) in {} on {}",
            p.agent_cmd,
            agent.pid,
            agent.mode.as_str(),
            if prepared.is_some() {
                "sandboxed"
            } else {
                "NOT sandboxed"
            },
            wt.path.display(),
            wt.branch
        );
        if let (Some(sb), Some(pr)) = (&self.sandbox, &prepared) {
            if !pr.allowlist.dropped.is_empty() {
                log_warn!(
                    "{run_id}: project egress rules not covered by the organization allowlist were dropped: {:?}",
                    pr.allowlist.dropped
                );
            }
            sb.audit.event(
                "run.start",
                vec![
                    ("run_id", run_id.as_str().into()),
                    ("name", name.as_str().into()),
                    ("task", p.task.as_str().into()),
                    ("repo", wt.repo_root.display().to_string().into()),
                    ("branch", wt.branch.as_str().into()),
                    ("worktree", wt.path.display().to_string().into()),
                    (
                        "agent_cmd",
                        Value::Array(p.agent_cmd.iter().map(|a| a.as_str().into()).collect()),
                    ),
                    ("pid", agent.pid.into()),
                    (
                        "egress_allowlist",
                        sandbox::rules_value(&pr.allowlist.rules),
                    ),
                    (
                        "egress_dropped",
                        sandbox::rules_value(&pr.allowlist.dropped),
                    ),
                ],
            );
        }
        let result = RunStartResult {
            run_id: run_id.clone(),
            name: name.clone(),
            worktree: wt.path.display().to_string(),
            branch: wt.branch.clone(),
        };
        let run = Arc::new(Run {
            id: run_id,
            name,
            task: p.task,
            agent_cmd: p.agent_cmd,
            worktree: wt,
            agent,
            sandboxed: prepared.is_some(),
        });
        let mut t = lock(&self.runs);
        t.runs.insert(seq, run);
        t.next_seq += 1;
        Ok(result)
    }

    fn run_stop(&self, p: &RunStopParams) -> Result<RunStopResult, RpcError> {
        let run = self.find(&p.run_id)?;
        let timeout = p
            .timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(self.cfg.stop_timeout)
            .min(Duration::from_secs(60));
        let out = run.agent.stop(timeout, &run.id);
        if let Some(sb) = &self.sandbox {
            sb.audit.event(
                "run.stop",
                vec![
                    ("run_id", run.id.as_str().into()),
                    ("killed", out.killed.into()),
                    ("already_exited", out.already_exited.into()),
                ],
            );
        }
        Ok(RunStopResult {
            run_id: run.id.clone(),
            exit_code: out.exit.and_then(|e| e.code),
            signal: out.exit.and_then(|e| e.signal),
            killed: out.killed,
            already_exited: out.already_exited,
        })
    }

    fn run_output(&self, p: &RunOutputParams) -> Result<RunOutputResult, RpcError> {
        let run = self.find(&p.run_id)?;
        let max = p
            .max_bytes
            .map_or(MAX_OUTPUT_CHUNK, |m| (m as usize).min(MAX_OUTPUT_CHUNK));
        let wait = p
            .wait_ms
            .map_or(Duration::ZERO, Duration::from_millis)
            .min(MAX_WAIT);
        let (chunk, exit) = run.agent.read_output(p.since.unwrap_or(0), max, wait);
        Ok(RunOutputResult {
            data: chunk.data,
            offset: chunk.offset,
            next_offset: chunk.next_offset,
            dropped: chunk.dropped,
            exited: exit.is_some(),
            exit_code: exit.and_then(|e| e.code),
            signal: exit.and_then(|e| e.signal),
        })
    }

    fn run_remove(&self, p: &RunRemoveParams) -> Result<RunRemoveResult, RpcError> {
        let run = self.find(&p.run_id)?;
        if run.agent.exit_info().is_none() {
            return Err(RpcError::new(
                code::CONFLICT,
                format!("run `{}` is still running; stop it first", run.id),
            ));
        }
        if p.delete_worktree {
            self.workspace
                .remove(&run.worktree)
                .map_err(|e| RpcError::new(code::GIT_ERROR, e))?;
        }
        lock(&self.runs).runs.retain(|_, r| r.id != run.id);
        if let Some(sb) = &self.sandbox {
            sb.cleanup(&run.id);
            sb.audit.event(
                "run.remove",
                vec![
                    ("run_id", run.id.as_str().into()),
                    ("worktree_deleted", p.delete_worktree.into()),
                ],
            );
        }
        log_info!(
            "{}: removed (worktree {})",
            run.id,
            if p.delete_worktree { "deleted" } else { "kept" }
        );
        Ok(RunRemoveResult {
            run_id: run.id.clone(),
            worktree_deleted: p.delete_worktree,
        })
    }
}

enum After {
    Continue,
    Authenticated,
    Close,
    Shutdown,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_format() {
        let t = generate_token().unwrap();
        assert_eq!(t.len(), 64);
        assert!(t.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(t, generate_token().unwrap());
    }

    #[test]
    fn ct_eq() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn socket_dir_permissions() {
        let base = std::env::temp_dir().join(format!("conductord-ut-{}", std::process::id()));
        let dir = base.join("a/b");
        prepare_socket_dir(&dir).unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        prepare_socket_dir(&dir).unwrap();
        assert_eq!(fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        // Symlink zamiast katalogu jest odrzucany.
        let link = base.join("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert!(prepare_socket_dir(&link).is_err());
        // Token 0600.
        let tok = dir.join("t.token");
        write_token_file(&tok, "x").unwrap();
        assert_eq!(fs::metadata(&tok).unwrap().mode() & 0o777, 0o600);
        fs::remove_dir_all(&base).unwrap();
    }
}
