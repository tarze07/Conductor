//! Typowane metody protokołu `conductord` (wersja [`PROTOCOL_VERSION`]).
//!
//! | Metoda            | Parametry                                                    | Wynik |
//! |-------------------|--------------------------------------------------------------|-------|
//! | `auth`            | `{token, protocol_version?}`                                 | `{protocol_version, daemon_version}` |
//! | `run.start`       | `{repo, task, agent_cmd: [..], name?}`                       | `{run_id, name, worktree, branch}` |
//! | `run.list`        | `{}`                                                         | `{runs: [RunInfo]}` |
//! | `run.stop`        | `{run_id, timeout_ms?}`                                      | `{run_id, exit_code?, signal?, killed, already_exited}` |
//! | `run.output`      | `{run_id, since?, max_bytes?, wait_ms?}`                     | `{data_b64, offset, next_offset, dropped, exited, exit_code?, signal?}` |
//! | `run.input`       | `{run_id, data}` albo `{run_id, data_b64}`                   | `{written}` |
//! | `run.remove`      | `{run_id, delete_worktree?}`                                 | `{run_id, worktree_deleted}` |
//! | `daemon.shutdown` | `{}`                                                         | `{shutting_down: true}` |
//!
//! Zasady zgodności: nieznane pola są ignorowane (dodawanie pól jest zmianą zgodną
//! wstecz), usunięcie lub zmiana znaczenia pola wymaga podbicia `PROTOCOL_VERSION`.
//! Wyjście terminala zawsze jako surowe bajty w `data_b64` (ADR-001).

use crate::base64;
use crate::json::Value;
use crate::rpc::RpcError;

/// Wersja protokołu na kablu. Zwracana w odpowiedzi na `auth`.
pub const PROTOCOL_VERSION: i64 = 1;

pub mod name {
    pub const AUTH: &str = "auth";
    pub const RUN_START: &str = "run.start";
    pub const RUN_LIST: &str = "run.list";
    pub const RUN_STOP: &str = "run.stop";
    pub const RUN_OUTPUT: &str = "run.output";
    pub const RUN_INPUT: &str = "run.input";
    pub const RUN_REMOVE: &str = "run.remove";
    pub const DAEMON_SHUTDOWN: &str = "daemon.shutdown";
}

/// Konwersja typu do/z wartości JSON na kablu.
pub trait Wire: Sized {
    fn to_value(&self) -> Value;
    fn from_value(v: &Value) -> Result<Self, String>;
}

/// Pomocnik do czytania pól obiektu z czytelnymi błędami.
struct Fields<'a>(&'a Value);

impl<'a> Fields<'a> {
    fn new(v: &'a Value) -> Result<Self, String> {
        if v.is_object() {
            Ok(Fields(v))
        } else {
            Err("expected an object".into())
        }
    }

    /// Pole obecne i różne od `null`.
    fn present(&self, k: &str) -> Option<&'a Value> {
        self.0.get(k).filter(|v| !v.is_null())
    }

    fn str(&self, k: &str) -> Result<String, String> {
        self.opt_str(k)?
            .ok_or_else(|| format!("missing field `{k}`"))
    }

    fn opt_str(&self, k: &str) -> Result<Option<String>, String> {
        match self.present(k) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(format!("field `{k}` must be a string")),
        }
    }

    fn opt_i64(&self, k: &str) -> Result<Option<i64>, String> {
        match self.present(k) {
            None => Ok(None),
            Some(Value::Int(i)) => Ok(Some(*i)),
            Some(_) => Err(format!("field `{k}` must be an integer")),
        }
    }

    fn opt_u64(&self, k: &str) -> Result<Option<u64>, String> {
        self.opt_i64(k)?
            .map(|i| u64::try_from(i).map_err(|_| format!("field `{k}` must be >= 0")))
            .transpose()
    }

    fn u64(&self, k: &str) -> Result<u64, String> {
        self.opt_u64(k)?
            .ok_or_else(|| format!("missing field `{k}`"))
    }

    fn opt_i32(&self, k: &str) -> Result<Option<i32>, String> {
        self.opt_i64(k)?
            .map(|i| i32::try_from(i).map_err(|_| format!("field `{k}` out of range")))
            .transpose()
    }

    fn opt_u32(&self, k: &str) -> Result<Option<u32>, String> {
        self.opt_i64(k)?
            .map(|i| u32::try_from(i).map_err(|_| format!("field `{k}` out of range")))
            .transpose()
    }

    fn bool_or(&self, k: &str, default: bool) -> Result<bool, String> {
        match self.present(k) {
            None => Ok(default),
            Some(Value::Bool(b)) => Ok(*b),
            Some(_) => Err(format!("field `{k}` must be a boolean")),
        }
    }

    fn bool(&self, k: &str) -> Result<bool, String> {
        match self.present(k) {
            Some(Value::Bool(b)) => Ok(*b),
            None => Err(format!("missing field `{k}`")),
            Some(_) => Err(format!("field `{k}` must be a boolean")),
        }
    }

    fn str_array(&self, k: &str) -> Result<Vec<String>, String> {
        let arr = self
            .present(k)
            .ok_or_else(|| format!("missing field `{k}`"))?
            .as_array()
            .ok_or_else(|| format!("field `{k}` must be an array of strings"))?;
        arr.iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| format!("field `{k}` must be an array of strings"))
            })
            .collect()
    }

    fn bytes_b64(&self, k: &str) -> Result<Option<Vec<u8>>, String> {
        self.opt_str(k)?
            .map(|s| base64::decode(&s).map_err(|e| format!("field `{k}`: {e}")))
            .transpose()
    }
}

/// Buduje obiekt, pomijając pola `None`.
fn obj(pairs: Vec<(&str, Option<Value>)>) -> Value {
    Value::object(pairs.into_iter().filter_map(|(k, v)| v.map(|v| (k, v))))
}

// --- auth -------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthParams {
    pub token: String,
    /// Wersja, którą mówi klient. Gdy podana i różna od [`PROTOCOL_VERSION`], daemon odmawia.
    pub protocol_version: Option<i64>,
}

impl Wire for AuthParams {
    fn to_value(&self) -> Value {
        obj(vec![
            ("token", Some(self.token.as_str().into())),
            ("protocol_version", self.protocol_version.map(Value::Int)),
        ])
    }
    fn from_value(v: &Value) -> Result<Self, String> {
        let f = Fields::new(v)?;
        Ok(AuthParams {
            token: f.str("token")?,
            protocol_version: f.opt_i64("protocol_version")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthResult {
    pub protocol_version: i64,
    pub daemon_version: String,
}

impl Wire for AuthResult {
    fn to_value(&self) -> Value {
        Value::object([
            ("protocol_version", Value::Int(self.protocol_version)),
            ("daemon_version", self.daemon_version.as_str().into()),
        ])
    }
    fn from_value(v: &Value) -> Result<Self, String> {
        let f = Fields::new(v)?;
        Ok(AuthResult {
            protocol_version: f
                .opt_i64("protocol_version")?
                .ok_or("missing field `protocol_version`")?,
            daemon_version: f.str("daemon_version")?,
        })
    }
}

// --- run.start ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunStartParams {
    /// Ścieżka absolutna do repozytorium (lub dowolnego katalogu w nim).
    pub repo: String,
    /// Opis zadania; z niego powstaje slug gałęzi.
    pub task: String,
    /// Komenda agenta (argv), uruchamiana w worktree.
    pub agent_cmd: Vec<String>,
    /// Nazwa przebiegu (np. `a1`). Domyślnie nadaje ją daemon.
    pub name: Option<String>,
}

impl Wire for RunStartParams {
    fn to_value(&self) -> Value {
        obj(vec![
            ("repo", Some(self.repo.as_str().into())),
            ("task", Some(self.task.as_str().into())),
            (
                "agent_cmd",
                Some(Value::Array(
                    self.agent_cmd.iter().map(|s| s.as_str().into()).collect(),
                )),
            ),
            ("name", self.name.as_deref().map(Value::from)),
        ])
    }
    fn from_value(v: &Value) -> Result<Self, String> {
        let f = Fields::new(v)?;
        Ok(RunStartParams {
            repo: f.str("repo")?,
            task: f.str("task")?,
            agent_cmd: f.str_array("agent_cmd")?,
            name: f.opt_str("name")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunStartResult {
    pub run_id: String,
    pub name: String,
    pub worktree: String,
    pub branch: String,
}

impl Wire for RunStartResult {
    fn to_value(&self) -> Value {
        Value::object([
            ("run_id", self.run_id.as_str().into()),
            ("name", self.name.as_str().into()),
            ("worktree", self.worktree.as_str().into()),
            ("branch", self.branch.as_str().into()),
        ])
    }
    fn from_value(v: &Value) -> Result<Self, String> {
        let f = Fields::new(v)?;
        Ok(RunStartResult {
            run_id: f.str("run_id")?,
            name: f.str("name")?,
            worktree: f.str("worktree")?,
            branch: f.str("branch")?,
        })
    }
}

// --- run.list -----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunInfo {
    pub run_id: String,
    pub name: String,
    pub task: String,
    pub repo: String,
    pub branch: String,
    pub worktree: String,
    pub agent_cmd: Vec<String>,
    /// `running` albo `exited`.
    pub state: String,
    /// `pty` albo `pipe`.
    pub tty: String,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    /// Liczba bajtów wyjścia wyprodukowanych od startu (absolutny offset końca).
    pub output_bytes: u64,
}

impl Wire for RunInfo {
    fn to_value(&self) -> Value {
        obj(vec![
            ("run_id", Some(self.run_id.as_str().into())),
            ("name", Some(self.name.as_str().into())),
            ("task", Some(self.task.as_str().into())),
            ("repo", Some(self.repo.as_str().into())),
            ("branch", Some(self.branch.as_str().into())),
            ("worktree", Some(self.worktree.as_str().into())),
            (
                "agent_cmd",
                Some(Value::Array(
                    self.agent_cmd.iter().map(|s| s.as_str().into()).collect(),
                )),
            ),
            ("state", Some(self.state.as_str().into())),
            ("tty", Some(self.tty.as_str().into())),
            ("pid", self.pid.map(Value::from)),
            ("exit_code", self.exit_code.map(Value::from)),
            ("signal", self.signal.map(Value::from)),
            ("output_bytes", Some(self.output_bytes.into())),
        ])
    }
    fn from_value(v: &Value) -> Result<Self, String> {
        let f = Fields::new(v)?;
        Ok(RunInfo {
            run_id: f.str("run_id")?,
            name: f.str("name")?,
            task: f.str("task")?,
            repo: f.str("repo")?,
            branch: f.str("branch")?,
            worktree: f.str("worktree")?,
            agent_cmd: f.str_array("agent_cmd")?,
            state: f.str("state")?,
            tty: f.str("tty")?,
            pid: f.opt_u32("pid")?,
            exit_code: f.opt_i32("exit_code")?,
            signal: f.opt_i32("signal")?,
            output_bytes: f.u64("output_bytes")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunListResult {
    pub runs: Vec<RunInfo>,
}

impl Wire for RunListResult {
    fn to_value(&self) -> Value {
        Value::object([(
            "runs",
            Value::Array(self.runs.iter().map(Wire::to_value).collect()),
        )])
    }
    fn from_value(v: &Value) -> Result<Self, String> {
        let runs = v
            .get("runs")
            .and_then(Value::as_array)
            .ok_or("missing field `runs`")?;
        Ok(RunListResult {
            runs: runs
                .iter()
                .map(RunInfo::from_value)
                .collect::<Result<_, _>>()?,
        })
    }
}

// --- run.stop -----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunStopParams {
    /// Identyfikator (`r1`) albo nazwa (`a1`) przebiegu.
    pub run_id: String,
    /// Czas między SIGTERM a SIGKILL. Domyślnie konfiguracja daemona.
    pub timeout_ms: Option<u64>,
}

impl Wire for RunStopParams {
    fn to_value(&self) -> Value {
        obj(vec![
            ("run_id", Some(self.run_id.as_str().into())),
            ("timeout_ms", self.timeout_ms.map(Value::from)),
        ])
    }
    fn from_value(v: &Value) -> Result<Self, String> {
        let f = Fields::new(v)?;
        Ok(RunStopParams {
            run_id: f.str("run_id")?,
            timeout_ms: f.opt_u64("timeout_ms")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunStopResult {
    pub run_id: String,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    /// Czy potrzebny był SIGKILL.
    pub killed: bool,
    /// Czy przebieg zakończył się już wcześniej.
    pub already_exited: bool,
}

impl Wire for RunStopResult {
    fn to_value(&self) -> Value {
        obj(vec![
            ("run_id", Some(self.run_id.as_str().into())),
            ("exit_code", self.exit_code.map(Value::from)),
            ("signal", self.signal.map(Value::from)),
            ("killed", Some(self.killed.into())),
            ("already_exited", Some(self.already_exited.into())),
        ])
    }
    fn from_value(v: &Value) -> Result<Self, String> {
        let f = Fields::new(v)?;
        Ok(RunStopResult {
            run_id: f.str("run_id")?,
            exit_code: f.opt_i32("exit_code")?,
            signal: f.opt_i32("signal")?,
            killed: f.bool("killed")?,
            already_exited: f.bool("already_exited")?,
        })
    }
}

// --- run.output ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutputParams {
    pub run_id: String,
    /// Absolutny offset, od którego czytać (domyślnie 0 = najstarsze dostępne).
    pub since: Option<u64>,
    /// Limit bajtów w jednej odpowiedzi (daemon i tak przycina do swojego maksimum).
    pub max_bytes: Option<u64>,
    /// Long-poll: ile maksymalnie czekać na nowe dane, gdy brak ich od `since`.
    pub wait_ms: Option<u64>,
}

impl Wire for RunOutputParams {
    fn to_value(&self) -> Value {
        obj(vec![
            ("run_id", Some(self.run_id.as_str().into())),
            ("since", self.since.map(Value::from)),
            ("max_bytes", self.max_bytes.map(Value::from)),
            ("wait_ms", self.wait_ms.map(Value::from)),
        ])
    }
    fn from_value(v: &Value) -> Result<Self, String> {
        let f = Fields::new(v)?;
        Ok(RunOutputParams {
            run_id: f.str("run_id")?,
            since: f.opt_u64("since")?,
            max_bytes: f.opt_u64("max_bytes")?,
            wait_ms: f.opt_u64("wait_ms")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutputResult {
    /// Surowe bajty; na kablu jako `data_b64`.
    pub data: Vec<u8>,
    /// Absolutny offset pierwszego zwróconego bajtu.
    pub offset: u64,
    /// Offset do podania jako `since` w następnym wywołaniu.
    pub next_offset: u64,
    /// Ile bajtów od `since` wypadło już z ring buffera (utracone).
    pub dropped: u64,
    /// Proces zakończony (i wyjście zostało odczytane do końca lub upłynął limit).
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

impl Wire for RunOutputResult {
    fn to_value(&self) -> Value {
        obj(vec![
            ("data_b64", Some(base64::encode(&self.data).into())),
            ("offset", Some(self.offset.into())),
            ("next_offset", Some(self.next_offset.into())),
            ("dropped", Some(self.dropped.into())),
            ("exited", Some(self.exited.into())),
            ("exit_code", self.exit_code.map(Value::from)),
            ("signal", self.signal.map(Value::from)),
        ])
    }
    fn from_value(v: &Value) -> Result<Self, String> {
        let f = Fields::new(v)?;
        Ok(RunOutputResult {
            data: f.bytes_b64("data_b64")?.ok_or("missing field `data_b64`")?,
            offset: f.u64("offset")?,
            next_offset: f.u64("next_offset")?,
            dropped: f.opt_u64("dropped")?.unwrap_or(0),
            exited: f.bool("exited")?,
            exit_code: f.opt_i32("exit_code")?,
            signal: f.opt_i32("signal")?,
        })
    }
}

// --- run.input ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunInputParams {
    pub run_id: String,
    /// Bajty do wpisania na terminal agenta. Na kablu jako `data` (UTF-8) albo
    /// `data_b64` (dowolne bajty).
    pub data: Vec<u8>,
}

impl Wire for RunInputParams {
    fn to_value(&self) -> Value {
        let mut v = Value::object([("run_id", self.run_id.as_str().into())]);
        match std::str::from_utf8(&self.data) {
            Ok(s) => v.insert("data", s.into()),
            Err(_) => v.insert("data_b64", base64::encode(&self.data).into()),
        }
        v
    }
    fn from_value(v: &Value) -> Result<Self, String> {
        let f = Fields::new(v)?;
        let data = match (f.opt_str("data")?, f.bytes_b64("data_b64")?) {
            (Some(s), None) => s.into_bytes(),
            (None, Some(b)) => b,
            (Some(_), Some(_)) => return Err("give either `data` or `data_b64`, not both".into()),
            (None, None) => return Err("missing field `data`".into()),
        };
        Ok(RunInputParams {
            run_id: f.str("run_id")?,
            data,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunInputResult {
    pub written: u64,
}

impl Wire for RunInputResult {
    fn to_value(&self) -> Value {
        Value::object([("written", self.written.into())])
    }
    fn from_value(v: &Value) -> Result<Self, String> {
        Ok(RunInputResult {
            written: Fields::new(v)?.u64("written")?,
        })
    }
}

// --- run.remove ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRemoveParams {
    pub run_id: String,
    /// Usuń także worktree (`git worktree remove --force`). Gałąź zostaje.
    pub delete_worktree: bool,
}

impl Wire for RunRemoveParams {
    fn to_value(&self) -> Value {
        Value::object([
            ("run_id", self.run_id.as_str().into()),
            ("delete_worktree", self.delete_worktree.into()),
        ])
    }
    fn from_value(v: &Value) -> Result<Self, String> {
        let f = Fields::new(v)?;
        Ok(RunRemoveParams {
            run_id: f.str("run_id")?,
            delete_worktree: f.bool_or("delete_worktree", false)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRemoveResult {
    pub run_id: String,
    pub worktree_deleted: bool,
}

impl Wire for RunRemoveResult {
    fn to_value(&self) -> Value {
        Value::object([
            ("run_id", self.run_id.as_str().into()),
            ("worktree_deleted", self.worktree_deleted.into()),
        ])
    }
    fn from_value(v: &Value) -> Result<Self, String> {
        let f = Fields::new(v)?;
        Ok(RunRemoveResult {
            run_id: f.str("run_id")?,
            worktree_deleted: f.bool("worktree_deleted")?,
        })
    }
}

// --- wywołanie ----------------------------------------------------------------

/// Jedno wywołanie protokołu (metoda + typowane parametry). `run.list` i
/// `daemon.shutdown` nie mają parametrów.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Call {
    Auth(AuthParams),
    RunStart(RunStartParams),
    RunList,
    RunStop(RunStopParams),
    RunOutput(RunOutputParams),
    RunInput(RunInputParams),
    RunRemove(RunRemoveParams),
    DaemonShutdown,
}

impl Call {
    /// Rozpoznaje metodę i dekoduje parametry. Nieznana metoda -> `METHOD_NOT_FOUND`,
    /// złe parametry -> `INVALID_PARAMS`.
    pub fn parse(method: &str, params: &Value) -> Result<Call, RpcError> {
        fn p<T: Wire>(v: &Value) -> Result<T, RpcError> {
            T::from_value(v).map_err(RpcError::invalid_params)
        }
        Ok(match method {
            name::AUTH => Call::Auth(p(params)?),
            name::RUN_START => Call::RunStart(p(params)?),
            name::RUN_LIST => Call::RunList,
            name::RUN_STOP => Call::RunStop(p(params)?),
            name::RUN_OUTPUT => Call::RunOutput(p(params)?),
            name::RUN_INPUT => Call::RunInput(p(params)?),
            name::RUN_REMOVE => Call::RunRemove(p(params)?),
            name::DAEMON_SHUTDOWN => Call::DaemonShutdown,
            other => {
                return Err(RpcError::new(
                    crate::rpc::code::METHOD_NOT_FOUND,
                    format!("unknown method `{other}`"),
                ))
            }
        })
    }

    pub fn method(&self) -> &'static str {
        match self {
            Call::Auth(_) => name::AUTH,
            Call::RunStart(_) => name::RUN_START,
            Call::RunList => name::RUN_LIST,
            Call::RunStop(_) => name::RUN_STOP,
            Call::RunOutput(_) => name::RUN_OUTPUT,
            Call::RunInput(_) => name::RUN_INPUT,
            Call::RunRemove(_) => name::RUN_REMOVE,
            Call::DaemonShutdown => name::DAEMON_SHUTDOWN,
        }
    }

    pub fn params(&self) -> Value {
        match self {
            Call::Auth(p) => p.to_value(),
            Call::RunStart(p) => p.to_value(),
            Call::RunStop(p) => p.to_value(),
            Call::RunOutput(p) => p.to_value(),
            Call::RunInput(p) => p.to_value(),
            Call::RunRemove(p) => p.to_value(),
            Call::RunList | Call::DaemonShutdown => Value::empty_object(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;
    use crate::rpc::code;

    fn roundtrip(call: Call) {
        let wire = call.params().to_string();
        let back = Call::parse(call.method(), &json::parse(&wire).unwrap()).unwrap();
        assert_eq!(back, call, "{wire}");
    }

    #[test]
    fn all_calls_roundtrip() {
        roundtrip(Call::Auth(AuthParams {
            token: "abc".into(),
            protocol_version: Some(PROTOCOL_VERSION),
        }));
        roundtrip(Call::RunStart(RunStartParams {
            repo: "/tmp/r".into(),
            task: "Napraw błąd #12".into(),
            agent_cmd: vec!["bash".into(), "-c".into(), "echo \"hi\"\n".into()],
            name: Some("a1".into()),
        }));
        roundtrip(Call::RunStart(RunStartParams {
            repo: "/tmp/r".into(),
            task: "t".into(),
            agent_cmd: vec!["true".into()],
            name: None,
        }));
        roundtrip(Call::RunList);
        roundtrip(Call::RunStop(RunStopParams {
            run_id: "r1".into(),
            timeout_ms: Some(500),
        }));
        roundtrip(Call::RunOutput(RunOutputParams {
            run_id: "r1".into(),
            since: Some(10),
            max_bytes: None,
            wait_ms: Some(1000),
        }));
        roundtrip(Call::RunInput(RunInputParams {
            run_id: "r1".into(),
            data: b"hello\n".to_vec(),
        }));
        roundtrip(Call::RunInput(RunInputParams {
            run_id: "r1".into(),
            data: vec![0xff, 0x00, 0x1b],
        }));
        roundtrip(Call::RunRemove(RunRemoveParams {
            run_id: "r1".into(),
            delete_worktree: true,
        }));
        roundtrip(Call::DaemonShutdown);
    }

    #[test]
    fn exact_wire_format() {
        let c = Call::RunStart(RunStartParams {
            repo: "/r".into(),
            task: "fix bug".into(),
            agent_cmd: vec!["sh".into(), "-c".into(), "echo hi".into()],
            name: None,
        });
        assert_eq!(
            c.params().to_string(),
            r#"{"repo":"/r","task":"fix bug","agent_cmd":["sh","-c","echo hi"]}"#
        );
        let out = RunOutputResult {
            data: b"hi\r\n".to_vec(),
            offset: 0,
            next_offset: 4,
            dropped: 0,
            exited: true,
            exit_code: Some(0),
            signal: None,
        };
        assert_eq!(
            out.to_value().to_string(),
            r#"{"data_b64":"aGkNCg==","offset":0,"next_offset":4,"dropped":0,"exited":true,"exit_code":0}"#
        );
        assert_eq!(RunOutputResult::from_value(&out.to_value()).unwrap(), out);
    }

    #[test]
    fn param_errors() {
        let v = json::parse(r#"{"repo":"/r","task":"t","agent_cmd":["a",1]}"#).unwrap();
        let e = Call::parse(name::RUN_START, &v).unwrap_err();
        assert_eq!(e.code, code::INVALID_PARAMS);
        assert!(e.message.contains("agent_cmd"), "{}", e.message);

        let e = Call::parse(name::RUN_STOP, &Value::empty_object()).unwrap_err();
        assert_eq!(e.message, "missing field `run_id`");

        let v = json::parse(r#"{"run_id":"r1","since":-1}"#).unwrap();
        assert!(Call::parse(name::RUN_OUTPUT, &v).is_err());

        let v = json::parse(r#"{"run_id":"r1","data":"x","data_b64":"eA=="}"#).unwrap();
        assert!(Call::parse(name::RUN_INPUT, &v).is_err());

        let e = Call::parse("run.explode", &Value::empty_object()).unwrap_err();
        assert_eq!(e.code, code::METHOD_NOT_FOUND);
    }

    #[test]
    fn unknown_fields_ignored_and_null_is_absent() {
        let v = json::parse(r#"{"run_id":"r1","delete_worktree":null,"future":1}"#).unwrap();
        assert_eq!(
            Call::parse(name::RUN_REMOVE, &v).unwrap(),
            Call::RunRemove(RunRemoveParams {
                run_id: "r1".into(),
                delete_worktree: false
            })
        );
    }

    #[test]
    fn result_roundtrips() {
        let info = RunInfo {
            run_id: "r1".into(),
            name: "a1".into(),
            task: "t".into(),
            repo: "/r".into(),
            branch: "agent/t/a1".into(),
            worktree: "/w".into(),
            agent_cmd: vec!["sh".into()],
            state: "exited".into(),
            tty: "pty".into(),
            pid: Some(42),
            exit_code: Some(3),
            signal: None,
            output_bytes: 12,
        };
        let list = RunListResult { runs: vec![info] };
        assert_eq!(RunListResult::from_value(&list.to_value()).unwrap(), list);
        let a = AuthResult {
            protocol_version: 1,
            daemon_version: "0.1.0".into(),
        };
        assert_eq!(AuthResult::from_value(&a.to_value()).unwrap(), a);
        let s = RunStopResult {
            run_id: "r1".into(),
            exit_code: None,
            signal: Some(15),
            killed: false,
            already_exited: false,
        };
        assert_eq!(RunStopResult::from_value(&s.to_value()).unwrap(), s);
    }
}
