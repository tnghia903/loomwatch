//! Instructions rewritten after the person removes something they name (ADR 0059).
//!
//! Taking a card off the canvas takes it out of the team file, but an agent still told "find the
//! EKIS page through the connected Notion tools" goes looking for it. This asks the person's own
//! Ask app, for one turn and with no tools, for the same instructions without that dependency.
//! Nothing here writes a team file: the canvas applies the answer as an ordinary edit, marks it so
//! the person sees what changed, and keeps what they had one click away.

use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    AGENT_ID, Control, EXIT_TIMEOUT, app_spec, ask_apps, chosen_app, chosen_model, error,
    first_line, prepare_workspace,
};
use crate::acp::{AcpProcess, EventLog, TeamSessionContext};

/// More than any team the canvas draws; a request naming more is not from the canvas.
const MAX_AGENTS: usize = 20;
const MAX_ROLE_CHARS: usize = 20_000;
const MAX_NAME_CHARS: usize = 300;
const MAX_KIND_CHARS: usize = 40;
/// One short turn with no tools to call. An app still going after this has stalled.
const REWRITE_LIMIT: Duration = Duration::from_mins(3);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RewriteRequest {
    #[serde(default)]
    app: Option<String>,
    #[serde(default)]
    model: Option<String>,
    removed: Removed,
    agents: Vec<AgentInstructions>,
}

#[derive(Debug, Deserialize)]
struct Removed {
    /// As its card shows it, e.g. `EKIS — SUTD Final Project Hub`.
    name: String,
    /// What it was, in plain words: `Notion page`, `skill`, `folder`.
    kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
struct AgentInstructions {
    id: String,
    #[serde(default)]
    name: String,
    role: String,
}

/// `POST /api/ask/instructions`: each named agent's instructions without the removed source.
pub(super) async fn rewrite(
    State(control): State<Control>,
    body: Result<Json<RewriteRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(request)) = body else {
        return error(StatusCode::BAD_REQUEST, "Send {removed, agents}.");
    };
    if let Err(message) = check(&request) {
        return error(StatusCode::UNPROCESSABLE_ENTITY, message);
    }
    let Some(archive) = control.inner.archive.clone() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            crate::watch_api::ARCHIVE_DISABLED_MESSAGE,
        );
    };
    let model = match chosen_model(request.model.as_deref()) {
        Ok(model) => model,
        Err(message) => return error(StatusCode::UNPROCESSABLE_ENTITY, message),
    };
    let apps = ask_apps(&control);
    let app = match chosen_app(&apps, request.app.as_deref()) {
        Ok(app) => app,
        Err(message) => return error(StatusCode::UNPROCESSABLE_ENTITY, message),
    };
    let workspace = match prepare_workspace(&control.inner.teams_root) {
        Ok(path) => path,
        Err(message) => return error(StatusCode::INTERNAL_SERVER_ERROR, message),
    };
    // No tools: the answer is the reply itself, and every request the app makes is declined.
    let spec = app_spec(&control, app, workspace);
    let mut process = match AcpProcess::spawn(&spec) {
        Ok(process) => process,
        Err(failure) => {
            return error(
                StatusCode::BAD_GATEWAY,
                format!(
                    "{} could not start: {failure}. Check that it works in a terminal, then try again.",
                    app.name
                ),
            );
        }
    };
    let session = format!("{AGENT_ID}-instructions-{}", uuid::Uuid::new_v4());
    let context = TeamSessionContext {
        archive: &archive,
        exit_timeout: EXIT_TIMEOUT,
        bus: None,
        event_log: Some(EventLog::new(archive.clone(), session)),
        packet: None,
        composed: None,
        boundary: None,
    };
    let prompt = compose(&request);
    let turn = process.run_session_with_bus(
        AGENT_ID,
        model.as_deref().unwrap_or_default(),
        &prompt,
        context,
    );
    let reply = match tokio::time::timeout(REWRITE_LIMIT, turn).await {
        Ok(Ok(outcome)) => outcome.reply,
        Ok(Err(failure)) => {
            let reason = first_line(&format!("{failure:#}"));
            return error(
                StatusCode::BAD_GATEWAY,
                format!("{} stopped answering: {reason}", app.name),
            );
        }
        Err(_) => {
            return error(
                StatusCode::GATEWAY_TIMEOUT,
                format!(
                    "{} didn't finish rewriting the instructions in 3 minutes.",
                    app.name
                ),
            );
        }
    };
    match parse_reply(&reply, &request.agents) {
        Ok(agents) => Json(json!({"agents": agents, "appName": app.name})).into_response(),
        Err(message) => error(StatusCode::BAD_GATEWAY, format!("{} {message}", app.name)),
    }
}

fn check(request: &RewriteRequest) -> Result<(), String> {
    let name = request.removed.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err("Say what was removed, by the name its card showed.".to_owned());
    }
    let kind = request.removed.kind.trim();
    if kind.is_empty() || kind.chars().count() > MAX_KIND_CHARS {
        return Err(
            "Say what kind of thing was removed: a skill, a folder, a Notion page.".to_owned(),
        );
    }
    if request.agents.is_empty() || request.agents.len() > MAX_AGENTS {
        return Err(format!(
            "Name between 1 and {MAX_AGENTS} agents to rewrite."
        ));
    }
    for agent in &request.agents {
        if agent.id.trim().is_empty() || agent.role.trim().is_empty() {
            return Err("Every agent needs its id and its instructions.".to_owned());
        }
        if agent.role.chars().count() > MAX_ROLE_CHARS {
            return Err(format!(
                "{}'s instructions are longer than {MAX_ROLE_CHARS} characters.",
                agent.id
            ));
        }
    }
    Ok(())
}

/// What the app is asked. The instructions go over as JSON so quotes and line breaks in them reach
/// it intact, and the answer comes back in the same shape.
fn compose(request: &RewriteRequest) -> String {
    let name = request.removed.name.trim();
    let kind = request.removed.kind.trim();
    let agents = serde_json::to_string_pretty(&request.agents).unwrap_or_default();
    format!(
        "You rewrite the instructions of agents in a LoomWatch team. Answer with JSON only.\n\n\
         The person removed the {kind} \"{name}\" from this team, so no agent is given it any more. \
         Rewrite each agent's instructions below so they no longer tell the agent to find, open, \
         read, use, update or report on \"{name}\".\n\n\
         - Change only what depends on \"{name}\". Keep every other sentence as it is, word for \
         word: the agent's job, how it works and what it replies with.\n\
         - Where a sentence mixes the job with \"{name}\", keep the job and drop \"{name}\".\n\
         - Add no new duties, tools or sources, and don't mention that anything was removed.\n\
         - If an agent's instructions don't depend on \"{name}\", return them unchanged.\n\n\
         Reply with this JSON and nothing else:\n\
         {{\"agents\": [{{\"id\": \"<the agent's id>\", \"role\": \"<its complete instructions>\"}}]}}\n\n\
         ## The agents' instructions\n{agents}\n"
    )
}

/// The rewritten instructions in `reply`, for agents that were asked about only. An empty answer
/// for an agent is not a rewrite, so it is left out rather than emptying the agent.
fn parse_reply(reply: &str, asked: &[AgentInstructions]) -> Result<Vec<Value>, String> {
    const MISSING: &str = "replied without the rewritten instructions. Try again.";
    let (Some(start), Some(end)) = (reply.find('{'), reply.rfind('}')) else {
        return Err(MISSING.to_owned());
    };
    let value: Value = serde_json::from_str(reply.get(start..=end).unwrap_or_default())
        .map_err(|_| MISSING.to_owned())?;
    let mut rewritten: Vec<Value> = Vec::new();
    for item in value
        .get("agents")
        .and_then(Value::as_array)
        .ok_or_else(|| MISSING.to_owned())?
    {
        let (Some(id), Some(role)) = (
            item.get("id").and_then(Value::as_str),
            item.get("role").and_then(Value::as_str),
        ) else {
            continue;
        };
        let role = role.trim();
        let asked_about = asked.iter().any(|agent| agent.id == id);
        let repeated = rewritten.iter().any(|done| done["id"] == id);
        if !asked_about || repeated || role.is_empty() || role.chars().count() > MAX_ROLE_CHARS {
            continue;
        }
        rewritten.push(json!({"id": id, "role": role}));
    }
    if rewritten.is_empty() {
        return Err(MISSING.to_owned());
    }
    Ok(rewritten)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str, role: &str) -> AgentInstructions {
        AgentInstructions {
            id: id.to_owned(),
            name: format!("{id} name"),
            role: role.to_owned(),
        }
    }

    fn request(agents: Vec<AgentInstructions>) -> RewriteRequest {
        RewriteRequest {
            app: None,
            model: None,
            removed: Removed {
                name: "EKIS — SUTD Final Project Hub".to_owned(),
                kind: "Notion page".to_owned(),
            },
            agents,
        }
    }

    #[test]
    fn the_prompt_names_what_was_removed_and_carries_each_agent_intact() {
        let prompt = compose(&request(vec![agent(
            "scope",
            "Read the \"EKIS\" page.\nThen plan.",
        )]));
        assert!(prompt.contains("removed the Notion page \"EKIS — SUTD Final Project Hub\""));
        assert!(prompt.contains(r#""role": "Read the \"EKIS\" page.\nThen plan.""#));
        assert!(prompt.contains("\"id\": \"scope\""));
    }

    #[test]
    fn a_reply_in_a_code_fence_with_words_around_it_is_read() {
        let asked = [agent("scope", "old"), agent("plan", "old")];
        let reply = "Here you go:\n```json\n{\"agents\": [{\"id\": \"scope\", \"role\": \" Plan from the request. \"}, {\"id\": \"plan\", \"role\": \"old\"}]}\n```";
        let rewritten = parse_reply(reply, &asked).expect("parsed");
        assert_eq!(
            rewritten,
            vec![
                json!({"id": "scope", "role": "Plan from the request."}),
                json!({"id": "plan", "role": "old"})
            ]
        );
    }

    #[test]
    fn agents_it_was_not_asked_about_empty_answers_and_repeats_are_left_out() {
        let asked = [agent("scope", "old")];
        let reply = r#"{"agents": [{"id": "other", "role": "x"}, {"id": "scope", "role": "  "}, {"id": "scope", "role": "new"}, {"id": "scope", "role": "newer"}]}"#;
        assert_eq!(
            parse_reply(reply, &asked).expect("parsed"),
            vec![json!({"id": "scope", "role": "new"})]
        );
    }

    #[test]
    fn a_reply_without_the_instructions_is_an_error() {
        let asked = [agent("scope", "old")];
        for reply in [
            "I removed it.",
            "{not json}",
            r#"{"agents": []}"#,
            r#"{"answer": "done"}"#,
        ] {
            assert!(parse_reply(reply, &asked).is_err(), "{reply}");
        }
    }

    #[test]
    fn a_request_must_say_what_was_removed_and_whose_instructions_to_rewrite() {
        assert!(check(&request(vec![agent("scope", "Read EKIS.")])).is_ok());
        assert!(check(&request(Vec::new())).is_err());
        assert!(check(&request(vec![agent("scope", "  ")])).is_err());
        assert!(
            check(&request(vec![agent(
                "scope",
                &"x".repeat(MAX_ROLE_CHARS + 1)
            )]))
            .is_err()
        );
        let mut nameless = request(vec![agent("scope", "Read EKIS.")]);
        nameless.removed.name = " ".to_owned();
        assert!(check(&nameless).is_err());
        let too_many = (0..=MAX_AGENTS)
            .map(|n| agent(&format!("a{n}"), "Read EKIS."))
            .collect();
        assert!(check(&request(too_many)).is_err());
    }
}
