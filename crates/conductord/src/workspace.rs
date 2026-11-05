//! Workspace Manager: worktree i gałęzie `agent/<task-slug>/<run-name>`.
//!
//! Wszystkie operacje git idą przez `std::process::Command` i są serializowane jednym
//! mutexem (git trzyma blokady w `.git/` i równoległe `worktree add` potrafią się
//! wywrócić na `index.lock`/`config.lock`).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

/// Maksymalna długość sluga zadania w nazwie gałęzi.
pub const MAX_SLUG_LEN: usize = 40;
pub const MAX_RUN_NAME_LEN: usize = 32;

/// Zamienia opis zadania na bezpieczny fragment nazwy gałęzi: małe litery ASCII, cyfry
/// i pojedyncze myślniki. Polskie znaki diakrytyczne są transliterowane.
pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in s.chars().flat_map(char::to_lowercase) {
        let c = match c {
            'ą' => 'a',
            'ć' => 'c',
            'ę' => 'e',
            'ł' => 'l',
            'ń' => 'n',
            'ó' => 'o',
            'ś' => 's',
            'ź' | 'ż' => 'z',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            let sep = dash && !out.is_empty();
            if out.len() + usize::from(sep) + 1 > MAX_SLUG_LEN {
                break;
            }
            if sep {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    if out.is_empty() {
        out.push_str("task");
    }
    out
}

/// Nazwa przebiegu trafia do nazwy gałęzi i ścieżki, więc dopuszczamy tylko
/// `[A-Za-z0-9_-]`, 1..=32 znaków, bez myślnika na początku.
pub fn validate_run_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > MAX_RUN_NAME_LEN {
        return Err(format!(
            "run name must have 1..={MAX_RUN_NAME_LEN} characters"
        ));
    }
    if name.starts_with('-') {
        return Err("run name must not start with '-'".into());
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("run name may contain only [A-Za-z0-9_-]".into());
    }
    Ok(())
}

pub fn branch_name(task_slug: &str, run_name: &str) -> String {
    format!("agent/{task_slug}/{run_name}")
}

/// Utworzony worktree.
#[derive(Debug, Clone)]
pub struct Worktree {
    pub repo_root: PathBuf,
    pub path: PathBuf,
    pub branch: String,
}

pub struct WorkspaceManager {
    git_lock: Mutex<()>,
    /// Gdzie tworzyć worktree. `None` = katalog `<repo>.worktrees` obok repozytorium.
    worktree_root: Option<PathBuf>,
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        // Zmienne z otoczenia (np. hook gita) nie mogą przekierować operacji na inne repo.
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_owned())
    } else {
        Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

impl WorkspaceManager {
    pub fn new(worktree_root: Option<PathBuf>) -> Self {
        WorkspaceManager {
            git_lock: Mutex::new(()),
            worktree_root,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        // Zatruty mutex (panika w innym wątku) nie chroni żadnych danych, więc go przejmujemy.
        self.git_lock.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Główny katalog repozytorium zawierającego `path`.
    pub fn repo_root(&self, path: &Path) -> Result<PathBuf, String> {
        if !path.is_absolute() {
            return Err(format!("repo path must be absolute: {}", path.display()));
        }
        let _g = self.lock();
        let top = git(path, &["rev-parse", "--show-toplevel"])?;
        Ok(PathBuf::from(top))
    }

    fn worktree_path(&self, repo_root: &Path, task_slug: &str, run_name: &str) -> PathBuf {
        let repo_name = repo_root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "repo".into());
        match &self.worktree_root {
            Some(root) => root.join(repo_name).join(task_slug).join(run_name),
            None => repo_root
                .parent()
                .unwrap_or(repo_root)
                .join(format!("{repo_name}.worktrees"))
                .join(task_slug)
                .join(run_name),
        }
    }

    /// `git worktree add -b agent/<task-slug>/<run-name> <path> HEAD`.
    pub fn create(
        &self,
        repo_root: &Path,
        task_slug: &str,
        run_name: &str,
    ) -> Result<Worktree, String> {
        let branch = branch_name(task_slug, run_name);
        let path = self.worktree_path(repo_root, task_slug, run_name);
        let _g = self.lock();
        git(repo_root, &["check-ref-format", "--branch", &branch])
            .map_err(|_| format!("invalid branch name `{branch}`"))?;
        if git(
            repo_root,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .is_ok()
        {
            return Err(format!("branch `{branch}` already exists"));
        }
        if path.exists() {
            return Err(format!("worktree path already exists: {}", path.display()));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        let path_str = path
            .to_str()
            .ok_or_else(|| format!("non UTF-8 worktree path: {}", path.display()))?;
        git(
            repo_root,
            &[
                "worktree", "add", "--quiet", "-b", &branch, path_str, "HEAD",
            ],
        )?;
        Ok(Worktree {
            repo_root: repo_root.to_owned(),
            path,
            branch,
        })
    }

    /// `git worktree remove --force <path>`. Gałąź (z ewentualnymi commitami agenta)
    /// zostaje; niezacommitowane zmiany w worktree są tracone.
    pub fn remove(&self, wt: &Worktree) -> Result<(), String> {
        let _g = self.lock();
        let path_str = wt
            .path
            .to_str()
            .ok_or_else(|| format!("non UTF-8 worktree path: {}", wt.path.display()))?;
        git(&wt.repo_root, &["worktree", "remove", "--force", path_str])?;
        // Puste katalogi-rodzice (<task-slug>) sprzątamy, jeśli zostały puste.
        if let Some(parent) = wt.path.parent() {
            let _ = std::fs::remove_dir(parent);
        }
        Ok(())
    }

    /// Wycofanie po nieudanym starcie: usuń worktree i świeżo utworzoną gałąź.
    pub fn rollback(&self, wt: &Worktree) {
        let _ = self.remove(wt);
        let _g = self.lock();
        let _ = git(&wt.repo_root, &["branch", "-D", &wt.branch]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert_eq!(slugify("fix bug"), "fix-bug");
        assert_eq!(slugify("  Fix   the BUG!!  #12 "), "fix-the-bug-12");
        assert_eq!(
            slugify("Napraw błąd w żółtym łańcuchu"),
            "napraw-blad-w-zoltym-lancuchu"
        );
        assert_eq!(slugify("ŻÓŁW"), "zolw");
        assert_eq!(slugify("../../etc/passwd"), "etc-passwd");
        assert_eq!(slugify("a/b\\c:d*e?f"), "a-b-c-d-e-f");
        assert_eq!(slugify("日本語"), "task");
        assert_eq!(slugify(""), "task");
        assert_eq!(slugify("---"), "task");
        assert_eq!(slugify("refs/heads/x.lock"), "refs-heads-x-lock");
    }

    #[test]
    fn slug_length_is_capped() {
        let s = slugify(&"word ".repeat(50));
        assert!(s.len() <= MAX_SLUG_LEN, "{s}");
        assert!(!s.ends_with('-'));
        assert!(s.starts_with("word-word"));
    }

    #[test]
    fn run_names() {
        for ok in ["a1", "agent_2", "A-b", "x"] {
            validate_run_name(ok).unwrap();
        }
        for bad in ["", "-a", "a/b", "a b", "..", "a.lock", &"x".repeat(33)] {
            assert!(validate_run_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn branch_format() {
        assert_eq!(branch_name(&slugify("fix bug"), "a1"), "agent/fix-bug/a1");
    }

    #[test]
    fn worktree_paths() {
        let wm = WorkspaceManager::new(None);
        assert_eq!(
            wm.worktree_path(Path::new("/src/proj"), "fix-bug", "a1"),
            Path::new("/src/proj.worktrees/fix-bug/a1")
        );
        let wm = WorkspaceManager::new(Some("/var/wt".into()));
        assert_eq!(
            wm.worktree_path(Path::new("/src/proj"), "fix-bug", "a1"),
            Path::new("/var/wt/proj/fix-bug/a1")
        );
    }
}
