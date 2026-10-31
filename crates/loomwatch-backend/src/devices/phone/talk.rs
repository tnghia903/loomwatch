//! What was said in one piece of work, for the phone: each agent's answer, turn by turn; who the
//! work went to next; your answers; and what waits for you. A plain reading of the run's events
//! (`GET /api/session/events`). The Mac's projection (`ui/src/lib/watch/events.ts`) shows more:
//! tool calls, files read, words written on the way.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

fn text_of(event: &Value) -> &str {
    event
        .pointer("/payload/content/text")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// The phase a model gave a message: `commentary` for words on the way, `final_answer` for the
/// reply (`messagePhase` in the app).
fn phase_of(event: &Value) -> Option<&str> {
    event
        .pointer("/payload/phase")
        .or_else(|| event.pointer("/raw/params/update/_meta/codex/phase"))
        .and_then(Value::as_str)
}

struct Turn {
    at: String,
    text: String,
}

/// The lines of a run's talk, oldest first.
#[must_use]
pub fn talk(events: &[Value]) -> Vec<Value> {
    let mut lines = Vec::new();
    let mut turns: BTreeMap<String, Turn> = BTreeMap::new();
    // Turns that write a checkpoint or the handover itself: their words go on, not to you.
    let mut aside: BTreeSet<String> = BTreeSet::new();
    let flush = |turns: &mut BTreeMap<String, Turn>,
                 agent: &str,
                 lines: &mut Vec<Value>,
                 live: bool| {
        if let Some(turn) = turns.remove(agent) {
            let text = turn.text.trim();
            if !text.is_empty() {
                lines.push(json!({"kind": "said", "agent": agent, "at": turn.at, "text": text, "live": live}));
            }
        }
    };
    for event in events {
        let agent = event
            .get("agentId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let at = event.get("ts").and_then(Value::as_str).unwrap_or_default();
        let kind = event
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let role = event.pointer("/payload/role").and_then(Value::as_str);
        match (kind, role) {
            ("message", Some("agent")) => {
                if aside.contains(agent) || phase_of(event) == Some("commentary") {
                    continue;
                }
                let turn = turns.entry(agent.to_owned()).or_insert_with(|| Turn {
                    at: at.to_owned(),
                    text: String::new(),
                });
                turn.text.push_str(text_of(event));
            }
            ("message", Some("user"))
                if event.pointer("/raw/phase").and_then(Value::as_str)
                    == Some("operator_answer") =>
            {
                lines.push(
                    json!({"kind": "you", "agent": agent, "at": at, "text": text_of(event).trim()}),
                );
            }
            ("turn_end", _) => flush(&mut turns, agent, &mut lines, false),
            ("session_meta", _) => {
                let payload = event.get("payload").unwrap_or(&Value::Null);
                match payload.get("phase").and_then(Value::as_str) {
                    Some("turn_purpose") => {
                        let purpose = payload.get("purpose").and_then(Value::as_str);
                        if matches!(purpose, Some("checkpoint" | "handover")) {
                            aside.insert(agent.to_owned());
                        } else {
                            aside.remove(agent);
                        }
                    }
                    Some("prompt_sections") => {
                        let from: Vec<&str> = payload
                            .get("stageResultsFrom")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .collect();
                        if !from.is_empty() {
                            lines.push(
                                json!({"kind": "handover", "from": from, "agent": agent, "at": at}),
                            );
                        }
                    }
                    Some("awaiting_operator") => lines.push(json!({
                        "kind": "waiting", "agent": agent, "at": at,
                        "from": payload.get("handoverFrom"),
                        "text": payload.get("question").and_then(Value::as_str).unwrap_or_default(),
                    })),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    // A turn still under way: what it has said so far.
    let open: Vec<String> = turns.keys().cloned().collect();
    for agent in open {
        flush(&mut turns, &agent, &mut lines, true);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(clippy::needless_pass_by_value)]
    fn event(seq: u32, agent: &str, kind: &str, payload: Value) -> Value {
        json!({"seq": seq, "agentId": agent, "ts": format!("2026-10-28T10:00:{seq:02}Z"), "kind": kind, "payload": payload})
    }

    fn said(seq: u32, agent: &str, text: &str) -> Value {
        event(
            seq,
            agent,
            "message",
            json!({"role": "agent", "content": {"type": "text", "text": text}}),
        )
    }

    #[test]
    fn each_turn_is_one_line_and_a_handover_names_who_it_came_from() {
        let events = vec![
            event(
                1,
                "researcher",
                "message",
                json!({"role": "user", "content": {"text": "## Task\nFind fares"}}),
            ),
            said(2, "researcher", "Four fares fit. "),
            event(
                3,
                "researcher",
                "message",
                json!({"role": "agent", "phase": "commentary", "content": {"text": "Looking at ANA…"}}),
            ),
            said(4, "researcher", "ANA is shortest."),
            event(
                5,
                "researcher",
                "turn_end",
                json!({"stopReason": "end_turn"}),
            ),
            event(
                6,
                "researcher",
                "session_meta",
                json!({"phase": "turn_purpose", "purpose": "handover"}),
            ),
            said(7, "researcher", "Handover: four fares."),
            event(8, "researcher", "turn_end", json!({})),
            event(
                9,
                "writer",
                "session_meta",
                json!({"phase": "prompt_sections", "stageResultsFrom": ["researcher"], "sections": []}),
            ),
            said(10, "writer", "The shortlist."),
        ];
        let lines = talk(&events);
        assert_eq!(
            lines,
            vec![
                json!({"kind": "said", "agent": "researcher", "at": "2026-10-28T10:00:02Z", "text": "Four fares fit. ANA is shortest.", "live": false}),
                json!({"kind": "handover", "from": ["researcher"], "agent": "writer", "at": "2026-10-28T10:00:09Z"}),
                json!({"kind": "said", "agent": "writer", "at": "2026-10-28T10:00:10Z", "text": "The shortlist.", "live": true}),
            ]
        );
    }

    #[test]
    fn a_review_stop_waits_and_your_answer_is_yours() {
        let mut answer = event(
            3,
            "check",
            "message",
            json!({"role": "user", "content": {"text": "Only morning flights "}}),
        );
        answer["raw"] = json!({"phase": "operator_answer"});
        let events = vec![
            event(
                1,
                "check",
                "session_meta",
                json!({"phase": "awaiting_operator", "handoverFrom": "scout", "question": "Approve the shortlist?"}),
            ),
            answer,
        ];
        assert_eq!(
            talk(&events),
            vec![
                json!({"kind": "waiting", "agent": "check", "at": "2026-10-28T10:00:01Z", "from": "scout", "text": "Approve the shortlist?"}),
                json!({"kind": "you", "agent": "check", "at": "2026-10-28T10:00:03Z", "text": "Only morning flights"}),
            ]
        );
    }
}
