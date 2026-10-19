//! `LoomWatch`'s own agent: the loop that turns a prompt into model calls and tool calls.
//!
//! This is the built-in harness that replaces the third-party apps `LoomWatch` used to start
//! over ACP. It runs inside the daemon, one [`Session`] per agent. A session talks to one model
//! [`Provider`]:
//! - [`OpenRouter`], with the API key the operator entered in `LoomWatch`;
//! - the offline [`Demo`], which powers "Offline demo (no AI)" and the tests.
//!
//! Everything a session does is reported to an [`EventSink`] in the update shapes the run archive
//! has always stored (`agent_message_chunk`, `tool_call`, `plan`, `usage_update`, …), so the
//! archive and the app read a built-in agent's work exactly as they read an app's.
//!
//! Four things belong to the daemon, not to the agent, and come in as traits:
//! - [`EventSink`]: where events go (the run archive).
//! - [`Permissions`]: whether a read, an edit, a command or a fetch may happen. The daemon's
//!   permission policy, Auto mode and the operator's cards answer.
//! - [`HostTools`]: tools the daemon serves itself, such as the Team Bus and Ask's tools.
//! - [`Spend`]: whether the next model call may go ahead, and what the last one cost (the run's
//!   spool, ADR 0068).
//!
//! The API key lives in an [`ApiKey`]. It is sent to the provider and nowhere else: not into the
//! events, not into errors, and not into the environment of a command an agent runs.

mod demo;
mod error;
mod events;
mod openrouter;
mod permission;
mod prompt;
mod provider;
mod sandbox;
mod session;
mod skills;
mod spend;
mod sse;
mod store;
mod tools;

#[cfg(test)]
mod tests;

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub use demo::{Demo, Hold, OFFLINE_MODEL, Respond, SeenRequest};
pub use error::{AgentError, CHATGPT_USAGE_URL, Problem, ProblemKind};
pub use events::{EventSink, ToolKind, ToolStatus};
pub use openrouter::{BASE_URL_ENV, DEFAULT_BASE_URL, OpenRouter, base_url, is_loopback_http};
pub(crate) use openrouter::{REFERER as OPENROUTER_REFERER, TITLE as OPENROUTER_TITLE};
pub use permission::{AllowAll, Decision, DenyAll, PermissionRequest, Permissions};
pub use provider::{
    Completion, Finish, Message, Native, Provider, ServerTools, ToolCall, ToolSpec, Usage,
    WebLimits,
};
pub use session::{
    CancelHandle, HostAsk, HostTools, NoHostTools, Session, SessionConfig, Snapshot, StopReason,
    ToolSet, TurnEnd, WORK,
};
pub use skills::{SkillEntry, SkillIndex, index_skills};
pub use spend::{Go, Spend, Unmetered};
pub use store::SessionStore;

/// A boxed future, for the traits the daemon implements ([`EventSink`], [`Permissions`],
/// [`HostTools`]): they are used as trait objects, which `async fn` in a trait cannot be.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The operator's provider key. Its `Debug` never shows it, and it has no `Display`, so it cannot
/// end up in an event, a log line or an error message by accident.
#[derive(Clone)]
pub struct ApiKey(Arc<str>);

impl ApiKey {
    /// The key as entered, trimmed. `None` for an empty one.
    #[must_use]
    pub fn new(key: &str) -> Option<Self> {
        let key = key.trim();
        (!key.is_empty()).then(|| Self(Arc::from(key)))
    }

    /// The key itself, for the one header that carries it.
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ApiKey(…)")
    }
}
