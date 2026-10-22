//! What can stop a turn, said the way the operator reads it.
//!
//! The app's run record shows these words as they are, so each one says what happened and what to
//! do about it. None of them carries the API key: [`redact`] runs over anything a provider said
//! before it reaches one.

use std::fmt;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use crate::ai::Source;

/// Why a turn could not finish. Each says which source the call went to (ADR 0073), so the words
/// name the right place to fix it.
#[derive(Debug)]
pub enum AgentError {
    /// The source refused the key or sign-in: wrong, revoked, or not allowed this model.
    KeyRefused(Source),
    /// The account behind the key has no credit left for this request.
    OutOfCredits(Source),
    /// The source is limiting this key's requests, even after waiting and trying again.
    RateLimited(Source),
    /// No model by that name is available through this source.
    ModelUnavailable(Source, String),
    /// The conversation no longer fits the model's context, even after summarising it.
    ContextTooLong,
    /// The source answered with an error it explained.
    Provider(Source, String),
    /// The source could not be reached.
    Network(Source, String),
    /// The source stopped sending anything for too long.
    Stalled(Source),
    /// `LoomWatch` reached a usage limit on the person's `ChatGPT` plan: the plan's own, or the weekly
    /// share they allowed `LoomWatch`.
    PlanLimit,
    /// This `ChatGPT` account can't share its plan with apps: only Plus and Pro can.
    PlanNotEligible,
    /// The person signed in with `ChatGPT` but did not allow `LoomWatch` to use the plan.
    PlanUseOff,
    /// The sign-in with `ChatGPT` has ended: it was disconnected, or could not be renewed.
    SignInAgain,
    /// The daemon could not record what the agent did. The run cannot go on without a record.
    Record(anyhow::Error),
}

/// Where `ChatGPT` shows a plan's usage and each app's share of it.
pub const CHATGPT_USAGE_URL: &str = "https://chatgpt.com/settings/usage";
const OPENROUTER_CREDITS_URL: &str = "https://openrouter.ai/settings/credits";
const CLAUDE_BILLING_URL: &str = "https://platform.claude.com/settings/billing";

/// A stop the app can offer a way out of, besides the words: which source, what went wrong, and
/// where to fix it when that is outside `LoomWatch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub kind: ProblemKind,
    pub source: Source,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<&'static str>,
}

/// What went wrong with a source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProblemKind {
    /// Nothing is connected for this source on this computer.
    NotConnected,
    KeyRefused,
    OutOfCredits,
    RateLimited,
    PlanLimit,
    PlanNotEligible,
    PlanUseOff,
    SignInAgain,
}

impl Problem {
    #[must_use]
    pub const fn new(kind: ProblemKind, source: Source) -> Self {
        let url = match (kind, source) {
            (ProblemKind::PlanLimit, _) => Some(CHATGPT_USAGE_URL),
            (ProblemKind::OutOfCredits, Source::OpenRouter) => Some(OPENROUTER_CREDITS_URL),
            (ProblemKind::OutOfCredits, Source::Anthropic) => Some(CLAUDE_BILLING_URL),
            _ => None,
        };
        Self { kind, source, url }
    }
}

impl AgentError {
    /// The stop as the app offers a way out of it, for the ones it can.
    #[must_use]
    pub fn problem(&self) -> Option<Problem> {
        let (kind, source) = match self {
            Self::KeyRefused(source) => (ProblemKind::KeyRefused, *source),
            Self::OutOfCredits(source) => (ProblemKind::OutOfCredits, *source),
            Self::RateLimited(source) => (ProblemKind::RateLimited, *source),
            Self::PlanLimit => (ProblemKind::PlanLimit, Source::ChatGpt),
            Self::PlanNotEligible => (ProblemKind::PlanNotEligible, Source::ChatGpt),
            Self::PlanUseOff => (ProblemKind::PlanUseOff, Source::ChatGpt),
            Self::SignInAgain => (ProblemKind::SignInAgain, Source::ChatGpt),
            _ => return None,
        };
        Some(Problem::new(kind, source))
    }

    /// Whether the source could not be reached at all: nothing it decided, so the same request may
    /// go through a little later, as one sent the moment a computer wakes does once its network is
    /// back.
    #[must_use]
    pub const fn is_unreachable(&self) -> bool {
        matches!(self, Self::Network(..))
    }
}

/// The company a source's calls go to, as an error names it.
const fn company(source: Source) -> &'static str {
    match source {
        Source::OpenRouter => "OpenRouter",
        Source::ChatGpt => "ChatGPT",
        Source::Anthropic => "Anthropic",
    }
}

impl fmt::Display for AgentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::KeyRefused(Source::OpenRouter) => formatter.write_str(
                "OpenRouter refused the API key. Check the key on LoomWatch's Connections page.",
            ),
            Self::KeyRefused(Source::Anthropic) => formatter.write_str(
                "Anthropic refused the Claude API key. Check the key on LoomWatch's Connections \
                 page.",
            ),
            Self::KeyRefused(Source::ChatGpt) | Self::SignInAgain => formatter.write_str(
                "LoomWatch's sign-in with ChatGPT has ended. Sign in with ChatGPT again on \
                 LoomWatch's Connections page.",
            ),
            Self::OutOfCredits(Source::OpenRouter) => formatter.write_str(
                "Your OpenRouter account is out of credits. Add credits at openrouter.ai, then try \
                 again.",
            ),
            Self::OutOfCredits(Source::Anthropic) => formatter.write_str(
                "Your Claude API credit is used up. It comes back with your plan's next bill, or \
                 add credits in the Claude Console.",
            ),
            Self::OutOfCredits(Source::ChatGpt) | Self::PlanLimit => formatter.write_str(
                "LoomWatch has reached a usage limit on your ChatGPT plan: the plan's own limit, \
                 or the share you allowed LoomWatch. See it under Manage usage in ChatGPT's \
                 settings.",
            ),
            Self::RateLimited(source) => write!(
                formatter,
                "{} is limiting how fast LoomWatch can make requests. Wait a minute, then try \
                 again.",
                company(*source)
            ),
            Self::ModelUnavailable(Source::ChatGpt, model) => write!(
                formatter,
                "Your ChatGPT plan doesn't offer a model called {model}. Choose another model for \
                 this agent."
            ),
            Self::ModelUnavailable(source, model) => write!(
                formatter,
                "{} has no model called {model}, or this key can't use it. Choose another model \
                 for this agent.",
                company(*source)
            ),
            Self::ContextTooLong => formatter.write_str(
                "This conversation no longer fits in the model's memory, even after summarising \
                 it. Start a new run, or choose a model with a larger context.",
            ),
            Self::Provider(source, message) => {
                write!(
                    formatter,
                    "{} reported an error: {message}",
                    company(*source)
                )
            }
            Self::Network(source, message) => {
                write!(
                    formatter,
                    "LoomWatch couldn't reach {}: {message}",
                    company(*source)
                )
            }
            Self::Stalled(source) => write!(
                formatter,
                "{} stopped answering partway through. Try the run again.",
                company(*source)
            ),
            Self::PlanNotEligible => formatter.write_str(
                "This ChatGPT account can't share its plan with apps: only ChatGPT Plus and Pro \
                 plans can. Choose a model from another source for this agent.",
            ),
            Self::PlanUseOff => formatter.write_str(
                "You signed in with ChatGPT but didn't allow LoomWatch to use your plan. Turn it \
                 on from LoomWatch's Connections page.",
            ),
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

/// Anything shaped like a signed token (a JWT, as a sign-in's access and ID tokens are).
static TOKEN_SHAPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]*")
        .expect("the token pattern compiles")
});

/// Secrets in use whose shape nothing above knows, such as a sign-in's refresh token.
static LIVE_SECRETS: LazyLock<std::sync::RwLock<Vec<String>>> = LazyLock::new(Default::default);

/// Keeps `secret` out of every error [`redact`] sees from now on.
pub(crate) fn hide_secret(secret: &str) {
    if secret.len() < 8 {
        return;
    }
    let mut secrets = LIVE_SECRETS
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !secrets.iter().any(|known| known == secret) {
        secrets.push(secret.to_owned());
    }
}

/// `text` with anything that looks like an API key cut down to its prefix, signed tokens and the
/// secrets in use taken out.
///
/// Providers don't echo keys back, but an error from a proxy or a misconfigured endpoint might, and
/// the run record keeps errors word for word.
pub(crate) fn redact(text: &str) -> String {
    let mut text = KEY_SHAPE.replace_all(text, "$1…").into_owned();
    text = TOKEN_SHAPE.replace_all(&text, "eyJ…").into_owned();
    for secret in LIVE_SECRETS
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .iter()
    {
        if text.contains(secret.as_str()) {
            text = text.replace(secret.as_str(), "…");
        }
    }
    text
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
    fn a_signed_token_or_a_secret_in_use_is_taken_out() {
        let said = "bad bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLXZhbHVl here";
        assert_eq!(redact(said), "bad bearer eyJ… here");
        hide_secret("rt_refresh-token-0123456789");
        assert_eq!(
            redact("refresh rt_refresh-token-0123456789 refused"),
            "refresh … refused"
        );
    }

    /// The app offers a button for these stops by their words (`ui/src/lib/runs/errors.ts`,
    /// `problemAction`), so the words it looks for stay.
    #[test]
    fn the_stops_the_app_offers_a_way_out_of_keep_their_words() {
        for (error, words) in [
            (AgentError::PlanLimit, "usage limit on your ChatGPT plan"),
            (
                AgentError::OutOfCredits(Source::Anthropic),
                "Claude API credit is used up",
            ),
            (
                AgentError::OutOfCredits(Source::OpenRouter),
                "OpenRouter account is out of credits",
            ),
            (AgentError::SignInAgain, "Connections page"),
            (AgentError::PlanUseOff, "Connections page"),
            (
                AgentError::KeyRefused(Source::Anthropic),
                "Connections page",
            ),
        ] {
            assert!(error.to_string().contains(words), "{error}");
        }
    }

    #[test]
    fn plain_words_are_left_alone() {
        assert_eq!(redact("model not found"), "model not found");
    }
}
