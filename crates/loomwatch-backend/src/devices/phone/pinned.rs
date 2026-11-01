//! The agent pinned to the Mac's notch (ADR 0083, decision 9), reached from the phone: who it is,
//! its own chat, and a message to it.
//!
//! Its chat is the one-agent team `.jobs/.bench/<id>.yaml`, the file its Chat tab on the Mac keeps.
//! The phone writes it as a link to the agent in My agents (`from: {agent}`), which the daemon
//! fills in from the saved agent each time it reads the file, so the agent always answers as its
//! saved version and the phone needs no copy of how the Mac writes an agent out.

use axum::http::{Method, StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};

use super::daemon::Daemon;
use super::studio::figure_for;
use crate::chat_files::SentFile;

/// Where My agents' chats are kept, relative to the teams folder (`jobs::BENCH_DIR`).
pub const CHATS: &str = ".jobs/.bench";

/// What a new team may spend in one run (`NEW_TEAM_PER_RUN_USD` in the app).
const PER_RUN_USD: u32 = 1;

/// A message for the pinned agent, as the phone sends it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedMessage {
    pub text: String,
    /// Made once on the phone and sent again on every retry, so a resend starts nothing twice.
    pub start_key: Option<String>,
    /// What it replies to, quoted as the Mac's chat quotes it (`replyTo` on a chat message).
    #[serde(default)]
    pub reply_to: Option<Value>,
    /// Files sent with it, by the paths their uploads to the agent's chat (`chatPath`) answered
    /// with. The chat refuses any other path (ADR 0082).
    #[serde(default)]
    pub files: Vec<SentFile>,
}

/// The agent's id in its own chat: `chatAgentId` in the app, the same id however it is renamed.
#[must_use]
pub fn chat_agent_id(job: &str) -> String {
    let lowered = job.trim().to_lowercase();
    let mut id = String::new();
    for part in lowered.split(|c: char| !c.is_ascii_alphanumeric()) {
        if part.is_empty() {
            continue;
        }
        if !id.is_empty() {
            id.push('-');
        }
        id.push_str(part);
    }
    if id.is_empty() {
        "agent".to_owned()
    } else {
        id
    }
}

/// The agent's chat as the phone writes it: the agent in My agents, by link.
#[must_use]
pub fn chat_yaml(job: &str, name: &str) -> String {
    let agent = chat_agent_id(job);
    let team = json!({
        "schemaVersion": 1,
        "id": format!("bench-{job}"),
        "name": format!("{name} · chat"),
        "spend": {"perRun": PER_RUN_USD},
        "entrypoint": agent,
        "agents": [{"id": agent, "from": {"agent": job}}],
    });
    serde_yaml::to_string(&team).unwrap_or_default()
}

/// Which agent is pinned: its id in My agents, or `None`.
async fn pinned_id(daemon: &Daemon) -> anyhow::Result<Option<String>> {
    let pinned = daemon.get_json("/api/pinned-agent").await?;
    Ok(pinned
        .get("agent")
        .and_then(Value::as_str)
        .map(str::to_owned))
}

/// One of My agents by id, or `None` when it is gone.
async fn mine(daemon: &Daemon, id: &str) -> anyhow::Result<Option<(String, Value)>> {
    let jobs = daemon.get_json("/api/jobs").await?;
    let job = jobs
        .get("jobs")
        .and_then(Value::as_array)
        .and_then(|jobs| {
            jobs.iter()
                .find(|job| job.get("id").and_then(Value::as_str) == Some(id))
        })
        .cloned();
    Ok(job.map(|job| (id.to_owned(), job)))
}

fn name_of(id: &str, job: &Value) -> String {
    job.get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(id)
        .to_owned()
}

fn query(path: &str, key: &str, value: &str) -> String {
    let mut url = reqwest::Url::parse("http://loomwatch").expect("a fixed URL parses");
    url.set_path(path);
    url.query_pairs_mut().append_pair(key, value);
    format!("{}?{}", url.path(), url.query().unwrap_or_default())
}

/// `GET /phone/v0/pinned`: the pinned agent with its figure, and the newest page of its chat
/// (`null` before its first message).
///
/// # Errors
/// When `LoomWatch` can't be reached.
pub async fn pinned_view(daemon: &Daemon) -> anyhow::Result<Value> {
    match pinned_id(daemon).await? {
        Some(id) => chat_view(daemon, &id).await,
        None => Ok(json!({"agent": null, "chat": null})),
    }
}

/// `GET /phone/v0/agents/{id}/chat`: one of My agents with its figure, and the newest page of its
/// own chat (`null` before its first message), as its Chat tab on the Mac shows it.
///
/// # Errors
/// When `LoomWatch` can't be reached.
pub async fn chat_view(daemon: &Daemon, id: &str) -> anyhow::Result<Value> {
    let Some((id, job)) = mine(daemon, id).await? else {
        return Ok(json!({"agent": null, "chat": null}));
    };
    let path = format!("{CHATS}/{id}.yaml");
    let chat = daemon
        .get_json(&format!(
            "{}&limit=20",
            query("/api/chat", "teamPath", &path)
        ))
        .await
        .ok();
    let (kind, color) = figure_for(&id, job.get("figure"));
    Ok(json!({
        "agent": {
            "id": id,
            "name": name_of(&id, &job),
            "figure": {"kind": kind, "color": color},
            "agent": chat_agent_id(&id),
            "chatPath": path,
        },
        "chat": chat,
    }))
}

/// `POST /phone/v0/pinned/messages`: writes the pinned agent's chat as a link to its saved self
/// when it isn't already, then sends the message there. The daemon decides, as for the Mac's
/// Chat tab, whether it starts a turn or waits as a note for the turn under way.
///
/// # Errors
/// When `LoomWatch` can't be reached; an answer the daemon refused comes back as its status.
pub async fn send_to_pinned(
    daemon: &Daemon,
    message: PinnedMessage,
) -> anyhow::Result<(StatusCode, Value)> {
    let text = message.text.trim();
    if text.is_empty() {
        return Ok((
            StatusCode::BAD_REQUEST,
            json!({"error": "Say something first."}),
        ));
    }
    let Some(id) = pinned_id(daemon).await? else {
        return Ok((
            StatusCode::CONFLICT,
            json!({"error": "No agent is pinned on your Mac."}),
        ));
    };
    send_to(daemon, &id, message).await
}

/// `POST /phone/v0/agents/{id}/messages`: a message in one of My agents' own chat, written as a
/// link to its saved self first when it isn't already.
///
/// # Errors
/// When `LoomWatch` can't be reached; an answer the daemon refused comes back as its status.
pub async fn send_to(
    daemon: &Daemon,
    id: &str,
    message: PinnedMessage,
) -> anyhow::Result<(StatusCode, Value)> {
    let text = message.text.trim();
    if text.is_empty() {
        return Ok((
            StatusCode::BAD_REQUEST,
            json!({"error": "Say something first."}),
        ));
    }
    let Some((id, job)) = mine(daemon, id).await? else {
        return Ok((
            StatusCode::NOT_FOUND,
            json!({"error": "That agent isn't in My agents any more."}),
        ));
    };
    let folder = daemon
        .send_json(Method::POST, "/api/bench", &[], &Value::Null)
        .await?
        .json::<Value>()
        .await
        .ok()
        .and_then(|reply| reply.get("folder")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| CHATS.to_owned());
    let path = format!("{folder}/{id}.yaml");
    let wanted = chat_yaml(&id, &name_of(&id, &job));
    let current = daemon
        .get_json(&query("/api/team", "path", &path))
        .await
        .ok();
    let mut revision = current
        .as_ref()
        .and_then(|file| file.get("revision")?.as_str().map(str::to_owned));
    let same = current
        .as_ref()
        .and_then(|file| file.get("yaml")?.as_str())
        .is_some_and(|yaml| yaml == wanted);
    if !same {
        let precondition = match &revision {
            Some(revision) => ("If-Match", format!("\"{revision}\"")),
            None => ("If-None-Match", "*".to_owned()),
        };
        let saved = daemon
            .send_json(
                Method::PUT,
                "/api/team",
                &[precondition],
                &json!({"path": path, "yaml": wanted}),
            )
            .await?;
        let status =
            StatusCode::from_u16(saved.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let reply: Value = saved.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Ok((status, reply));
        }
        revision = reply
            .get("revision")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    let mut body = json!({
        "teamPath": path,
        "text": text,
        "to": {"kind": "agent", "agent": chat_agent_id(&id)},
        "expectedRevision": revision,
        "startKey": message.start_key,
    });
    if let Some(reply) = message.reply_to {
        body["replyTo"] = reply;
    }
    if !message.files.is_empty() {
        body["files"] = json!(message.files);
    }
    let sent = daemon
        .send_json(Method::POST, "/api/chat/messages", &[], &body)
        .await?;
    let status = StatusCode::from_u16(sent.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    Ok((status, sent.json().await.unwrap_or(Value::Null)))
}

/// `POST /phone/v0/pinned {agent}`: pins one of My agents to the Mac's notch, as its menu in My
/// agents does; `null` unpins.
///
/// # Errors
/// When `LoomWatch` can't be reached; a refusal comes back as its status.
pub async fn pin(daemon: &Daemon, agent: Option<&str>) -> anyhow::Result<(StatusCode, Value)> {
    let reply = daemon
        .send_json(
            Method::PUT,
            "/api/pinned-agent",
            &[],
            &json!({"agent": agent}),
        )
        .await?;
    let status = StatusCode::from_u16(reply.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    Ok((status, reply.json().await.unwrap_or(Value::Null)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chat_id_is_the_apps() {
        // `agentId` in ui/src/lib/library/draft.ts.
        assert_eq!(chat_agent_id("maya"), "maya");
        assert_eq!(chat_agent_id("Trip Planner"), "trip-planner");
        assert_eq!(chat_agent_id("--a__b--"), "a-b");
        assert_eq!(chat_agent_id("***"), "agent");
    }

    #[test]
    fn the_chat_links_the_saved_agent() {
        let yaml = chat_yaml("trip-planner", "Trip Planner");
        let team: Value = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(team["id"], "bench-trip-planner");
        assert_eq!(team["name"], "Trip Planner · chat");
        assert_eq!(team["entrypoint"], "trip-planner");
        assert_eq!(
            team["agents"],
            json!([{"id": "trip-planner", "from": {"agent": "trip-planner"}}])
        );
        // No fields of its own: the daemon fills them from the saved agent each time.
        assert!(team["agents"][0].get("role").is_none());
    }
}
