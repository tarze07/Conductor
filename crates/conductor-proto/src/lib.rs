//! Protokół `conductord`: JSON-RPC 2.0 rozdzielany nowymi liniami po lokalnym sockecie unix.
//!
//! Crate używa wyłącznie biblioteki standardowej. Zawiera:
//! - [`json`]: minimalny koder/dekoder JSON (obiekty, tablice, stringi, liczby całkowite, bool, null),
//! - [`base64`]: kodowanie surowych bajtów wyjścia terminala,
//! - [`rpc`]: koperty JSON-RPC 2.0 (żądanie, odpowiedź, błąd),
//! - [`methods`]: typowane parametry i wyniki metod protokołu,
//! - [`client`]: synchroniczny klient używany przez CLI i testy,
//! - [`paths`]: domyślne ścieżki socketu i pliku z tokenem.
#![forbid(unsafe_code)]

pub mod base64;
pub mod client;
pub mod json;
pub mod methods;
pub mod paths;
pub mod rpc;

pub use json::Value;
pub use methods::PROTOCOL_VERSION;
