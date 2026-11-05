//! Minimalny koder/dekoder JSON (RFC 8259) w zakresie potrzebnym protokołowi.
//!
//! Obsługiwane: `null`, `true`/`false`, liczby całkowite mieszczące się w `i64`,
//! stringi (wszystkie escape'y, w tym pary surogatów `😀`), tablice i obiekty.
//! Świadomie NIE obsługujemy liczb zmiennoprzecinkowych (protokół ich nie używa):
//! dekoder zwraca wtedy błąd zamiast cicho tracić precyzję.
//!
//! Obiekty zachowują kolejność kluczy. Zduplikowane klucze są odrzucane, bo różne
//! implementacje rozstrzygają je różnie (pierwszy/ostatni wygrywa), co bywa źródłem
//! luk przy walidacji.

use std::fmt;

/// Maksymalna głębokość zagnieżdżenia przy dekodowaniu (ochrona stosu).
pub const MAX_DEPTH: usize = 64;

/// Wartość JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    String(String),
    Array(Vec<Value>),
    /// Obiekt jako lista par z zachowaną kolejnością (klucze są unikalne).
    Object(Vec<(String, Value)>),
}

impl Value {
    /// Buduje obiekt z par `(klucz, wartość)`.
    pub fn object<K: Into<String>>(pairs: impl IntoIterator<Item = (K, Value)>) -> Value {
        Value::Object(pairs.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }

    /// Pusty obiekt `{}`.
    pub fn empty_object() -> Value {
        Value::Object(Vec::new())
    }

    /// Pole obiektu (None, gdy to nie obiekt albo klucza brak).
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Int(i) => Some(*i),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(a) => Some(a),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    pub fn is_object(&self) -> bool {
        matches!(self, Value::Object(_))
    }

    /// Dopisuje pole do obiektu (zastępuje istniejące). Na innych typach nic nie robi.
    pub fn insert(&mut self, key: impl Into<String>, value: Value) {
        if let Value::Object(pairs) = self {
            let key = key.into();
            if let Some(slot) = pairs.iter_mut().find(|(k, _)| *k == key) {
                slot.1 = value;
            } else {
                pairs.push((key, value));
            }
        }
    }
}

impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Bool(b)
    }
}
impl From<i64> for Value {
    fn from(i: i64) -> Self {
        Value::Int(i)
    }
}
impl From<i32> for Value {
    fn from(i: i32) -> Self {
        Value::Int(i64::from(i))
    }
}
impl From<u32> for Value {
    fn from(i: u32) -> Self {
        Value::Int(i64::from(i))
    }
}
impl From<u64> for Value {
    /// Wartości powyżej `i64::MAX` są nasycane (protokół takich nie używa).
    fn from(i: u64) -> Self {
        Value::Int(i64::try_from(i).unwrap_or(i64::MAX))
    }
}
impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::String(s.to_owned())
    }
}
impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::String(s)
    }
}
impl From<Vec<Value>> for Value {
    fn from(a: Vec<Value>) -> Self {
        Value::Array(a)
    }
}
impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(o: Option<T>) -> Self {
        o.map_or(Value::Null, Into::into)
    }
}

// ---------------------------------------------------------------------------
// Koder
// ---------------------------------------------------------------------------

/// Kodowanie zwarte (bez białych znaków). Wynik nigdy nie zawiera surowego `\n`,
/// więc nadaje się do protokołu rozdzielanego nowymi liniami.
impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut out = String::new();
        write_value(self, &mut out);
        f.write_str(&out)
    }
}

fn write_value(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Int(i) => out.push_str(&i.to_string()),
        Value::String(s) => write_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(pairs) => {
            out.push('{');
            for (i, (k, val)) in pairs.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(k, out);
                out.push(':');
                write_value(val, out);
            }
            out.push('}');
        }
    }
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            // Pozostałe znaki sterujące oraz separatory linii/akapitu (bezpieczeństwo
            // przy osadzaniu w JS) jako \uXXXX.
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

// ---------------------------------------------------------------------------
// Dekoder
// ---------------------------------------------------------------------------

/// Błąd dekodowania z pozycją (offset w bajtach).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonError {
    pub pos: usize,
    pub msg: &'static str,
}

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid JSON at byte {}: {}", self.pos, self.msg)
    }
}

impl std::error::Error for JsonError {}

/// Dekoduje bajty (muszą być poprawnym UTF-8).
pub fn parse_bytes(input: &[u8]) -> Result<Value, JsonError> {
    let s = std::str::from_utf8(input).map_err(|e| JsonError {
        pos: e.valid_up_to(),
        msg: "invalid UTF-8",
    })?;
    parse(s)
}

/// Dekoduje dokładnie jedną wartość JSON (dopuszczalne białe znaki wokół).
pub fn parse(input: &str) -> Result<Value, JsonError> {
    let mut p = Parser {
        src: input,
        b: input.as_bytes(),
        pos: 0,
        depth: 0,
    };
    p.skip_ws();
    let v = p.value()?;
    p.skip_ws();
    if p.pos != p.b.len() {
        return Err(p.err("trailing characters"));
    }
    Ok(v)
}

struct Parser<'a> {
    src: &'a str,
    b: &'a [u8],
    pos: usize,
    depth: usize,
}

impl Parser<'_> {
    fn err(&self, msg: &'static str) -> JsonError {
        JsonError { pos: self.pos, msg }
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.peek() {
            self.pos += 1;
        }
    }

    fn expect_literal(&mut self, lit: &str, v: Value) -> Result<Value, JsonError> {
        if self.b[self.pos..].starts_with(lit.as_bytes()) {
            self.pos += lit.len();
            Ok(v)
        } else {
            Err(self.err("invalid literal"))
        }
    }

    fn value(&mut self) -> Result<Value, JsonError> {
        match self.peek() {
            None => Err(self.err("unexpected end of input")),
            Some(b'n') => self.expect_literal("null", Value::Null),
            Some(b't') => self.expect_literal("true", Value::Bool(true)),
            Some(b'f') => self.expect_literal("false", Value::Bool(false)),
            Some(b'"') => self.string().map(Value::String),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(b'[') => self.nested(Self::array),
            Some(b'{') => self.nested(Self::object),
            Some(_) => Err(self.err("unexpected character")),
        }
    }

    fn nested(&mut self, f: fn(&mut Self) -> Result<Value, JsonError>) -> Result<Value, JsonError> {
        if self.depth >= MAX_DEPTH {
            return Err(self.err("nesting too deep"));
        }
        self.depth += 1;
        let r = f(self);
        self.depth -= 1;
        r
    }

    fn number(&mut self) -> Result<Value, JsonError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => {
                self.pos += 1;
                if let Some(b'0'..=b'9') = self.peek() {
                    return Err(self.err("leading zeros are not allowed"));
                }
            }
            Some(b'1'..=b'9') => {
                while let Some(b'0'..=b'9') = self.peek() {
                    self.pos += 1;
                }
            }
            _ => return Err(self.err("invalid number")),
        }
        if let Some(b'.' | b'e' | b'E') = self.peek() {
            return Err(self.err("non-integer numbers are not supported"));
        }
        self.src[start..self.pos]
            .parse::<i64>()
            .map(Value::Int)
            .map_err(|_| JsonError {
                pos: start,
                msg: "integer out of range",
            })
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        let digits = self
            .b
            .get(self.pos..self.pos + 4)
            .ok_or_else(|| self.err("truncated \\u escape"))?;
        let mut v = 0u32;
        for &d in digits {
            let n = match d {
                b'0'..=b'9' => d - b'0',
                b'a'..=b'f' => d - b'a' + 10,
                b'A'..=b'F' => d - b'A' + 10,
                _ => return Err(self.err("invalid hex digit in \\u escape")),
            };
            v = v * 16 + u32::from(n);
        }
        self.pos += 4;
        Ok(v)
    }

    fn string(&mut self) -> Result<String, JsonError> {
        debug_assert_eq!(self.peek(), Some(b'"'));
        self.pos += 1;
        let mut out = String::new();
        let mut chunk_start = self.pos;
        loop {
            match self.peek() {
                None => return Err(self.err("unterminated string")),
                Some(b'"') => {
                    out.push_str(&self.src[chunk_start..self.pos]);
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    out.push_str(&self.src[chunk_start..self.pos]);
                    self.pos += 1;
                    let esc = self.peek().ok_or_else(|| self.err("unterminated escape"))?;
                    self.pos += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&hi) {
                                if !self.b[self.pos..].starts_with(b"\\u") {
                                    return Err(self.err("lone high surrogate"));
                                }
                                self.pos += 2;
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return Err(self.err("invalid low surrogate"));
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else if (0xDC00..0xE000).contains(&hi) {
                                return Err(self.err("lone low surrogate"));
                            } else {
                                hi
                            };
                            // Po wykluczeniu surogatów każdy kod <= 0x10FFFF jest poprawny.
                            let c = char::from_u32(code)
                                .ok_or_else(|| self.err("invalid code point"))?;
                            out.push(c);
                        }
                        _ => {
                            self.pos -= 1;
                            return Err(self.err("invalid escape"));
                        }
                    }
                    chunk_start = self.pos;
                }
                Some(c) if c < 0x20 => {
                    return Err(self.err("unescaped control character in string"))
                }
                // Bajty UTF-8 (także wielobajtowe) kopiujemy kawałkami; granice kawałków
                // wypadają zawsze na znakach ASCII, więc są granicami znaków.
                Some(_) => self.pos += 1,
            }
        }
    }

    fn array(&mut self) -> Result<Value, JsonError> {
        self.pos += 1; // '['
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Value::Array(items));
        }
        loop {
            self.skip_ws();
            items.push(self.value()?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Value::Array(items));
                }
                _ => return Err(self.err("expected ',' or ']'")),
            }
        }
    }

    fn object(&mut self) -> Result<Value, JsonError> {
        self.pos += 1; // '{'
        let mut pairs: Vec<(String, Value)> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Value::Object(pairs));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err(self.err("expected string key"));
            }
            let key_pos = self.pos;
            let key = self.string()?;
            if pairs.iter().any(|(k, _)| *k == key) {
                return Err(JsonError {
                    pos: key_pos,
                    msg: "duplicate object key",
                });
            }
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err(self.err("expected ':'"));
            }
            self.pos += 1;
            self.skip_ws();
            let v = self.value()?;
            pairs.push((key, v));
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Value::Object(pairs));
                }
                _ => return Err(self.err("expected ',' or '}'")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt(s: &str) -> String {
        parse(s).expect(s).to_string()
    }

    #[test]
    fn literals_and_numbers() {
        assert_eq!(parse("null").unwrap(), Value::Null);
        assert_eq!(parse(" true ").unwrap(), Value::Bool(true));
        assert_eq!(parse("false").unwrap(), Value::Bool(false));
        assert_eq!(parse("0").unwrap(), Value::Int(0));
        assert_eq!(parse("-42").unwrap(), Value::Int(-42));
        assert_eq!(parse("9223372036854775807").unwrap(), Value::Int(i64::MAX));
        assert_eq!(parse("-9223372036854775808").unwrap(), Value::Int(i64::MIN));
    }

    #[test]
    fn rejects_bad_numbers() {
        for s in [
            "01",
            "-",
            "1.5",
            "1e3",
            "1E3",
            "9223372036854775808",
            "+1",
            "--1",
        ] {
            assert!(parse(s).is_err(), "{s} should fail");
        }
        assert_eq!(
            parse("2.5").unwrap_err().msg,
            "non-integer numbers are not supported"
        );
    }

    #[test]
    fn strings_and_escapes() {
        assert_eq!(
            parse(r#""a\"b\\c\/d\b\f\n\r\t""#).unwrap(),
            Value::String("a\"b\\c/d\u{8}\u{c}\n\r\t".into())
        );
        assert_eq!(parse(r#""Aéą""#).unwrap(), Value::String("Aéą".into()));
        // Para surogatów -> emoji spoza BMP.
        assert_eq!(parse(r#""😀""#).unwrap(), Value::String("\u{1F600}".into()));
        // Surowe UTF-8 przechodzi bez zmian.
        assert_eq!(
            parse("\"zażółć gęślą jaźń 日本\"").unwrap(),
            Value::String("zażółć gęślą jaźń 日本".into())
        );
    }

    #[test]
    fn rejects_bad_strings() {
        for s in [
            r#""abc"#,
            r#""\x""#,
            r#""\u12""#,
            r#""\uZZZZ""#,
            r#""\uD800""#,
            r#""\uD800A""#,
            r#""\uDC00""#,
            "\"a\u{1}b\"",
            "\"line\nbreak\"",
        ] {
            assert!(parse(s).is_err(), "{s:?} should fail");
        }
        assert!(parse_bytes(b"\"\xff\"").is_err());
    }

    #[test]
    fn encoder_escapes() {
        let v = Value::String("q\"\\\n\r\t\u{1}\u{7f}ą\u{2028}\u{1F600}".into());
        let s = v.to_string();
        assert_eq!(s, "\"q\\\"\\\\\\n\\r\\t\\u0001\u{7f}ą\\u2028\u{1F600}\"");
        assert!(!s.contains('\n'));
        assert_eq!(parse(&s).unwrap(), v);
    }

    #[test]
    fn arrays_and_objects() {
        assert_eq!(rt("[]"), "[]");
        assert_eq!(rt("{}"), "{}");
        assert_eq!(
            rt(" [ 1 , [ true , null ] , \"x\" ] "),
            "[1,[true,null],\"x\"]"
        );
        assert_eq!(
            rt(r#"{ "b" : 1, "a" : { "c" : [] } }"#),
            r#"{"b":1,"a":{"c":[]}}"#
        );
        let v = parse(r#"{"x":1,"y":"z"}"#).unwrap();
        assert_eq!(v.get("x").and_then(Value::as_i64), Some(1));
        assert_eq!(v.get("y").and_then(Value::as_str), Some("z"));
        assert!(v.get("nope").is_none());
    }

    #[test]
    fn rejects_bad_structures() {
        for s in [
            "",
            "[",
            "[1,]",
            "[1 2]",
            "{\"a\"}",
            "{\"a\":1,}",
            "{a:1}",
            "{\"a\":1,\"a\":2}",
            "1 2",
            "nul",
            "truex",
            "[1]]",
        ] {
            assert!(parse(s).is_err(), "{s:?} should fail");
        }
    }

    #[test]
    fn depth_limit() {
        let ok = "[".repeat(MAX_DEPTH) + &"]".repeat(MAX_DEPTH);
        assert!(parse(&ok).is_ok());
        let deep = "[".repeat(MAX_DEPTH + 1) + &"]".repeat(MAX_DEPTH + 1);
        assert_eq!(parse(&deep).unwrap_err().msg, "nesting too deep");
    }

    #[test]
    fn builders_and_insert() {
        let mut v = Value::object([("a", Value::from(1i64)), ("b", Value::from("x"))]);
        v.insert("a", Value::from(true));
        v.insert("c", Value::from(None::<i64>));
        assert_eq!(v.to_string(), r#"{"a":true,"b":"x","c":null}"#);
        assert_eq!(Value::from(u64::MAX), Value::Int(i64::MAX));
    }

    #[test]
    fn roundtrip_all_control_chars() {
        let s: String = (0u32..0x80).filter_map(char::from_u32).collect();
        let v = Value::String(s);
        assert_eq!(parse(&v.to_string()).unwrap(), v);
    }
}
