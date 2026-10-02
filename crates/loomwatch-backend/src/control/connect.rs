//! One-click connections: other AI apps use the `LoomWatch` Control tools (ADR 0033, step 3).
//!
//! *Connect* registers `LoomWatch` with the app's own command — never by editing its config files —
//! after the panel has shown that exact command. Each connection gets its own token, kept in
//! `<teams root>/.loomwatch/connections.json` so the app keeps working after a restart.
//! *Disconnect* runs the app's own remove and revokes the token. Apps with no command for this get
//! a snippet to paste instead.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path as RoutePath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Caller, Control, SERVER_NAME, error, lock, new_token, now};
use crate::acp::EventLog;
use crate::archive::EventArchive;

const FILE: &str = ".loomwatch/connections.json";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
/// The environment variable the stdio bridge reads its token from.
pub const TOKEN_VARIABLE: &str = "LOOMWATCH_CONTROL_TOKEN";

#[derive(Debug, Default, Serialize, Deserialize)]
struct ConnectionsFile {
    #[serde(default)]
    apps: BTreeMap<String, Record>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    token: String,
    connected_at: String,
}

pub(super) struct Connections {
    path: PathBuf,
    file: StdMutex<ConnectionsFile>,
    /// One archive session per app per daemon start: an `EventLog` numbers from zero, so reusing
    /// last start's session id would collide with what is already archived under it.
    logs: StdMutex<BTreeMap<String, EventLog>>,
    started: String,
    /// The last [`INBOX_LIMIT`] things connected apps did, for the Ask panel.
    inbox: StdMutex<std::collections::VecDeque<Value>>,
}

const INBOX_LIMIT: usize = 50;

impl Connections {
    pub(super) fn load(teams_root: &Path) -> Self {
        let path = teams_root.join(FILE);
        let file = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self {
            path,
            file: StdMutex::new(file),
            logs: StdMutex::default(),
            started: uuid::Uuid::new_v4().simple().to_string(),
            inbox: StdMutex::default(),
        }
    }

    pub(super) fn remember(&self, app: &str, payload: &Value) {
        let name = APPS
            .iter()
            .find(|spec| spec.id == app)
            .map_or(app, |spec| spec.name);
        let mut item = payload.clone();
        if let Some(object) = item.as_object_mut() {
            object.insert("app".to_owned(), json!(app));
            object.insert("appName".to_owned(), json!(name));
            object.insert("at".to_owned(), json!(now()));
        }
        let mut inbox = lock(&self.inbox);
        inbox.push_back(item);
        while inbox.len() > INBOX_LIMIT {
            inbox.pop_front();
        }
    }

    pub(super) fn inbox(&self) -> Vec<Value> {
        lock(&self.inbox).iter().cloned().collect()
    }

    pub(super) fn tokens(&self) -> Vec<(String, String)> {
        lock(&self.file)
            .apps
            .iter()
            .map(|(app, record)| (app.clone(), record.token.clone()))
            .collect()
    }

    pub(super) fn event_log(&self, app: &str, archive: Option<&EventArchive>) -> Option<EventLog> {
        let archive = archive?;
        let mut logs = lock(&self.logs);
        Some(
            logs.entry(app.to_owned())
                .or_insert_with(|| {
                    EventLog::new(
                        archive.clone(),
                        format!("ask-connection-{app}-{}", self.started),
                    )
                })
                .clone(),
        )
    }

    fn connected(&self, app: &str) -> Option<Record> {
        lock(&self.file).apps.get(app).cloned()
    }

    fn save(&self, update: impl FnOnce(&mut ConnectionsFile)) -> Result<(), String> {
        let mut file = lock(&self.file);
        update(&mut file);
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let text = serde_json::to_string_pretty(&*file).map_err(|error| error.to_string())?;
        std::fs::write(&self.path, text).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

/// How one app is connected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Method {
    /// `LoomWatch` runs the app's own command.
    Command,
    /// The app has no command for this: `LoomWatch` shows a snippet to paste.
    Snippet,
}

struct AppSpec {
    id: &'static str,
    name: &'static str,
    method: Method,
    /// Where the person pastes a snippet.
    snippet_place: &'static str,
}

const APPS: [AppSpec; 6] = [
    AppSpec {
        id: "claude",
        name: "Claude Code",
        method: Method::Command,
        snippet_place: "",
    },
    AppSpec {
        id: "codex",
        name: "Codex",
        method: Method::Command,
        snippet_place: "",
    },
    AppSpec {
        id: "gemini",
        name: "Gemini CLI",
        method: Method::Command,
        snippet_place: "",
    },
    AppSpec {
        id: "vscode",
        name: "VS Code",
        method: Method::Command,
        snippet_place: "",
    },
    AppSpec {
        id: "opencode",
        name: "OpenCode",
        method: Method::Snippet,
        snippet_place: "the \"mcp\" section of ~/.config/opencode/opencode.json",
    },
    AppSpec {
        id: "claude-desktop",
        name: "Claude Desktop",
        method: Method::Snippet,
        snippet_place: "\"mcpServers\" in Claude Desktop's Settings → Developer → Edit Config",
    },
];

/// What runs for one app, or the snippet it takes. `token` is the real one; [`masked`] hides it
/// for display.
struct Plan {
    program: String,
    args: Vec<String>,
    remove: Option<(String, Vec<String>)>,
    snippet: Option<Value>,
}

fn plan(control: &Control, spec: &AppSpec, token: &str) -> Plan {
    let url = control.mcp_url();
    let bridge = std::env::current_exe().map_or_else(
        |_| "loomwatchd".to_owned(),
        |path| path.to_string_lossy().into_owned(),
    );
    let header = format!("Authorization: Bearer {token}");
    let program = |command: &str| {
        control
            .inner
            .search_path
            .as_deref()
            .and_then(|path| crate::api::find_executable(path, command))
            .map_or_else(
                || command.to_owned(),
                |path| path.to_string_lossy().into_owned(),
            )
    };
    let strings = |values: &[&str]| {
        values
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>()
    };
    match spec.id {
        "claude" => Plan {
            program: program("claude"),
            args: strings(&["mcp", "add", "--scope", "user", "--transport", "http", SERVER_NAME, &url, "--header", &header]),
            remove: Some((program("claude"), strings(&["mcp", "remove", "--scope", "user", SERVER_NAME]))),
            snippet: None,
        },
        "codex" => Plan {
            program: program("codex"),
            args: strings(&["mcp", "add", SERVER_NAME, "--env", &format!("{TOKEN_VARIABLE}={token}"), "--", &bridge, "mcp", "--url", &url]),
            remove: Some((program("codex"), strings(&["mcp", "remove", SERVER_NAME]))),
            snippet: None,
        },
        "gemini" => Plan {
            program: program("gemini"),
            args: strings(&["mcp", "add", "--scope", "user", "--transport", "http", "--header", &header, SERVER_NAME, &url]),
            remove: Some((program("gemini"), strings(&["mcp", "remove", "--scope", "user", SERVER_NAME]))),
            snippet: None,
        },
        "vscode" => Plan {
            program: program("code"),
            args: vec![
                "--add-mcp".to_owned(),
                json!({"name": SERVER_NAME, "type": "http", "url": url, "headers": {"Authorization": format!("Bearer {token}")}}).to_string(),
            ],
            remove: None,
            snippet: None,
        },
        "opencode" => Plan {
            program: String::new(),
            args: Vec::new(),
            remove: None,
            snippet: Some(json!({SERVER_NAME: {"type": "remote", "url": url, "enabled": true, "headers": {"Authorization": format!("Bearer {token}")}}})),
        },
        _ => Plan {
            program: String::new(),
            args: Vec::new(),
            remove: None,
            snippet: Some(json!({SERVER_NAME: {"command": bridge, "args": ["mcp", "--url", url], "env": {TOKEN_VARIABLE: token}}})),
        },
    }
}

/// A command as the panel shows it: the token replaced, every argument quoted as a shell would
/// need it.
fn shown(program: &str, args: &[String], token: &str) -> String {
    let short = Path::new(program).file_name().map_or_else(
        || program.to_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    std::iter::once(short)
        .chain(args.iter().map(|arg| quote(&masked(arg, token))))
        .collect::<Vec<_>>()
        .join(" ")
}

fn masked(text: &str, token: &str) -> String {
    if token.is_empty() {
        return text.to_owned();
    }
    text.replace(token, "lw_••••••••")
}

fn quote(arg: &str) -> String {
    if !arg.is_empty()
        && arg
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_./:=@".contains(character))
    {
        arg.to_owned()
    } else {
        format!("'{}'", arg.replace('\'', r"'\''"))
    }
}

fn detected(control: &Control, spec: &AppSpec) -> bool {
    let on_path = |command: &str| {
        control
            .inner
            .search_path
            .as_deref()
            .and_then(|path| crate::api::find_executable(path, command))
            .is_some()
    };
    match spec.id {
        "claude" => on_path("claude"),
        "codex" => on_path("codex"),
        "gemini" => on_path("gemini"),
        "opencode" => on_path("opencode"),
        "vscode" => on_path("code"),
        _ => Path::new("/Applications/Claude.app").exists(),
    }
}

fn describe(control: &Control, spec: &AppSpec) -> Value {
    let record = control.inner.connections.connected(spec.id);
    // Shown before connecting with a placeholder token, after connecting with the real one masked.
    let token = record
        .as_ref()
        .map(|record| record.token.clone())
        .unwrap_or_default();
    let plan = plan(
        control,
        spec,
        if token.is_empty() { "TOKEN" } else { &token },
    );
    json!({
        "id": spec.id,
        "name": spec.name,
        "detected": detected(control, spec),
        "connected": record.is_some(),
        "connectedAt": record.map(|record| record.connected_at),
        "method": if spec.method == Method::Command { "command" } else { "snippet" },
        "command": (spec.method == Method::Command).then(|| shown(&plan.program, &plan.args, &token).replace("TOKEN", "lw_••••••••")),
        "canRemove": plan.remove.is_some(),
        "snippetPlace": (spec.method == Method::Snippet).then_some(spec.snippet_place),
    })
}

pub(super) async fn list(State(control): State<Control>) -> Json<Value> {
    Json(json!({
        "url": control.mcp_url(),
        "apps": APPS.iter().map(|spec| describe(&control, spec)).collect::<Vec<_>>(),
    }))
}

pub(super) async fn connect(
    State(control): State<Control>,
    RoutePath(app): RoutePath<String>,
) -> Response {
    let Some(spec) = APPS.iter().find(|spec| spec.id == app) else {
        return error(
            StatusCode::NOT_FOUND,
            format!("LoomWatch can't connect {app}."),
        );
    };
    let token = control
        .inner
        .connections
        .connected(spec.id)
        .map_or_else(new_token, |record| record.token);
    let plan = plan(&control, spec, &token);
    if spec.method == Method::Command {
        if !detected(&control, spec) {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("{} isn't installed on this computer.", spec.name),
            );
        }
        if let Err(message) = run(&plan.program, &plan.args, &token).await {
            return error(
                StatusCode::BAD_GATEWAY,
                format!("{} didn't accept the connection: {message}", spec.name),
            );
        }
    }
    if let Err(message) = control.inner.connections.save(|file| {
        file.apps.insert(
            spec.id.to_owned(),
            Record {
                token: token.clone(),
                connected_at: now(),
            },
        );
    }) {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("couldn't save the connection: {message}"),
        );
    }
    control
        .inner
        .tokens
        .write()
        .await
        .insert(token.clone(), Caller::Connection(spec.id.to_owned()));
    let mut body = describe(&control, spec);
    if let (Some(snippet), Some(object)) = (plan.snippet, body.as_object_mut()) {
        // The one place the real token leaves the daemon for a snippet app: the person has to paste it.
        object.insert("snippet".to_owned(), snippet);
    }
    (StatusCode::OK, Json(body)).into_response()
}

pub(super) async fn disconnect(
    State(control): State<Control>,
    RoutePath(app): RoutePath<String>,
) -> Response {
    let Some(spec) = APPS.iter().find(|spec| spec.id == app) else {
        return error(
            StatusCode::NOT_FOUND,
            format!("LoomWatch can't connect {app}."),
        );
    };
    let Some(record) = control.inner.connections.connected(spec.id) else {
        return StatusCode::NO_CONTENT.into_response();
    };
    let plan = plan(&control, spec, &record.token);
    let mut removed_by_app = false;
    if let Some((program, args)) = &plan.remove
        && detected(&control, spec)
    {
        removed_by_app = run(program, args, &record.token).await.is_ok();
    }
    // The token is revoked whatever the app said, so a stale registration can no longer call in.
    control.inner.tokens.write().await.remove(&record.token);
    if let Err(message) = control.inner.connections.save(|file| {
        file.apps.remove(spec.id);
    }) {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("couldn't save: {message}"),
        );
    }
    Json(json!({
        "id": spec.id,
        "connected": false,
        "removedFromApp": removed_by_app,
        "note": (!removed_by_app).then(|| format!(
            "LoomWatch stopped answering {}. Remove \"{SERVER_NAME}\" from its MCP settings too.",
            spec.name
        )),
    }))
    .into_response()
}

/// Run an app's own registration command, refusing to wait forever.
async fn run(program: &str, args: &[String], token: &str) -> Result<(), String> {
    let output = tokio::time::timeout(
        COMMAND_TIMEOUT,
        tokio::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "it took more than a minute".to_owned())?
    .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&output.stderr);
    let said = if said.trim().is_empty() {
        String::from_utf8_lossy(&output.stdout).into_owned()
    } else {
        said.into_owned()
    };
    Err(masked(super::first_line(said.trim()).as_str(), token))
}

/// `loomwatchd mcp`: a stdio MCP server that forwards every request to the daemon's HTTP tool
/// server, for apps that start local servers as commands (Codex, Claude Desktop).
///
/// # Errors
///
/// Returns an error when the token variable is missing or stdin/stdout fail. A daemon that is not
/// running is reported per request, as a JSON-RPC error the app can show.
pub async fn bridge(url: &str) -> anyhow::Result<()> {
    use anyhow::Context as _;

    let token = std::env::var(TOKEN_VARIABLE).with_context(|| {
        format!("{TOKEN_VARIABLE} is not set; connect this app from LoomWatch's Connections page")
    })?;
    bridge_io(url, &token, tokio::io::stdin(), tokio::io::stdout()).await
}

/// [`bridge`] over any pair of streams, so it can be tested without a process.
pub(crate) async fn bridge_io<R, W>(
    url: &str,
    token: &str,
    input: R,
    mut stdout: W,
) -> anyhow::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};

    let client = reqwest::Client::new();
    let mut lines = BufReader::new(input).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(_) => continue,
        };
        let id = request.get("id").cloned();
        let response = client
            .post(url)
            .bearer_auth(token)
            .json(&request)
            .send()
            .await;
        let Some(id) = id else { continue };
        let reply = match response {
            Ok(response) if response.status().is_success() => {
                response.json::<Value>().await.unwrap_or_else(|error| {
                    bridge_error(&id, &format!("LoomWatch sent an unreadable reply: {error}"))
                })
            }
            Ok(response) if response.status() == reqwest::StatusCode::UNAUTHORIZED => bridge_error(
                &id,
                "LoomWatch no longer accepts this connection. Connect this app again from LoomWatch's Connections page.",
            ),
            Ok(response) => {
                bridge_error(&id, &format!("LoomWatch answered {}.", response.status()))
            }
            Err(_) => bridge_error(
                &id,
                "LoomWatch isn't running. Start it with ./loomwatch, then try again.",
            ),
        };
        let mut encoded = serde_json::to_vec(&reply)?;
        encoded.push(b'\n');
        stdout.write_all(&encoded).await?;
        stdout.flush().await?;
    }
    Ok(())
}

fn bridge_error(id: &Value, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": message}})
}
