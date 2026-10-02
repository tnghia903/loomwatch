//! Ask `LoomWatch` end to end, with a scripted ACP app and fake app commands: no model provider is
//! ever contacted (ADR 0033).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use sqlx::PgPool;

use super::{Control, ControlOptions};
use crate::archive::EventArchive;
use crate::runs::RunRegistry;

const FAKE_ASSISTANT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/ask_fake_assistant.py"
);
const DEMO_HARNESS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../examples/operator-stop-harness.py"
);

struct TempDirectory(PathBuf);

impl TempDirectory {
    fn new(label: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("loomwatch-ask-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("temporary directory");
        Self(std::fs::canonicalize(&path).expect("canonical temporary directory"))
    }
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A served [`Control`] over a scratch teams folder.
struct Fixture {
    root: TempDirectory,
    base: String,
    control: Control,
    registry: RunRegistry,
    client: reqwest::Client,
}

impl Fixture {
    async fn start(archive: Option<EventArchive>, search_path: Option<std::ffi::OsString>) -> Self {
        let root = TempDirectory::new("teams");
        std::fs::copy(DEMO_HARNESS, root.0.join("operator-stop-harness.py")).expect("demo harness");
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let registry = RunRegistry::default();
        let control = Control::with_search_path(
            ControlOptions {
                archive,
                teams_root: root.0.clone(),
                registry: registry.clone(),
                listen: address,
                ask_command: Some(vec!["python3".to_owned(), FAKE_ASSISTANT.to_owned()]),
            },
            search_path,
        );
        let router = control.router();
        tokio::spawn(async move { axum::serve(listener, router).await });
        Self {
            root,
            base: format!("http://{address}"),
            control,
            registry,
            client: reqwest::Client::new(),
        }
    }

    async fn post(&self, path: &str, body: &Value) -> (u16, Value) {
        let response = self
            .client
            .post(format!("{}{path}", self.base))
            .json(body)
            .send()
            .await
            .expect("post");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str) -> (u16, Value) {
        let response = self
            .client
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .expect("get");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    async fn mcp(&self, token: &str, body: &Value) -> (u16, Value) {
        let response = self
            .client
            .post(format!("{}/api/control/mcp", self.base))
            .bearer_auth(token)
            .json(body)
            .send()
            .await
            .expect("mcp");
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }

    /// Send a message and wait for the app to finish its turn.
    async fn say(&self, conversation: &str, text: &str) {
        let (status, body) = self
            .post(
                &format!("/api/ask/conversations/{conversation}/messages"),
                &json!({"text": text, "context": {"view": "home"}}),
            )
            .await;
        assert_eq!(status, 202, "message accepted: {body}");
        for _ in 0..300 {
            let (_, status) = self
                .get(&format!("/api/ask/conversations/{conversation}"))
                .await;
            match status["state"].as_str() {
                Some("ready") => return,
                Some("failed") => panic!("conversation failed: {status}"),
                _ => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
        panic!("the app never finished its turn");
    }

    async fn events(&self, conversation: &str) -> Vec<crate::RunEvent> {
        self.control
            .inner
            .archive
            .as_ref()
            .expect("archive")
            .load_session(conversation)
            .await
            .expect("events")
    }

    async fn token_of(&self, conversation: &str) -> String {
        self.control
            .conversation(conversation)
            .await
            .expect("conversation")
            .token
            .clone()
    }
}

fn phases<'a>(events: &'a [crate::RunEvent], phase: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|event| event.payload["phase"] == phase)
        .map(|event| &event.payload)
        .collect()
}

/// Every event in one line each, for a failure message that explains itself.
fn dump(events: &[crate::RunEvent]) -> String {
    events
        .iter()
        .map(|event| {
            let detail = [
                event.payload.get("phase"),
                event.payload.get("title"),
                event.payload.get("status"),
                event.payload.pointer("/content/text"),
                event.payload.get("message"),
                event.payload.get("error"),
            ]
            .into_iter()
            .flatten()
            .map(|value| value.to_string().chars().take(160).collect::<String>())
            .collect::<Vec<_>>()
            .join(" ");
            format!("{:?} {detail}", event.kind)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn said(events: &[crate::RunEvent]) -> String {
    events
        .iter()
        .filter(|event| event.kind == crate::EventKind::Message && event.payload["role"] == "agent")
        .filter_map(|event| {
            event
                .payload
                .pointer("/content/text")
                .and_then(Value::as_str)
        })
        .collect()
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_conversation_proposes_asks_before_running_and_drafts_a_review_note(pool: PgPool) {
    let fixture = Fixture::start(Some(EventArchive::from_pool(pool)), None).await;
    let (status, started) = fixture.post("/api/ask/conversations", &json!({})).await;
    assert_eq!(status, 201, "{started}");
    assert_eq!(started["appName"], "Offline assistant");
    let id = started["id"].as_str().expect("id").to_owned();

    // A proposal: the broken draft is refused by the same rules as a save, the fixed one is
    // archived for the panel, and nothing is written to disk.
    fixture.say(&id, "Build me a morning brief team").await;
    let events = fixture.events(&id).await;
    let proposals = phases(&events, "ask_proposal");
    assert_eq!(
        proposals.len(),
        1,
        "only the valid draft becomes a proposal: {}",
        dump(&events)
    );
    let proposal = proposals[0];
    assert_eq!(proposal["file"], "morning-chip-brief.yaml");
    assert_eq!(proposal["isNew"], true);
    assert_eq!(proposal["baseRevision"], Value::Null);
    let yaml = proposal["yaml"].as_str().expect("yaml").to_owned();
    assert!(crate::config::TeamConfig::parse(&yaml).is_ok());
    assert!(
        !fixture.root.0.join("morning-chip-brief.yaml").exists(),
        "a proposal never writes the team file"
    );
    let refused = events
        .iter()
        .filter(|event| {
            event.kind == crate::EventKind::ToolUpdate && event.payload["status"] == "failed"
        })
        .count();
    assert_eq!(refused, 1, "the broken draft came back as a tool error");
    assert!(
        said(&events).contains("fixed it"),
        "the app saw the error and fixed it"
    );
    assert_eq!(
        phases(&events, "ask_message")[0]["text"],
        "Build me a morning brief team"
    );
    let (status, stored) = fixture
        .get(&format!(
            "/api/ask/proposals/{}",
            proposal["proposalId"].as_str().expect("id")
        ))
        .await;
    assert_eq!(status, 200);
    assert_eq!(stored["yaml"], yaml.as_str());

    // A run of a team that was only proposed is refused with the reason.
    fixture.say(&id, "run it").await;
    let events = fixture.events(&id).await;
    assert!(
        said(&events).contains("There is no team file morning-chip-brief.yaml yet")
            && said(&events).contains("press Apply before it can run"),
        "{}",
        said(&events)
    );
    assert!(phases(&events, "ask_run_request").is_empty());

    // Applied (the panel saves with the editor's own PUT): now the app may only ask.
    std::fs::write(fixture.root.0.join("morning-chip-brief.yaml"), &yaml).expect("apply");
    fixture.say(&id, "run it").await;
    let events = fixture.events(&id).await;
    let requests = phases(&events, "ask_run_request");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["name"], "Morning chip brief");
    assert_eq!(requests[0]["request"], "Prepare today's brief.");
    assert_eq!(requests[0]["apps"], json!(["a custom command"]));
    assert!(fixture.registry.list().is_empty(), "asking starts nothing");
    let request = requests[0]["requestId"]
        .as_str()
        .expect("request")
        .to_owned();
    let (status, _) = fixture
        .post(
            &format!("/api/ask/conversations/{id}/run-requests/{request}"),
            &json!({"decision": "declined"}),
        )
        .await;
    assert_eq!(status, 204);
    assert_eq!(
        phases(&fixture.events(&id).await, "ask_run_declined").len(),
        1
    );

    // With direct runs allowed, the same tool starts a real run.
    let (status, _) = fixture
        .post(
            &format!("/api/ask/conversations/{id}/settings"),
            &json!({"askBeforeRun": false}),
        )
        .await;
    assert_eq!(status, 200);
    fixture.say(&id, "run it").await;
    let events = fixture.events(&id).await;
    let started = phases(&events, "ask_run_started");
    assert_eq!(started.len(), 1);
    let run_id = started[0]["runId"].as_str().expect("run").to_owned();
    assert!(fixture.registry.get(&run_id).is_some());

    // The run reaches its review stop; the app can draft a note but not answer it.
    let mut waiting = false;
    for _ in 0..300 {
        if fixture
            .registry
            .get(&run_id)
            .is_some_and(|record| record.waiting_on.is_some())
        {
            waiting = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        waiting,
        "the run reached its review stop: {:?}",
        fixture.registry.get(&run_id)
    );
    fixture.say(&id, "draft a note").await;
    let events = fixture.events(&id).await;
    let notes = phases(&events, "ask_review_note");
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0]["runId"], run_id.as_str());
    assert_eq!(notes[0]["node"], "review");
    assert_eq!(
        notes[0]["text"],
        "Approved. Keep the brief to five bullets."
    );
    let record = fixture.registry.get(&run_id).expect("run");
    assert!(
        record.waiting_on.is_some(),
        "a drafted note answers nothing"
    );

    // Ending the conversation revokes its token.
    let token = fixture.token_of(&id).await;
    let client = reqwest::Client::new();
    let deleted = client
        .delete(format!("{}/api/ask/conversations/{id}", fixture.base))
        .send()
        .await
        .expect("delete");
    assert_eq!(deleted.status().as_u16(), 204);
    let mut revoked = false;
    for _ in 0..100 {
        let (status, _) = fixture
            .mcp(
                &token,
                &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
            )
            .await;
        if status == 401 {
            revoked = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(revoked, "an ended conversation's token no longer works");
    let (_, ended) = fixture.get(&format!("/api/ask/conversations/{id}")).await;
    assert_eq!(ended["state"], "ended");
    let _ = fixture.registry.cancel(&run_id);
}

#[sqlx::test(migrations = "../../migrations")]
async fn the_person_chooses_the_app_and_model_a_conversation_uses(pool: PgPool) {
    let fixture = Fixture::start(Some(EventArchive::from_pool(pool)), None).await;

    let (status, refused) = fixture
        .post("/api/ask/conversations", &json!({"app": "nope"}))
        .await;
    assert_eq!(status, 422, "{refused}");
    assert!(
        refused["error"]
            .as_str()
            .is_some_and(|text| text.starts_with("nope isn't an AI app Ask can use")),
        "{refused}"
    );
    let (status, refused) = fixture
        .post(
            "/api/ask/conversations",
            &json!({"app": "custom", "model": "a\nb"}),
        )
        .await;
    assert_eq!(
        status, 422,
        "a model with a line break is not an id: {refused}"
    );

    let (status, started) = fixture
        .post(
            "/api/ask/conversations",
            &json!({"app": "custom", "model": "  fake-model-2  "}),
        )
        .await;
    assert_eq!(status, 201, "{started}");
    assert_eq!(started["app"], "custom");
    assert_eq!(started["model"], "fake-model-2");
    let id = started["id"].as_str().expect("id").to_owned();
    let (_, status) = fixture.get(&format!("/api/ask/conversations/{id}")).await;
    assert_eq!(status["model"], "fake-model-2");

    // The app is asked for that model when its session opens, and the transcript says which.
    fixture.say(&id, "Which teams do I have?").await;
    let events = fixture.events(&id).await;
    let asked_for = events
        .iter()
        .filter(|event| event.kind == crate::EventKind::SessionMeta)
        .any(|event| {
            event.payload["configId"] == "model" && event.payload["value"] == "fake-model-2"
        });
    assert!(asked_for, "the model reached the app: {}", dump(&events));
    let recorded = phases(&events, "ask_status");
    assert!(
        recorded
            .iter()
            .all(|status| status["app"]["model"] == "fake-model-2"),
        "{}",
        dump(&events)
    );

    // No model means the app's own default, and the status leaves the model out.
    let (status, default) = fixture
        .post("/api/ask/conversations", &json!({"model": ""}))
        .await;
    assert_eq!(status, 201, "{default}");
    assert_eq!(default["model"], Value::Null);
    for conversation in [id, default["id"].as_str().expect("id").to_owned()] {
        let _ = fixture
            .client
            .delete(format!(
                "{}/api/ask/conversations/{conversation}",
                fixture.base
            ))
            .send()
            .await;
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn the_tool_server_needs_a_live_token_and_lists_only_its_tools(pool: PgPool) {
    let fixture = Fixture::start(
        Some(EventArchive::from_pool(pool)),
        Some(std::ffi::OsString::new()),
    )
    .await;
    let (status, _) = fixture
        .mcp(
            "not-a-token",
            &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
        )
        .await;
    assert_eq!(status, 401);
    let response = reqwest::Client::new()
        .post(format!("{}/api/control/mcp", fixture.base))
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
        .send()
        .await
        .expect("post");
    assert_eq!(response.status().as_u16(), 401, "no token, no tools");

    let (_, started) = fixture.post("/api/ask/conversations", &json!({})).await;
    let id = started["id"].as_str().expect("id").to_owned();
    let token = fixture.token_of(&id).await;
    let (status, listed) = fixture
        .mcp(
            &token,
            &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
        )
        .await;
    assert_eq!(status, 200);
    let names = listed["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool["name"].as_str().expect("name").to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        [
            "list_teams",
            "read_team",
            "list_apps",
            "propose_team",
            "start_run",
            "get_run",
            "draft_review_note"
        ],
        "no tool answers a review stop, saves a file, or deletes anything"
    );

    // Paths a proposal may not use, checked before anything is parsed or archived.
    for file in [
        "../outside.yaml",
        "/etc/team.yaml",
        ".hidden/team.yaml",
        "team.txt",
        "missing/team.yaml",
    ] {
        let (_, reply) = fixture
            .mcp(
                &token,
                &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
                    "name": "propose_team",
                    "arguments": {"file": file, "yaml": "schemaVersion: 1", "summary": "x"}
                }}),
            )
            .await;
        assert_eq!(reply["result"]["isError"], true, "{file}: {reply}");
    }
    let (_, apps) = fixture
        .mcp(
            &token,
            &json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "list_apps", "arguments": {}}}),
        )
        .await;
    assert_eq!(
        apps["result"]["structuredContent"]["apps"],
        json!([]),
        "an empty search path finds no apps"
    );
    let _ = reqwest::Client::new()
        .delete(format!("{}/api/ask/conversations/{id}", fixture.base))
        .send()
        .await;
}

/// A stand-in for an app's own command: records its arguments, then succeeds or fails.
fn fake_app(bin: &Path, name: &str, record: &Path, fail: bool) {
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{}'\n{}",
        record.display(),
        if fail {
            "echo \"error: refused $*\" >&2\nexit 1\n"
        } else {
            "exit 0\n"
        }
    );
    let path = bin.join(name);
    std::fs::write(&path, script).expect("fake app");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("executable");
    }
}

#[tokio::test]
async fn connect_runs_the_apps_own_command_and_disconnect_revokes_the_token() {
    let bin = TempDirectory::new("bin");
    let record = bin.0.join("calls.txt");
    fake_app(&bin.0, "claude", &record, false);
    let fixture = Fixture::start(None, Some(bin.0.clone().into_os_string())).await;

    let (_, before) = fixture.get("/api/ask/connections").await;
    let claude = before["apps"]
        .as_array()
        .expect("apps")
        .iter()
        .find(|app| app["id"] == "claude")
        .expect("claude")
        .clone();
    assert_eq!(claude["detected"], true);
    assert_eq!(claude["connected"], false);
    let shown = claude["command"].as_str().expect("command");
    assert!(
        shown.starts_with("claude mcp add --scope user --transport http loomwatch"),
        "{shown}"
    );
    assert!(
        shown.contains("lw_••••••••"),
        "the token is never shown: {shown}"
    );

    let (status, connected) = fixture
        .post("/api/ask/connections/claude", &json!({}))
        .await;
    assert_eq!(status, 200, "{connected}");
    assert_eq!(connected["connected"], true);
    let calls = std::fs::read_to_string(&record).expect("calls");
    let token = calls
        .lines()
        .find_map(|line| line.strip_prefix("Authorization: Bearer "))
        .expect("the header carried the token")
        .to_owned();
    assert!(calls.contains(&format!("{}/api/control/mcp", fixture.base)));
    assert!(
        !connected.to_string().contains(&token),
        "the token never comes back for a command app"
    );
    let saved =
        std::fs::read_to_string(fixture.root.0.join(".loomwatch/connections.json")).expect("saved");
    assert!(saved.contains(&token));
    let (status, listed) = fixture
        .mcp(
            &token,
            &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
        )
        .await;
    assert_eq!(status, 200, "{listed}");

    let removed = reqwest::Client::new()
        .delete(format!("{}/api/ask/connections/claude", fixture.base))
        .send()
        .await
        .expect("disconnect");
    let removed: Value = removed.json().await.expect("json");
    assert_eq!(removed["removedFromApp"], true);
    assert!(
        std::fs::read_to_string(&record)
            .expect("calls")
            .contains("remove")
    );
    let (status, _) = fixture
        .mcp(
            &token,
            &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
        )
        .await;
    assert_eq!(status, 401, "a disconnected app can no longer call in");
}

#[tokio::test]
async fn a_refused_connection_is_not_saved_and_never_echoes_the_token() {
    let bin = TempDirectory::new("bin");
    let record = bin.0.join("calls.txt");
    fake_app(&bin.0, "claude", &record, true);
    let fixture = Fixture::start(None, Some(bin.0.clone().into_os_string())).await;
    let (status, refused) = fixture
        .post("/api/ask/connections/claude", &json!({}))
        .await;
    assert_eq!(status, 502);
    let message = refused["error"].as_str().expect("error");
    assert!(
        message.starts_with("Claude Code didn't accept the connection"),
        "{message}"
    );
    assert!(
        !message.contains("Bearer lw_") || message.contains("lw_••••••••"),
        "{message}"
    );
    assert!(!fixture.root.0.join(".loomwatch/connections.json").exists());
}

#[tokio::test]
async fn snippet_apps_get_their_snippet_once_connected() {
    let fixture = Fixture::start(None, Some(std::ffi::OsString::new())).await;
    let (status, connected) = fixture
        .post("/api/ask/connections/opencode", &json!({}))
        .await;
    assert_eq!(status, 200, "{connected}");
    let header = connected["snippet"]["loomwatch"]["headers"]["Authorization"]
        .as_str()
        .expect("header");
    assert!(header.starts_with("Bearer lw_"));
    assert_eq!(
        connected["snippetPlace"],
        "the \"mcp\" section of ~/.config/opencode/opencode.json"
    );
}

/// A proposal has to be one the editor can save: the editor checks the team schema before every
/// save, so a file `TeamConfig::parse` accepts but the schema refuses would land on the canvas and
/// then refuse to apply. And a connected app is told where the person will find it.
#[tokio::test]
async fn a_proposal_must_pass_the_editors_schema_and_a_connected_app_learns_where_it_waits() {
    let fixture = Fixture::start(None, Some(std::ffi::OsString::new())).await;
    let (_, connected) = fixture
        .post("/api/ask/connections/opencode", &json!({}))
        .await;
    let token = connected["snippet"]["loomwatch"]["headers"]["Authorization"]
        .as_str()
        .and_then(|header| header.strip_prefix("Bearer "))
        .expect("token")
        .to_owned();
    let team = |spawn: &str| {
        format!(
            "schemaVersion: 1\nid: brief\nname: Brief\nentrypoint: a\nagents:\n  - id: a\n    \
             name: Collector\n    role: Collect\n    model: m\n    spawn: {spawn}\nedges: []\n"
        )
    };
    let propose = |yaml: String| {
        json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "propose_team",
            "arguments": {"file": "brief.yaml", "yaml": yaml, "summary": "A brief."}
        }})
    };

    let (_, refused) = fixture
        .mcp(
            &token,
            &propose(team(r#"{"cmd": "python3", "args": [], "cwd": "."}"#)),
        )
        .await;
    assert_eq!(refused["result"]["isError"], true, "{refused}");
    let message = refused["result"]["content"][0]["text"]
        .as_str()
        .expect("text");
    assert!(
        message.starts_with("The team file has a problem:") && message.contains("env"),
        "{message}"
    );
    let (_, inbox) = fixture.get("/api/ask/inbox").await;
    assert_eq!(inbox["items"], json!([]), "a refused proposal is not shown");

    let (_, accepted) = fixture
        .mcp(
            &token,
            &propose(team(
                r#"{"cmd": "python3", "args": [], "env": {}, "cwd": "."}"#,
            )),
        )
        .await;
    let result = &accepted["result"]["structuredContent"];
    assert_eq!(result["status"], "waiting_for_the_person", "{accepted}");
    assert!(
        result["message"]
            .as_str()
            .is_some_and(|text| text.contains("From your connected apps")),
        "{result}"
    );
    let (_, inbox) = fixture.get("/api/ask/inbox").await;
    assert_eq!(inbox["items"][0]["phase"], "ask_proposal");
    assert_eq!(inbox["items"][0]["appName"], "OpenCode");
    assert_eq!(inbox["items"][0]["proposalId"], result["proposalId"]);
}

#[tokio::test]
async fn the_stdio_bridge_forwards_requests_and_explains_a_revoked_token() {
    let bin = TempDirectory::new("bin");
    let record = bin.0.join("calls.txt");
    fake_app(&bin.0, "codex", &record, false);
    let fixture = Fixture::start(None, Some(bin.0.clone().into_os_string())).await;
    let (status, _) = fixture.post("/api/ask/connections/codex", &json!({})).await;
    assert_eq!(status, 200);
    let calls = std::fs::read_to_string(&record).expect("calls");
    let token = calls
        .lines()
        .find_map(|line| line.strip_prefix("LOOMWATCH_CONTROL_TOKEN="))
        .expect("the token travels as an environment variable")
        .to_owned();
    assert!(
        calls.lines().any(|line| line == "mcp"),
        "codex starts `loomwatchd mcp`: {calls}"
    );

    let url = format!("{}/api/control/mcp", fixture.base);
    let input = concat!(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
        "\n",
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        "\n",
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        "\n",
    );
    let mut output = Vec::new();
    super::connect::bridge_io(&url, &token, input.as_bytes(), &mut output)
        .await
        .expect("bridge");
    let replies = String::from_utf8(output).expect("utf-8");
    let replies = replies
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("json"))
        .collect::<Vec<_>>();
    assert_eq!(replies.len(), 2, "a notification gets no reply");
    assert_eq!(replies[0]["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(
        replies[1]["result"]["tools"]
            .as_array()
            .expect("tools")
            .len(),
        7
    );

    let mut output = Vec::new();
    super::connect::bridge_io(
        &url,
        "lw_revoked",
        r#"{"jsonrpc":"2.0","id":9,"method":"tools/list"}"#.as_bytes(),
        &mut output,
    )
    .await
    .expect("bridge");
    let reply: Value = serde_json::from_slice(&output).expect("json");
    assert!(
        reply["error"]["message"]
            .as_str()
            .expect("message")
            .contains("Connect this app again")
    );
}
