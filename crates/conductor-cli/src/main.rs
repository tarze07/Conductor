//! `conductor`: proste CLI do sterowania `conductord` (UI fazy 0).
//!
//! Cała logika jest w daemonie; CLI tylko tłumaczy argumenty na wywołania JSON-RPC
//! (ten sam kontrakt, którego użyje UI Tauri).
#![forbid(unsafe_code)]

use conductor_proto::client::{Client, ClientError};
use conductor_proto::methods::{RunInfo, RunOutputParams, RunStartParams};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const USAGE: &str = "\
conductor - sterowanie daemonem conductord

Uzycie: conductor [--socket PATH] <komenda> [argumenty]

Komendy:
  start --repo DIR --task TEKST [--name NAZWA] -- KOMENDA [ARG...]
                          utworz worktree i gałąź agent/<task>/<nazwa>, uruchom agenta
  list                    lista przebiegow
  logs <id> [-f]          wyjscie agenta (-f: sledz do zakonczenia)
  send <id> <tekst...> [--no-newline]
                          wpisz tekst na terminal agenta (domyslnie z \\n na koncu)
  stop <id> [--timeout-ms N]
                          SIGTERM do grupy procesow, po timeoucie SIGKILL
  rm <id> [--delete-worktree]
                          usun zakonczony przebieg (opcjonalnie z worktree; gałąź zostaje)
  status                  wersja daemona i protokolu
  shutdown                zatrzymaj agentow i daemona

<id> to identyfikator (r1) albo nazwa (a1) przebiegu.
Socket: --socket, $CONDUCTOR_SOCKET albo domyslna sciezka daemona.
";

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Start {
        repo: PathBuf,
        task: String,
        name: Option<String>,
        agent_cmd: Vec<String>,
    },
    List,
    Logs {
        id: String,
        follow: bool,
    },
    Send {
        id: String,
        text: String,
        newline: bool,
    },
    Stop {
        id: String,
        timeout_ms: Option<u64>,
    },
    Rm {
        id: String,
        delete_worktree: bool,
    },
    Status,
    Shutdown,
    Help,
}

#[derive(Debug, PartialEq, Eq)]
struct Cli {
    socket: Option<PathBuf>,
    command: Command,
}

fn one_id(cmd: &str, rest: &[String]) -> Result<String, String> {
    match rest {
        [id] if !id.starts_with('-') => Ok(id.clone()),
        _ => Err(format!("`{cmd}` expects exactly one <id>")),
    }
}

fn parse_args(args: &[String]) -> Result<Cli, String> {
    let mut socket = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--socket" => {
                socket = Some(PathBuf::from(
                    args.get(i + 1).ok_or("--socket requires a value")?,
                ));
                i += 2;
            }
            "-h" | "--help" => {
                return Ok(Cli {
                    socket,
                    command: Command::Help,
                })
            }
            _ => break,
        }
    }
    let Some(cmd) = args.get(i) else {
        return Err("missing command".into());
    };
    let rest = &args[i + 1..];
    let command = match cmd.as_str() {
        "start" => parse_start(rest)?,
        "list" | "ls" => {
            if !rest.is_empty() {
                return Err("`list` takes no arguments".into());
            }
            Command::List
        }
        "logs" => {
            let mut follow = false;
            let mut pos = Vec::new();
            for a in rest {
                match a.as_str() {
                    "-f" | "--follow" => follow = true,
                    _ => pos.push(a.clone()),
                }
            }
            Command::Logs {
                id: one_id("logs", &pos)?,
                follow,
            }
        }
        "send" => {
            let mut newline = true;
            let mut pos = Vec::new();
            let mut literal = false;
            for a in rest {
                match a.as_str() {
                    "--no-newline" if !literal => newline = false,
                    "--" if !literal => literal = true,
                    _ => pos.push(a.clone()),
                }
            }
            let (id, words) = pos.split_first().ok_or("`send` expects <id> <text...>")?;
            Command::Send {
                id: id.clone(),
                text: words.join(" "),
                newline,
            }
        }
        "stop" => {
            let mut timeout_ms = None;
            let mut pos = Vec::new();
            let mut it = rest.iter();
            while let Some(a) = it.next() {
                if a == "--timeout-ms" {
                    let v = it.next().ok_or("--timeout-ms requires a value")?;
                    timeout_ms = Some(v.parse().map_err(|_| "--timeout-ms must be an integer")?);
                } else {
                    pos.push(a.clone());
                }
            }
            Command::Stop {
                id: one_id("stop", &pos)?,
                timeout_ms,
            }
        }
        "rm" => {
            let mut delete_worktree = false;
            let mut pos = Vec::new();
            for a in rest {
                match a.as_str() {
                    "--delete-worktree" => delete_worktree = true,
                    _ => pos.push(a.clone()),
                }
            }
            Command::Rm {
                id: one_id("rm", &pos)?,
                delete_worktree,
            }
        }
        "status" => Command::Status,
        "shutdown" => Command::Shutdown,
        "help" => Command::Help,
        other => return Err(format!("unknown command `{other}`")),
    };
    Ok(Cli { socket, command })
}

fn parse_start(rest: &[String]) -> Result<Command, String> {
    let mut repo = None;
    let mut task = None;
    let mut name = None;
    let mut it = rest.iter();
    let mut agent_cmd = Vec::new();
    while let Some(a) = it.next() {
        let mut value = |opt: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{opt} requires a value"))
        };
        match a.as_str() {
            "--repo" => repo = Some(PathBuf::from(value("--repo")?)),
            "--task" => task = Some(value("--task")?),
            "--name" => name = Some(value("--name")?),
            "--" => {
                agent_cmd = it.by_ref().cloned().collect();
                break;
            }
            other => {
                return Err(format!(
                    "start: unexpected argument `{other}` (agent command goes after --)"
                ))
            }
        }
    }
    if agent_cmd.is_empty() {
        return Err("start: missing agent command after --".into());
    }
    Ok(Command::Start {
        repo: repo.unwrap_or_else(|| PathBuf::from(".")),
        task: task.ok_or("start: --task is required")?,
        name,
        agent_cmd,
    })
}

fn print_runs(runs: &[RunInfo]) {
    let rows: Vec<[String; 8]> = runs
        .iter()
        .map(|r| {
            let exit = match (r.exit_code, r.signal) {
                (Some(c), _) => c.to_string(),
                (None, Some(s)) => format!("sig{s}"),
                (None, None) => "-".into(),
            };
            [
                r.run_id.clone(),
                r.name.clone(),
                r.state.clone(),
                exit,
                if r.sandboxed { "yes" } else { "NO" }.to_string(),
                r.output_bytes.to_string(),
                r.branch.clone(),
                r.worktree.clone(),
            ]
        })
        .collect();
    let header = [
        "ID", "NAME", "STATE", "EXIT", "SANDBOX", "OUT(B)", "BRANCH", "WORKTREE",
    ]
    .map(String::from);
    let mut widths = header.clone().map(|h| h.len());
    for row in &rows {
        for (w, c) in widths.iter_mut().zip(row) {
            *w = (*w).max(c.chars().count());
        }
    }
    for row in std::iter::once(&header).chain(&rows) {
        let line: Vec<String> = row
            .iter()
            .zip(widths)
            .map(|(c, w)| format!("{c:<w$}"))
            .collect();
        println!("{}", line.join("  ").trim_end());
    }
}

fn logs(c: &mut Client, id: &str, follow: bool) -> Result<(), ClientError> {
    let mut since = 0;
    let mut out = std::io::stdout().lock();
    loop {
        let r = c.run_output(RunOutputParams {
            run_id: id.to_owned(),
            since: Some(since),
            max_bytes: None,
            wait_ms: follow.then_some(1000),
        })?;
        if r.dropped > 0 {
            eprintln!("[conductor: {} bytes dropped from ring buffer]", r.dropped);
        }
        out.write_all(&r.data)?;
        out.flush()?;
        since = r.next_offset;
        if r.data.is_empty() && (!follow || r.exited) {
            if follow {
                match (r.exit_code, r.signal) {
                    (Some(code), _) => eprintln!("[conductor: {id} exited with code {code}]"),
                    (None, Some(sig)) => eprintln!("[conductor: {id} killed by signal {sig}]"),
                    _ => eprintln!("[conductor: {id} exited]"),
                }
            }
            return Ok(());
        }
    }
}

fn run(cli: Cli) -> Result<(), ClientError> {
    if cli.command == Command::Help {
        print!("{USAGE}");
        return Ok(());
    }
    let socket = match cli.socket {
        Some(s) => s,
        None => conductor_proto::paths::default_socket_path()?,
    };
    let (mut c, auth) = Client::connect_authenticated(&socket)?;
    match cli.command {
        Command::Help => unreachable!("handled above"),
        Command::Status => println!(
            "conductord {} on {} (protocol v{})",
            auth.daemon_version,
            socket.display(),
            auth.protocol_version
        ),
        Command::Start {
            repo,
            task,
            name,
            agent_cmd,
        } => {
            let repo = absolute(&repo)?;
            let r = c.run_start(RunStartParams {
                repo: repo.display().to_string(),
                task,
                agent_cmd,
                name,
            })?;
            println!(
                "started {} (name {})\n  branch:   {}\n  worktree: {}",
                r.run_id, r.name, r.branch, r.worktree
            );
        }
        Command::List => print_runs(&c.run_list()?),
        Command::Logs { id, follow } => logs(&mut c, &id, follow)?,
        Command::Send { id, text, newline } => {
            let mut data = text.into_bytes();
            if newline {
                data.push(b'\n');
            }
            let n = c.run_input(&id, &data)?;
            println!("sent {n} bytes to {id}");
        }
        Command::Stop { id, timeout_ms } => {
            let r = c.run_stop(&id, timeout_ms)?;
            let how = match (r.exit_code, r.signal) {
                (Some(code), _) => format!("exit code {code}"),
                (None, Some(sig)) => format!("signal {sig}"),
                _ => "unknown status".into(),
            };
            if r.already_exited {
                println!("{} had already exited ({how})", r.run_id);
            } else if r.killed {
                println!("{} killed with SIGKILL ({how})", r.run_id);
            } else {
                println!("{} stopped ({how})", r.run_id);
            }
        }
        Command::Rm {
            id,
            delete_worktree,
        } => {
            let r = c.run_remove(&id, delete_worktree)?;
            println!(
                "removed {}{}",
                r.run_id,
                if r.worktree_deleted {
                    " (worktree deleted, branch kept)"
                } else {
                    " (worktree kept)"
                }
            );
        }
        Command::Shutdown => {
            c.shutdown()?;
            println!("conductord is shutting down");
        }
    }
    Ok(())
}

fn absolute(p: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(p)
        .map_err(|e| std::io::Error::new(e.kind(), format!("{}: {e}", p.display())))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cli = match parse_args(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("conductor: {e}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("conductor: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(a: &[&str]) -> Result<Cli, String> {
        parse_args(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn start_with_agent_command() {
        let cli = p(&[
            "--socket",
            "/s",
            "start",
            "--repo",
            ".",
            "--task",
            "fix bug",
            "--name",
            "a1",
            "--",
            "bash",
            "-c",
            "echo --name x",
        ])
        .unwrap();
        assert_eq!(cli.socket, Some(PathBuf::from("/s")));
        assert_eq!(
            cli.command,
            Command::Start {
                repo: ".".into(),
                task: "fix bug".into(),
                name: Some("a1".into()),
                agent_cmd: vec!["bash".into(), "-c".into(), "echo --name x".into()],
            }
        );
        assert!(p(&["start", "--task", "t"]).is_err());
        assert!(p(&["start", "--repo", ".", "--", "x"]).is_err());
        assert!(p(&["start", "--task", "t", "bash"]).is_err());
    }

    #[test]
    fn other_commands() {
        assert_eq!(p(&["list"]).unwrap().command, Command::List);
        assert_eq!(
            p(&["logs", "a1", "-f"]).unwrap().command,
            Command::Logs {
                id: "a1".into(),
                follow: true
            }
        );
        assert_eq!(
            p(&["send", "r2", "hello", "world"]).unwrap().command,
            Command::Send {
                id: "r2".into(),
                text: "hello world".into(),
                newline: true
            }
        );
        assert_eq!(
            p(&["send", "--no-newline", "r2", "--", "--no-newline"])
                .unwrap()
                .command,
            Command::Send {
                id: "r2".into(),
                text: "--no-newline".into(),
                newline: false
            }
        );
        assert_eq!(
            p(&["stop", "r1", "--timeout-ms", "100"]).unwrap().command,
            Command::Stop {
                id: "r1".into(),
                timeout_ms: Some(100)
            }
        );
        assert_eq!(
            p(&["rm", "--delete-worktree", "r1"]).unwrap().command,
            Command::Rm {
                id: "r1".into(),
                delete_worktree: true
            }
        );
        assert_eq!(p(&["shutdown"]).unwrap().command, Command::Shutdown);
        assert!(p(&[]).is_err());
        assert!(p(&["logs"]).is_err());
        assert!(p(&["logs", "a", "b"]).is_err());
        assert!(p(&["frobnicate"]).is_err());
    }
}
