//! The offline provider: answers without a model, so "Offline demo (no AI)" runs on a computer
//! with no key and no internet, and the engine's tests run without either.
//!
//! [`Demo::offline`] says what `examples/operator-stop-harness.py` used to say for the demo team
//! (`model: fake/offline`), so the demo reads the same now that the built-in agent runs it.
//! [`Demo::scripted`] replays exact replies, tool calls included, and keeps every request it was
//! sent for a test to read.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};

use super::error::CallError;
use super::provider::{ChatRequest, Completion, DeltaSink, Message};

/// The model name team files use for the offline demo.
pub const OFFLINE_MODEL: &str = "fake/offline";

/// The offline provider.
#[derive(Debug, Clone)]
pub struct Demo {
    script: Option<Arc<Script>>,
}

#[derive(Debug, Default)]
struct Script {
    replies: Mutex<VecDeque<Completion>>,
    seen: Mutex<Vec<SeenRequest>>,
}

/// One request the scripted demo was sent.
#[derive(Debug, Clone, PartialEq)]
pub struct SeenRequest {
    pub model: String,
    pub effort: Option<String>,
    pub messages: Vec<Message>,
    /// The names of the tools offered.
    pub tools: Vec<String>,
}

impl Demo {
    /// The demo team's fixed answers.
    #[must_use]
    pub fn offline() -> Self {
        Self { script: None }
    }

    /// Exactly these replies, in order. Once they run out, every reply is "(the script ended)".
    #[must_use]
    pub fn scripted(replies: Vec<Completion>) -> Self {
        Self {
            script: Some(Arc::new(Script {
                replies: Mutex::new(replies.into()),
                seen: Mutex::default(),
            })),
        }
    }

    /// Every request the scripted demo has been sent, oldest first. Empty for [`Demo::offline`].
    #[must_use]
    pub fn requests(&self) -> Vec<SeenRequest> {
        self.script.as_ref().map_or_else(Vec::new, |script| {
            script
                .seen
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        })
    }

    pub(crate) async fn complete(
        &self,
        request: &ChatRequest<'_>,
        deltas: &dyn DeltaSink,
    ) -> Result<Completion, CallError> {
        let completion = match &self.script {
            Some(script) => {
                script
                    .seen
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(SeenRequest {
                        model: request.model.to_owned(),
                        effort: request.effort.map(str::to_owned),
                        messages: request.messages.to_vec(),
                        tools: request.tools.iter().map(|tool| tool.name.clone()).collect(),
                    });
                script
                    .replies
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .pop_front()
                    .unwrap_or_else(|| Completion::text("(the script ended)"))
            }
            None => Completion::text(&offline_reply(request)),
        };
        if !completion.content.is_empty() {
            deltas.text(&completion.content).await?;
        }
        Ok(completion)
    }
}

fn last_user_message(messages: &[Message]) -> &str {
    messages
        .iter()
        .rev()
        .find_map(|message| match message {
            Message::User { content } => Some(content.as_str()),
            _ => None,
        })
        .unwrap_or_default()
}

/// What the demo team's agents say, word for word as the old fixture did.
fn offline_reply(request: &ChatRequest<'_>) -> String {
    let prompt = last_user_message(request.messages);
    if prompt.starts_with("Last step. Record where this work stands") {
        return "## Done\nPrepared the offline demonstration.\n\n## Next\nApply the operator's next \
                direction."
            .to_owned();
    }
    if prompt.starts_with("Your work on this task is done. Write the handover") {
        let revision = sent_back(request.messages)
            .map(|feedback| format!("\n\n## Revision requested\n{feedback}"))
            .unwrap_or_default();
        return format!(
            "## Summary\nDemo options: a short guide or a detailed walkthrough.{revision}\n\n## \
             Open questions\nWhich format should Writer use?"
        );
    }
    if let Some(feedback) = feedback_in(prompt) {
        return format!("Revised the demo findings: {feedback}");
    }
    if request.agent_id == "writer" {
        let note = operator_note(prompt);
        return if note.is_empty() {
            "Offline demo complete. No AI model was used. Writer received no direction.".to_owned()
        } else {
            format!(
                "Offline demo complete. No AI model was used. Writer received your direction:\n\n\
                 {note}"
            )
        };
    }
    "Offline demo findings: choose a short guide or a detailed walkthrough. No model provider was \
     called."
        .to_owned()
}

/// The newest send-back the agent was given, if any.
fn sent_back(messages: &[Message]) -> Option<&str> {
    messages.iter().rev().find_map(|message| match message {
        Message::User { content } => feedback_in(content),
        _ => None,
    })
}

/// The feedback in a send-back prompt: the paragraph after its first, up to its closing line.
fn feedback_in(prompt: &str) -> Option<&str> {
    if !prompt.contains("read your handover and sent this") {
        return None;
    }
    let (_, rest) = prompt.split_once("\n\n")?;
    Some(
        rest.split_once("\n\nWhen you are done")
            .map_or(rest, |(feedback, _)| feedback),
    )
}

/// The operator's own words from "## Direction from you", without `LoomWatch`'s framing.
fn operator_note(prompt: &str) -> &str {
    let Some((_, section)) = prompt.split_once("## Direction from you") else {
        return "";
    };
    let section = section
        .split_once("## Results from preceding stages")
        .map_or(section, |(before, _)| before)
        .trim();
    // `LoomWatch` opens the section with one paragraph of its own ("The operator answered at the
    // review stop ..."); what follows it is what the operator typed or chose.
    match section.split_once("\n\n") {
        Some((framing, note)) if framing.starts_with("The operator") => note.trim(),
        _ => section,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::provider::ServerTools;

    fn ask(agent: &str, messages: &[Message]) -> String {
        offline_reply(&ChatRequest {
            model: OFFLINE_MODEL,
            effort: None,
            messages,
            tools: &[],
            server_tools: ServerTools::default(),
            max_tokens: 1,
            session_key: "s",
            agent_id: agent,
        })
    }

    fn user(text: &str) -> Message {
        Message::User {
            content: text.to_owned(),
        }
    }

    #[test]
    fn the_demo_team_reads_as_it_always_has() {
        assert!(
            ask("researcher", &[user("Task: compare guides")]).starts_with("Offline demo findings")
        );
        assert_eq!(
            ask(
                "writer",
                &[user(
                    "## Task\nWrite\n\n## Direction from you\nThe operator answered at the review stop.\n\nUse the short guide."
                )]
            ),
            "Offline demo complete. No AI model was used. Writer received your direction:\n\nUse the short guide."
        );
        assert!(
            ask(
                "researcher",
                &[user("Last step. Record where this work stands, please")]
            )
            .starts_with("## Done")
        );
    }

    #[test]
    fn a_send_back_is_answered_and_then_named_in_the_handover() {
        let send_back = "Writer read your handover and sent this back.\n\nAdd a table.\n\nWhen you are done, reply.";
        assert_eq!(
            ask("researcher", &[user(send_back)]),
            "Revised the demo findings: Add a table."
        );
        let handover = ask(
            "researcher",
            &[
                user(send_back),
                user("Your work on this task is done. Write the handover now."),
            ],
        );
        assert!(handover.contains("## Revision requested\nAdd a table."));
    }
}
