//! Domyślne ścieżki socketu i tokenu, wspólne dla daemona i klientów.

use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// Zmienna środowiskowa z alternatywną ścieżką socketu.
pub const SOCKET_ENV: &str = "CONDUCTOR_SOCKET";
pub const SOCKET_FILE: &str = "conductord.sock";

/// Efektywny UID procesu bez FFI: właścicielem `/proc/self` jest efektywny UID.
pub fn current_uid() -> io::Result<u32> {
    Ok(std::fs::metadata("/proc/self")?.uid())
}

/// `$CONDUCTOR_SOCKET`, w przeciwnym razie `$XDG_RUNTIME_DIR/conductor/conductord.sock`,
/// a gdy `XDG_RUNTIME_DIR` nie jest ustawione: `/tmp/conductor-<uid>/conductord.sock`.
pub fn default_socket_path() -> io::Result<PathBuf> {
    if let Some(p) = std::env::var_os(SOCKET_ENV).filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(p));
    }
    let dir = match std::env::var_os("XDG_RUNTIME_DIR").filter(|p| !p.is_empty()) {
        Some(xdg) => PathBuf::from(xdg).join("conductor"),
        None => std::env::temp_dir().join(format!("conductor-{}", current_uid()?)),
    };
    Ok(dir.join(SOCKET_FILE))
}

/// Plik z tokenem leży obok socketu: `<socket>.token`.
pub fn token_path(socket: &Path) -> PathBuf {
    let mut s = socket.as_os_str().to_owned();
    s.push(".token");
    PathBuf::from(s)
}

/// Czyta token (bez białych znaków na końcu).
pub fn read_token(socket: &Path) -> io::Result<String> {
    let path = token_path(socket);
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", path.display())))?;
    Ok(raw.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_next_to_socket() {
        assert_eq!(
            token_path(Path::new("/run/u/conductor/conductord.sock")),
            Path::new("/run/u/conductor/conductord.sock.token")
        );
    }

    #[test]
    fn uid_is_readable() {
        current_uid().unwrap();
    }
}
