//! One of My agents, from the phone: its bench (everything it is set up with, and what it learned)
//! and the few things the phone may change on it.
//!
//! The phone changes only its name, its instructions, its model and how hard it thinks, what it may
//! do without asking, and its figure ([`AgentChange`]). What it reads, its skills and its tools stay
//! on the Mac, where files are picked and tools are connected. A change is saved against the
//! version the phone last read, so one saved on the Mac in between is never overwritten.

use axum::http::{Method, StatusCode};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::daemon::Daemon;
use super::studio::figure_for;

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
    /// The version the phone read; a newer one saved on the Mac answers 412.
    pub version: u32,
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
/// wears, the one its id picks when none was chosen, as the Mac draws it.
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
            let (kind, color) = figure_for(id, job.get("figure"));
            Some(json!({
                "id": id,
                "name": job.get("name").and_then(Value::as_str).unwrap_or(id),
                "figure": {"kind": kind, "color": color},
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
    let (kind, color) = figure_for(id, job.get("figure"));
    Ok(Some(json!({
        "version": version_of(&job),
        "figure": {"kind": kind, "color": color},
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
    set(&mut spec, "note", change.note.as_deref());
    Value::Object(spec)
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
            "figure": {"kind": "bobbin", "color": "butter", "wear": ["scarf"]},
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
            json!({"id": "maya", "name": "Maya", "figure": {"kind": "bobbin", "color": "butter"}})
        );
        // None chosen: the one its id picks, never one stand-in for all.
        let (kind, color) = figure_for("cole", None);
        assert_eq!(agents[1]["figure"], json!({"kind": kind, "color": color}));
        assert_ne!(agents[1]["figure"], agents[2]["figure"]);
        assert_eq!(agents[2]["name"], "nameless");
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
                kind: "spool".into(),
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
            json!({"kind": "spool", "color": "sky", "wear": ["scarf"]})
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
    }
}
