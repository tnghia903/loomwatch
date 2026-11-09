//! What was said in one piece of work, for the phone: each agent's answer, turn by turn; who the
//! work went to next; your answers; and what waits for you. A plain reading of the run's events
//! (`GET /api/session/events`). The Mac's projection (`ui/src/lib/watch/events.ts`) shows more:
//! tool calls, files read, words written on the way.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use crate::engine::{ReplyText, commentary};

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
    /// Its messages a paragraph apart, the words on the way left out, as the Mac's chat reads them.
    text: ReplyText,
}

/// The notes an agent's answer ended with went to the run's record, not the answer (ADR 0062):
/// its last line leaves them out too, so it reads as the answer and holds its widgets.
fn leave_out_notes(lines: &mut [Value], agent: &str) {
    let last = lines
        .iter_mut()
        .rev()
        .find(|line| line["kind"] == "said" && line["agent"] == agent);
    if let Some(line) = last {
        let text = line["text"].as_str().unwrap_or_default();
        if let Some((work, _)) = crate::split_answer_notes(text) {
            line["text"] = json!(work.trim());
        }
    }
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
            let reply = turn.text.reply();
            let text = reply.trim();
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
                    text: ReplyText::default(),
                });
                let id = event.pointer("/payload/messageId").and_then(Value::as_str);
                turn.text.push(text_of(event), id);
            }
            // The agent did something other than talk: what it says next is a new message.
            ("tool_call" | "tool_update" | "plan" | "permission", _) => {
                if let Some(turn) = turns.get_mut(agent) {
                    turn.text.note_activity();
                }
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
                // Words written alongside tool calls were said on the way, not the answer.
                if let (Some(id), Some(turn)) = (commentary(payload), turns.get_mut(agent)) {
                    turn.text.set_aside(id);
                }
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
                    Some("answer_notes") => leave_out_notes(&mut lines, agent),
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

    /// A daily brief, 2026-11-09: "Now the Vietnamese market pages." before a web read, then the
    /// answer, reached the phone as "pages.## Summary", so the heading showed as words.
    #[test]
    fn messages_sit_a_paragraph_apart_and_words_on_the_way_are_left_out() {
        let message = |seq, id: &str, text: &str| {
            event(
                seq,
                "researcher",
                "message",
                json!({"role": "agent", "messageId": id, "content": {"type": "text", "text": text}}),
            )
        };
        let tool = |seq| event(seq, "researcher", "tool_call", json!({"toolCallId": "t"}));
        let on_the_way = |seq, id: &str| {
            event(
                seq,
                "researcher",
                "session_meta",
                json!({"sessionUpdate": "agent_message_phase", "phase": "commentary", "messageId": id}),
            )
        };
        let end = |seq| event(seq, "researcher", "turn_end", json!({}));

        // Words on the way, set aside: only the answer stays.
        let lines = talk(&[
            message(1, "m1", "Now the Vietnamese market pages."),
            on_the_way(2, "m1"),
            tool(3),
            message(4, "m2", "## Summary\nFor Vietnam"),
            message(5, "m2", ", the biggest story."),
            end(6),
        ]);
        assert_eq!(
            lines[0]["text"],
            "## Summary\nFor Vietnam, the biggest story."
        );

        // Two messages, neither set aside: a paragraph apart, by their ids.
        let lines = talk(&[
            message(1, "m1", "First."),
            message(2, "m2", "## Second"),
            end(3),
        ]);
        assert_eq!(lines[0]["text"], "First.\n\n## Second");

        // No ids: a tool call between them is the boundary.
        let lines = talk(&[
            said(1, "researcher", "First."),
            tool(2),
            said(3, "researcher", "## Second"),
            end(4),
        ]);
        assert_eq!(lines[0]["text"], "First.\n\n## Second");
    }

    /// The same brief: its answer ended with "## Not met", which the run's record keeps apart, so
    /// the phone couldn't tell the Writer's line was the answer and drew its widgets on a copy.
    #[test]
    fn the_notes_an_answer_ended_with_leave_its_line() {
        let events = vec![
            said(
                1,
                "writer",
                "# Brief\n\nThree stories.\n\n## Not met\n- No startup news",
            ),
            event(2, "writer", "turn_end", json!({})),
            event(
                3,
                "writer",
                "session_meta",
                json!({"phase": "answer_notes", "not_met": ["No startup news"]}),
            ),
        ];
        assert_eq!(talk(&events)[0]["text"], "# Brief\n\nThree stories.");

        // Without the record's note, a closing section is the agent's own words.
        assert_eq!(
            talk(&events[..2])[0]["text"],
            "# Brief\n\nThree stories.\n\n## Not met\n- No startup news"
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
