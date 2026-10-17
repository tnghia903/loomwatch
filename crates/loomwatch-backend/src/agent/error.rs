//! What can stop a turn, said the way the operator reads it.
//!
//! The app's run record shows these words as they are, so each one says what happened and what to
//! do about it. None of them carries the API key: [`redact`] runs over anything a provider said
//! before it reaches one.

use std::fmt;
use std::sync::LazyLock;

use regex::Regex;

/// Why a turn could not finish.
#[derive(Debug)]
pub enum AgentError {
    /// The provider refused the key: wrong, revoked, or not allowed this model.
    KeyRefused,
    /// The account behind the key has no credit left for this request.
    OutOfCredits,
    /// The provider is limiting this key's requests, even after waiting and trying again.
    RateLimited,
    /// No model by that name is available to this key.
    ModelUnavailable(String),
    /// The conversation no longer fits the model's context, even after summarising it.
    ContextTooLong,
    /// The provider answered with an error it explained.
    Provider(String),
    /// The provider could not be reached.
    Network(String),
    /// The provider stopped sending anything for too long.
    Stalled,
    /// The daemon could not record what the agent did. The run cannot go on without a record.
    Record(anyhow::Error),
}

impl fmt::Display for AgentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::KeyRefused => formatter.write_str(
                "OpenRouter refused the API key. Check the key on LoomWatch's Connections page.",
            ),
            Self::OutOfCredits => formatter.write_str(
                "Your OpenRouter account is out of credits. Add credits at openrouter.ai, then try \
                 again.",
            ),
            Self::RateLimited => formatter.write_str(
                "OpenRouter is limiting how fast this key can make requests. Wait a minute, then \
                 try again.",
            ),
            Self::ModelUnavailable(model) => write!(
                formatter,
                "OpenRouter has no model called {model}, or this key can't use it. Choose another \
                 model for this agent."
            ),
            Self::ContextTooLong => formatter.write_str(
                "This conversation no longer fits in the model's memory, even after summarising \
                 it. Start a new run, or choose a model with a larger context.",
            ),
            Self::Provider(message) => write!(formatter, "OpenRouter reported an error: {message}"),
            Self::Network(message) => {
                write!(formatter, "LoomWatch couldn't reach OpenRouter: {message}")
            }
            Self::Stalled => formatter
                .write_str("OpenRouter stopped answering partway through. Try the run again."),
            Self::Record(error) => write!(formatter, "LoomWatch couldn't record the run: {error}"),
        }
    }
}

impl std::error::Error for AgentError {}

/// How a provider call ended when it did not complete.
#[derive(Debug)]
pub(crate) enum CallError {
    /// The operator or the daemon cancelled the turn.
    Cancelled,
    Failed(AgentError),
}

impl From<AgentError> for CallError {
    fn from(error: AgentError) -> Self {
        Self::Failed(error)
    }
}

/// Anything shaped like a provider key, replaced by its first few characters.
static KEY_SHAPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(sk-[A-Za-z0-9]{1,4})[A-Za-z0-9_\-]{8,}").expect("the key pattern compiles")
});

/// `text` with anything that looks like an API key cut down to its prefix.
///
/// Providers don't echo keys back, but an error from a proxy or a misconfigured endpoint might, and
/// the run record keeps errors word for word.
pub(crate) fn redact(text: &str) -> String {
    KEY_SHAPE.replace_all(text, "$1…").into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_in_an_error_is_cut_to_its_prefix() {
        let said = "bad key sk-or-v1-0123456789abcdef0123456789abcdef in header";
        assert_eq!(redact(said), "bad key sk-or… in header");
    }

    #[test]
    fn plain_words_are_left_alone() {
        assert_eq!(redact("model not found"), "model not found");
    }
}
