//! Synchroniczny klient JSON-RPC po sockecie unix (CLI, testy, przyszły most Tauri).

use crate::json::{self, Value};
use crate::methods::*;
use crate::rpc::{Request, Response, RpcError, MAX_FRAME_BYTES};
use std::fmt;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;

#[derive(Debug)]
pub enum ClientError {
    Io(io::Error),
    /// Odpowiedź niezgodna z protokołem.
    Protocol(String),
    /// Daemon zwrócił błąd JSON-RPC.
    Rpc(RpcError),
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClientError::Io(e) => write!(f, "I/O error: {e}"),
            ClientError::Protocol(m) => write!(f, "protocol error: {m}"),
            ClientError::Rpc(e) => write!(f, "daemon error: {e}"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<io::Error> for ClientError {
    fn from(e: io::Error) -> Self {
        ClientError::Io(e)
    }
}

impl ClientError {
    /// Kod błędu JSON-RPC, jeśli to błąd zwrócony przez daemon.
    pub fn rpc_code(&self) -> Option<i64> {
        match self {
            ClientError::Rpc(e) => Some(e.code),
            _ => None,
        }
    }
}

pub struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next_id: i64,
}

impl Client {
    pub fn connect(socket: &Path) -> Result<Client, ClientError> {
        let stream = UnixStream::connect(socket).map_err(|e| {
            io::Error::new(
                e.kind(),
                format!("cannot connect to {}: {e}", socket.display()),
            )
        })?;
        let writer = stream.try_clone()?;
        Ok(Client {
            reader: BufReader::new(stream),
            writer,
            next_id: 1,
        })
    }

    /// Łączy się i uwierzytelnia tokenem z pliku obok socketu.
    pub fn connect_authenticated(socket: &Path) -> Result<(Client, AuthResult), ClientError> {
        let token = crate::paths::read_token(socket)?;
        let mut c = Client::connect(socket)?;
        let auth = c.auth(&token)?;
        Ok((c, auth))
    }

    /// Wysyła surowe wywołanie i zwraca `result`.
    pub fn call_raw(&mut self, method: &str, params: Value) -> Result<Value, ClientError> {
        let id = self.next_id;
        self.next_id += 1;
        let mut line = Request::new(id, method, params).to_value().to_string();
        line.push('\n');
        self.writer.write_all(line.as_bytes())?;
        self.writer.flush()?;

        let mut buf = Vec::new();
        let n = (&mut self.reader)
            .take(MAX_FRAME_BYTES as u64 + 1)
            .read_until(b'\n', &mut buf)?;
        if n == 0 {
            return Err(ClientError::Protocol("daemon closed the connection".into()));
        }
        if buf.last() != Some(&b'\n') {
            return Err(ClientError::Protocol(
                "response frame too long or truncated".into(),
            ));
        }
        buf.pop();
        let v = json::parse_bytes(&buf).map_err(|e| ClientError::Protocol(e.to_string()))?;
        let resp = Response::from_value(&v).map_err(ClientError::Protocol)?;
        if resp.id != Value::Int(id) {
            return Err(ClientError::Protocol(format!(
                "response id {} does not match request id {id}",
                resp.id
            )));
        }
        resp.outcome.map_err(ClientError::Rpc)
    }

    pub fn call<R: Wire>(&mut self, call: &Call) -> Result<R, ClientError> {
        let v = self.call_raw(call.method(), call.params())?;
        R::from_value(&v).map_err(|e| ClientError::Protocol(format!("{}: {e}", call.method())))
    }

    pub fn auth(&mut self, token: &str) -> Result<AuthResult, ClientError> {
        self.call(&Call::Auth(AuthParams {
            token: token.to_owned(),
            protocol_version: Some(PROTOCOL_VERSION),
        }))
    }

    pub fn run_start(&mut self, p: RunStartParams) -> Result<RunStartResult, ClientError> {
        self.call(&Call::RunStart(p))
    }

    pub fn run_list(&mut self) -> Result<Vec<RunInfo>, ClientError> {
        self.call::<RunListResult>(&Call::RunList).map(|r| r.runs)
    }

    pub fn run_stop(
        &mut self,
        run_id: &str,
        timeout_ms: Option<u64>,
    ) -> Result<RunStopResult, ClientError> {
        self.call(&Call::RunStop(RunStopParams {
            run_id: run_id.to_owned(),
            timeout_ms,
        }))
    }

    pub fn run_output(&mut self, p: RunOutputParams) -> Result<RunOutputResult, ClientError> {
        self.call(&Call::RunOutput(p))
    }

    pub fn run_input(&mut self, run_id: &str, data: &[u8]) -> Result<u64, ClientError> {
        self.call::<RunInputResult>(&Call::RunInput(RunInputParams {
            run_id: run_id.to_owned(),
            data: data.to_vec(),
        }))
        .map(|r| r.written)
    }

    pub fn run_remove(
        &mut self,
        run_id: &str,
        delete_worktree: bool,
    ) -> Result<RunRemoveResult, ClientError> {
        self.call(&Call::RunRemove(RunRemoveParams {
            run_id: run_id.to_owned(),
            delete_worktree,
        }))
    }

    pub fn shutdown(&mut self) -> Result<(), ClientError> {
        self.call_raw(name::DAEMON_SHUTDOWN, Value::empty_object())
            .map(|_| ())
    }
}
