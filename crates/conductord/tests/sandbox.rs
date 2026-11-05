//! Test integracyjny sandboksa (issue #14): prawdziwy `conductord` uruchamia agenta
//! przez launcher z `prototypes/sandbox-linux/`. Agent (skrypt w Pythonie) próbuje
//! sieci, zapisu poza worktree, zmiany metadanych git i robi commit; test sprawdza
//! wynik po stronie hosta i w audit logu.
//!
//! Test jest pomijany (z komunikatem), gdy środowisko nie pozwala na namespace'y.

use conductor_proto::client::Client;
use conductor_proto::methods::{RunOutputParams, RunStartParams};
use conductor_proto::paths::token_path;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn launcher() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../prototypes/sandbox-linux/run-sandboxed.sh")
        .canonicalize()
        .expect("launcher exists")
}

fn sandbox_supported() -> bool {
    let ok = |c: &mut Command| {
        c.stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    let userns = if unsafe_euid_is_root() {
        ok(Command::new("unshare").args(["--net", "--mount", "--pid", "--fork", "true"]))
    } else {
        ok(Command::new("unshare").args(["--user", "--map-root-user", "--net", "true"]))
    };
    userns && ok(Command::new("python3").arg("--version"))
}

fn unsafe_euid_is_root() -> bool {
    // Bez libc: właściciel /proc/self to efektywny uid procesu.
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata("/proc/self").is_ok_and(|m| m.uid() == 0)
}

fn bwrap_available() -> bool {
    Command::new("bwrap")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// Agent: każda próba drukuje jeden znacznik, test sprawdza znaczniki.
const AGENT: &str = r#"
import os, socket, subprocess, sys
port, outside, gitconfig = sys.argv[1], sys.argv[2], sys.argv[3]

def connect(target):
    s = socket.create_connection(("127.0.0.1", 3128), timeout=5)
    s.sendall(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
    return s, s.recv(4096).decode(errors="replace").split("\r\n")[0]

s, line = connect(f"localhost:{port}")
if " 200" in line:
    s.sendall(b"GET /hello HTTP/1.0\r\nHost: localhost\r\n\r\n")
    print("ALLOWED_OK" if b"hello-from-gateway" in s.recv(4096) else "ALLOWED_BAD")
else:
    print("ALLOWED_REFUSED", line)
_, line = connect("evil.example:443")
print("EVIL_ALLOWED" if " 200" in line else "EVIL_DENIED")
try:
    socket.create_connection(("1.1.1.1", 443), timeout=2); print("DIRECT_OK")
except OSError:
    print("DIRECT_BLOCKED")

def attempt(name, fn):
    try:
        fn(); print(name + "_WRITTEN")
    except OSError:
        print(name + "_BLOCKED")

# Zapis "obok" worktree trafia najwyzej do prywatnego tmpfs sandboksa; test sprawdza hosta.
attempt("OUTSIDE", lambda: open(outside, "w").write("x"))
attempt("CHECKOUT", lambda: open(os.path.join(os.path.dirname(os.path.dirname(gitconfig)), "agent.py"), "a").write("evil\n"))
attempt("CONFIG", lambda: open(gitconfig, "a").write("[core]\n\tfsmonitor = /tmp/evil\n"))
attempt("GITFILE", lambda: open(".git", "a").write("x"))

with open("work.txt", "w") as f:
    f.write("done by agent\n")
ok = subprocess.run(["git", "add", "work.txt"]).returncode == 0
ok = ok and subprocess.run(["git", "commit", "-q", "-m", "agent work"]).returncode == 0
print("COMMIT_OK" if ok else "COMMIT_FAILED")
r = subprocess.run(["git", "update-ref", "refs/heads/main", "HEAD"], capture_output=True)
print("MAIN_MOVED" if r.returncode == 0 else "MAIN_BLOCKED")
r = subprocess.run(["git", "status", "--porcelain"], capture_output=True, text=True)
print("STATUS_CLEAN" if r.returncode == 0 and r.stdout == "" else "STATUS_DIRTY " + repr(r.stdout))
print("TOKEN=" + os.environ.get("SECRET_TOKEN", "none"))
print("SANDBOX=" + os.environ.get("CONDUCTOR_SANDBOX", "0"))
"#;

struct Env {
    root: PathBuf,
    repo: PathBuf,
    socket: PathBuf,
    daemon: Option<Child>,
}

impl Drop for Env {
    fn drop(&mut self) {
        if let Some(mut d) = self.daemon.take() {
            if let Ok(mut c) = Client::connect_authenticated(&self.socket) {
                let _ = c.0.shutdown();
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if d.try_wait().ok().flatten().is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = d.kill();
            let _ = d.wait();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn setup(port: u16) -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "cdsbx-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&root);
    let repo = root.join("repo");
    std::fs::create_dir_all(repo.join(".conductor")).unwrap();
    git(&repo, &["init", "--quiet", "-b", "main"]);
    git(&repo, &["config", "user.email", "test@example.invalid"]);
    git(&repo, &["config", "user.name", "Test"]);
    std::fs::write(repo.join("agent.py"), AGENT).unwrap();
    // Projekt prosi o więcej niż pozwala organizacja: evil.example ma zostać odrzucony.
    std::fs::write(
        repo.join(".conductor/egress-allowlist.txt"),
        format!("localhost:{port} plaintext\nevil.example:443\n"),
    )
    .unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "--quiet", "-m", "init"]);
    std::fs::write(
        root.join("org-allowlist.txt"),
        format!("# organizacja\n*.corp.example:443\nlocalhost:{port} plaintext\n"),
    )
    .unwrap();
    (root, repo)
}

fn start_daemon(root: &Path, repo: &Path, backend: &str) -> Env {
    let socket = root.join("run").join("conductord.sock");
    let daemon = Command::new(env!("CARGO_BIN_EXE_conductord"))
        .arg("--socket")
        .arg(&socket)
        .arg("--worktree-root")
        .arg(root.join("worktrees"))
        .arg("--sandbox-launcher")
        .arg(launcher())
        .arg("--egress-allowlist")
        .arg(root.join("org-allowlist.txt"))
        .args(["--sandbox-backend", backend, "--stop-timeout-ms", "2000"])
        // Sekret w środowisku daemona nie może trafić do agenta.
        .env("SECRET_TOKEN", "leaked")
        .env("SANDBOX_RO_PATHS", "/root")
        .stdin(Stdio::null())
        .spawn()
        .expect("spawn conductord");
    let env = Env {
        root: root.to_owned(),
        repo: repo.to_owned(),
        socket,
        daemon: Some(daemon),
    };
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if token_path(&env.socket).exists() && Client::connect(&env.socket).is_ok() {
            return env;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("conductord did not become ready");
}

/// Udawany LLM Gateway na localhost.
fn gateway() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut s in l.incoming().flatten() {
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.0 200 OK\r\nContent-Length: 18\r\n\r\nhello-from-gateway");
        }
    });
    port
}

fn output_until_exit(c: &mut Client, id: &str) -> (String, Option<i32>) {
    let mut since = 0;
    let mut out = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        assert!(Instant::now() < deadline, "{id} did not exit in time");
        let r = c
            .run_output(RunOutputParams {
                run_id: id.into(),
                since: Some(since),
                max_bytes: None,
                wait_ms: Some(500),
            })
            .unwrap();
        out.extend_from_slice(&r.data);
        since = r.next_offset;
        if r.exited && r.data.is_empty() {
            return (String::from_utf8_lossy(&out).into_owned(), r.exit_code);
        }
    }
}

fn run_scenario(backend: &str) {
    let port = gateway();
    let (root, repo) = setup(port);
    let env = start_daemon(&root, &repo, backend);
    let outside = root.join("outside.txt");
    let gitconfig = repo.join(".git/config");
    let config_before = std::fs::read_to_string(&gitconfig).unwrap();
    let main_before = git(&repo, &["rev-parse", "main"]);

    let (mut c, _) = Client::connect_authenticated(&env.socket).unwrap();
    let started = c
        .run_start(RunStartParams {
            repo: env.repo.display().to_string(),
            task: "sbx task".into(),
            agent_cmd: vec![
                "python3".into(),
                "agent.py".into(),
                port.to_string(),
                outside.display().to_string(),
                gitconfig.display().to_string(),
            ],
            name: Some("s1".into()),
        })
        .unwrap();
    let (out, code) = output_until_exit(&mut c, &started.run_id);
    assert_eq!(code, Some(0), "[{backend}] agent output:\n{out}");
    for marker in [
        "ALLOWED_OK",
        "EVIL_DENIED",
        "DIRECT_BLOCKED",
        "CONFIG_BLOCKED",
        "GITFILE_BLOCKED",
        "COMMIT_OK",
        "MAIN_BLOCKED",
        "STATUS_CLEAN",
        "TOKEN=none",
        "SANDBOX=1",
    ] {
        assert!(
            out.contains(marker),
            "[{backend}] missing {marker} in:\n{out}"
        );
    }

    let runs = c.run_list().unwrap();
    assert!(runs[0].sandboxed, "[{backend}] run not marked as sandboxed");

    // Host: commit agenta jest na jego gałęzi, reszta repozytorium bez zmian.
    assert!(
        !outside.exists(),
        "[{backend}] write outside worktree reached host"
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("agent.py")).unwrap(),
        AGENT,
        "[{backend}] main checkout modified"
    );
    assert_eq!(std::fs::read_to_string(&gitconfig).unwrap(), config_before);
    assert_eq!(git(&repo, &["rev-parse", "main"]), main_before);
    assert_eq!(
        git(&repo, &["log", "-1", "--format=%s|%ae", &started.branch]),
        "agent work|s1@agents.conductor.invalid"
    );

    // Audit log: start z efektywną allowlistą i decyzje Egress Guard tego przebiegu.
    let audit = std::fs::read_to_string(root.join("run/state/audit.jsonl")).unwrap();
    let start_line = audit
        .lines()
        .find(|l| l.contains("\"event\":\"run.start\""))
        .unwrap_or_else(|| panic!("no run.start in audit:\n{audit}"));
    assert!(
        start_line.contains(&format!(
            "\"egress_allowlist\":[\"localhost:{port} plaintext\"]"
        )),
        "{start_line}"
    );
    assert!(
        start_line.contains("\"egress_dropped\":[\"evil.example:443\"]"),
        "{start_line}"
    );
    let guard: Vec<&str> = audit
        .lines()
        .filter(|l| {
            l.contains("\"component\":\"egress-guard\"") && l.contains("\"sandbox\":\"r1\"")
        })
        .collect();
    assert!(
        guard
            .iter()
            .any(|l| l.contains("\"decision\":\"allow\"") && l.contains("localhost")),
        "[{backend}] no allow entry:\n{audit}"
    );
    assert!(
        guard.iter().any(|l| l.contains("\"decision\":\"deny\"")
            && l.contains("evil.example")
            && l.contains("not_in_allowlist")),
        "[{backend}] no deny entry:\n{audit}"
    );

    // Sprzątanie: katalog tymczasowy przebiegu znika razem z przebiegiem.
    c.run_remove(&started.run_id, true).unwrap();
    assert!(!root.join("run/state/runs/r1").exists());
    assert!(std::fs::read_to_string(root.join("run/state/audit.jsonl"))
        .unwrap()
        .contains("\"event\":\"run.remove\""));
}

#[test]
fn agent_runs_isolated_unshare() {
    if !sandbox_supported() {
        eprintln!("SKIP: namespaces or python3 not available");
        return;
    }
    run_scenario("unshare");
}

#[test]
fn agent_runs_isolated_bwrap() {
    if !sandbox_supported() || !bwrap_available() {
        eprintln!("SKIP: bwrap not available");
        return;
    }
    run_scenario("bwrap");
}

#[test]
fn daemon_refuses_to_start_without_sandbox_choice() {
    let root = std::env::temp_dir().join(format!(
        "cdsbx-nostart-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let out = Command::new(env!("CARGO_BIN_EXE_conductord"))
        .arg("--socket")
        .arg(root.join("s.sock"))
        .env_remove("CONDUCTOR_SANDBOX_LAUNCHER")
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("no sandbox launcher"));

    let out = Command::new(env!("CARGO_BIN_EXE_conductord"))
        .arg("--socket")
        .arg(root.join("s.sock"))
        .args(["--sandbox-launcher", "/nonexistent/run-sandboxed.sh"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("sandbox launcher"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!root.join("s.sock").exists());
    let _ = std::fs::remove_dir_all(&root);
}
