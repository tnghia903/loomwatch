//! One of My agents on its own, as Ask reads and proposes it (ADR 0119).
//!
//! When the person wants an agent to keep, to talk to or to use in their teams, Ask proposes the
//! agent alone, with no team around it. When they ask for a change to one of their agents, Ask
//! changes that agent. As with a team (ADR 0033), nothing here saves: the proposal opens on the
//! agent's own page, and the person saves it there with the page's own Save, against the version
//! it was made from.
//!
//! A change to an agent's instructions is a list of edits to its numbered lines
//! ([`super::line_edits`]), so every line Ask doesn't name stays as the person wrote it. Its other
//! settings are given whole, as a team file's fields are.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::line_edits;
use super::mcp::{connected_tool_names, installed_skills, object, read_only, string, text};
use super::{Caller, Control, now};
use crate::jobs::{JobAllow, JobRead, JobSpec};

/// The longest `note` a saved version keeps (`jobs::MAX_NOTE`).
const NOTE_CHARS: usize = 200;

/// The settings of an agent Ask may give, as a My agents file writes them. Its instructions come
/// whole for a new agent, and as edits for a change.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fields {
    name: Option<String>,
    does: Option<String>,
    #[serde(alias = "role")]
    instructions: Option<String>,
    model: Option<String>,
    thinking_effort: Option<String>,
    skills: Option<Vec<String>>,
    tools: Option<Vec<String>>,
    reads: Option<Vec<JobRead>>,
    done_when: Option<Vec<String>>,
    allow: Option<JobAllow>,
}

/// One of My agents Ask proposed, new or changed. Never written here: the agent's page saves it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentProposal {
    pub(super) id: String,
    /// The conversation it was proposed in.
    pub(super) source: String,
    /// `agent`, so the app tells it from a team's proposal, which has no kind.
    kind: &'static str,
    /// The agent it changes, by id. A new one has none yet: its page saves it under an id made
    /// from its name, as one made by hand is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) agent: Option<String>,
    pub(super) name: String,
    is_new: bool,
    /// The whole agent as it would be saved.
    spec: JobSpec,
    /// The version it was changed from: a save made after the agent moved on is refused.
    #[serde(skip_serializing_if = "Option::is_none")]
    base_version: Option<u32>,
    summary: String,
    /// The teams that use it, by name. Each gets the change from its next run (ADR 0094).
    in_teams: Vec<String>,
    created_at: String,
}

pub(super) fn definitions() -> [Value; 2] {
    let fields = json!({
        "name": string("What it is called, a word or two: Researcher, Email helper."),
        "does": string("What it does, in a few words, shown under its name."),
        "model": string("Its model, from `list_models`."),
        "thinkingEffort": string("How hard its model thinks, for a model `list_models` marks as reasoning."),
        "skills": {"type": "array", "items": {"type": "string"}, "description": "Skills it is given, by name from `list_skills`."},
        "tools": {"type": "array", "items": {"type": "string"}, "description": "Connected tools it is given, by name from `list_tools`. Each action asks the person first."},
        "reads": {"type": "array", "description": "Folders and files it reads in every team it joins, each as `find_files` gave it.", "items": {"type": "object", "additionalProperties": false, "required": ["name", "path"], "properties": {"name": {"type": "string"}, "path": {"type": "string"}}}},
        "doneWhen": {"type": "array", "items": {"type": "string"}, "description": "Two or three short, checkable things its result must always have."},
        "allow": {"type": "object", "additionalProperties": false, "description": "What it may do without asking.", "properties": {"web": {"type": "boolean"}, "edits": {"type": "boolean"}, "commands": {"type": "boolean"}}},
    });
    let mut new = fields.clone();
    new["instructions"] = string(
        "Its instructions, written for its kind of work so they fit any team that uses it: what \
         it does and leaves to others; how to work, ending with how it checks its work; and \
         exactly what it replies with.",
    );
    [
        json!({
            "name": "read_my_agent",
            "title": "Read one of My agents",
            "description": "One of My agents in full: its instructions one numbered line per line, its version, every setting, and the teams that use it. Read it before you propose a change to it.",
            "inputSchema": object(json!({"agent": string("Its id, from `list_my_agents`.")}), &["agent"]),
            "annotations": read_only(),
        }),
        json!({
            "name": "propose_agent",
            "title": "Propose an agent",
            "description": "Show the person one agent on its own, new or changed, as a card. It is checked first. Nothing is saved until they open it on its page and press Save.",
            "inputSchema": object(json!({
                "summary": string("One plain sentence saying what the proposal does, shown on the card."),
                "new": object(new, &["name", "instructions"]),
                "change": object(json!({
                    "agent": string("Its id, from `list_my_agents`."),
                    "version": {"type": "integer", "description": "Its version, from `read_my_agent`."},
                    "edits": {"type": "array", "description": "Edits to its instructions, by the line numbers `read_my_agent` showed. Every line you don't name stays exactly as it is. Each is {n, replace} for a line's whole new text, {n, drop: true}, or {after, add} for new lines after line `after` (0 for the start).", "items": {"type": "object"}},
                    "set": object(fields, &[]),
                }), &["agent", "version"]),
            }), &["summary"]),
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false},
        }),
    ]
}

/// The agent's id as the tools are given it, and its saved file, or what to tell the assistant.
fn saved(teams_root: &Path, arguments: &Value) -> Result<(String, JobSpec), String> {
    let id = text(arguments, "agent")?;
    crate::jobs::read_job(teams_root, &id)
        .map(|spec| (id.clone(), spec))
        .ok_or_else(|| {
            format!("There is no agent `{id}` in My agents. Use an id from `list_my_agents`.")
        })
}

pub(super) async fn read_my_agent(control: &Control, arguments: &Value) -> Result<Value, String> {
    let root = control.inner.teams_root.clone();
    let arguments = arguments.clone();
    tokio::task::spawn_blocking(move || {
        let (id, spec) = saved(&root, &arguments)?;
        Ok(json!({
            "id": id,
            "name": spec.name,
            "does": spec.does,
            "version": spec.version,
            "instructions": line_edits::numbered(&spec.instructions),
            "model": spec.model,
            "thinkingEffort": spec.thinking_effort,
            "skills": spec.skills,
            "tools": spec.tools,
            "reads": spec.reads,
            "doneWhen": spec.done_when,
            "allow": spec.allow,
            "inTeams": crate::my_agents::teams_using(&root, &id),
        }))
    })
    .await
    .map_err(|error| format!("Couldn't read the agent: {error}"))?
}

pub(super) async fn propose_agent(
    control: &Control,
    caller: &Caller,
    arguments: &Value,
) -> Result<Value, String> {
    let summary = text(arguments, "summary").unwrap_or_else(|_| "A proposed agent.".to_owned());
    let root = control.inner.teams_root.clone();
    let given = |key: &str| arguments.get(key).filter(|value| !value.is_null());
    let (agent, spec, current) = match (given("new"), given("change")) {
        (Some(new), None) => {
            let spec = new_agent(&root, new)?;
            (None, spec, None)
        }
        (None, Some(change)) => {
            let (id, current) = saved(&root, change)?;
            let spec = changed_agent(&current, change, &summary)?;
            (Some(id), spec, Some(current))
        }
        _ => {
            return Err(
                "Give `new` for a new agent, or `change` for one of My agents: one of them."
                    .to_owned(),
            );
        }
    };
    names_only_what_is_there(control, &spec, current.as_ref()).await?;
    let in_teams = agent
        .as_deref()
        .map(|id| crate::my_agents::teams_using(&root, id))
        .unwrap_or_default();
    let id = format!("proposal-{}", uuid::Uuid::new_v4());
    let Caller::Conversation(source) = caller.clone();
    let proposal = AgentProposal {
        id: id.clone(),
        source,
        kind: "agent",
        agent: agent.clone(),
        name: spec.name.clone(),
        is_new: agent.is_none(),
        base_version: current.as_ref().map(|current| current.version),
        spec,
        summary: summary.clone(),
        in_teams: in_teams.clone(),
        created_at: now(),
    };
    control
        .record(
            caller,
            "ask_agent_proposal",
            json!({
                "proposalId": id,
                "agent": proposal.agent,
                "name": proposal.name,
                "isNew": proposal.is_new,
                "summary": summary,
                "spec": proposal.spec,
                "baseVersion": proposal.base_version,
                "inTeams": in_teams,
            }),
        )
        .await;
    control
        .inner
        .agent_proposals
        .write()
        .await
        .insert(id.clone(), proposal);
    // Said to the assistant, which says it to the person: where it is, and that nothing changed.
    let message = if in_teams.is_empty() {
        "Shown to the person as a card. Nothing is saved until they open it and press Save on its page.".to_owned()
    } else {
        let (get, run) = if in_teams.len() == 1 {
            ("gets", "its next run")
        } else {
            ("get", "their next run")
        };
        format!(
            "Shown to the person as a card. Nothing is saved until they open it and press Save on \
             its page. Once saved, {} {get} the change from {run}.",
            crate::my_agents::listed(&in_teams)
        )
    };
    Ok(json!({
        "proposalId": id,
        "status": "waiting_for_the_person",
        "message": message,
    }))
}

/// The fields Ask gave, read as the person's agents file reads them.
fn fields(value: &Value, what: &str) -> Result<Fields, String> {
    serde_json::from_value(value.clone())
        .map_err(|error| format!("`{what}` has a problem: {error}"))
}

/// `base` with every field `given` names put in its place.
fn with_fields(mut base: Value, given: Fields) -> Value {
    let Fields {
        name,
        does,
        instructions,
        model,
        thinking_effort,
        skills,
        tools,
        reads,
        done_when,
        allow,
    } = given;
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            base[key] = value;
        }
    };
    put("name", name.map(Value::from));
    put("does", does.map(Value::from));
    put("instructions", instructions.map(Value::from));
    put("model", model.map(Value::from));
    put("thinkingEffort", thinking_effort.map(Value::from));
    put("skills", skills.map(|skills| json!(skills)));
    put("tools", tools.map(|tools| json!(tools)));
    put("reads", reads.map(|reads| json!(reads)));
    put("doneWhen", done_when.map(|done| json!(done)));
    put("allow", allow.map(|allow| json!(allow)));
    base
}

/// A My agents file from `value`, with every field checked as a save checks it.
fn spec_from(value: Value) -> Result<JobSpec, String> {
    let spec: JobSpec = serde_json::from_value(value)
        .map_err(|error| format!("The agent has a problem: {error}"))?;
    crate::jobs::normalize(spec).map_err(|error| format!("The agent has a problem: {error}"))
}

fn new_agent(teams_root: &Path, new: &Value) -> Result<JobSpec, String> {
    let given = fields(new, "new")?;
    if given
        .name
        .as_deref()
        .is_none_or(|name| name.trim().is_empty())
    {
        return Err("Give the new agent a `name`.".to_owned());
    }
    if given
        .instructions
        .as_deref()
        .is_none_or(|text| text.trim().is_empty())
    {
        return Err("Give the new agent its `instructions`.".to_owned());
    }
    let spec = spec_from(with_fields(json!({}), given))?;
    // The page saves a new agent under an id from its name, and refuses a name one of them has.
    if let Ok(list) = crate::jobs::list_jobs(teams_root)
        && let Some(same) = list
            .jobs
            .iter()
            .find(|job| job.spec.name.trim().eq_ignore_ascii_case(&spec.name))
    {
        return Err(format!(
            "They already have an agent called {} (`{}`). Change that one with `change`, or give \
             this one another name.",
            same.spec.name, same.id
        ));
    }
    Ok(spec)
}

fn changed_agent(current: &JobSpec, change: &Value, summary: &str) -> Result<JobSpec, String> {
    let version = change.get("version").and_then(Value::as_u64);
    if version != Some(u64::from(current.version)) {
        return Err(format!(
            "{} is at version {}: it changed since you read it, or `version` is missing. Read it \
             again with `read_my_agent` and propose the change again.",
            current.name, current.version
        ));
    }
    let set = change
        .get("set")
        .filter(|value| !value.is_null())
        .map(|set| fields(set, "set"))
        .transpose()?
        .unwrap_or_default();
    if set.instructions.is_some() {
        return Err(
            "Change its instructions with `edits`, by the numbered lines `read_my_agent` showed, \
             so every line you don't name stays as the person wrote it."
                .to_owned(),
        );
    }
    let edits = change
        .get("edits")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let applied = line_edits::apply(&current.instructions, edits);
    if !applied.missed.is_empty() {
        return Err(format!(
            "Some edits name no line its instructions have ({}). Read it again with \
             `read_my_agent` and propose the change again.",
            applied.missed.join("; ")
        ));
    }
    let mut base = serde_json::to_value(current).map_err(|error| error.to_string())?;
    base["instructions"] = json!(applied.text);
    let mut spec = spec_from(with_fields(base, set))?;
    let unchanged = JobSpec {
        version: current.version,
        note: current.note.clone(),
        saved_at: current.saved_at.clone(),
        ..spec.clone()
    } == *current;
    if unchanged {
        return Err(
            "That changes nothing in the agent. Say what to change in `edits` or `set`.".to_owned(),
        );
    }
    spec.version = current.version;
    spec.saved_at.clone_from(&current.saved_at);
    spec.note = summary.chars().take(NOTE_CHARS).collect();
    Ok(spec)
}

/// The skills, tools and places `spec` names that aren't there now, as a team proposal is refused
/// for them (ADR 0096). What the saved agent already has is let through, so a change that keeps it,
/// as it must, isn't refused for one removed since.
async fn names_only_what_is_there(
    control: &Control,
    spec: &JobSpec,
    current: Option<&JobSpec>,
) -> Result<(), String> {
    let kept = |name: &String, list: fn(&JobSpec) -> &Vec<String>| {
        current.is_some_and(|current| {
            list(current)
                .iter()
                .any(|other| other.eq_ignore_ascii_case(name))
        })
    };
    let installed = installed_skills(control).await?;
    let missing: Vec<String> = spec
        .skills
        .iter()
        .filter(|name| !kept(name, |spec| &spec.skills))
        .filter(|name| {
            !installed
                .iter()
                .any(|skill| skill.name.eq_ignore_ascii_case(name))
        })
        .cloned()
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "{} {} one of their skills. Use a name from `list_skills`.",
            crate::my_agents::listed(&missing),
            if missing.len() == 1 {
                "isn't"
            } else {
                "aren't"
            }
        ));
    }
    let connected = connected_tool_names().await;
    let missing: Vec<String> = spec
        .tools
        .iter()
        .filter(|name| !kept(name, |spec| &spec.tools))
        .filter(|name| {
            !connected
                .iter()
                .any(|other| other.eq_ignore_ascii_case(name))
        })
        .cloned()
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "{} {} connected yet. Connect it in Connections, under Tools.",
            crate::my_agents::listed(&missing),
            if missing.len() == 1 {
                "isn't"
            } else {
                "aren't"
            }
        ));
    }
    let root = &control.inner.teams_root;
    let had = |read: &JobRead| current.is_some_and(|current| current.reads.contains(read));
    let mut missing = Vec::new();
    for read in spec.reads.iter().filter(|read| !had(read)) {
        match (&read.path, &read.notion) {
            (Some(path), _) => {
                if !crate::chosen_knowledge::resolve(root, Path::new(path)).exists() {
                    missing.push(path.clone());
                }
            }
            (None, Some(_)) => {
                return Err(
                    "A Notion page is chosen in LoomWatch: tell the person to open the agent and \
                     add the page there."
                        .to_owned(),
                );
            }
            (None, None) => {
                return Err(format!(
                    "`{}` names no folder or file: give its `path` from `find_files`.",
                    read.name
                ));
            }
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "There is no folder or file at {} on this computer. Find it with `find_files` and \
             propose again.",
            missing.join(" or ")
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(instructions: &str) -> JobSpec {
        spec_from(json!({
            "name": "Researcher",
            "instructions": instructions,
            "model": "fake/offline",
            "doneWhen": ["Every fact has a source"],
        }))
        .expect("an agent")
    }

    #[test]
    fn a_change_keeps_every_line_it_does_not_name() {
        let current =
            agent("You find facts.\nHow to work:\n- Use primary sources.\nReply with the facts.");
        let change = json!({
            "version": 1,
            "edits": [{"after": 3, "add": "- Say how sure you are of each fact."}],
            "set": {"doneWhen": ["Every fact has a source", "Says how sure it is"]},
        });
        let spec = changed_agent(&current, &change, "Says how sure it is of each fact.")
            .expect("a change");
        assert_eq!(
            spec.instructions,
            "You find facts.\nHow to work:\n- Use primary sources.\n- Say how sure you are of each fact.\nReply with the facts."
        );
        assert_eq!(spec.done_when.len(), 2);
        assert_eq!(
            spec.model.as_deref(),
            Some("fake/offline"),
            "what it doesn't set stays"
        );
        assert_eq!(
            spec.version, 1,
            "the version it was made from, which the save names"
        );
        assert_eq!(spec.note, "Says how sure it is of each fact.");
    }

    #[test]
    fn a_change_is_refused_for_a_stale_version_whole_instructions_a_missed_line_or_nothing() {
        let current = agent("You find facts.\nReply with the facts.");
        let refused = |change: Value, says: &str| {
            let message = changed_agent(&current, &change, "x").expect_err("refused");
            assert!(message.contains(says), "{change}: {message}");
        };
        refused(json!({"version": 2, "edits": []}), "is at version 1");
        refused(json!({"edits": []}), "`version` is missing");
        refused(
            json!({"version": 1, "set": {"instructions": "All new."}}),
            "with `edits`",
        );
        refused(
            json!({"version": 1, "edits": [{"n": 7, "replace": "x"}]}),
            "line 7: there are only 2 lines",
        );
        refused(json!({"version": 1}), "changes nothing");
        refused(
            json!({"version": 1, "set": {"colour": "blue"}}),
            "unknown field `colour`",
        );
    }
}
