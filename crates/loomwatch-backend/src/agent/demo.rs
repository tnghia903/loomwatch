//! The offline provider: answers without a model, so "Offline demo (no AI)" runs on a computer
//! with no key and no internet, and the engine's tests run without either.
//!
//! [`Demo::offline`] says what `examples/operator-stop-harness.py` used to say for the demo team
//! (`model: fake/offline`), so the demo reads the same now that the built-in agent runs it.
//! [`Demo::scripted`] replays exact replies, tool calls included, and [`Demo::responder`] answers
//! each request from what it says; both keep every request they were sent for a test to read.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use super::error::{AgentError, CallError};
use super::provider::{ChatRequest, Completion, DeltaSink, Message};

/// The model name team files use for the offline demo.
pub const OFFLINE_MODEL: &str = "fake/offline";

/// Answers a request from what it says, or `None` to fall back to "(the script ended)".
pub type Respond = Arc<dyn Fn(&SeenRequest) -> Option<Completion> + Send + Sync>;

/// The offline provider.
#[derive(Clone)]
pub struct Demo {
    script: Option<Arc<Script>>,
}

impl std::fmt::Debug for Demo {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(if self.script.is_some() {
            "Demo(scripted)"
        } else {
            "Demo(offline)"
        })
    }
}

#[derive(Default)]
struct Script {
    replies: Mutex<VecDeque<Completion>>,
    seen: Mutex<Vec<SeenRequest>>,
    respond: Option<Respond>,
    /// Every request waits here before it is answered — only the ones `hold_when` picks, when
    /// there is one, after streaming `hold_partial`.
    hold: Option<Arc<Hold>>,
    hold_when: Option<Arc<HoldWhen>>,
    hold_partial: String,
    /// Once the replies run out, every request streams the first and then fails, as `OpenRouter`
    /// reporting the second.
    fail: Option<(String, String)>,
}

/// Which requests [`Demo::responder_holding`] holds.
type HoldWhen = dyn Fn(&SeenRequest) -> bool + Send + Sync;

/// Where [`Demo::held`] keeps its requests until a test lets them through.
#[derive(Debug)]
pub struct Hold {
    waiting: AtomicUsize,
    release: tokio::sync::Semaphore,
}

impl Hold {
    /// How many requests are waiting right now.
    #[must_use]
    pub fn waiting(&self) -> usize {
        self.waiting.load(Ordering::SeqCst)
    }

    /// Let `requests` more requests through, now or when they come.
    pub fn release(&self, requests: usize) {
        self.release.add_permits(requests);
    }
}

/// One request waiting at a [`Hold`]: counted while it waits, including when its turn is stopped.
struct Waiting<'a>(&'a AtomicUsize);

impl<'a> Waiting<'a> {
    fn new(count: &'a AtomicUsize) -> Self {
        count.fetch_add(1, Ordering::SeqCst);
        Self(count)
    }
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// One request the scripted demo was sent.
#[derive(Debug, Clone, PartialEq)]
pub struct SeenRequest {
    pub agent: String,
    pub model: String,
    pub effort: Option<String>,
    pub messages: Vec<Message>,
    /// The names of the tools offered.
    pub tools: Vec<String>,
}

impl SeenRequest {
    /// The newest prompt the agent was given.
    #[must_use]
    pub fn prompt(&self) -> &str {
        last_user_message(&self.messages)
    }

    /// Whether the conversation's newest message is a tool's result, so the model is continuing a
    /// turn rather than starting one.
    #[must_use]
    pub fn after_tool(&self) -> bool {
        matches!(self.messages.last(), Some(Message::Tool { .. }))
    }
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
                ..Script::default()
            })),
        }
    }

    /// Answers each request with `respond`, which reads the request (its prompt, the agent asking,
    /// whether a tool just answered) the way a stand-in agent would.
    #[must_use]
    pub fn responder(
        respond: impl Fn(&SeenRequest) -> Option<Completion> + Send + Sync + 'static,
    ) -> Self {
        Self {
            script: Some(Arc::new(Script {
                respond: Some(Arc::new(respond)),
                ..Script::default()
            })),
        }
    }

    /// [`Demo::scripted`], with every request waiting at the returned [`Hold`] until the test lets
    /// it through: an agent that is still thinking, for as long as a test needs it to be.
    #[must_use]
    pub fn held(replies: Vec<Completion>) -> (Self, Arc<Hold>) {
        let hold = Arc::new(Hold {
            waiting: AtomicUsize::new(0),
            release: tokio::sync::Semaphore::new(0),
        });
        let demo = Self {
            script: Some(Arc::new(Script {
                replies: Mutex::new(replies.into()),
                hold: Some(Arc::clone(&hold)),
                ..Script::default()
            })),
        };
        (demo, hold)
    }

    /// [`Demo::responder`], with the requests `hold_when` picks streaming `partial` (when it is not
    /// empty) and then waiting at the returned [`Hold`] until the test lets them through or their
    /// turn is stopped: an agent part way through a turn.
    #[must_use]
    pub fn responder_holding(
        respond: impl Fn(&SeenRequest) -> Option<Completion> + Send + Sync + 'static,
        hold_when: impl Fn(&SeenRequest) -> bool + Send + Sync + 'static,
        partial: &str,
    ) -> (Self, Arc<Hold>) {
        let hold = Arc::new(Hold {
            waiting: AtomicUsize::new(0),
            release: tokio::sync::Semaphore::new(0),
        });
        let demo = Self {
            script: Some(Arc::new(Script {
                respond: Some(Arc::new(respond)),
                hold: Some(Arc::clone(&hold)),
                hold_when: Some(Arc::new(hold_when)),
                hold_partial: partial.to_owned(),
                ..Script::default()
            })),
        };
        (demo, hold)
    }

    /// Streams `partial` and then fails, as `OpenRouter` reporting `message`: a turn cut off part
    /// way through.
    #[must_use]
    pub fn dying(partial: &str, message: &str) -> Self {
        Self {
            script: Some(Arc::new(Script {
                fail: Some((partial.to_owned(), message.to_owned())),
                ..Script::default()
            })),
        }
    }

    /// [`Demo::scripted`], and once the replies run out every request fails, as `OpenRouter`
    /// reporting `message`.
    #[must_use]
    pub fn failing_after(replies: Vec<Completion>, message: &str) -> Self {
        Self {
            script: Some(Arc::new(Script {
                replies: Mutex::new(replies.into()),
                fail: Some((String::new(), message.to_owned())),
                ..Script::default()
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
                let seen = SeenRequest {
                    agent: request.agent_id.to_owned(),
                    model: request.model.to_owned(),
                    effort: request.effort.map(str::to_owned),
                    messages: request.messages.to_vec(),
                    tools: request.tools.iter().map(|tool| tool.name.clone()).collect(),
                };
                script
                    .seen
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(seen.clone());
                if let Some(hold) = &script.hold
                    && script.hold_when.as_ref().is_none_or(|when| when(&seen))
                {
                    if !script.hold_partial.is_empty() {
                        deltas.text(&script.hold_partial).await?;
                    }
                    let _waiting = Waiting::new(&hold.waiting);
                    hold.release
                        .acquire()
                        .await
                        .map_err(|_| CallError::Cancelled)?
                        .forget();
                }
                let scripted = script
                    .replies
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .pop_front();
                if scripted.is_none()
                    && let Some((partial, message)) = &script.fail
                {
                    if !partial.is_empty() {
                        deltas.text(partial).await?;
                    }
                    return Err(AgentError::Provider(message.clone()).into());
                }
                scripted
                    .or_else(|| script.respond.as_ref().and_then(|respond| respond(&seen)))
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
