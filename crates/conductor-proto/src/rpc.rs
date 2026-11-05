//! Koperty JSON-RPC 2.0 (https://www.jsonrpc.org/specification).
//!
//! Ramkowanie: jedna wiadomość JSON na linię (`\n`). Koder JSON nigdy nie emituje
//! surowego znaku nowej linii, więc ramkowanie jest jednoznaczne. Batch (tablica
//! żądań) nie jest obsługiwany.

use crate::json::{self, Value};
use std::fmt;

pub const JSONRPC_VERSION: &str = "2.0";

/// Maksymalna długość jednej linii (ramki) w bajtach.
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// Kody błędów: standardowe JSON-RPC i aplikacyjne (zakres -32000..-32099).
pub mod code {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    /// Brak uwierzytelnienia albo zły token.
    pub const UNAUTHORIZED: i64 = -32001;
    /// Nieznany przebieg.
    pub const NOT_FOUND: i64 = -32002;
    /// Konflikt stanu (np. nazwa zajęta, przebieg nadal działa).
    pub const CONFLICT: i64 = -32003;
    /// Klient mówi inną wersją protokołu.
    pub const UNSUPPORTED_VERSION: i64 = -32004;
    /// Daemon się wyłącza.
    pub const SHUTTING_DOWN: i64 = -32005;
    /// Błąd operacji git (worktree, gałąź).
    pub const GIT_ERROR: i64 = -32010;
    /// Nie udało się uruchomić agenta.
    pub const SPAWN_ERROR: i64 = -32011;
}

/// Obiekt błędu JSON-RPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        RpcError {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(code::INVALID_PARAMS, message)
    }

    pub fn to_value(&self) -> Value {
        let mut v = Value::object([
            ("code", Value::Int(self.code)),
            ("message", Value::from(self.message.as_str())),
        ]);
        if let Some(d) = &self.data {
            v.insert("data", d.clone());
        }
        v
    }

    pub fn from_value(v: &Value) -> Option<Self> {
        Some(RpcError {
            code: v.get("code")?.as_i64()?,
            message: v.get("message")?.as_str()?.to_owned(),
            data: v.get("data").cloned(),
        })
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (code {})", self.message, self.code)
    }
}

impl std::error::Error for RpcError {}

/// Żądanie (albo notyfikacja, gdy `id` jest `None`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub id: Option<Value>,
    pub method: String,
    /// Zawsze obiekt (brak `params` dekodujemy jako `{}`).
    pub params: Value,
}

/// Błąd dekodowania żądania razem z `id` (jeśli dało się je odczytać), żeby
/// serwer mógł odpowiedzieć zgodnie ze specyfikacją.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestError {
    pub id: Value,
    pub error: RpcError,
}

impl Request {
    pub fn new(id: i64, method: &str, params: Value) -> Self {
        Request {
            id: Some(Value::Int(id)),
            method: method.to_owned(),
            params,
        }
    }

    pub fn to_value(&self) -> Value {
        let mut v = Value::object([
            ("jsonrpc", Value::from(JSONRPC_VERSION)),
            ("method", Value::from(self.method.as_str())),
            ("params", self.params.clone()),
        ]);
        if let Some(id) = &self.id {
            v.insert("id", id.clone());
        }
        v
    }

    /// Dekoduje jedną linię protokołu.
    pub fn parse_line(line: &[u8]) -> Result<Request, RequestError> {
        let v = json::parse_bytes(line).map_err(|e| RequestError {
            id: Value::Null,
            error: RpcError::new(code::PARSE_ERROR, e.to_string()),
        })?;
        Self::from_value(&v)
    }

    pub fn from_value(v: &Value) -> Result<Request, RequestError> {
        let invalid = |id: &Value, msg: &str| RequestError {
            id: id.clone(),
            error: RpcError::new(code::INVALID_REQUEST, msg),
        };
        if matches!(v, Value::Array(_)) {
            return Err(invalid(&Value::Null, "batch requests are not supported"));
        }
        if !v.is_object() {
            return Err(invalid(&Value::Null, "request must be an object"));
        }
        let id = match v.get("id") {
            None => None,
            Some(id @ (Value::Null | Value::Int(_) | Value::String(_))) => Some(id.clone()),
            Some(_) => {
                return Err(invalid(
                    &Value::Null,
                    "id must be a string, integer or null",
                ))
            }
        };
        let id_for_err = id.clone().unwrap_or(Value::Null);
        if v.get("jsonrpc").and_then(Value::as_str) != Some(JSONRPC_VERSION) {
            return Err(invalid(&id_for_err, "jsonrpc must be \"2.0\""));
        }
        let method = v
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid(&id_for_err, "method must be a string"))?
            .to_owned();
        let params = match v.get("params") {
            None => Value::empty_object(),
            Some(p @ Value::Object(_)) => p.clone(),
            Some(Value::Array(_)) => {
                return Err(RequestError {
                    id: id_for_err,
                    error: RpcError::invalid_params("positional params are not supported"),
                })
            }
            Some(_) => return Err(invalid(&id_for_err, "params must be an object")),
        };
        Ok(Request { id, method, params })
    }
}

/// Odpowiedź: wynik albo błąd.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub id: Value,
    pub outcome: Result<Value, RpcError>,
}

impl Response {
    pub fn ok(id: Value, result: Value) -> Self {
        Response {
            id,
            outcome: Ok(result),
        }
    }

    pub fn err(id: Value, error: RpcError) -> Self {
        Response {
            id,
            outcome: Err(error),
        }
    }

    pub fn to_value(&self) -> Value {
        let mut v = Value::object([("jsonrpc", Value::from(JSONRPC_VERSION))]);
        match &self.outcome {
            Ok(r) => v.insert("result", r.clone()),
            Err(e) => v.insert("error", e.to_value()),
        }
        v.insert("id", self.id.clone());
        v
    }

    /// Linia gotowa do wysłania (z `\n` na końcu).
    pub fn to_line(&self) -> String {
        let mut s = self.to_value().to_string();
        s.push('\n');
        s
    }

    pub fn from_value(v: &Value) -> Result<Response, String> {
        if v.get("jsonrpc").and_then(Value::as_str) != Some(JSONRPC_VERSION) {
            return Err("response: jsonrpc must be \"2.0\"".into());
        }
        let id = v.get("id").cloned().ok_or("response: missing id")?;
        let outcome = match (v.get("result"), v.get("error")) {
            (Some(r), None) => Ok(r.clone()),
            (None, Some(e)) => Err(RpcError::from_value(e).ok_or("response: malformed error")?),
            _ => return Err("response: exactly one of result/error required".into()),
        };
        Ok(Response { id, outcome })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_roundtrip() {
        let r = Request::new(7, "run.list", Value::empty_object());
        let line = r.to_value().to_string();
        assert_eq!(
            line,
            r#"{"jsonrpc":"2.0","method":"run.list","params":{},"id":7}"#
        );
        assert_eq!(Request::parse_line(line.as_bytes()).unwrap(), r);
    }

    #[test]
    fn request_defaults_and_notifications() {
        let r = Request::parse_line(br#"{"jsonrpc":"2.0","method":"x"}"#).unwrap();
        assert_eq!(r.id, None);
        assert_eq!(r.params, Value::empty_object());
        let r = Request::parse_line(br#"{"jsonrpc":"2.0","method":"x","id":"abc"}"#).unwrap();
        assert_eq!(r.id, Some(Value::from("abc")));
    }

    #[test]
    fn request_errors() {
        let e = Request::parse_line(b"{oops").unwrap_err();
        assert_eq!(e.error.code, code::PARSE_ERROR);
        assert_eq!(e.id, Value::Null);

        let e = Request::parse_line(br#"{"jsonrpc":"1.0","method":"x","id":3}"#).unwrap_err();
        assert_eq!(e.error.code, code::INVALID_REQUEST);
        assert_eq!(e.id, Value::Int(3));

        let e = Request::parse_line(br#"{"jsonrpc":"2.0","id":3}"#).unwrap_err();
        assert_eq!(e.error.code, code::INVALID_REQUEST);

        let e = Request::parse_line(br#"[{"jsonrpc":"2.0","method":"x"}]"#).unwrap_err();
        assert_eq!(e.error.code, code::INVALID_REQUEST);

        let e = Request::parse_line(br#"{"jsonrpc":"2.0","method":"x","id":1,"params":[1]}"#)
            .unwrap_err();
        assert_eq!(e.error.code, code::INVALID_PARAMS);

        let e = Request::parse_line(br#"{"jsonrpc":"2.0","method":"x","id":[1]}"#).unwrap_err();
        assert_eq!(e.error.code, code::INVALID_REQUEST);
    }

    #[test]
    fn response_roundtrip() {
        let ok = Response::ok(Value::Int(1), Value::object([("a", Value::from(true))]));
        let line = ok.to_line();
        assert!(line.ends_with('\n'));
        assert_eq!(
            line,
            "{\"jsonrpc\":\"2.0\",\"result\":{\"a\":true},\"id\":1}\n"
        );
        let parsed = Response::from_value(&json::parse(line.trim_end()).unwrap()).unwrap();
        assert_eq!(parsed, ok);

        let err = Response::err(Value::Null, RpcError::new(code::UNAUTHORIZED, "bad token"));
        let parsed = Response::from_value(&json::parse(err.to_line().trim_end()).unwrap()).unwrap();
        assert_eq!(parsed, err);
    }

    #[test]
    fn response_rejects_ambiguous() {
        let v =
            json::parse(r#"{"jsonrpc":"2.0","id":1,"result":1,"error":{"code":1,"message":"x"}}"#)
                .unwrap();
        assert!(Response::from_value(&v).is_err());
        let v = json::parse(r#"{"jsonrpc":"2.0","id":1}"#).unwrap();
        assert!(Response::from_value(&v).is_err());
    }
}
