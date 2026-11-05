//! Integracja sandboksa agentów (ADR-002, issue #14).
//!
//! Daemon nie tworzy namespace'ów sam: uruchamia agenta przez launcher z
//! `prototypes/sandbox-linux/run-sandboxed.sh`, któremu podaje:
//! - efektywną allowlistę Egress Guard (warstwa organizacji ∩ warstwa projektu),
//! - montowania metadanych git worktree, żeby `git status`/`git commit` działały,
//!   a agent nie mógł zmienić konfiguracji repozytorium ani cudzych gałęzi,
//! - wspólny audit log daemona (Egress Guard dopisuje do niego swoje wpisy),
//! - jawną listę zmiennych środowiskowych, które mają trafić do sandboksa.
//!
//! Docelowo (ADR-002) ta logika przechodzi do Rusta w `conductord`; interfejs
//! modułu (`Sandbox::prepare`) ma się przy tym nie zmienić.

use crate::log::timestamp;
use crate::workspace::{GitPaths, Worktree};
use conductor_proto::Value;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::SystemTime;

/// Plik allowlisty projektu, czytany z głównego checkoutu repozytorium
/// (nie z worktree agenta, którego treść agent kontroluje).
pub const PROJECT_ALLOWLIST: &str = ".conductor/egress-allowlist.txt";

/// Identyfikator sandboksa dla agenta (domyślny git autor commitów agenta).
const AGENT_EMAIL_DOMAIN: &str = "agents.conductor.invalid";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxConfig {
    /// Ścieżka do `run-sandboxed.sh`.
    pub launcher: PathBuf,
    /// Allowlista organizacji. `None` = brak jakiegokolwiek wyjścia do sieci.
    pub org_allowlist: Option<PathBuf>,
    /// `auto` | `bwrap` | `unshare` (przekazywane do launchera).
    pub backend: Option<String>,
    /// Pełny `/etc` zamiast minimalnego.
    pub full_etc: bool,
    /// Limity zasobów cgroup v2 (issue #15).
    pub limits: Limits,
}

// --- limity zasobów (cgroup v2, issue #15) ---------------------------------------

/// Limity per przebieg przekazywane launcherowi (`--cgroups`, `--pids-max` itd.).
/// Wartości w formacie plików cgroup v2; `max` = bez limitu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    /// `required` | `best-effort` | `off`.
    pub cgroups: String,
    pub pids_max: String,
    pub memory_max: String,
    pub memory_swap_max: String,
    /// `cpu.max`: `"QUOTA PERIOD"` albo `max`.
    pub cpu_max: String,
}

impl Default for Limits {
    /// Domyślne wartości daemona: dość dla buildów (cargo, gradle), a fork bomba
    /// albo wyciek pamięci jednego agenta nie położy stacji ani pozostałych agentów.
    fn default() -> Limits {
        Limits {
            cgroups: "best-effort".into(),
            pids_max: "4096".into(),
            memory_max: "8G".into(),
            memory_swap_max: "0".into(),
            cpu_max: "max".into(),
        }
    }
}

fn valid_size(v: &str) -> bool {
    let digits = v.strip_suffix(['K', 'M', 'G', 'T']).unwrap_or(v);
    v == "max" || (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

fn valid_number(v: &str) -> bool {
    v == "max" || (!v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
}

impl Limits {
    /// Ustawia opcję `--sandbox-<name>` (bez prefiksu); błąd przy złej wartości.
    pub fn set(&mut self, name: &str, v: String) -> Result<(), String> {
        let ok = match name {
            "cgroups" => matches!(v.as_str(), "required" | "best-effort" | "off"),
            "pids-max" => valid_number(&v),
            "memory-max" | "memory-swap-max" => valid_size(&v),
            "cpu-max" => {
                let mut it = v.split(' ');
                let quota = it.next().unwrap_or_default();
                let period = it.next();
                valid_number(quota)
                    && period.is_none_or(|p| p != "max" && valid_number(p))
                    && it.next().is_none()
            }
            _ => return Err(format!("unknown sandbox limit `{name}`")),
        };
        if !ok {
            return Err(format!("invalid value for --sandbox-{name}: `{v}`"));
        }
        let slot = match name {
            "cgroups" => &mut self.cgroups,
            "pids-max" => &mut self.pids_max,
            "memory-max" => &mut self.memory_max,
            "memory-swap-max" => &mut self.memory_swap_max,
            _ => &mut self.cpu_max,
        };
        *slot = v;
        Ok(())
    }

    /// Argumenty launchera.
    pub fn args(&self) -> Vec<String> {
        [
            ("--cgroups", &self.cgroups),
            ("--pids-max", &self.pids_max),
            ("--memory-max", &self.memory_max),
            ("--memory-swap-max", &self.memory_swap_max),
            ("--cpu-max", &self.cpu_max),
        ]
        .into_iter()
        .flat_map(|(k, v)| [k.to_owned(), v.clone()])
        .collect()
    }
}

// --- allowlista -----------------------------------------------------------------

/// Reguła allowlisty: `host[:port] [plaintext]`, wildcard tylko jako `*.` na początku.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub host: String,
    pub port: u16,
    pub plaintext: bool,
}

impl Rule {
    fn render(&self) -> String {
        let mut s = format!("{}:{}", self.host, self.port);
        if self.plaintext {
            s.push_str(" plaintext");
        }
        s
    }
}

fn valid_host(h: &str) -> bool {
    let base = h.strip_prefix("*.").unwrap_or(h);
    !base.is_empty()
        && base.len() <= 253
        && base.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

/// Parsuje allowlistę w formacie Egress Guard (komentarze `#`, puste linie pomijane).
pub fn parse_allowlist(text: &str) -> Result<Vec<Rule>, String> {
    let mut rules = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let err = |m: &str| format!("line {}: {m}: `{}`", i + 1, raw.trim());
        let mut parts = line.split_whitespace();
        let target = parts.next().unwrap_or_default().to_ascii_lowercase();
        let plaintext = match parts.next() {
            None => false,
            Some("plaintext") => true,
            Some(_) => return Err(err("unknown flag (only `plaintext` is allowed)")),
        };
        if parts.next().is_some() {
            return Err(err("too many fields"));
        }
        let (host, port) = match target.rsplit_once(':') {
            Some((h, p)) => (
                h.to_owned(),
                p.parse::<u16>()
                    .ok()
                    .filter(|p| *p > 0)
                    .ok_or_else(|| err("invalid port"))?,
            ),
            None => (target.clone(), 443),
        };
        if !valid_host(&host) {
            return Err(err("invalid host name"));
        }
        rules.push(Rule {
            host,
            port,
            plaintext,
        });
    }
    Ok(rules)
}

/// Czy wzorzec hosta organizacji obejmuje wzorzec hosta projektu.
fn host_covers(org: &str, project: &str) -> bool {
    if org == project {
        return true;
    }
    match org.strip_prefix("*.") {
        Some(suffix) => {
            let base = project.strip_prefix("*.").unwrap_or(project);
            base.ends_with(&format!(".{suffix}"))
        }
        None => false,
    }
}

/// Wynik łączenia warstw allowlisty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Effective {
    pub rules: Vec<Rule>,
    /// Reguły projektu odrzucone, bo warstwa organizacji ich nie obejmuje.
    pub dropped: Vec<Rule>,
}

/// Niższa warstwa (projekt) może tylko zawężać wyższą (organizację), ADR-003.
/// Brak allowlisty organizacji oznacza brak dostępu do sieci.
pub fn effective_allowlist(org: Option<&[Rule]>, project: Option<&[Rule]>) -> Effective {
    match (org, project) {
        (None, p) => Effective {
            rules: Vec::new(),
            dropped: p.map(<[Rule]>::to_vec).unwrap_or_default(),
        },
        (Some(o), None) => Effective {
            rules: o.to_vec(),
            dropped: Vec::new(),
        },
        (Some(o), Some(p)) => {
            let (rules, dropped) = p.iter().cloned().partition(|r| {
                o.iter().any(|or| {
                    or.port == r.port
                        && host_covers(&or.host, &r.host)
                        && (or.plaintext || !r.plaintext)
                })
            });
            Effective { rules, dropped }
        }
    }
}

fn read_allowlist(path: &Path) -> Result<Vec<Rule>, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse_allowlist(&text).map_err(|e| format!("{}: {e}", path.display()))
}

// --- audyt ----------------------------------------------------------------------

/// Wspólny audit log daemona (JSON lines, append-only). Egress Guard każdego
/// sandboksa dopisuje do tego samego pliku (`O_APPEND`, jedna linia = jeden zapis).
/// Łańcuch hashy: issue #17.
pub struct Audit {
    path: PathBuf,
    lock: Mutex<()>,
}

impl Audit {
    pub fn new(path: PathBuf) -> Audit {
        Audit {
            path,
            lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn event(&self, event: &str, fields: Vec<(&str, Value)>) {
        let mut pairs = vec![
            ("ts", Value::from(timestamp(SystemTime::now()))),
            ("component", Value::from("conductord")),
            ("event", Value::from(event)),
        ];
        pairs.extend(fields);
        let mut line = Value::object(pairs).to_string();
        line.push('\n');
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let res = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&self.path)
            .and_then(|mut f| f.write_all(line.as_bytes()));
        if let Err(e) = res {
            crate::log::log_error!("audit log {}: {e}", self.path.display());
        }
    }
}

pub fn rules_value(rules: &[Rule]) -> Value {
    Value::Array(rules.iter().map(|r| Value::from(r.render())).collect())
}

// --- przygotowanie uruchomienia -------------------------------------------------

/// Wszystko, czego Agent Runtime potrzebuje, żeby uruchomić agenta w sandboksie.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub argv: Vec<String>,
    /// Pełne środowisko launchera (daemon czyści swoje środowisko).
    pub env: Vec<(String, String)>,
    pub allowlist: Effective,
}

pub struct Sandbox {
    cfg: SandboxConfig,
    org: Option<Vec<Rule>>,
    runs_dir: PathBuf,
    pub audit: Audit,
}

fn mkdir_private(dir: &Path) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

fn path_str(p: &Path) -> Result<String, String> {
    p.to_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("non UTF-8 path: {}", p.display()))
}

/// Montowanie przekazywane launcherowi (`--ro`/`--rw`), w kolejności.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mount {
    Ro(PathBuf),
    Rw(PathBuf),
}

/// Montowania metadanych git dla worktree agenta:
/// - `<common>` (cały `.git` repo) tylko do odczytu: config, hooks, inne gałęzie,
/// - `<common>/objects` do zapisu: nowe obiekty commitów agenta,
/// - `<common>/refs/heads/<katalog gałęzi agenta>` i odpowiadający mu reflog do zapisu,
/// - `<common>/worktrees/<id>` (index, HEAD) do zapisu, ale pliki `commondir`
///   i `gitdir` oraz plik `.git` w worktree tylko do odczytu: agent nie może
///   przepiąć worktree na inne repozytorium ani podsunąć hostowi obcego `gitdir`.
pub fn git_mounts(git: &GitPaths, wt: &Worktree) -> Result<Vec<Mount>, String> {
    let branch_dir = Path::new(&wt.branch)
        .parent()
        .ok_or_else(|| format!("unexpected branch name `{}`", wt.branch))?;
    let refs_dir = git.common_dir.join("refs/heads").join(branch_dir);
    let logs_dir = git.common_dir.join("logs/refs/heads").join(branch_dir);
    for d in [&refs_dir, &logs_dir] {
        fs::create_dir_all(d).map_err(|e| format!("cannot create {}: {e}", d.display()))?;
    }
    let mut m = vec![
        Mount::Ro(git.common_dir.clone()),
        Mount::Rw(git.common_dir.join("objects")),
        Mount::Rw(refs_dir),
        Mount::Rw(logs_dir),
        Mount::Rw(git.git_dir.clone()),
    ];
    for f in ["commondir", "gitdir"] {
        let p = git.git_dir.join(f);
        if p.exists() {
            m.push(Mount::Ro(p));
        }
    }
    m.push(Mount::Ro(wt.path.join(".git")));
    Ok(m)
}

impl Sandbox {
    /// Sprawdza konfigurację i przygotowuje katalog stanu `<state>/runs` (0700).
    pub fn new(cfg: SandboxConfig, state_dir: &Path) -> Result<Sandbox, String> {
        let meta = fs::metadata(&cfg.launcher)
            .map_err(|e| format!("sandbox launcher {}: {e}", cfg.launcher.display()))?;
        if !meta.is_file() || meta.permissions().mode() & 0o111 == 0 {
            return Err(format!(
                "sandbox launcher {} is not an executable file",
                cfg.launcher.display()
            ));
        }
        let org = cfg
            .org_allowlist
            .as_deref()
            .map(read_allowlist)
            .transpose()?;
        let runs_dir = state_dir.join("runs");
        mkdir_private(state_dir).map_err(|e| format!("{}: {e}", state_dir.display()))?;
        // Pozostałości po poprzednim uruchomieniu daemona (identyfikatory r1, r2...
        // zaczynają się od nowa) usuwamy: to wyłącznie katalogi tymczasowe launchera.
        let _ = fs::remove_dir_all(&runs_dir);
        mkdir_private(&runs_dir).map_err(|e| format!("{}: {e}", runs_dir.display()))?;
        Ok(Sandbox {
            audit: Audit::new(state_dir.join("audit.jsonl")),
            cfg,
            org,
            runs_dir,
        })
    }

    pub fn org_rules(&self) -> Option<&[Rule]> {
        self.org.as_deref()
    }

    fn launcher_env(&self) -> Vec<(String, String)> {
        // Launcher potrzebuje PATH (python3, unshare, bwrap) i locale; nic więcej
        // ze środowiska daemona (tokeny, SANDBOX_* itp.) nie przechodzi.
        let mut env = vec![(
            "PATH".to_owned(),
            std::env::var("PATH")
                .unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into()),
        )];
        for k in ["LANG", "LC_ALL"] {
            if let Ok(v) = std::env::var(k) {
                env.push((k.to_owned(), v));
            }
        }
        env
    }

    /// Buduje wywołanie launchera dla przebiegu `run_id`.
    pub fn prepare(
        &self,
        run_id: &str,
        run_name: &str,
        wt: &Worktree,
        git: &GitPaths,
        agent_cmd: &[String],
        agent_env: &[(String, String)],
    ) -> Result<Prepared, String> {
        let project = {
            let p = wt.repo_root.join(PROJECT_ALLOWLIST);
            if p.exists() {
                Some(read_allowlist(&p)?)
            } else {
                None
            }
        };
        let allowlist = effective_allowlist(self.org.as_deref(), project.as_deref());

        let run_dir = self.runs_dir.join(run_id);
        let _ = fs::remove_dir_all(&run_dir);
        mkdir_private(&run_dir).map_err(|e| format!("{}: {e}", run_dir.display()))?;
        let allowlist_file = run_dir.join("egress-allowlist.txt");
        let mut text = String::from("# wygenerowane przez conductord: organizacja ∩ projekt\n");
        for r in &allowlist.rules {
            text.push_str(&r.render());
            text.push('\n');
        }
        fs::write(&allowlist_file, text)
            .map_err(|e| format!("{}: {e}", allowlist_file.display()))?;

        // TMPDIR launchera zostaje domyślny (/tmp): ścieżka socketu Egress Guard
        // musi się zmieścić w limicie AF_UNIX (108 bajtów).
        let mut env = self.launcher_env();
        let author = format!("Conductor agent {run_name}");
        let email = format!("{run_name}@{AGENT_EMAIL_DOMAIN}");
        let mut inner: Vec<(String, String)> = agent_env.to_vec();
        inner.extend([
            ("GIT_AUTHOR_NAME".into(), author.clone()),
            ("GIT_AUTHOR_EMAIL".into(), email.clone()),
            ("GIT_COMMITTER_NAME".into(), author),
            ("GIT_COMMITTER_EMAIL".into(), email),
            // Agent nie ma prawa zapisu do packed-refs ani reszty .git: gc wyłączone.
            ("GIT_CONFIG_COUNT".into(), "1".into()),
            ("GIT_CONFIG_KEY_0".into(), "gc.auto".into()),
            ("GIT_CONFIG_VALUE_0".into(), "0".into()),
        ]);

        let mut argv = vec![
            path_str(&self.cfg.launcher)?,
            "--id".into(),
            run_id.into(),
            "--allowlist".into(),
            path_str(&allowlist_file)?,
            "--audit-log".into(),
            path_str(self.audit.path())?,
            "--etc".into(),
            if self.cfg.full_etc { "full" } else { "minimal" }.into(),
        ];
        if let Some(b) = &self.cfg.backend {
            argv.extend(["--backend".into(), b.clone()]);
        }
        argv.extend(self.cfg.limits.args());
        for (k, _) in &inner {
            argv.extend(["--pass-env".into(), k.clone()]);
        }
        for m in git_mounts(git, wt)? {
            let (flag, p) = match &m {
                Mount::Ro(p) => ("--ro", p),
                Mount::Rw(p) => ("--rw", p),
            };
            argv.extend([flag.into(), path_str(p)?]);
        }
        argv.push(path_str(&wt.path)?);
        argv.push("--".into());
        argv.extend(agent_cmd.iter().cloned());
        env.extend(inner);
        Ok(Prepared {
            argv,
            env,
            allowlist,
        })
    }

    /// Usuwa katalog tymczasowy przebiegu.
    pub fn cleanup(&self, run_id: &str) {
        let _ = fs::remove_dir_all(self.runs_dir.join(run_id));
    }

    /// Próbny sandbox przy starcie daemona: jeśli namespace'y nie działają, daemon
    /// nie startuje (zamiast uruchamiać agentów bez izolacji albo odrzucać każdy start).
    pub fn self_test(&self) -> Result<(), String> {
        let dir = self.runs_dir.join("self-test");
        mkdir_private(&dir).map_err(|e| e.to_string())?;
        let wt = dir.join("worktree");
        mkdir_private(&wt).map_err(|e| e.to_string())?;
        let allow = dir.join("allowlist.txt");
        fs::write(&allow, "").map_err(|e| e.to_string())?;
        let mut cmd = Command::new(&self.cfg.launcher);
        crate::ffi::configure_pipe_child(&mut cmd);
        cmd.env_clear()
            .envs(self.launcher_env())
            .args(["--id", "self-test", "--allowlist"])
            .arg(&allow)
            .arg("--audit-log")
            .arg(dir.join("audit.jsonl"));
        if let Some(b) = &self.cfg.backend {
            cmd.args(["--backend", b]);
        }
        cmd.args(self.cfg.limits.args());
        let out = cmd
            .arg(&wt)
            .args(["--", "/bin/sh", "-c", "echo sandbox-ok"])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("cannot run sandbox launcher: {e}"))?;
        let _ = fs::remove_dir_all(&dir);
        let stdout = String::from_utf8_lossy(&out.stdout);
        if out.status.success() && stdout.trim() == "sandbox-ok" {
            log_self_test_warnings(&String::from_utf8_lossy(&out.stderr));
            Ok(())
        } else {
            Err(format!(
                "sandbox self-test failed ({}): {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }
}

/// Ostrzeżenia launchera z próbnego sandboksa (np. cgroup v2 niedostępne przy
/// `--sandbox-cgroups best-effort`) trafiają do logu daemona przy starcie.
fn log_self_test_warnings(stderr: &str) {
    for line in stderr.lines().filter(|l| l.starts_with("sandbox:")) {
        crate::log::log_warn!("sandbox self-test: {line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_validation_and_args() {
        let mut l = Limits::default();
        assert_eq!(
            l.args(),
            [
                "--cgroups",
                "best-effort",
                "--pids-max",
                "4096",
                "--memory-max",
                "8G",
                "--memory-swap-max",
                "0",
                "--cpu-max",
                "max"
            ]
        );
        for (k, v) in [
            ("cgroups", "required"),
            ("pids-max", "64"),
            ("memory-max", "512M"),
            ("memory-swap-max", "max"),
            ("cpu-max", "200000 100000"),
        ] {
            l.set(k, v.into()).unwrap();
        }
        assert_eq!(l.cpu_max, "200000 100000");
        assert_eq!(l.cgroups, "required");
        for (k, v) in [
            ("cgroups", "maybe"),
            ("pids-max", "-1"),
            ("pids-max", ""),
            ("memory-max", "1.5G"),
            ("memory-max", "G"),
            ("cpu-max", "100000 max"),
            ("cpu-max", "1 2 3"),
            ("cpu-max", "2 CPU"),
            ("bogus", "1"),
        ] {
            assert!(l.set(k, v.into()).is_err(), "{k}={v}");
        }
    }

    fn r(host: &str, port: u16, plaintext: bool) -> Rule {
        Rule {
            host: host.into(),
            port,
            plaintext,
        }
    }

    #[test]
    fn parses_allowlist() {
        let rules = parse_allowlist(
            "# komentarz\n\nLLM-Gateway.corp.example:443\n*.mirror.corp.example  # mirror\nlocalhost:18080 plaintext\n",
        )
        .unwrap();
        assert_eq!(
            rules,
            vec![
                r("llm-gateway.corp.example", 443, false),
                r("*.mirror.corp.example", 443, false),
                r("localhost", 18080, true),
            ]
        );
    }

    #[test]
    fn rejects_bad_allowlist() {
        for bad in [
            "host:0",
            "host:99999",
            "host:443 tls",
            "a b c",
            "foo.*.example",
            "*",
            "-bad.example",
            "1.1.1.1:443:1",
            "under_score.example",
        ] {
            assert!(parse_allowlist(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn host_coverage() {
        assert!(host_covers("a.example", "a.example"));
        assert!(host_covers("*.example", "a.example"));
        assert!(host_covers("*.example", "x.a.example"));
        assert!(host_covers("*.example", "*.a.example"));
        assert!(host_covers("*.example", "*.example"));
        assert!(!host_covers("*.example", "example"));
        assert!(!host_covers("a.example", "*.a.example"));
        assert!(!host_covers("a.example", "b.example"));
        assert!(!host_covers("*.example", "evil-example"));
        assert!(!host_covers("*.example", "a.example.evil"));
    }

    #[test]
    fn layers_only_narrow() {
        let org = vec![r("*.corp.example", 443, false), r("localhost", 8080, true)];
        let project = vec![
            r("llm.corp.example", 443, false),
            r("evil.example", 443, false),
            r("llm.corp.example", 80, true),
            r("localhost", 8080, true),
        ];
        let e = effective_allowlist(Some(&org), Some(&project));
        assert_eq!(
            e.rules,
            vec![
                r("llm.corp.example", 443, false),
                r("localhost", 8080, true)
            ]
        );
        assert_eq!(
            e.dropped,
            vec![
                r("evil.example", 443, false),
                r("llm.corp.example", 80, true)
            ]
        );
        // Bez projektu: obowiązuje organizacja.
        assert_eq!(effective_allowlist(Some(&org), None).rules, org);
        // Bez organizacji: brak sieci, niezależnie od projektu.
        let e = effective_allowlist(None, Some(&project));
        assert!(e.rules.is_empty());
        assert_eq!(e.dropped.len(), 4);
        // TLS-owa reguła organizacji nie dopuszcza ruchu bez TLS.
        let e = effective_allowlist(
            Some(&[r("localhost", 8080, false)]),
            Some(&[r("localhost", 8080, true)]),
        );
        assert!(e.rules.is_empty());
    }

    #[test]
    fn git_mount_order() {
        let tmp = std::env::temp_dir().join(format!("cd-sbx-unit-{}", std::process::id()));
        let git = GitPaths {
            common_dir: tmp.join("repo/.git"),
            git_dir: tmp.join("repo/.git/worktrees/a1"),
        };
        fs::create_dir_all(&git.git_dir).unwrap();
        fs::write(git.git_dir.join("commondir"), "../..\n").unwrap();
        let wt = Worktree {
            repo_root: tmp.join("repo"),
            path: tmp.join("wt/fix/a1"),
            branch: "agent/fix/a1".into(),
        };
        let m = git_mounts(&git, &wt).unwrap();
        let c = &git.common_dir;
        assert_eq!(
            m,
            vec![
                Mount::Ro(c.clone()),
                Mount::Rw(c.join("objects")),
                Mount::Rw(c.join("refs/heads/agent/fix")),
                Mount::Rw(c.join("logs/refs/heads/agent/fix")),
                Mount::Rw(git.git_dir.clone()),
                Mount::Ro(git.git_dir.join("commondir")),
                Mount::Ro(wt.path.join(".git")),
            ]
        );
        assert!(c.join("refs/heads/agent/fix").is_dir());
        let _ = fs::remove_dir_all(&tmp);
    }
}
