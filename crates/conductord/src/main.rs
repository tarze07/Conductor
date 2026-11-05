//! `conductord`: daemon Conductor (prototyp fazy 0, tylko biblioteka standardowa).
//!
//! Architektura i instrukcja demo: `crates/conductord/README.md`.

mod ffi;
mod log;
mod ring;
mod runtime;
mod sandbox;
mod server;
mod workspace;

use log::{log_error, log_info};
use runtime::TtyMode;
use sandbox::SandboxConfig;
use server::{Config, Daemon};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

const USAGE: &str = "\
conductord - daemon Conductor (prototyp)

Uzycie: conductord [opcje]

Opcje:
  --socket PATH          sciezka socketu (domyslnie $CONDUCTOR_SOCKET,
                         $XDG_RUNTIME_DIR/conductor/conductord.sock
                         albo /tmp/conductor-<uid>/conductord.sock)
  --worktree-root DIR    gdzie tworzyc worktree (domyslnie <repo>.worktrees obok repo)
  --ring-bytes N         rozmiar bufora wyjscia na przebieg (domyslnie 1048576)
  --stop-timeout-ms N    czas miedzy SIGTERM a SIGKILL (domyslnie 5000)
  --no-pty               uruchamiaj agentow na pipe'ach zamiast w PTY

Sandbox (ADR-002), wymagany domyslnie:
  --sandbox-launcher P   launcher sandboksa (run-sandboxed.sh); domyslnie
                         $CONDUCTOR_SANDBOX_LAUNCHER
  --egress-allowlist F   allowlista Egress Guard organizacji; bez niej agenci
                         nie maja sieci. Allowlista projektu
                         (<repo>/.conductor/egress-allowlist.txt) moze ja tylko zawezic
  --sandbox-backend B    auto | bwrap | unshare (domyslnie auto)
  --sandbox-full-etc     pelny /etc w sandboksie zamiast minimalnego
  --no-sandbox           uruchamiaj agentow BEZ izolacji (tylko do testow)
  -v, --verbose          logi DEBUG
  -h, --help             ta pomoc
  -V, --version          wersja daemona i protokolu
";

#[derive(Debug, PartialEq)]
enum Cli {
    Run(Config, bool),
    Help,
    Version,
}

fn parse_args(args: &[String]) -> Result<Cli, String> {
    let mut socket = None;
    let mut worktree_root = None;
    let mut ring_bytes = 1024 * 1024;
    let mut stop_timeout = Duration::from_millis(5000);
    let mut tty = TtyMode::Pty;
    let mut verbose = false;
    let mut launcher: Option<PathBuf> = None;
    let mut allowlist: Option<PathBuf> = None;
    let mut backend: Option<String> = None;
    let mut full_etc = false;
    let mut no_sandbox = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("option {name} requires a value"))
        };
        match a.as_str() {
            "--socket" => socket = Some(PathBuf::from(value("--socket")?)),
            "--worktree-root" => worktree_root = Some(PathBuf::from(value("--worktree-root")?)),
            "--ring-bytes" => {
                ring_bytes = value("--ring-bytes")?
                    .parse::<usize>()
                    .ok()
                    .filter(|n| *n > 0)
                    .ok_or("--ring-bytes must be a positive integer")?;
            }
            "--stop-timeout-ms" => {
                stop_timeout = Duration::from_millis(
                    value("--stop-timeout-ms")?
                        .parse()
                        .map_err(|_| "--stop-timeout-ms must be an integer")?,
                );
            }
            "--no-pty" => tty = TtyMode::Pipe,
            "--sandbox-launcher" => launcher = Some(PathBuf::from(value("--sandbox-launcher")?)),
            "--egress-allowlist" => allowlist = Some(PathBuf::from(value("--egress-allowlist")?)),
            "--sandbox-backend" => {
                let b = value("--sandbox-backend")?;
                if !matches!(b.as_str(), "auto" | "bwrap" | "unshare") {
                    return Err(format!("unknown sandbox backend `{b}`"));
                }
                backend = Some(b);
            }
            "--sandbox-full-etc" => full_etc = true,
            "--no-sandbox" => no_sandbox = true,
            "-v" | "--verbose" => verbose = true,
            "-h" | "--help" => return Ok(Cli::Help),
            "-V" | "--version" => return Ok(Cli::Version),
            other => return Err(format!("unknown argument `{other}`")),
        }
    }
    let socket = match socket {
        Some(s) => s,
        None => conductor_proto::paths::default_socket_path()
            .map_err(|e| format!("cannot determine socket path: {e}"))?,
    };
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let launcher = launcher.or_else(|| {
        std::env::var_os("CONDUCTOR_SANDBOX_LAUNCHER")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    });
    let sandbox = match (no_sandbox, launcher) {
        (true, Some(_)) => {
            return Err("--no-sandbox conflicts with --sandbox-launcher".into());
        }
        (true, None) => None,
        (false, None) => {
            return Err("no sandbox launcher: pass --sandbox-launcher PATH (or set \
                 CONDUCTOR_SANDBOX_LAUNCHER), or --no-sandbox to run agents unisolated"
                .into());
        }
        (false, Some(l)) => Some(SandboxConfig {
            launcher: cwd.join(l),
            org_allowlist: allowlist.map(|a| cwd.join(a)),
            backend,
            full_etc,
        }),
    };
    Ok(Cli::Run(
        Config {
            socket: cwd.join(socket),
            worktree_root: worktree_root.map(|w| cwd.join(w)),
            ring_bytes,
            stop_timeout,
            tty,
            sandbox,
        },
        verbose,
    ))
}

fn main() -> ExitCode {
    // Najpierw blokujemy sygnały, zanim powstanie jakikolwiek wątek: maskę dziedziczą
    // wszystkie wątki, a sygnał odbiera synchronicznie wyłącznie wątek `signals`.
    // Dzieci (git, agenci) dostają czystą maskę (std + pre_exec w ffi).
    let sigset = match ffi::block_shutdown_signals() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("conductord: cannot block signals: {e}");
            return ExitCode::FAILURE;
        }
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (cfg, verbose) = match parse_args(&args) {
        Ok(Cli::Run(cfg, verbose)) => (cfg, verbose),
        Ok(Cli::Help) => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Ok(Cli::Version) => {
            println!(
                "conductord {} (protocol v{})",
                env!("CARGO_PKG_VERSION"),
                conductor_proto::PROTOCOL_VERSION
            );
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            eprintln!("conductord: {e}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    log::set_verbose(verbose);

    let (daemon, listener) = match Daemon::setup(cfg) {
        Ok(x) => x,
        Err(e) => {
            log_error!("startup failed: {e}");
            return ExitCode::FAILURE;
        }
    };

    let d = std::sync::Arc::clone(&daemon);
    let spawned = std::thread::Builder::new()
        .name("signals".into())
        .spawn(move || match ffi::wait_for_signal(&sigset) {
            Ok(sig) => {
                log_info!("received signal {sig}");
                d.begin_shutdown("signal");
            }
            Err(e) => log_error!("sigwait failed: {e}"),
        });
    if let Err(e) = spawned {
        log_error!("cannot spawn signal thread: {e}");
        return ExitCode::FAILURE;
    }

    daemon.serve(listener);
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_options() {
        let Cli::Run(cfg, verbose) = parse_args(&args(&[
            "--socket",
            "/tmp/x/s.sock",
            "--no-pty",
            "--ring-bytes",
            "100",
            "--stop-timeout-ms",
            "250",
            "-v",
            "--no-sandbox",
        ]))
        .unwrap() else {
            panic!("expected Run")
        };
        assert_eq!(cfg.socket, PathBuf::from("/tmp/x/s.sock"));
        assert_eq!(cfg.tty, TtyMode::Pipe);
        assert_eq!(cfg.ring_bytes, 100);
        assert_eq!(cfg.stop_timeout, Duration::from_millis(250));
        assert!(verbose);
        assert_eq!(cfg.sandbox, None);
    }

    #[test]
    fn sandbox_is_required_by_default() {
        std::env::remove_var("CONDUCTOR_SANDBOX_LAUNCHER");
        assert!(parse_args(&args(&[])).is_err());
        assert!(parse_args(&args(&["--no-sandbox", "--sandbox-launcher", "/x"])).is_err());
        assert!(parse_args(&args(&[
            "--sandbox-launcher",
            "/x",
            "--sandbox-backend",
            "lxc"
        ]))
        .is_err());
        let Cli::Run(cfg, _) = parse_args(&args(&[
            "--sandbox-launcher",
            "/opt/run-sandboxed.sh",
            "--egress-allowlist",
            "/etc/conductor/egress.txt",
            "--sandbox-backend",
            "unshare",
        ]))
        .unwrap() else {
            panic!("expected Run")
        };
        assert_eq!(
            cfg.sandbox,
            Some(SandboxConfig {
                launcher: "/opt/run-sandboxed.sh".into(),
                org_allowlist: Some("/etc/conductor/egress.txt".into()),
                backend: Some("unshare".into()),
                full_etc: false,
            })
        );
    }

    #[test]
    fn rejects_bad_args() {
        assert!(parse_args(&args(&["--bogus"])).is_err());
        assert!(parse_args(&args(&["--socket"])).is_err());
        assert!(parse_args(&args(&["--ring-bytes", "0"])).is_err());
        assert_eq!(parse_args(&args(&["--help"])).unwrap(), Cli::Help);
    }
}
