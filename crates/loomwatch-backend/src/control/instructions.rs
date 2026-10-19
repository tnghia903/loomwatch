//! Instructions rewritten after the person removes something they name (ADR 0059).
//!
//! Taking a card off the canvas takes it out of the team file, but an agent still told "find the
//! EKIS page through the connected Notion tools" goes looking for it. This asks `LoomWatch`'s own
//! agent, for one turn and with no tools, which sentences to drop or replace so the instructions
//! no longer depend on it. The agent is shown every agent's instructions as numbered sentences and
//! answers with edits only; `LoomWatch` makes them, so a sentence the agent doesn't name stays
//! exactly as the person wrote it. It runs with a short system prompt of its own in place of the
//! agents' base prompt, on the fast model unless the person chose one.
//! Nothing here writes a team file: the canvas applies the answer as an ordinary edit, marks it so
//! the person sees what changed, and keeps what they had one click away.

use std::collections::BTreeMap;
use std::collections::btree_map::Entry;
use std::fmt::Write as _;
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    AGENT_ID, ASSISTANT_NAME, Control, ask_spec, chosen_model, error, first_line, prepare_workspace,
};
use crate::engine::{AgentRun, EventLog, TeamSessionContext};

/// More than any team the canvas draws; a request naming more is not from the canvas.
const MAX_AGENTS: usize = 20;
const MAX_ROLE_CHARS: usize = 20_000;
const MAX_NAME_CHARS: usize = 300;
const MAX_KIND_CHARS: usize = 40;
/// One short turn with no tools to call. An agent still going after this has stalled.
const REWRITE_LIMIT: Duration = Duration::from_mins(3);
/// What the agent is told it is, in place of the base prompt every team agent gets.
const SYSTEM_PROMPT: &str =
    "You edit the instructions of agents in a LoomWatch team. Reply with JSON only.";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RewriteRequest {
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
        Ok(model) => model.unwrap_or_else(|| super::tier_model("fast")),
        Err(message) => return error(StatusCode::UNPROCESSABLE_ENTITY, message),
    };
    let model = control.model_for(Some(model));
    let workspace = match prepare_workspace(&control.inner.teams_root) {
        Ok(path) => path,
        Err(message) => return error(StatusCode::INTERNAL_SERVER_ERROR, message),
    };
    // No tools: the answer is the reply itself.
    let mut process = match AgentRun::spawn(&ask_spec(workspace)) {
        // Not told about the person (ADR 0074): their "answer in Vietnamese" is for answers, and
        // must not translate the instructions they wrote.
        Ok(process) => process
            .without_tools()
            .without_the_person()
            .with_instructions(SYSTEM_PROMPT),
        Err(failure) => {
            return error(
                StatusCode::BAD_GATEWAY,
                format!("{ASSISTANT_NAME} could not start: {failure}"),
            );
        }
    };
    let session = format!("{AGENT_ID}-instructions-{}", uuid::Uuid::new_v4());
    let context = TeamSessionContext {
        archive: &archive,
        bus: None,
        event_log: Some(EventLog::new(archive.clone(), session)),
        packet: None,
        composed: None,
        boundary: None,
    };
    let prompt = compose(&request);
    let turn = process.run_session_with_bus(AGENT_ID, &model, &prompt, context);
    let reply = match tokio::time::timeout(REWRITE_LIMIT, turn).await {
        Ok(Ok(outcome)) => outcome.reply,
        Ok(Err(failure)) => {
            let reason = first_line(&format!("{failure:#}"));
            return error(
                StatusCode::BAD_GATEWAY,
                format!("{ASSISTANT_NAME} stopped answering: {reason}"),
            );
        }
        Err(_) => {
            return error(
                StatusCode::GATEWAY_TIMEOUT,
                format!("{ASSISTANT_NAME} didn't finish rewriting the instructions in 3 minutes."),
            );
        }
    };
    match parse_reply(&reply, &request.agents) {
        Ok(agents) => Json(json!({"agents": agents, "appName": ASSISTANT_NAME})).into_response(),
        Err(message) => error(
            StatusCode::BAD_GATEWAY,
            format!("{ASSISTANT_NAME} {message}"),
        ),
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

/// What the app is asked: every sentence of every agent's instructions, numbered, so it can also
/// drop one that only made sense next to what was removed, and an answer of edits alone.
fn compose(request: &RewriteRequest) -> String {
    let name = request.removed.name.trim();
    let kind = request.removed.kind.trim();
    let mut listing = String::new();
    for agent in &request.agents {
        let label = agent.name.trim();
        if label.is_empty() || label == agent.id {
            let _ = writeln!(listing, "### {}", agent.id);
        } else {
            let _ = writeln!(listing, "### {} ({label})", agent.id);
        }
        for (index, sentence) in Numbered::new(&agent.role).sentences.iter().enumerate() {
            let _ = writeln!(listing, "[{}] {sentence}", index + 1);
        }
        listing.push('\n');
    }
    format!(
        "The person removed the {kind} \"{name}\" from this LoomWatch team, so no agent is given \
         it any more. Each agent's instructions are below, one numbered sentence per line. List \
         the edits that stop them telling the agent to find, open, read, use, update or report on \
         \"{name}\".\n\n\
         - Drop a sentence that is only about \"{name}\", or that only made sense beside it.\n\
         - Where a sentence mixes the agent's job with \"{name}\", replace it: keep the job, leave \
         out \"{name}\", and write the whole new sentence.\n\
         - Name only the sentences you change. Every other sentence stays exactly as it is.\n\
         - Add no new duties, tools or sources, and don't mention that anything was removed.\n\n\
         Reply with this JSON and nothing else; an empty list if nothing depends on it:\n\
         {{\"edits\": [{{\"agent\": \"<id>\", \"n\": <number>, \"drop\": true}}, \
         {{\"agent\": \"<id>\", \"n\": <number>, \"replace\": \"<the whole new sentence>\"}}]}}\n\n\
         ## The agents' instructions\n\n{listing}"
    )
}

/// One agent's instructions as the app is shown them: its sentences, numbered from 1, and the
/// whitespace around them. `gaps[0]` comes before the first sentence, `gaps[i]` between sentence
/// `i` and `i + 1`, and the last one after the last sentence, so together they are the
/// instructions byte for byte.
#[derive(Debug)]
struct Numbered<'a> {
    sentences: Vec<&'a str>,
    gaps: Vec<&'a str>,
}

/// What the app asked for one sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Edit {
    Drop,
    Replace(String),
}

impl<'a> Numbered<'a> {
    fn new(text: &'a str) -> Self {
        let mut sentences = Vec::new();
        let mut gaps = Vec::new();
        let mut rest = text;
        loop {
            let body = rest.trim_start();
            gaps.push(&rest[..rest.len() - body.len()]);
            if body.is_empty() {
                return Self { sentences, gaps };
            }
            let end = sentence_end(body);
            sentences.push(&body[..end]);
            rest = &body[end..];
        }
    }

    /// The instructions with `edits` made, keyed by sentence number. Every other sentence is kept
    /// as it was, and so is the whitespace between two kept sentences. Where sentences are
    /// dropped, the widest gap around them stays, so a paragraph's last sentence takes its
    /// paragraph break with it only when the paragraph goes.
    fn apply(&self, edits: &BTreeMap<usize, Edit>) -> String {
        if self.sentences.is_empty() {
            return self.gaps.concat();
        }
        let mut out = String::from(self.gaps.first().copied().unwrap_or_default());
        let mut gap: Option<&str> = None;
        let mut started = false;
        for (index, sentence) in self.sentences.iter().enumerate() {
            if started {
                let before = self.gaps.get(index).copied().unwrap_or_default();
                gap = Some(widest(gap, before));
            }
            let text = match edits.get(&(index + 1)) {
                Some(Edit::Drop) => continue,
                Some(Edit::Replace(text)) => text.as_str(),
                None => sentence,
            };
            if let Some(gap) = gap.take() {
                out.push_str(gap);
            }
            out.push_str(text);
            started = true;
        }
        out.push_str(self.gaps.last().copied().unwrap_or_default());
        out
    }
}

/// Where the sentence `text` opens with ends: at the line break, or after `.`, `!` or `?` (and any
/// closing quote or bracket) followed by a space and a word that isn't lowercase, so "e.g. the"
/// and a list's "1." stay inside their sentence.
fn sentence_end(text: &str) -> usize {
    let line = text.find(['\n', '\r']).map_or(text, |end| &text[..end]);
    let mut chars = line.char_indices().peekable();
    while let Some((at, mark)) = chars.next() {
        if !matches!(mark, '.' | '!' | '?') {
            continue;
        }
        let mut end = at + mark.len_utf8();
        while let Some(&(next_at, next)) = chars.peek() {
            if !matches!(next, '"' | '\'' | ')' | ']' | '”' | '’' | '»') {
                break;
            }
            end = next_at + next.len_utf8();
            chars.next();
        }
        let after = &line[end..];
        let word = after.trim_start();
        if word.len() == after.len() {
            continue;
        }
        if word.is_empty() {
            break;
        }
        if word.starts_with(char::is_lowercase) || is_list_marker(&line[..end]) {
            continue;
        }
        return end;
    }
    line.trim_end().len()
}

/// `1.` or `a.` opening a list item, which is not a sentence of its own.
fn is_list_marker(sentence: &str) -> bool {
    let Some(marker) = sentence.strip_suffix('.') else {
        return false;
    };
    let mut chars = marker.chars();
    (!marker.is_empty() && marker.chars().all(|c| c.is_ascii_digit()))
        || (chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.next().is_none())
}

/// Of the whitespace around dropped sentences, the one with the most line breaks; the first on a
/// tie.
fn widest<'a>(kept: Option<&'a str>, next: &'a str) -> &'a str {
    match kept {
        Some(kept) if kept.matches('\n').count() >= next.matches('\n').count() => kept,
        _ => next,
    }
}

/// The agent, sentence number and edit an item of the reply's `edits` names, if it names all three.
/// A replacement with nothing in it drops the sentence.
fn read_edit(item: &Value) -> Option<(&str, usize, Edit)> {
    let agent = item.get("agent")?.as_str()?;
    let n = item.get("n")?;
    let n = n
        .as_u64()
        .or_else(|| n.as_str().and_then(|n| n.trim().parse().ok()))?;
    let n = usize::try_from(n).ok()?;
    let edit = if item.get("drop").and_then(Value::as_bool) == Some(true) {
        Edit::Drop
    } else {
        match item.get("replace")?.as_str()?.trim() {
            "" => Edit::Drop,
            text => Edit::Replace(text.to_owned()),
        }
    };
    Some((agent, n, edit))
}

/// The instructions of each agent the edits in `reply` change, with the edits made. An edit for an
/// agent or a sentence the app wasn't shown is ignored, and so is a second edit to one sentence.
/// An agent the edits would leave with no instructions is left out rather than emptied.
fn parse_reply(reply: &str, asked: &[AgentInstructions]) -> Result<Vec<Value>, String> {
    const MISSING: &str = "replied without the rewritten instructions. Try again.";
    let (Some(start), Some(end)) = (reply.find('{'), reply.rfind('}')) else {
        return Err(MISSING.to_owned());
    };
    let value: Value = serde_json::from_str(reply.get(start..=end).unwrap_or_default())
        .map_err(|_| MISSING.to_owned())?;
    let listed = value
        .get("edits")
        .and_then(Value::as_array)
        .ok_or_else(|| MISSING.to_owned())?;
    let numbered: Vec<Numbered> = asked
        .iter()
        .map(|agent| Numbered::new(&agent.role))
        .collect();
    let mut edits: Vec<BTreeMap<usize, Edit>> = vec![BTreeMap::new(); asked.len()];
    for item in listed {
        let Some((agent, n, edit)) = read_edit(item) else {
            continue;
        };
        let Some(index) = asked.iter().position(|candidate| candidate.id == agent) else {
            continue;
        };
        if n == 0 || n > numbered[index].sentences.len() {
            continue;
        }
        if let Entry::Vacant(slot) = edits[index].entry(n) {
            slot.insert(edit);
        }
    }
    // An empty list is an answer: nothing depends on what was removed. Edits that all miss are not.
    if !listed.is_empty() && edits.iter().all(BTreeMap::is_empty) {
        return Err(MISSING.to_owned());
    }
    let mut rewritten = Vec::new();
    for ((agent, sentences), made) in asked.iter().zip(&numbered).zip(&edits) {
        if made.is_empty() {
            continue;
        }
        let role = sentences.apply(made);
        if role.trim().is_empty() || role == agent.role || role.chars().count() > MAX_ROLE_CHARS {
            continue;
        }
        rewritten.push(json!({"id": agent.id, "role": role}));
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
            model: None,
            removed: Removed {
                name: "EKIS — SUTD Final Project Hub".to_owned(),
                kind: "Notion page".to_owned(),
            },
            agents,
        }
    }

    fn edits(pairs: &[(usize, Edit)]) -> BTreeMap<usize, Edit> {
        pairs.iter().cloned().collect()
    }

    /// Instructions as people write them: paragraphs, a list, quotes, abbreviations, a heading,
    /// odd spacing, a closing line break.
    const ROLE: &str = "  Establish the problem from the EKIS page.  Use EKIS as the workspace!\n\
        \n\
        ## Steps\n\
        1. Read the brief, e.g. the request.\n\
        2. Say \"done.\" Then stop?\r\n\
        - Keep it short... Really short.\n\
        \tReply with a brief (one page).\n";

    #[test]
    fn instructions_are_cut_into_sentences_and_put_back_byte_for_byte() {
        let numbered = Numbered::new(ROLE);
        assert_eq!(
            numbered.sentences,
            [
                "Establish the problem from the EKIS page.",
                "Use EKIS as the workspace!",
                "## Steps",
                "1. Read the brief, e.g. the request.",
                "2. Say \"done.\"",
                "Then stop?",
                "- Keep it short...",
                "Really short.",
                "Reply with a brief (one page).",
            ]
        );
        assert_eq!(numbered.gaps.len(), numbered.sentences.len() + 1);
        assert_eq!(numbered.apply(&BTreeMap::new()), ROLE);
        for text in [
            "",
            "   \n",
            "One line, no stop",
            "A. B.",
            "Version 1.2 is out. Ok",
        ] {
            assert_eq!(
                Numbered::new(text).apply(&BTreeMap::new()),
                text,
                "{text:?}"
            );
        }
    }

    #[test]
    fn an_unnamed_sentence_never_changes() {
        let numbered = Numbered::new(ROLE);
        let count = numbered.sentences.len();
        for named in 1..=count {
            for edit in [
                Edit::Drop,
                Edit::Replace("Plan from the request.".to_owned()),
            ] {
                let after = numbered.apply(&edits(&[(named, edit.clone())]));
                let mut rest = after.as_str();
                for (index, sentence) in numbered.sentences.iter().enumerate() {
                    if index + 1 == named {
                        continue;
                    }
                    let at = rest
                        .find(sentence)
                        .unwrap_or_else(|| panic!("{sentence:?} after editing {named}: {after:?}"));
                    rest = &rest[at + sentence.len()..];
                }
                if edit == Edit::Drop {
                    assert!(!after.contains(numbered.sentences[named - 1]), "{after:?}");
                }
            }
        }
        // Every sentence but one rewritten: that one is still exactly as it was, spacing and all.
        let all_but_four = (1..=count)
            .filter(|n| *n != 4)
            .map(|n| (n, Edit::Replace(format!("Sentence {n}."))))
            .collect::<Vec<_>>();
        let after = numbered.apply(&edits(&all_but_four));
        assert!(
            after.contains("\n1. Read the brief, e.g. the request.\n"),
            "{after:?}"
        );
    }

    #[test]
    fn dropping_a_sentence_keeps_the_paragraphs_around_it() {
        let role = "Plan.\n\nRead EKIS. Then write.\nReply.\n";
        let numbered = Numbered::new(role);
        let drop = |n| numbered.apply(&edits(&[(n, Edit::Drop)]));
        assert_eq!(drop(1), "Read EKIS. Then write.\nReply.\n");
        assert_eq!(drop(2), "Plan.\n\nThen write.\nReply.\n");
        assert_eq!(drop(3), "Plan.\n\nRead EKIS.\nReply.\n");
        assert_eq!(drop(4), "Plan.\n\nRead EKIS. Then write.\n");
        assert_eq!(
            numbered.apply(&edits(&[(2, Edit::Drop), (3, Edit::Drop)])),
            "Plan.\n\nReply.\n"
        );
        assert_eq!(
            numbered.apply(&edits(&[(
                2,
                Edit::Replace("Read the request.".to_owned())
            )])),
            "Plan.\n\nRead the request. Then write.\nReply.\n"
        );
    }

    #[test]
    fn the_prompt_names_what_was_removed_and_numbers_every_sentence() {
        let prompt = compose(&request(vec![agent(
            "scope",
            "Read the \"EKIS\" page.\nThen plan.",
        )]));
        assert!(prompt.contains("removed the Notion page \"EKIS — SUTD Final Project Hub\""));
        assert!(
            prompt
                .contains("### scope (scope name)\n[1] Read the \"EKIS\" page.\n[2] Then plan.\n")
        );
        assert!(prompt.contains(r#"{"edits": [{"agent": "<id>", "n": <number>, "drop": true}"#));
    }

    #[test]
    fn a_reply_in_a_code_fence_with_words_around_it_is_read() {
        let asked = [
            agent("scope", "Read EKIS. Plan from EKIS.\nReply with a brief.\n"),
            agent("plan", "Write the plan."),
        ];
        let reply = "Here you go:\n```json\n{\"edits\": [{\"agent\": \"scope\", \"n\": 1, \"drop\": true}, {\"agent\": \"scope\", \"n\": \"2\", \"replace\": \" Plan from the request. \"}]}\n```";
        assert_eq!(
            parse_reply(reply, &asked).expect("parsed"),
            vec![json!({"id": "scope", "role": "Plan from the request.\nReply with a brief.\n"})]
        );
    }

    #[test]
    fn edits_it_was_not_asked_for_and_repeats_are_left_out() {
        let asked = [
            agent("scope", "Read EKIS. Plan."),
            agent("plan", "Use EKIS."),
        ];
        let reply = r#"{"edits": [
            {"agent": "other", "n": 1, "drop": true},
            {"agent": "scope", "n": 3, "drop": true},
            {"agent": "scope", "n": 0, "drop": true},
            {"agent": "scope", "n": 1},
            {"agent": "scope", "n": 1, "replace": "Read the request."},
            {"agent": "scope", "n": 1, "drop": true},
            {"agent": "plan", "n": 1, "replace": "  "}
        ]}"#;
        assert_eq!(
            parse_reply(reply, &asked).expect("parsed"),
            vec![json!({"id": "scope", "role": "Read the request. Plan."})],
            "plan is left with nothing, so it is not rewritten to nothing"
        );
    }

    #[test]
    fn nothing_to_change_is_an_answer_and_a_reply_without_edits_is_an_error() {
        let asked = [agent("scope", "Read EKIS.")];
        assert_eq!(parse_reply(r#"{"edits": []}"#, &asked), Ok(Vec::new()));
        assert_eq!(
            parse_reply(
                r#"{"edits": [{"agent": "scope", "n": 1, "replace": "Read EKIS."}]}"#,
                &asked
            ),
            Ok(Vec::new()),
            "a replacement that changes nothing"
        );
        for reply in [
            "I removed it.",
            "{not json}",
            r#"{"agents": [{"id": "scope", "role": "Plan."}]}"#,
            r#"{"edits": [{"agent": "other", "n": 1, "drop": true}]}"#,
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
