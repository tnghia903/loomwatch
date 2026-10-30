//! What an agent is doing right now, for the line under its desk on the phone: the web's phases
//! (`workPhase` in `ui/src/lib/watch/workPhase.ts`: reading, thinking, at a tool, writing) and the
//! step in words, from its run's newest events. Change both.

use serde_json::{Value, json};

/// A message it was handed counts as being read for this long.
const READING_MS: i64 = 6_000;
/// A step this recent counts as under way even after it finished.
const WORKING_WINDOW_MS: i64 = 3_000;
/// Events that say nothing about what it is doing.
const SILENT: [&str; 6] = [
    "usage",
    "session_meta",
    "process",
    "turn_end",
    "permission",
    "permission_request",
];

/// `{"phase": "reading" | "thinking" | "tools" | "typing", "words": "Reading corbado.com"}`, for
/// `agent`'s events (every agent's when `None`), at `now_ms`.
#[must_use]
pub fn doing(events: &[Value], agent: Option<&str>, now_ms: i64) -> Value {
    let mut finished: Vec<&str> = Vec::new();
    for event in events.iter().rev() {
        let kind = event
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let from = event.get("agentId").and_then(Value::as_str);
        if agent.is_some_and(|agent| from != Some(agent)) || SILENT.contains(&kind) {
            continue;
        }
        let payload = event.get("payload").unwrap_or(&Value::Null);
        let since = event
            .get("ts")
            .and_then(Value::as_str)
            .and_then(epoch_ms)
            .map_or(i64::MAX, |at| now_ms - at);
        let recent = since < WORKING_WINDOW_MS;
        match kind {
            "message" => {
                if payload.get("role").and_then(Value::as_str) == Some("user") {
                    return if since >= READING_MS {
                        thinking(events, agent)
                    } else {
                        said("reading", "Reading what it was given")
                    };
                }
                return if recent {
                    said("typing", "Writing its answer")
                } else {
                    thinking(events, agent)
                };
            }
            "thought" | "plan" => return thinking(events, agent),
            "tool_update" => {
                let done = matches!(
                    payload.get("status").and_then(Value::as_str),
                    Some("completed" | "failed")
                );
                if done && let Some(call) = payload.get("callId").and_then(Value::as_str) {
                    finished.push(call);
                }
            }
            "tool_call" => {
                if payload.get("toolKind").and_then(Value::as_str) == Some("think") {
                    return thinking(events, agent);
                }
                let closed = matches!(
                    payload.get("status").and_then(Value::as_str),
                    Some("completed" | "failed")
                ) || payload
                    .get("callId")
                    .and_then(Value::as_str)
                    .is_some_and(|call| finished.contains(&call));
                return if !closed || recent {
                    said("tools", &tool_words(payload))
                } else {
                    thinking(events, agent)
                };
            }
            _ => {}
        }
    }
    said("reading", "Reading what it was given")
}

fn said(phase: &str, words: &str) -> Value {
    json!({"phase": phase, "words": words})
}

/// Thinking, with the heading of what it is thinking about when its reasoning has one, as the
/// web's thought bubble shows it (`thoughtLine`: the last bold heading, at most 38 characters).
fn thinking(events: &[Value], agent: Option<&str>) -> Value {
    let heading = events
        .iter()
        .rev()
        .filter(|event| event.get("kind").and_then(Value::as_str) == Some("thought"))
        .filter(|event| {
            agent.is_none_or(|agent| event.get("agentId").and_then(Value::as_str) == Some(agent))
        })
        .find_map(|event| {
            let text = event
                .pointer("/payload/content/text")
                .or_else(|| event.pointer("/payload/text"))
                .and_then(Value::as_str)?;
            let last = text.rsplit("**").nth(1)?.trim();
            (!last.is_empty() && last.chars().count() <= 38).then(|| last.to_owned())
        });
    match heading {
        Some(heading) => said("thinking", &format!("Thinking: {heading}")),
        None => said("thinking", "Thinking"),
    }
}

/// A tool call in words, as the step it is: "Reading corbado.com", "Searching the web for “…”",
/// "Changing report.md", "Running npm" (the web's `asUse`, said as under way).
fn tool_words(payload: &Value) -> String {
    let input = payload.get("rawInput").unwrap_or(&Value::Null);
    let text = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let title = payload
        .get("title")
        .and_then(Value::as_str)
        .and_then(|title| title.lines().next())
        .map(str::trim)
        .filter(|title| !title.is_empty());
    let path = text("path")
        .or_else(|| text("file_path"))
        .or_else(|| payload.pointer("/locations/0/path").and_then(Value::as_str));
    let url = text("url").or_else(|| {
        title.and_then(|title| {
            title
                .split_whitespace()
                .find(|word| word.starts_with("http"))
        })
    });
    match payload
        .get("toolKind")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "fetch" => url.map_or_else(
            || "Reading a web page".to_owned(),
            |url| format!("Reading {}", host(url)),
        ),
        "search" => match text("query") {
            Some(query) if path.is_none() => format!("Searching the web for “{}”", clip(query, 40)),
            Some(query) => format!("Looking for “{}”", clip(query, 40)),
            None => "Searching".to_owned(),
        },
        "read" => path.map_or_else(
            || "Reading a file".to_owned(),
            |path| format!("Reading {}", base(path)),
        ),
        "edit" | "delete" | "move" => path.map_or_else(
            || "Changing a file".to_owned(),
            |path| format!("Changing {}", base(path)),
        ),
        "execute" => {
            let command = text("command").map(str::to_owned).or_else(|| {
                input.get("command").and_then(Value::as_array).map(|parts| {
                    parts
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
            });
            command
                .as_deref()
                .and_then(|command| command.split_whitespace().find(|word| !word.contains('=')))
                .map_or_else(
                    || "Running a command".to_owned(),
                    |program| format!("Running {}", base(program)),
                )
        }
        _ => title.map_or_else(|| "Using a tool".to_owned(), |title| clip(title, 48)),
    }
}

/// `corbado.com` from `https://www.corbado.com/blog/…`.
fn host(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let rest = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    rest.strip_prefix("www.").unwrap_or(rest)
}

fn base(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
}

fn clip(text: &str, most: usize) -> String {
    if text.chars().count() <= most {
        return text.to_owned();
    }
    let cut: String = text.chars().take(most - 1).collect();
    format!("{}…", cut.trim_end())
}

/// Milliseconds since 1970 for an RFC 3339 time such as `2026-10-28T10:00:02.123Z`.
#[must_use]
pub fn epoch_ms(ts: &str) -> Option<i64> {
    let (date, time) = ts.split_once('T')?;
    let mut ymd = date.split('-').map(str::parse::<i64>);
    let (year, month, day) = (ymd.next()?.ok()?, ymd.next()?.ok()?, ymd.next()?.ok()?);
    let (clock, offset_minutes) = if let Some(clock) = time.strip_suffix('Z') {
        (clock, 0)
    } else {
        let at = time.rfind(['+', '-'])?;
        let (clock, zone) = time.split_at(at);
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let mut parts = zone[1..].split(':').map(str::parse::<i64>);
        let hours = parts.next()?.ok()?;
        let minutes = parts.next().and_then(Result::ok).unwrap_or(0);
        (clock, sign * (hours * 60 + minutes))
    };
    let mut hms = clock.split(':');
    let hours: i64 = hms.next()?.parse().ok()?;
    let minutes: i64 = hms.next()?.parse().ok()?;
    let seconds: f64 = hms.next()?.parse().ok()?;
    // Days from 1970-01-01 (Howard Hinnant's days_from_civil).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    #[allow(clippy::cast_possible_truncation)]
    let millis = (seconds * 1000.0).round() as i64;
    Some(((days * 24 + hours) * 60 + minutes - offset_minutes) * 60_000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-10-29T10:00:10Z";

    fn at(seconds_before: i64) -> String {
        format!("2026-10-29T10:00:{:02}Z", 10 - seconds_before)
    }

    fn event(kind: &str, agent: &str, seconds_before: i64, payload: &Value) -> Value {
        json!({"kind": kind, "agentId": agent, "ts": at(seconds_before), "payload": payload})
    }

    fn now() -> i64 {
        epoch_ms(NOW).unwrap()
    }

    #[test]
    fn times_read_as_the_web_reads_them() {
        assert_eq!(epoch_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(epoch_ms("1970-01-02T00:00:01.5Z"), Some(86_401_500));
        assert_eq!(epoch_ms("2026-10-29T17:00:10+07:00"), epoch_ms(NOW));
    }

    #[test]
    fn an_open_tool_call_is_the_step_in_words() {
        let fetch = event(
            "tool_call",
            "scout",
            20,
            &json!({"callId": "c1", "toolKind": "fetch", "title": "Fetch https://www.corbado.com/blog/product-hunt", "status": "in_progress"}),
        );
        assert_eq!(
            doing(std::slice::from_ref(&fetch), Some("scout"), now()),
            json!({"phase": "tools", "words": "Reading corbado.com"})
        );
        let search = event(
            "tool_call",
            "scout",
            1,
            &json!({"callId": "c2", "toolKind": "search", "rawInput": {"query": "Product Hunt supporters"}}),
        );
        assert_eq!(
            doing(&[search], Some("scout"), now())["words"],
            "Searching the web for “Product Hunt supporters”"
        );
        let edit = event(
            "tool_call",
            "scout",
            1,
            &json!({"toolKind": "edit", "locations": [{"path": "/w/notes/report.md"}]}),
        );
        assert_eq!(doing(&[edit], None, now())["words"], "Changing report.md");
        let run = event(
            "tool_call",
            "scout",
            1,
            &json!({"toolKind": "execute", "rawInput": {"command": ["CI=1", "/usr/bin/npm", "test"]}}),
        );
        assert_eq!(doing(&[run], None, now())["words"], "Running npm");
    }

    #[test]
    fn a_finished_step_long_ago_is_thinking_with_its_heading() {
        let events = [
            event(
                "thought",
                "scout",
                30,
                &json!({"content": {"text": "**Weighing the launch day**\nShow HN first…"}}),
            ),
            event(
                "tool_call",
                "scout",
                20,
                &json!({"callId": "c1", "toolKind": "fetch", "title": "Fetch https://a.dev"}),
            ),
            event(
                "tool_update",
                "scout",
                19,
                &json!({"callId": "c1", "status": "completed"}),
            ),
        ];
        assert_eq!(
            doing(&events, Some("scout"), now()),
            json!({"phase": "thinking", "words": "Thinking: Weighing the launch day"})
        );
    }

    #[test]
    fn a_message_it_was_given_is_read_then_thought_about_and_its_own_is_written() {
        let given = event("message", "scout", 2, &json!({"role": "user"}));
        assert_eq!(doing(&[given], Some("scout"), now())["phase"], "reading");
        let older = event("message", "scout", 8, &json!({"role": "user"}));
        assert_eq!(doing(&[older], Some("scout"), now())["phase"], "thinking");
        let writing = event("message", "scout", 1, &json!({"role": "assistant"}));
        assert_eq!(
            doing(&[writing], Some("scout"), now()),
            json!({"phase": "typing", "words": "Writing its answer"})
        );
    }

    #[test]
    fn another_agent_and_silent_events_are_passed_over() {
        let events = [
            event(
                "tool_call",
                "scout",
                1,
                &json!({"toolKind": "read", "rawInput": {"path": "/a/brief.md"}}),
            ),
            event("message", "writer", 0, &json!({"role": "assistant"})),
            event("usage", "scout", 0, &json!({})),
        ];
        assert_eq!(
            doing(&events, Some("scout"), now())["words"],
            "Reading brief.md"
        );
    }
}
