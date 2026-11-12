//! One of My agents, from the phone: its bench (everything it is set up with, and what it learned)
//! and the few things the phone may change on it.
//!
//! The phone changes only its name, its instructions, its model and how hard it thinks, what it may
//! do without asking, and its figure ([`AgentChange`]). It may also always allow one call of a tool
//! the agent is given, as a permission card's "Always allow this" does (ADR 0069, ADR 0102). What it
//! reads, its skills and its tools stay on the Mac, where files are picked and tools are connected.
//! A change is saved against the version the phone last read, so one saved on the Mac in between is
//! never overwritten.

use axum::http::{Method, StatusCode};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::daemon::Daemon;
use super::studio::job_figure;

/// What the phone may change on one of My agents. Absent fields stay as they are.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentChange {
    pub name: Option<String>,
    pub instructions: Option<String>,
    pub model: Option<String>,
    /// `""` takes the model's own default.
    pub thinking_effort: Option<String>,
    pub allow: Option<Allow>,
    pub figure: Option<Figure>,
    /// What changed, in the person's words, kept with the version.
    pub note: Option<String>,
    /// One call of a tool it is given that it may make without asking from now on, added to its
    /// `toolAllow`: a permission's "Always allow this" on the phone. Nothing is taken away.
    pub always_allow: Option<ToolCall>,
    /// The version the phone read; a newer one saved on the Mac answers 412.
    pub version: u32,
}

/// A connected tool's call, by the tool's name as the agent is given it and the call's name, as a
/// permission request names them (`tool.server`, `tool.call`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    pub tool: String,
    pub call: String,
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct Allow {
    pub web: bool,
    pub edits: bool,
    pub commands: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Figure {
    pub kind: String,
    pub color: String,
}

/// A saved agent's version, as the daemon counts them: a listing leaves out version 1.
fn version_of(job: &Value) -> u32 {
    job.get("version")
        .and_then(Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
        .unwrap_or(1)
}

/// The saved agent `id` as `GET /api/jobs` lists it.
async fn saved(daemon: &Daemon, id: &str) -> anyhow::Result<Option<Value>> {
    let jobs = daemon.get_json("/api/jobs").await?;
    Ok(jobs
        .get("jobs")
        .and_then(Value::as_array)
        .and_then(|jobs| {
            jobs.iter()
                .find(|job| job.get("id").and_then(Value::as_str) == Some(id))
        })
        .cloned())
}

/// `GET /phone/v0/agents`: My agents in the Mac's order, each with its name and the figure it
/// wears, the one its id picks when none was chosen, as the Mac draws it, its job's sign on its
/// head.
///
/// # Errors
/// When `LoomWatch` can't be reached.
pub async fn agents_list(daemon: &Daemon) -> anyhow::Result<Value> {
    Ok(listed(&daemon.get_json("/api/jobs").await?))
}

fn listed(jobs: &Value) -> Value {
    let agents: Vec<Value> = jobs
        .get("jobs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|job| {
            let id = job.get("id").and_then(Value::as_str)?;
            Some(json!({
                "id": id,
                "name": job.get("name").and_then(Value::as_str).unwrap_or(id),
                "figure": job_figure(id, job),
            }))
        })
        .collect();
    json!({ "agents": agents })
}

/// `GET /phone/v0/agents/{id}`: the agent as saved, the figure it wears, its version, and what it
/// learned and keeps.
///
/// # Errors
/// When `LoomWatch` can't be reached.
pub async fn agent_view(daemon: &Daemon, id: &str) -> anyhow::Result<Option<Value>> {
    let Some(job) = saved(daemon, id).await? else {
        return Ok(None);
    };
    let lessons = daemon
        .get_json(&format!("/api/lessons?savedAgent={id}"))
        .await
        .ok();
    Ok(Some(json!({
        "version": version_of(&job),
        "figure": job_figure(id, &job),
        "job": job,
        "lessons": lessons.as_ref().and_then(|lessons| lessons.get("lessons")).cloned().unwrap_or(json!([])),
        "learns": lessons.as_ref().and_then(|lessons| lessons.get("learns")).cloned().unwrap_or(json!(true)),
    })))
}

/// The saved agent `job` with `change` made to it, as `PUT /api/jobs/{id}` takes it: the listing's
/// own fields (`id`, `file`) left out, everything the phone doesn't change kept as it is.
#[must_use]
pub fn changed(job: &Value, change: &AgentChange) -> Value {
    let mut spec: Map<String, Value> = job.as_object().cloned().unwrap_or_default();
    for listing_only in ["id", "file"] {
        spec.remove(listing_only);
    }
    set(&mut spec, "name", change.name.as_deref());
    set(&mut spec, "instructions", change.instructions.as_deref());
    if let Some(model) = &change.model {
        set(&mut spec, "model", Some(model));
        // An effort belongs to the model it was chosen for.
        if change.thinking_effort.is_none() {
            spec.remove("thinkingEffort");
        }
    }
    set(
        &mut spec,
        "thinkingEffort",
        change.thinking_effort.as_deref(),
    );
    if let Some(allow) = &change.allow {
        spec.insert("allow".to_owned(), json!(allow));
    }
    if let Some(figure) = &change.figure {
        let wear = spec
            .get("figure")
            .and_then(|figure| figure.get("wear"))
            .cloned();
        let mut worn = json!({"kind": figure.kind, "color": figure.color});
        if let Some(wear) = wear {
            worn["wear"] = wear;
        }
        spec.insert("figure".to_owned(), worn);
    }
    if let Some(always) = &change.always_allow {
        allow_call(&mut spec, always);
    }
    set(&mut spec, "note", change.note.as_deref());
    Value::Object(spec)
}

/// The tool `name` as an agent's `tools` give it, ignoring case, as the daemon finds tools.
fn given_tool<'a>(tools: Option<&'a Value>, name: &str) -> Option<&'a str> {
    let wanted = name.trim();
    tools?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .find(|tool| tool.trim().eq_ignore_ascii_case(wanted))
}

/// Adds `always.call` to the calls of `always.tool` that `spec` always allows, under the name the
/// agent is given the tool by (the name a save keeps them under), once. The rest of `toolAllow`
/// stays as it is.
fn allow_call(spec: &mut Map<String, Value>, always: &ToolCall) {
    let tool = given_tool(spec.get("tools"), &always.tool)
        .unwrap_or_else(|| always.tool.trim())
        .to_owned();
    let call = always.call.trim();
    let allowed = spec
        .entry("toolAllow")
        .or_insert_with(|| json!({}))
        .as_object_mut();
    let Some(allowed) = allowed else { return };
    let calls = allowed.entry(tool).or_insert_with(|| json!([]));
    if let Some(calls) = calls.as_array_mut()
        && !calls.iter().any(|kept| kept.as_str() == Some(call))
    {
        calls.push(json!(call));
    }
}

/// Why `change` can't be saved on `job`, in a sentence, before it reaches the Mac: an always
/// allowed call of a tool the agent isn't given would be dropped by the save without a word.
fn refusal(job: &Value, change: &AgentChange) -> Option<String> {
    let always = change.always_allow.as_ref()?;
    if always.tool.trim().is_empty() || always.call.trim().is_empty() {
        return Some("Say which tool and which of its actions to always allow.".to_owned());
    }
    if given_tool(job.get("tools"), &always.tool).is_none() {
        let name = job
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("This agent");
        return Some(format!(
            "{name} isn't given {} in My agents, so it can't always allow it. Give it the tool on your Mac first.",
            always.tool.trim()
        ));
    }
    None
}

/// Sets `key` to `value`, trimmed; an empty one takes the field off (its default). `None` leaves it.
fn set(spec: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    match value.map(str::trim) {
        Some("") => {
            spec.remove(key);
        }
        Some(text) => {
            spec.insert(key.to_owned(), json!(text));
        }
        None => {}
    }
}

/// `POST /phone/v0/agents/{id}`: saves `change` on the agent, against the version the phone read.
///
/// # Errors
/// When `LoomWatch` can't be reached; a change the daemon refused comes back as its status.
pub async fn save_agent(
    daemon: &Daemon,
    id: &str,
    change: AgentChange,
) -> anyhow::Result<(StatusCode, Value)> {
    let Some(job) = saved(daemon, id).await? else {
        return Ok((
            StatusCode::NOT_FOUND,
            json!({"error": "That agent isn't in My agents any more."}),
        ));
    };
    if version_of(&job) != change.version {
        return Ok((
            StatusCode::PRECONDITION_FAILED,
            json!({"error": "This agent was changed on your Mac since you opened it. Close it and open it again to see that change."}),
        ));
    }
    if let Some(why) = refusal(&job, &change) {
        return Ok((StatusCode::BAD_REQUEST, json!({"error": why})));
    }
    let reply = daemon
        .send_json(
            Method::PUT,
            &format!("/api/jobs/{id}"),
            &[("If-Match", format!("\"{}\"", change.version))],
            &changed(&job, &change),
        )
        .await?;
    let status = StatusCode::from_u16(reply.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    Ok((status, reply.json().await.unwrap_or(Value::Null)))
}

/// `GET /phone/v0/models`: what an agent may think with, as the Mac's picker groups it, each with
/// the few fields the phone shows.
///
/// # Errors
/// When `LoomWatch` can't be reached.
pub async fn models_view(daemon: &Daemon) -> anyhow::Result<Value> {
    let list = daemon.get_json("/api/models").await?;
    let trim = |models: Option<&Value>| -> Vec<Value> {
        models
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|model| {
                json!({
                    "id": model.get("id"),
                    "name": model.get("name"),
                    "inputPrice": model.get("inputPrice"),
                    "outputPrice": model.get("outputPrice"),
                    "reasoning": model.get("reasoning"),
                    "free": model.get("free"),
                })
            })
            .collect()
    };
    Ok(json!({
        "defaultModel": list.get("defaultModel"),
        "chatgpt": trim(list.get("chatgpt")),
        "anthropic": trim(list.get("anthropic")),
        "openrouter": trim(list.get("models")),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job() -> Value {
        json!({
            "id": "maya", "file": ".jobs/maya.yaml", "name": "Maya", "instructions": "Help.",
            "model": "anthropic/claude-sonnet-5.5", "thinkingEffort": "high",
            "reads": [{"name": "Trips", "path": "~/Trips"}], "tools": ["notion"],
            "figure": {"kind": "bobbin", "color": "butter", "wear": ["collar"]},
            "savedAt": "2026-10-28T10:00:00Z", "version": 3,
        })
    }

    #[test]
    fn my_agents_wear_the_figure_the_mac_draws_them_in() {
        let list = listed(&json!({"jobs": [
            job(),
            {"id": "cole", "name": "Cole"},
            {"id": "nameless"},
        ]}));
        let agents = list["agents"].as_array().unwrap();
        assert_eq!(
            agents[0],
            // Saved under an earlier name (the earned bobbin), it wears that figure today, with the
            // sign its job puts on its head: none named, a curl.
            json!({"id": "maya", "name": "Maya", "figure": {"kind": "tall", "color": "sunset", "sign": "curl"}})
        );
        // None chosen: the one its id picks, never one stand-in for all.
        let (kind, color) = super::super::studio::figure_for("cole", None);
        assert_eq!(
            agents[1]["figure"],
            json!({"kind": kind, "color": color, "sign": "curl"})
        );
        assert_ne!(agents[1]["figure"], agents[2]["figure"]);
        assert_eq!(agents[2]["name"], "nameless");
    }

    /// The sign is only for drawing: a figure the phone sends back with one is refused, as the
    /// saved figure (`jobs::JobFigure`) refuses one, so the phone never sends it.
    #[test]
    fn my_agents_wear_their_jobs_sign_and_a_change_never_carries_it() {
        let list = listed(&json!({"jobs": [
            {"id": "w", "name": "Trip writer"},
            {"id": "v", "name": "Ada", "icon": "video"},
        ]}));
        assert_eq!(list["agents"][0]["figure"]["sign"], "write");
        assert_eq!(list["agents"][1]["figure"]["sign"], "video");
        let signed =
            json!({"version": 1, "figure": {"kind": "tall", "color": "sky", "sign": "write"}});
        assert!(serde_json::from_value::<AgentChange>(signed).is_err());
    }

    #[test]
    fn a_change_keeps_what_the_phone_does_not_touch() {
        let change = AgentChange {
            instructions: Some(" Help, briefly. ".into()),
            allow: Some(Allow {
                web: true,
                edits: false,
                commands: false,
            }),
            figure: Some(Figure {
                kind: "tall".into(),
                color: "sky".into(),
            }),
            version: 3,
            ..AgentChange::default()
        };
        let spec = changed(&job(), &change);
        assert_eq!(spec["instructions"], "Help, briefly.");
        assert_eq!(
            spec["allow"],
            json!({"web": true, "edits": false, "commands": false})
        );
        // Its accessories stay on whatever figure it wears.
        assert_eq!(
            spec["figure"],
            json!({"kind": "tall", "color": "sky", "wear": ["collar"]})
        );
        assert_eq!(spec["reads"], job()["reads"]);
        assert_eq!(spec["tools"], json!(["notion"]));
        assert_eq!(spec["thinkingEffort"], "high");
        assert!(spec.get("id").is_none() && spec.get("file").is_none());
    }

    #[test]
    fn a_new_model_drops_the_old_ones_effort_unless_one_is_chosen() {
        let change = AgentChange {
            model: Some("openai/gpt-6.1-sol".into()),
            version: 3,
            ..AgentChange::default()
        };
        assert!(changed(&job(), &change).get("thinkingEffort").is_none());

        let change = AgentChange {
            model: Some("openai/gpt-6.1-sol".into()),
            thinking_effort: Some("low".into()),
            version: 3,
            ..AgentChange::default()
        };
        assert_eq!(changed(&job(), &change)["thinkingEffort"], "low");
    }

    #[test]
    fn the_phone_cannot_change_what_it_reads_or_its_tools() {
        let tried: Result<AgentChange, _> =
            serde_json::from_value(json!({"version": 1, "reads": [{"name": "All", "path": "/"}]}));
        assert!(tried.is_err());
        let tried: Result<AgentChange, _> =
            serde_json::from_value(json!({"version": 1, "tools": ["gmail"]}));
        assert!(tried.is_err());
        let tried: Result<AgentChange, _> = serde_json::from_value(
            json!({"version": 1, "toolAllow": {"notion": ["create-pages"]}}),
        );
        assert!(
            tried.is_err(),
            "its whole always-allowed list stays on the Mac"
        );
    }

    fn always(tool: &str, call: &str) -> AgentChange {
        serde_json::from_value(json!({"version": 3, "alwaysAllow": {"tool": tool, "call": call}}))
            .unwrap()
    }

    /// A permission's "Always allow this" on the phone: one call of a tool it is given, added to
    /// what it always may do, under the tool's name as it is given it, once; nothing taken away.
    #[test]
    fn the_phone_always_allows_one_call_of_a_tool_the_agent_is_given() {
        let mut given = job();
        given["tools"] = json!(["notion", "Apple Health"]);
        given["toolAllow"] = json!({"notion": ["search"]});

        let spec = changed(&given, &always("apple health", " daily "));
        assert_eq!(
            spec["toolAllow"],
            json!({"notion": ["search"], "Apple Health": ["daily"]})
        );
        assert_eq!(spec["tools"], given["tools"], "its tools stay as they are");

        let again = changed(&spec, &always("Apple Health", "daily"));
        assert_eq!(again["toolAllow"]["Apple Health"], json!(["daily"]), "once");
        let more = changed(&spec, &always("NOTION", "create-pages"));
        assert_eq!(
            more["toolAllow"]["notion"],
            json!(["search", "create-pages"])
        );

        // None kept yet.
        assert_eq!(
            changed(&job(), &always("notion", "search"))["toolAllow"],
            json!({"notion": ["search"]})
        );
        assert!(refusal(&given, &always("apple health", "daily")).is_none());
    }

    /// A save would drop a call of a tool the agent isn't given without a word, so the phone is
    /// told before it goes.
    #[test]
    fn a_tool_the_agent_isnt_given_is_refused_with_a_reason() {
        let why = refusal(&job(), &always("Apple Health", "daily")).unwrap();
        assert_eq!(
            why,
            "Maya isn't given Apple Health in My agents, so it can't always allow it. Give it the tool on your Mac first."
        );
        assert!(refusal(&job(), &always("notion", " ")).is_some());
        assert!(
            refusal(
                &job(),
                &AgentChange {
                    version: 3,
                    ..AgentChange::default()
                }
            )
            .is_none()
        );
    }
}
