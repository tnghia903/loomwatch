//! The phone's home screen: what needs you, what is working, what is done.
//!
//! Built from the daemon's own records (`GET /api/runs`, `GET /api/team-requests`), whose items
//! are passed on whole, so a field the daemon adds reaches the phone without a change here.

use serde_json::{Map, Value, json};

/// `runs` is `GET /api/runs`, `requests` is `GET /api/team-requests` (`Null` when it failed).
#[must_use]
pub fn home_view(runs: &Value, requests: &Value) -> Value {
    let mut needs_you = Vec::new();
    let mut working = Vec::new();
    let mut done = Vec::new();

    for record in runs.as_array().into_iter().flatten() {
        let run = run_summary(record);
        for request in list(record, "permissionRequests") {
            needs_you.push(item("permission", &run, "request", request, "since"));
        }
        for stop in list(record, "spendStops") {
            needs_you.push(item("spend", &run, "stop", stop, "since"));
        }
        if let Some(waiting) = record.get("waitingOn").filter(|value| !value.is_null()) {
            needs_you.push(item("answer", &run, "waitingOn", waiting, "since"));
        }
        if is_finished(record) {
            done.push(run);
        } else {
            working.push(run);
        }
    }
    for request in requests.as_array().into_iter().flatten() {
        if request.get("status").and_then(Value::as_str) == Some("waiting") {
            needs_you.push(json!({
                "kind": "teamRequest",
                "since": request.get("createdAt").cloned().unwrap_or(Value::Null),
                "teamRequest": request,
            }));
        }
    }

    // Oldest first: the one waiting longest is the one to answer first.
    needs_you.sort_by(|a, b| text(a, "since").cmp(text(b, "since")));
    // Newest first, as the Mac's lists show them.
    done.sort_by(|a, b| text(b, "finishedAt").cmp(text(a, "finishedAt")));

    json!({ "needsYou": needs_you, "working": working, "done": done })
}

/// The run fields a phone row shows, so a row needs no second call.
fn run_summary(record: &Value) -> Value {
    let mut run = Map::new();
    for key in [
        "runId",
        "teamPath",
        "teamName",
        "status",
        "prompt",
        "working",
        "agentNames",
        "onlyAgent",
        "reply",
        "createdAt",
        "startedAt",
        "finishedAt",
        "errorCode",
        "stopReason",
        // Why work didn't finish, who answers for the team, and when a timed run tries again (the
        // Mac leaves those out of what needs you).
        "error",
        "responder",
        "nextTryAt",
        // The message the person asked for at a time that the run wrote (ADR 0108): its notice
        // is the agent's message, and the words that were set when the turn failed.
        "messageAt",
    ] {
        if let Some(value) = record.get(key).filter(|value| !value.is_null()) {
            run.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(run)
}

fn item(kind: &str, run: &Value, field: &str, value: &Value, since: &str) -> Value {
    json!({
        "kind": kind,
        "since": value.get(since).cloned().unwrap_or(Value::Null),
        "run": run,
        field: value,
    })
}

fn list<'a>(record: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    record
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn is_finished(record: &Value) -> bool {
    matches!(
        record.get("status").and_then(Value::as_str),
        Some("succeeded" | "failed" | "cancelled")
    )
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_runs_into_needs_you_working_and_done() {
        let runs = json!([
            {
                "runId": "live", "teamName": "Research", "status": "running", "working": ["writer"],
                "permissionRequests": [
                    {"id": "p1", "agent": "writer", "title": "Run ls", "since": "2026-10-28T10:05:00Z"}
                ],
                "spendStops": [{"id": "s1", "limitUsd": 1.0, "since": "2026-10-28T10:01:00Z"}],
                "waitingOn": null
            },
            {
                "runId": "review", "teamName": "Review stop demo", "status": "running",
                "permissionRequests": [], "spendStops": [],
                "waitingOn": {"node": "review", "question": "Approve?", "since": "2026-10-28T10:03:00Z"}
            },
            {"runId": "old", "status": "succeeded", "reply": "Done.", "finishedAt": "2026-10-28T09:00:00Z",
             "messageAt": {"id": "m1", "at": "2026-10-28T08:59:00.000Z", "text": "stand up"}},
            {"runId": "new", "status": "failed", "finishedAt": "2026-10-28T09:30:00Z",
             "error": "Out of credits.\nDetails follow.", "responder": "writer", "nextTryAt": null}
        ]);
        let requests = json!([
            {"id": "t1", "status": "waiting", "createdAt": "2026-10-28T10:02:00Z"},
            {"id": "t2", "status": "done", "createdAt": "2026-10-28T08:00:00Z"}
        ]);

        let home = home_view(&runs, &requests);

        let kinds: Vec<&str> = home["needsYou"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["spend", "teamRequest", "answer", "permission"]);
        assert_eq!(home["needsYou"][3]["request"]["id"], "p1");
        assert_eq!(home["needsYou"][3]["run"]["teamName"], "Research");
        assert_eq!(home["needsYou"][2]["waitingOn"]["node"], "review");

        let working: Vec<&str> = home["working"]
            .as_array()
            .unwrap()
            .iter()
            .map(|run| run["runId"].as_str().unwrap())
            .collect();
        assert_eq!(working, ["live", "review"]);
        let done: Vec<&str> = home["done"]
            .as_array()
            .unwrap()
            .iter()
            .map(|run| run["runId"].as_str().unwrap())
            .collect();
        assert_eq!(done, ["new", "old"]);
        assert_eq!(home["done"][1]["reply"], "Done.");
        assert_eq!(
            home["done"][1]["messageAt"]["text"], "stand up",
            "a message the person asked for reaches the phone as one (ADR 0108)"
        );
        assert_eq!(home["done"][0]["error"], "Out of credits.\nDetails follow.");
        assert_eq!(home["done"][0]["responder"], "writer");
        assert!(
            home["done"][0].get("nextTryAt").is_none(),
            "a null is left out"
        );
    }

    #[test]
    fn a_failed_team_requests_call_still_gives_a_home() {
        let home = home_view(&json!([]), &Value::Null);
        assert_eq!(home, json!({"needsYou": [], "working": [], "done": []}));
    }
}
