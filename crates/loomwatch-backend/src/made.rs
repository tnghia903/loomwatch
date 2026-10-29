//! The files a run's agents made: the paths their edit calls name, of the calls that went through.
//!
//! Worked out once from the run's archived tool calls when it ends, and kept with the run
//! ([`crate::runs::RunRecord::made`]), so a page that lists many runs, such as a project's room or
//! Home, shows what they made without replaying each one. The rule is the app's `filesWritten`
//! (`ui/src/lib/files/fileRefs.ts`): an edit call that failed, or whose permission the person
//! refused, made nothing.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::Value;

use crate::archive::EventArchive;

/// The most files one run keeps: past it, the first ones it made.
pub(crate) const MADE_MAX: usize = 100;

/// Whether a run has no files to show, because they are not worked out yet or it made none: what
/// the run list leaves out.
// serde's `skip_serializing_if` passes a reference.
#[allow(clippy::ref_option)]
pub(crate) fn none_made(made: &Option<Vec<String>>) -> bool {
    made.as_ref().is_none_or(Vec::is_empty)
}

/// The files `run_id` made, from its archive.
///
/// # Errors
///
/// Returns an error when the archive cannot be read.
pub(crate) async fn files_made(
    archive: &EventArchive,
    run_id: &str,
) -> anyhow::Result<Vec<String>> {
    Ok(made_from(&archive.tool_events(run_id).await?))
}

/// One tool call, as far as making a file goes.
struct Call {
    edit: bool,
    failed: bool,
    declined: bool,
    paths: Vec<String>,
}

/// The files `events` show made, in the order their calls started: `(agent id, kind, payload)`
/// for each tool call, update and permission, oldest first.
pub(crate) fn made_from(events: &[(String, String, Value)]) -> Vec<String> {
    let mut calls: HashMap<(&str, &str), Call> = HashMap::new();
    let mut order: Vec<(&str, &str)> = Vec::new();
    // The permission each agent was last asked for and not yet answered: the call it is about and
    // the options offered. And the calls the person refused, should one be recorded after.
    let mut asked: HashMap<&str, (Option<&str>, &Value)> = HashMap::new();
    let mut refused: HashSet<(&str, &str)> = HashSet::new();
    for (agent, kind, payload) in events {
        let agent = agent.as_str();
        match kind.as_str() {
            "tool_call" => {
                let Some(id) = payload["callId"].as_str() else {
                    continue;
                };
                if calls.contains_key(&(agent, id)) {
                    continue;
                }
                order.push((agent, id));
                calls.insert(
                    (agent, id),
                    Call {
                        edit: payload["toolKind"] == "edit",
                        failed: payload["status"] == "failed",
                        declined: refused.contains(&(agent, id)),
                        paths: paths_of(payload),
                    },
                );
            }
            "tool_update" => {
                let Some(call) = payload["callId"]
                    .as_str()
                    .and_then(|id| calls.get_mut(&(agent, id)))
                else {
                    continue;
                };
                if call.paths.is_empty() {
                    call.paths = paths_of(payload);
                }
                match payload["status"].as_str() {
                    Some("failed") => call.failed = true,
                    Some("completed") => call.failed = false,
                    _ => {}
                }
            }
            "permission"
                if payload.get("options").is_some() || payload.get("toolCall").is_some() =>
            {
                asked.insert(
                    agent,
                    (
                        payload["toolCall"]["toolCallId"].as_str(),
                        &payload["options"],
                    ),
                );
            }
            "permission" => {
                let Some(outcome) = payload.get("outcome").filter(|outcome| outcome.is_object())
                else {
                    continue;
                };
                let Some((call, options)) = asked.remove(agent) else {
                    continue;
                };
                if allowed(outcome, options) {
                    continue;
                }
                if let Some(id) = call {
                    refused.insert((agent, id));
                    if let Some(call) = calls.get_mut(&(agent, id)) {
                        call.declined = true;
                    }
                }
            }
            _ => {}
        }
    }
    let mut seen = HashSet::new();
    order
        .iter()
        .filter_map(|key| calls.get(key))
        .filter(|call| call.edit && !call.failed && !call.declined)
        .flat_map(|call| call.paths.iter())
        .filter(|path| seen.insert(path.as_str()))
        .take(MADE_MAX)
        .cloned()
        .collect()
}

/// Whether the person let a call go ahead: they chose an option, and not one of the app's own
/// rejections (`reject_once`), which is how `LoomWatch` declines.
fn allowed(outcome: &Value, options: &Value) -> bool {
    if outcome["outcome"] != "selected" {
        return false;
    }
    let kind = options
        .as_array()
        .and_then(|options| {
            options
                .iter()
                .find(|option| option["optionId"] == outcome["optionId"])
        })
        .and_then(|option| option["kind"].as_str())
        .unwrap_or_default();
    !kind.starts_with("reject_")
}

/// The files a tool event names in its `locations`: full paths to a file with an extension, as the
/// app keeps them (`filePathFrom`).
fn paths_of(payload: &Value) -> Vec<String> {
    payload["locations"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|location| location["path"].as_str())
        .map(str::trim)
        .filter(|path| {
            path.len() <= 1024
                && !path.contains(['\n', '\r'])
                && Path::new(path).is_absolute()
                && Path::new(path).extension().is_some()
        })
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn event(agent: &str, kind: &str, payload: Value) -> (String, String, Value) {
        (agent.to_owned(), kind.to_owned(), payload)
    }

    /// A full path on any system, as an agent's tool call names it.
    fn at(name: &str) -> String {
        std::env::temp_dir()
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    fn edit(id: &str, path: &str) -> Value {
        json!({ "callId": id, "title": "Write", "toolKind": "edit", "status": "in_progress", "locations": [{ "path": path }] })
    }

    fn done(id: &str, status: &str) -> Value {
        json!({ "callId": id, "status": status })
    }

    #[test]
    fn an_edit_that_went_through_is_made_and_a_read_is_not() {
        let events = [
            event("writer", "tool_call", edit("1", &at("brief.md"))),
            event("writer", "tool_update", done("1", "completed")),
            event(
                "writer",
                "tool_call",
                json!({ "callId": "2", "title": "Read", "toolKind": "read", "status": "in_progress", "locations": [{ "path": at("notes.md") }] }),
            ),
            event("writer", "tool_update", done("2", "completed")),
        ];
        assert_eq!(made_from(&events), [at("brief.md")]);
    }

    #[test]
    fn a_failed_edit_made_nothing() {
        let events = [
            event("writer", "tool_call", edit("1", &at("brief.md"))),
            event("writer", "tool_update", done("1", "failed")),
        ];
        assert!(made_from(&events).is_empty());
    }

    #[test]
    fn an_edit_the_person_refused_made_nothing_and_one_they_allowed_did() {
        let options = json!([
            { "optionId": "allow", "kind": "allow_once", "name": "Allow" },
            { "optionId": "deny", "kind": "reject_once", "name": "Deny" },
        ]);
        let events = [
            event("writer", "tool_call", edit("1", &at("refused.md"))),
            event(
                "writer",
                "permission",
                json!({ "toolCall": { "toolCallId": "1", "title": "Write" }, "options": options }),
            ),
            event(
                "writer",
                "permission",
                json!({ "outcome": { "outcome": "selected", "optionId": "deny" } }),
            ),
            event("writer", "tool_call", edit("2", &at("allowed.md"))),
            event(
                "writer",
                "permission",
                json!({ "toolCall": { "toolCallId": "2", "title": "Write" }, "options": options }),
            ),
            event(
                "writer",
                "permission",
                json!({ "outcome": { "outcome": "selected", "optionId": "allow" } }),
            ),
            event("writer", "tool_update", done("2", "completed")),
        ];
        assert_eq!(made_from(&events), [at("allowed.md")]);
    }

    #[test]
    fn a_refusal_recorded_before_its_call_still_counts() {
        let events = [
            event(
                "writer",
                "permission",
                json!({ "toolCall": { "toolCallId": "1" }, "options": [] }),
            ),
            event(
                "writer",
                "permission",
                json!({ "outcome": { "outcome": "cancelled" } }),
            ),
            event("writer", "tool_call", edit("1", &at("brief.md"))),
        ];
        assert!(made_from(&events).is_empty());
    }

    #[test]
    fn calls_are_told_apart_by_agent_and_a_file_made_twice_is_listed_once() {
        // Two agents' harnesses both number their first call "1": the writer's went through and
        // the researcher's failed, whichever update comes first.
        let events = [
            event("researcher", "tool_call", edit("1", &at("brief.md"))),
            event("writer", "tool_call", edit("1", &at("post.md"))),
            event("writer", "tool_update", done("1", "completed")),
            event("researcher", "tool_update", done("1", "failed")),
            event("researcher", "tool_call", edit("2", &at("brief.md"))),
            event("researcher", "tool_call", edit("3", &at("brief.md"))),
        ];
        assert_eq!(made_from(&events), [at("post.md"), at("brief.md")]);
    }

    #[test]
    fn a_path_from_the_update_counts_and_a_folder_or_relative_path_does_not() {
        let events = [
            event(
                "writer",
                "tool_call",
                json!({ "callId": "1", "toolKind": "edit", "locations": [] }),
            ),
            event(
                "writer",
                "tool_update",
                json!({ "callId": "1", "status": "completed", "locations": [{ "path": at("late.md") }] }),
            ),
            event("writer", "tool_call", edit("2", &at("folder"))),
            event("writer", "tool_call", edit("3", "relative.md")),
        ];
        assert_eq!(made_from(&events), [at("late.md")]);
    }

    #[test]
    fn a_run_keeps_at_most_its_first_files() {
        let events: Vec<_> = (0..MADE_MAX + 5)
            .map(|index| {
                event(
                    "writer",
                    "tool_call",
                    edit(&index.to_string(), &at(&format!("{index}.md"))),
                )
            })
            .collect();
        let made = made_from(&events);
        assert_eq!(made.len(), MADE_MAX);
        assert_eq!(made[0], at("0.md"));
    }

    #[test]
    fn nothing_made_is_left_out_of_the_list() {
        assert!(none_made(&None));
        assert!(none_made(&Some(Vec::new())));
        assert!(!none_made(&Some(vec![at("brief.md")])));
    }
}
