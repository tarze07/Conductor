//! Proste logowanie na stderr: `2026-11-05T17:10:00.123Z INFO  wiadomość`.

use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

static VERBOSE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_verbose(v: bool) {
    VERBOSE.store(v, std::sync::atomic::Ordering::Relaxed);
}

pub fn write(level: Level, msg: std::fmt::Arguments<'_>) {
    if level == Level::Debug && !VERBOSE.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let tag = match level {
        Level::Debug => "DEBUG",
        Level::Info => "INFO ",
        Level::Warn => "WARN ",
        Level::Error => "ERROR",
    };
    // Jeden eprintln = jedna linia; std blokuje stderr na czas zapisu, więc linie
    // z różnych wątków się nie przeplatają.
    eprintln!("{} {tag} {msg}", timestamp(SystemTime::now()));
}

/// Znacznik czasu RFC 3339 w UTC z milisekundami (bez zależności od chrono).
pub fn timestamp(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, day) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        d.subsec_millis()
    )
}

/// Algorytm H. Hinnanta: dni od 1970-01-01 -> (rok, miesiąc, dzień).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

macro_rules! log_info {
    ($($t:tt)*) => { $crate::log::write($crate::log::Level::Info, format_args!($($t)*)) };
}
macro_rules! log_warn {
    ($($t:tt)*) => { $crate::log::write($crate::log::Level::Warn, format_args!($($t)*)) };
}
macro_rules! log_error {
    ($($t:tt)*) => { $crate::log::write($crate::log::Level::Error, format_args!($($t)*)) };
}
macro_rules! log_debug {
    ($($t:tt)*) => { $crate::log::write($crate::log::Level::Debug, format_args!($($t)*)) };
}
pub(crate) use {log_debug, log_error, log_info, log_warn};

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn timestamps() {
        assert_eq!(timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            timestamp(UNIX_EPOCH + Duration::from_millis(951_782_400_123)),
            "2000-02-29T00:00:00.123Z"
        );
        assert_eq!(
            timestamp(UNIX_EPOCH + Duration::from_secs(1_793_985_045)),
            "2026-11-06T17:10:45.000Z"
        );
    }
}
