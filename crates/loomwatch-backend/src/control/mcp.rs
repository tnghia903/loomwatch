//! The `LoomWatch` Control tools, served over MCP's HTTP transport (ADR 0033).
//!
//! Same wire shape as the Team Bus: one `POST`, a JSON-RPC body, a JSON body back, a bearer token
//! naming the caller. The tools read and propose; none writes a team file or answers a review stop.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State;
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Value, json};

use super::{Caller, Control, Proposal, RunRequest, lock, now};
use crate::config::{AgentKind, TeamConfig};

const PROTOCOL_VERSION: &str = "2025-03-26";
const MODEL_CACHE: Duration = Duration::from_mins(10);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(25);
const MAX_REQUEST_CHARS: usize = 4_000;
const MAX_REPLY_CHARS: usize = 4_000;

/// What the app is told once, at the top of its first turn.
pub(super) const INSTRUCTIONS: &str = r#"You are Ask LoomWatch, the assistant built into LoomWatch. LoomWatch runs teams of AI agents on this person's computer: each agent is one of their AI apps (Claude Code, Codex, Gemini CLI, OpenCode), and the agents work through a pipeline, handing work from one to the next. A "You" step is a review stop where the team waits for the person.

You help by reading their teams and runs and by proposing changes, using the `loomwatch` tools. Rules:
- You cannot save files or start runs yourself. `propose_team` shows the person a proposal on the canvas; nothing is saved until they press Apply. `start_run` asks them to start the run, unless they have allowed you to start runs directly; its result tells you which. Never say something was saved, applied or started unless a tool result says so.
- Review stops belong to the person. You may explain what a team is waiting for and use `draft_review_note` to suggest a note; only they approve or send work back.
- Use only the AI apps `list_apps` reports as available, with the `spawn` block and a model it lists. Never invent a model id.
- Reply in plain words, in one to three short sentences. Don't paste team files into the chat: the proposal card shows the changes. Don't use tables.
- Don't use any tool besides the `loomwatch` ones. Don't read, write or run anything on the computer.

A team file is YAML. A complete pipeline with a review stop:

schemaVersion: 1
id: morning-brief            # lowercase letters, digits and dashes; usually the file name without .yaml
name: Morning brief
entrypoint: researcher       # the first stage
agents:
  - id: researcher
    name: Researcher
    role: Find today's AI news from primary sources, with a link for every story.
    spawn: {"cmd": "claude-agent-acp", "args": [], "env": {}, "cwd": "."}   # copy the spawn block from list_apps
    model: claude-sonnet-5-5                          # a model list_apps lists for that app
  - id: review
    kind: operator           # a review stop: no spawn, no model
    name: You
    role: Researcher is done. Approve the findings, or say what to change.
  - id: writer
    name: Writer
    role: Write a five-bullet brief from the approved findings.
    spawn: {"cmd": "codex-acp", "args": [], "env": {}, "cwd": "."}
    model: gpt-5.5
edges:                       # the order work is handed along
  - {from: researcher, to: review, layer: configured, kind: sequence, ts: "2026-10-02T00:00:00Z"}
  - {from: review, to: writer, layer: configured, kind: sequence, ts: "2026-10-02T00:00:00Z"}

To run it on a schedule, add a top-level block:
schedule: {cron: "0 8 * * 1-5", timezone: "Asia/Singapore", prompt: "Prepare today's brief."}
and, to send each scheduled answer to Notion, `deliver: {notion: {title: "Brief {{date}}"}}` inside `schedule`.
To send every answer to Notion, whoever starts the run, add a top-level `deliver: {notion: {}}` (title placeholders: {{team}}, {{date}}, {{time}}, {{weekday}}). Pages go under the destination the person chose in Connections.

When you change an existing team, call `read_team` first and propose the whole edited file, keeping everything you were not asked to change. A review stop can't be the first stage. If `propose_team` reports a problem, fix the file and propose it again before you answer."#;

/// What `list_apps` reports for one app's models.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AppModels {
    default_model: Option<String>,
    models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    problem: Option<String>,
}

pub(super) async fn post(
    State(control): State<Control>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    let Some(token) = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return (StatusCode::UNAUTHORIZED, "missing bearer token").into_response();
    };
    let Some(caller) = control.caller(token).await else {
        return (
            StatusCode::UNAUTHORIZED,
            "this LoomWatch connection has ended or was removed",
        )
            .into_response();
    };
    let Some(Json(request)) = body else {
        return (StatusCode::BAD_REQUEST, "send a JSON-RPC request").into_response();
    };
    let Some(id) = request.get("id").cloned() else {
        return StatusCode::ACCEPTED.into_response();
    };
    let response = match request.get("method").and_then(Value::as_str) {
        Some("initialize") => rpc_result(
            &id,
            &json!({
                "protocolVersion": request
                    .pointer("/params/protocolVersion")
                    .and_then(Value::as_str)
                    .filter(|version| SUPPORTED_VERSIONS.contains(version))
                    .unwrap_or(PROTOCOL_VERSION),
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": super::SERVER_NAME, "title": "LoomWatch", "version": env!("CARGO_PKG_VERSION")},
                "instructions": "Read and propose changes to the person's LoomWatch teams and runs. Nothing is saved or run without them."
            }),
        ),
        Some("ping") => rpc_result(&id, &json!({})),
        Some("tools/list") => rpc_result(&id, &json!({"tools": definitions()})),
        Some("tools/call") => {
            let name = request
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let arguments = request
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let result = match call(&control, &caller, name, &arguments).await {
                Ok(value) => tool_success(&value),
                Err(message) => tool_error(&message),
            };
            rpc_result(&id, &result)
        }
        Some(method) => rpc_error(&id, -32601, &format!("unsupported method {method}")),
        None => rpc_error(&id, -32600, "request omitted method"),
    };
    (
        StatusCode::OK,
        [(CONTENT_TYPE, "application/json")],
        Json(response),
    )
        .into_response()
}

const SUPPORTED_VERSIONS: [&str; 3] = ["2025-03-26", "2025-06-18", "2025-11-25"];

fn rpc_result(id: &Value, result: &Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn tool_success(value: &Value) -> Value {
    json!({
        "content": [{"type": "text", "text": serde_json::to_string(value).unwrap_or_default()}],
        "structuredContent": value,
        "isError": false
    })
}

fn tool_error(message: &str) -> Value {
    json!({"content": [{"type": "text", "text": message}], "isError": true})
}

fn definitions() -> Vec<Value> {
    let string = |description: &str| json!({"type": "string", "description": description});
    let object = |properties: Value, required: &[&str]| json!({"type": "object", "properties": properties, "required": required, "additionalProperties": false});
    let read_only = json!({"readOnlyHint": true, "openWorldHint": false});
    vec![
        json!({
            "name": "list_teams",
            "title": "List teams",
            "description": "The person's teams: file, name and number of steps.",
            "inputSchema": object(json!({}), &[]),
            "annotations": read_only,
        }),
        json!({
            "name": "read_team",
            "title": "Read a team",
            "description": "One team file's YAML and revision. Read before proposing a change to it.",
            "inputSchema": object(json!({"file": string("The team file, relative to the teams folder, e.g. morning-brief.yaml.")}), &["file"]),
            "annotations": read_only,
        }),
        json!({
            "name": "list_apps",
            "title": "List AI apps",
            "description": "The AI apps found on this computer: whether each can run agents, the spawn block to copy into an agent, its default model and the models it offers.",
            "inputSchema": object(json!({}), &[]),
            "annotations": read_only,
        }),
        json!({
            "name": "propose_team",
            "title": "Propose a team",
            "description": "Show the person a complete team file as a proposal on the canvas. It is checked first; nothing is saved until they press Apply.",
            "inputSchema": object(json!({
                "file": string("Where the team lives, relative to the teams folder, ending in .yaml. An existing file to change it, a new name to create a team."),
                "yaml": string("The complete team file."),
                "summary": string("One plain sentence saying what the proposal does, shown on the card."),
            }), &["file", "yaml", "summary"]),
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false},
        }),
        json!({
            "name": "start_run",
            "title": "Start a run",
            "description": "Ask to run a team with a request. Usually the person confirms in LoomWatch first; the result says whether it started.",
            "inputSchema": object(json!({
                "file": string("The team file to run."),
                "request": string("What the team should do, in the person's words."),
            }), &["file", "request"]),
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true},
        }),
        json!({
            "name": "get_run",
            "title": "Read a run",
            "description": "A run's status, what it is waiting for, and its answer. Without runId, the run started from this conversation most recently.",
            "inputSchema": object(json!({"runId": string("The run id. Optional.")}), &[]),
            "annotations": read_only,
        }),
        json!({
            "name": "draft_review_note",
            "title": "Draft a review note",
            "description": "Suggest a note for a run waiting at a review stop. The person decides whether to use it and whether to approve; you can't answer the stop.",
            "inputSchema": object(json!({
                "runId": string("The waiting run. Optional: defaults to this conversation's latest run."),
                "text": string("The suggested note, written as the person would write it."),
            }), &["text"]),
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": false},
        }),
    ]
}

async fn call(
    control: &Control,
    caller: &Caller,
    name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    match name {
        "list_teams" => list_teams(control).await,
        "read_team" => read_team(control, arguments),
        "list_apps" => list_apps(control).await,
        "propose_team" => propose_team(control, caller, arguments).await,
        "start_run" => start_run(control, caller, arguments).await,
        "get_run" => get_run(control, caller, arguments).await,
        "draft_review_note" => draft_review_note(control, caller, arguments).await,
        other => Err(format!("LoomWatch has no tool called {other}.")),
    }
}

fn text(arguments: &Value, name: &str) -> Result<String, String> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Give `{name}` as a non-empty string."))
}

async fn list_teams(control: &Control) -> Result<Value, String> {
    let root = control.inner.teams_root.clone();
    let teams = tokio::task::spawn_blocking(move || {
        crate::api::discover_team_files(&root).map(|files| {
            files
                .iter()
                .map(|file| crate::api::summarize_team_file(&root, file))
                .collect::<Vec<_>>()
        })
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| format!("couldn't read the teams folder: {error}"))?;
    Ok(json!({
        "teams": teams.iter().map(|team| json!({
            "file": team.path,
            "name": team.name,
            "steps": team.agent_count,
            "problem": team.problem,
        })).collect::<Vec<_>>()
    }))
}

fn read_team(control: &Control, arguments: &Value) -> Result<Value, String> {
    let file = text(arguments, "file")?;
    let path = crate::api::resolve_existing_team_path(&control.inner.teams_root, Path::new(&file))
        .map_err(|error| error.message)?;
    let yaml =
        std::fs::read_to_string(&path).map_err(|error| format!("couldn't read {file}: {error}"))?;
    Ok(json!({"file": file, "yaml": yaml, "revision": crate::api::revision(yaml.as_bytes())}))
}

async fn list_apps(control: &Control) -> Result<Value, String> {
    let apps = crate::api::detect_harnesses(control.inner.search_path.as_deref());
    let mut discovered = BTreeMap::new();
    let pending = apps
        .iter()
        .filter(|app| app.acp_available)
        .map(|app| {
            let control = control.clone();
            let app = app.clone();
            async move { (app.id.clone(), models_for(&control, &app).await) }
        })
        .collect::<Vec<_>>();
    for (id, models) in futures_join(pending).await {
        discovered.insert(id, models);
    }
    Ok(json!({
        "apps": apps.iter().map(|app| {
            let models = discovered.get(&app.id).cloned().unwrap_or_default();
            json!({
                "id": app.id,
                "name": app.name,
                "available": app.acp_available && models.problem.is_none(),
                "reason": app.unavailable_reason.clone().or(models.problem.clone()),
                // A complete spawn block: `cwd` "." is the team file's own folder.
                "spawn": {"cmd": app.spawn.cmd, "args": app.spawn.args, "env": {}, "cwd": "."},
                "defaultModel": models.default_model,
                "models": models.models,
            })
        }).collect::<Vec<_>>()
    }))
}

/// Run futures concurrently without pulling in a futures crate: each becomes a task.
async fn futures_join<F, T>(futures: Vec<F>) -> Vec<T>
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let handles = futures.into_iter().map(tokio::spawn).collect::<Vec<_>>();
    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        if let Ok(result) = handle.await {
            results.push(result);
        }
    }
    results
}

/// Find every app's models ahead of the first `list_apps`, so proposing a team does not wait on
/// starting each app.
pub(super) async fn warm_models(control: &Control) {
    let _ = list_apps(control).await;
}

async fn cached_models(control: &Control, app: &str) -> Option<AppModels> {
    control
        .inner
        .models
        .lock()
        .await
        .get(app)
        .filter(|(at, _)| at.elapsed() < MODEL_CACHE)
        .map(|(_, models)| models.clone())
}

async fn models_for(control: &Control, app: &crate::api::DetectedHarness) -> AppModels {
    if let Some(models) = cached_models(control, &app.id).await {
        return models;
    }
    let discovering = Arc::clone(
        super::lock(&control.inner.discovering)
            .entry(app.id.clone())
            .or_default(),
    );
    let _discovering = discovering.lock().await;
    // Whoever held the lock may have just found them.
    if let Some(models) = cached_models(control, &app.id).await {
        return models;
    }
    let command = control
        .inner
        .search_path
        .as_deref()
        .and_then(|path| crate::api::find_executable(path, &app.spawn.cmd))
        .map_or_else(
            || app.spawn.cmd.clone(),
            |path| path.to_string_lossy().into_owned(),
        );
    let spec = crate::acp::ProcessSpec {
        cmd: command,
        args: app.spawn.args.clone(),
        env: BTreeMap::new(),
        cwd: control.inner.teams_root.clone(),
        tools: Vec::new(),
        permissions: None,
        asker: None,
    };
    let models =
        match tokio::time::timeout(DISCOVERY_TIMEOUT, crate::acp::discover_models(&spec)).await {
            Ok(Ok(catalog)) => {
                let ids = catalog
                    .models
                    .iter()
                    .map(|model| model.id.clone())
                    .take(12)
                    .collect::<Vec<_>>();
                AppModels {
                    default_model: catalog
                        .current_model_id
                        .clone()
                        .or_else(|| ids.first().cloned()),
                    models: ids,
                    problem: None,
                }
            }
            Ok(Err(error)) => AppModels {
                problem: Some(format!(
                    "{} didn't start: {}",
                    app.name,
                    super::first_line(&format!("{error:#}"))
                )),
                ..AppModels::default()
            },
            Err(_) => AppModels {
                problem: Some(format!("{} took too long to start.", app.name)),
                ..AppModels::default()
            },
        };
    control
        .inner
        .models
        .lock()
        .await
        .insert(app.id.clone(), (Instant::now(), models.clone()));
    models
}

/// The relative path a proposal may use: a `.yaml` or `.yml` file below the teams root, never in
/// a hidden folder, and in a folder that already exists.
fn proposal_path(control: &Control, file: &str) -> Result<std::path::PathBuf, String> {
    let relative = Path::new(file);
    let well_formed = relative.is_relative()
        && relative
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(name) if !name.to_string_lossy().starts_with('.')))
        && relative
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("yaml") || extension.eq_ignore_ascii_case("yml"));
    if !well_formed {
        return Err(format!(
            "`{file}` isn't a place for a team. Use a name like morning-brief.yaml, relative to the \
             teams folder."
        ));
    }
    crate::api::resolve_writable_team_path(&control.inner.teams_root, relative)
        .map_err(|error| error.message)
}

/// What the team schema says is wrong with a team file — the check the editor makes before it
/// saves, so a proposal that passes here is one the person can apply. At most five, with where.
fn schema_problems(yaml: &str) -> Vec<String> {
    static VALIDATOR: OnceLock<Option<jsonschema::Validator>> = OnceLock::new();
    let validator = VALIDATOR.get_or_init(|| {
        let schema: Value = serde_yaml::from_str(crate::api::TEAM_SCHEMA).ok()?;
        jsonschema::draft202012::new(&schema).ok()
    });
    let (Some(validator), Ok(document)) = (validator, serde_yaml::from_str::<Value>(yaml)) else {
        return Vec::new();
    };
    validator
        .iter_errors(&document)
        .take(5)
        .map(|error| {
            let at = error.instance_path().to_string();
            if at.is_empty() {
                error.to_string()
            } else {
                format!("{error} (at {at})")
            }
        })
        .collect()
}

async fn propose_team(
    control: &Control,
    caller: &Caller,
    arguments: &Value,
) -> Result<Value, String> {
    let file = text(arguments, "file")?;
    let yaml = arguments
        .get("yaml")
        .and_then(Value::as_str)
        .filter(|yaml| !yaml.trim().is_empty())
        .ok_or("Give the complete team file as `yaml`.")?
        .to_owned();
    let summary = text(arguments, "summary").unwrap_or_else(|_| "A proposed team.".to_owned());
    let path = proposal_path(control, &file)?;
    let team = TeamConfig::parse(&yaml).map_err(|error| {
        format!("The team file has a problem: {error:#}. Fix it and propose again.")
    })?;
    let problems = schema_problems(&yaml);
    if !problems.is_empty() {
        return Err(format!(
            "The team file has a problem: {}. Fix it and propose again.",
            problems.join("; ")
        ));
    }
    let existing = std::fs::read(&path).ok();
    let id = format!("proposal-{}", uuid::Uuid::new_v4());
    let source = match caller {
        Caller::Conversation(id) => id.clone(),
        Caller::Connection(app) => format!("connection:{app}"),
    };
    let proposal = Proposal {
        id: id.clone(),
        source,
        file: file.clone(),
        name: if team.name.is_empty() {
            file.clone()
        } else {
            team.name.clone()
        },
        is_new: existing.is_none(),
        yaml: yaml.clone(),
        base_revision: existing.as_deref().map(crate::api::revision),
        summary: summary.clone(),
        created_at: now(),
    };
    control
        .record(
            caller,
            "ask_proposal",
            json!({
                "proposalId": id,
                "file": file,
                "name": proposal.name,
                "isNew": proposal.is_new,
                "summary": summary,
                "baseRevision": proposal.base_revision,
                "yaml": yaml,
            }),
        )
        .await;
    control
        .inner
        .proposals
        .write()
        .await
        .insert(id.clone(), proposal.clone());
    // Said to the app, which says it to the person: where to look, and that nothing changed yet.
    let message = match caller {
        Caller::Conversation(_) => {
            "Shown to the person as a proposal on the canvas. Nothing is saved until they press \
             Apply."
        }
        Caller::Connection(_) => {
            "Waiting for the person in LoomWatch: it is listed in the Ask panel there, under \
             \"From your connected apps\". Nothing is saved until they press Apply."
        }
    };
    Ok(json!({
        "proposalId": id,
        "file": file,
        "isNew": proposal.is_new,
        "status": "waiting_for_the_person",
        "message": message,
    }))
}

/// The names of the apps a team's agents use, for the "Start this run?" card.
fn apps_used(team: &TeamConfig) -> Vec<String> {
    let mut names = Vec::new();
    for agent in &team.agents {
        if agent.kind == AgentKind::Operator {
            continue;
        }
        let name = match crate::workspace::Harness::of(agent).id() {
            Some("claude") => "Claude",
            Some("codex") => "Codex",
            Some("gemini") => "Gemini",
            Some("opencode") => "OpenCode",
            Some("hermes") => "Hermes",
            Some("openclaw") => "OpenClaw",
            _ => "a custom command",
        }
        .to_owned();
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

async fn start_run(control: &Control, caller: &Caller, arguments: &Value) -> Result<Value, String> {
    let file = text(arguments, "file")?;
    let request = text(arguments, "request")?;
    if request.chars().count() > MAX_REQUEST_CHARS {
        return Err(format!(
            "Keep the request under {MAX_REQUEST_CHARS} characters."
        ));
    }
    let path = crate::api::resolve_existing_team_path(&control.inner.teams_root, Path::new(&file))
        .map_err(|error| {
            if error.status == StatusCode::NOT_FOUND {
                format!(
                    "There is no team file {file} yet. If you just proposed it, the person has to \
                     press Apply before it can run."
                )
            } else {
                error.message
            }
        })?;
    let yaml = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let team = TeamConfig::parse(&yaml).map_err(|error| format!("{file} can't run: {error:#}"))?;
    let ask_first = match caller {
        Caller::Conversation(id) => control
            .conversation(id)
            .await
            .is_none_or(|conversation| lock(&conversation.status).ask_before_run),
        // A connected app asked the person itself before calling a tool that acts.
        Caller::Connection(_) => false,
    };
    if ask_first {
        let request_id = format!("run-request-{}", uuid::Uuid::new_v4());
        if let Caller::Conversation(id) = caller
            && let Some(conversation) = control.conversation(id).await
        {
            lock(&conversation.status).run_requests.insert(
                request_id.clone(),
                RunRequest {
                    file: file.clone(),
                    request: request.clone(),
                },
            );
        }
        control
            .record(
                caller,
                "ask_run_request",
                json!({
                    "requestId": request_id,
                    "file": file,
                    "name": if team.name.is_empty() { file.clone() } else { team.name.clone() },
                    "request": request,
                    "apps": apps_used(&team),
                    "steps": team.agents.len(),
                }),
            )
            .await;
        return Ok(json!({
            "status": "waiting_for_the_person",
            "requestId": request_id,
            "message": "The person was asked to start this run. It starts only when they press Start run.",
        }));
    }
    let record = crate::runs::launch(
        &control.inner.registry,
        control.inner.archive.clone(),
        &control.inner.teams_root,
        Path::new(&file),
        &request,
        crate::runs::RunTrigger::Manual,
    )
    .map_err(|error| error.message)?;
    control.inner.registry.persist_quietly(&record.run_id).await;
    if let Caller::Conversation(id) = caller
        && let Some(conversation) = control.conversation(id).await
    {
        lock(&conversation.status).last_run = Some(record.run_id.clone());
    }
    control
        .record(
            caller,
            "ask_run_started",
            json!({"runId": record.run_id, "file": record.team_path, "request": request}),
        )
        .await;
    Ok(json!({
        "status": "started",
        "runId": record.run_id,
        "url": control.run_url(&record.team_path, &record.run_id),
    }))
}

async fn resolve_run(
    control: &Control,
    caller: &Caller,
    arguments: &Value,
) -> Result<crate::runs::RunRecord, String> {
    let requested = arguments
        .get("runId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let run_id = if let Some(id) = requested {
        id
    } else {
        let latest = match caller {
            Caller::Conversation(id) => control
                .conversation(id)
                .await
                .and_then(|conversation| lock(&conversation.status).last_run.clone()),
            Caller::Connection(_) => None,
        };
        latest.ok_or("No run was started from here yet. Give a runId.")?
    };
    control
        .inner
        .registry
        .get(&run_id)
        .ok_or_else(|| format!("LoomWatch has no run {run_id}."))
}

async fn get_run(control: &Control, caller: &Caller, arguments: &Value) -> Result<Value, String> {
    let record = resolve_run(control, caller, arguments).await?;
    let reply = record.reply.as_deref().map(|reply| {
        let mut text = reply.chars().take(MAX_REPLY_CHARS).collect::<String>();
        if reply.chars().count() > MAX_REPLY_CHARS {
            text.push_str(" …(cut short; the full answer is in LoomWatch)");
        }
        text
    });
    Ok(json!({
        "runId": record.run_id,
        "file": record.team_path,
        "status": record.status,
        "request": record.prompt,
        "waitingOn": record.waiting_on.as_ref().map(|waiting| json!({
            "node": waiting.get("node"),
            "name": waiting.get("name"),
            "question": waiting.get("question"),
            "sendBackAvailable": waiting.get("sendBackAvailable"),
        })),
        "reply": reply,
        "error": record.error,
        "url": control.run_url(&record.team_path, &record.run_id),
    }))
}

async fn draft_review_note(
    control: &Control,
    caller: &Caller,
    arguments: &Value,
) -> Result<Value, String> {
    let note = text(arguments, "text")?;
    let record = resolve_run(control, caller, arguments).await?;
    let Some(waiting) = record.waiting_on.clone() else {
        return Err(format!(
            "Run {} isn't waiting for the person, so there is nothing to answer.",
            record.run_id
        ));
    };
    control
        .record(
            caller,
            "ask_review_note",
            json!({
                "runId": record.run_id,
                "file": record.team_path,
                "node": waiting.get("node"),
                "name": waiting.get("name"),
                "question": waiting.get("question"),
                "text": note,
            }),
        )
        .await;
    Ok(json!({
        "status": "shown_to_the_person",
        "message": "The person sees your note in LoomWatch's Ask panel, with a button that puts it in \
                    the review box. Only they can send it, approve, or send the work back.",
    }))
}
