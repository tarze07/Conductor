//! Test integracyjny: prawdziwy `conductord` w tymczasowym repozytorium git,
//! sterowany przez klienta z `conductor-proto` (ten sam kod co CLI).

use conductor_proto::client::Client;
use conductor_proto::json::Value;
use conductor_proto::methods::{RunOutputParams, RunStartParams};
use conductor_proto::paths::token_path;
use conductor_proto::rpc::code;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Env {
    root: PathBuf,
    repo: PathBuf,
    socket: PathBuf,
    daemon: Option<Child>,
}

impl Env {
    fn new() -> Env {
        let root = std::env::temp_dir().join(format!(
            "cdtest-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "--quiet", "-b", "main"]);
        git(&repo, &["config", "user.email", "test@example.invalid"]);
        git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("README.md"), "test repo\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "--quiet", "-m", "init"]);

        let socket = root.join("run").join("conductord.sock");
        let daemon = Command::new(env!("CARGO_BIN_EXE_conductord"))
            .arg("--socket")
            .arg(&socket)
            .arg("--worktree-root")
            .arg(root.join("worktrees"))
            .arg("--stop-timeout-ms")
            .arg("2000")
            // Ten test sprawdza IPC, worktree i runtime; sandbox: tests/sandbox.rs.
            .arg("--no-sandbox")
            .stdin(Stdio::null())
            .spawn()
            .expect("spawn conductord");
        let env = Env {
            root,
            repo,
            socket,
            daemon: Some(daemon),
        };
        env.wait_ready();
        env
    }

    fn wait_ready(&self) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if token_path(&self.socket).exists() && Client::connect(&self.socket).is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("conductord did not become ready");
    }

    fn client(&self) -> Client {
        Client::connect_authenticated(&self.socket).unwrap().0
    }

    /// Zbiera wyjście aż do zakończenia agenta.
    fn output_until_exit(&self, c: &mut Client, id: &str) -> (String, Option<i32>, Option<i32>) {
        let mut since = 0;
        let mut out = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(20);
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
            assert_eq!(r.dropped, 0);
            out.extend_from_slice(&r.data);
            since = r.next_offset;
            if r.exited && r.data.is_empty() {
                return (
                    String::from_utf8_lossy(&out).into_owned(),
                    r.exit_code,
                    r.signal,
                );
            }
        }
    }

    fn wait_for_output(&self, c: &mut Client, id: &str, needle: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let r = c
                .run_output(RunOutputParams {
                    run_id: id.into(),
                    since: Some(0),
                    max_bytes: None,
                    wait_ms: Some(200),
                })
                .unwrap();
            if String::from_utf8_lossy(&r.data).contains(needle) {
                return;
            }
        }
        panic!("{id}: `{needle}` not seen in output");
    }

    fn shutdown_and_wait(&mut self) {
        self.client().shutdown().unwrap();
        let mut child = self.daemon.take().unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(st) = child.try_wait().unwrap() {
                assert!(st.success(), "daemon exit status {st}");
                break;
            }
            assert!(Instant::now() < deadline, "daemon did not exit");
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!self.socket.exists(), "socket not removed");
        assert!(!token_path(&self.socket).exists(), "token not removed");
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        if let Some(mut d) = self.daemon.take() {
            let _ = d.kill();
            let _ = d.wait();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
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
    String::from_utf8(out.stdout).unwrap()
}

const AGENT_SCRIPT: &str = r#"echo "work of $CONDUCTOR_RUN_NAME" > agent-output.txt
echo "hello from $CONDUCTOR_RUN_NAME on $(git rev-parse --abbrev-ref HEAD)"
exit "$0""#;

#[test]
fn three_agents_in_three_worktrees() {
    let mut env = Env::new();
    let mut c = env.client();

    let mut started = Vec::new();
    for (name, code) in [("a1", 0), ("a2", 3), ("a3", 7)] {
        let r = c
            .run_start(RunStartParams {
                repo: env.repo.display().to_string(),
                task: "Fix the bug #12".into(),
                agent_cmd: vec![
                    "sh".into(),
                    "-c".into(),
                    AGENT_SCRIPT.into(),
                    code.to_string(),
                ],
                name: Some(name.into()),
            })
            .unwrap();
        assert_eq!(r.name, name);
        assert_eq!(r.branch, format!("agent/fix-the-bug-12/{name}"));
        started.push((r, code));
    }

    // Duplikat nazwy jest odrzucany.
    let dup = c
        .run_start(RunStartParams {
            repo: env.repo.display().to_string(),
            task: "other".into(),
            agent_cmd: vec!["true".into()],
            name: Some("a1".into()),
        })
        .unwrap_err();
    assert_eq!(dup.rpc_code(), Some(code::CONFLICT));

    for (r, code) in &started {
        let (out, exit_code, signal) = env.output_until_exit(&mut c, &r.run_id);
        assert!(
            out.contains(&format!("hello from {} on {}", r.name, r.branch)),
            "{}: {out:?}",
            r.run_id
        );
        assert_eq!(exit_code, Some(*code), "{}", r.run_id);
        assert_eq!(signal, None);
        let wt = Path::new(&r.worktree);
        assert_eq!(
            std::fs::read_to_string(wt.join("agent-output.txt")).unwrap(),
            format!("work of {}\n", r.name)
        );
        assert!(wt.join("README.md").exists());
        // Agent pisał tylko w swoim worktree.
        assert!(!env.repo.join("agent-output.txt").exists());
    }

    // Osobne gałęzie i osobne worktree.
    let branches = git(
        &env.repo,
        &["branch", "--list", "agent/*", "--format=%(refname:short)"],
    );
    let mut branches: Vec<&str> = branches.lines().collect();
    branches.sort();
    assert_eq!(
        branches,
        [
            "agent/fix-the-bug-12/a1",
            "agent/fix-the-bug-12/a2",
            "agent/fix-the-bug-12/a3"
        ]
    );
    let wts = git(&env.repo, &["worktree", "list", "--porcelain"]);
    for (r, _) in &started {
        assert!(wts.contains(&format!("worktree {}", r.worktree)), "{wts}");
        assert!(
            wts.contains(&format!("branch refs/heads/{}", r.branch)),
            "{wts}"
        );
    }

    let list = c.run_list().unwrap();
    assert_eq!(list.len(), 3);
    assert!(list.iter().all(|r| r.state == "exited" && r.tty == "pty"));
    let codes: Vec<_> = list.iter().map(|r| r.exit_code).collect();
    assert_eq!(codes, [Some(0), Some(3), Some(7)]);

    // Interaktywny agent: input przez run.input (po nazwie zamiast run_id).
    let chat = c
        .run_start(RunStartParams {
            repo: env.repo.display().to_string(),
            task: "chat".into(),
            agent_cmd: vec![
                "sh".into(),
                "-c".into(),
                "echo ready; read line; echo got:$line".into(),
            ],
            name: Some("talker".into()),
        })
        .unwrap();
    env.wait_for_output(&mut c, "talker", "ready");
    assert_eq!(c.run_input("talker", b"ping\n").unwrap(), 5);
    let (out, code, _) = env.output_until_exit(&mut c, &chat.run_id);
    assert!(out.contains("got:ping"), "{out:?}");
    assert_eq!(code, Some(0));

    // Długo działający agent: usunięcie odrzucone, stop przez SIGTERM na grupę.
    let looper = c
        .run_start(RunStartParams {
            repo: env.repo.display().to_string(),
            task: "loop".into(),
            agent_cmd: vec![
                "sh".into(),
                "-c".into(),
                "echo looping; while :; do sleep 0.2; done".into(),
            ],
            name: None,
        })
        .unwrap();
    assert_eq!(looper.name, "a5");
    env.wait_for_output(&mut c, &looper.run_id, "looping");
    let busy = c.run_remove(&looper.run_id, true).unwrap_err();
    assert_eq!(busy.rpc_code(), Some(code::CONFLICT));
    let stop = c.run_stop(&looper.run_id, None).unwrap();
    assert!(!stop.already_exited && !stop.killed);
    assert_eq!(stop.signal, Some(15));

    let missing = c.run_stop("r999", None).unwrap_err();
    assert_eq!(missing.rpc_code(), Some(code::NOT_FOUND));

    // Sprzątanie: usuń przebiegi razem z worktree; gałęzie zostają.
    for r in c.run_list().unwrap() {
        let rm = c.run_remove(&r.run_id, true).unwrap();
        assert!(rm.worktree_deleted);
        assert!(
            !Path::new(&r.worktree).exists(),
            "{} still exists",
            r.worktree
        );
    }
    assert!(c.run_list().unwrap().is_empty());
    let wts = git(&env.repo, &["worktree", "list", "--porcelain"]);
    assert_eq!(wts.matches("worktree ").count(), 1, "{wts}");
    assert_eq!(
        git(&env.repo, &["branch", "--list", "agent/*"])
            .lines()
            .count(),
        5
    );

    env.shutdown_and_wait();
}

#[test]
fn authentication_is_enforced() {
    let mut env = Env::new();

    // Uprawnienia katalogu socketu i pliku z tokenem.
    let dir_mode = std::fs::metadata(env.socket.parent().unwrap())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(dir_mode & 0o777, 0o700);
    let tok_mode = std::fs::metadata(token_path(&env.socket))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(tok_mode & 0o777, 0o600);

    // Zły token: błąd UNAUTHORIZED i zamknięte połączenie.
    let mut bad = Client::connect(&env.socket).unwrap();
    let e = bad.auth("not-the-token").unwrap_err();
    assert_eq!(e.rpc_code(), Some(code::UNAUTHORIZED));
    assert!(bad.run_list().is_err());

    // Bez auth żadna metoda nie działa.
    let mut anon = Client::connect(&env.socket).unwrap();
    let e = anon.run_list().unwrap_err();
    assert_eq!(e.rpc_code(), Some(code::UNAUTHORIZED));

    // Niezgodna wersja protokołu.
    let token = conductor_proto::paths::read_token(&env.socket).unwrap();
    let mut old = Client::connect(&env.socket).unwrap();
    let e = old
        .call_raw(
            "auth",
            Value::object([
                ("token", Value::from(token.as_str())),
                ("protocol_version", Value::Int(999)),
            ]),
        )
        .unwrap_err();
    assert_eq!(e.rpc_code(), Some(code::UNSUPPORTED_VERSION));

    // Poprawny token: wersja protokołu w odpowiedzi, nieznana metoda -> METHOD_NOT_FOUND.
    let (mut good, auth) = Client::connect_authenticated(&env.socket).unwrap();
    assert_eq!(auth.protocol_version, conductor_proto::PROTOCOL_VERSION);
    let e = good
        .call_raw("run.explode", Value::empty_object())
        .unwrap_err();
    assert_eq!(e.rpc_code(), Some(code::METHOD_NOT_FOUND));
    let e = good
        .call_raw("run.start", Value::object([("repo", Value::from("/x"))]))
        .unwrap_err();
    assert_eq!(e.rpc_code(), Some(code::INVALID_PARAMS));
    // Repo, które nie jest repozytorium git.
    let e = good
        .run_start(RunStartParams {
            repo: env.root.display().to_string(),
            task: "t".into(),
            agent_cmd: vec!["true".into()],
            name: None,
        })
        .unwrap_err();
    assert_eq!(e.rpc_code(), Some(code::GIT_ERROR));
    // Agent, którego nie da się uruchomić: błąd i wycofanie worktree oraz gałęzi.
    let e = good
        .run_start(RunStartParams {
            repo: env.repo.display().to_string(),
            task: "t".into(),
            agent_cmd: vec!["/nonexistent/agent".into()],
            name: Some("ghost".into()),
        })
        .unwrap_err();
    assert_eq!(e.rpc_code(), Some(code::SPAWN_ERROR));
    assert!(git(&env.repo, &["branch", "--list", "agent/*"]).is_empty());
    assert_eq!(
        git(&env.repo, &["worktree", "list", "--porcelain"])
            .matches("worktree ")
            .count(),
        1
    );

    env.shutdown_and_wait();
}
