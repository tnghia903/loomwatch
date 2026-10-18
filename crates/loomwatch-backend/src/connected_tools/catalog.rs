//! A short list of tools to start from. Each address was checked on 2026-10-18 with an anonymous
//! hello and, for a sign-in, its published metadata: the open ones answered, and the sign-in ones
//! publish where to sign in and let any app register itself, as `LoomWatch` must. Services that
//! sign in only apps they registered by hand (Asana, for one) aren't listed; any tool can still be
//! connected by pasting its address.
use serde::Serialize;

use super::Auth;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Entry {
    pub name: &'static str,
    pub url: &'static str,
    /// What it lets an agent do, in a few words.
    pub does: &'static str,
    pub auth: Auth,
    /// For a token: where the operator makes one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_help: Option<&'static str>,
}

pub(super) const CATALOG: &[Entry] = &[
    Entry {
        name: "Notion",
        url: "https://mcp.notion.com/mcp",
        does: "Search, read and write pages in your workspace",
        auth: Auth::SignIn,
        token_help: None,
    },
    Entry {
        name: "Linear",
        url: "https://mcp.linear.app/mcp",
        does: "Find, create and update issues and projects",
        auth: Auth::SignIn,
        token_help: None,
    },
    Entry {
        name: "GitHub",
        url: "https://api.githubcopilot.com/mcp/",
        does: "Read code, issues and pull requests",
        auth: Auth::Token,
        token_help: Some("https://github.com/settings/personal-access-tokens/new"),
    },
    Entry {
        name: "Canva",
        url: "https://mcp.canva.com/mcp",
        does: "Find and create designs",
        auth: Auth::SignIn,
        token_help: None,
    },
    Entry {
        name: "Stripe",
        url: "https://mcp.stripe.com",
        does: "Look up customers, payments and invoices",
        auth: Auth::SignIn,
        token_help: None,
    },
    Entry {
        name: "Sentry",
        url: "https://mcp.sentry.dev/mcp",
        does: "Look into errors and issues in your apps",
        auth: Auth::SignIn,
        token_help: None,
    },
    Entry {
        name: "DeepWiki",
        url: "https://mcp.deepwiki.com/mcp",
        does: "Ask questions about any public GitHub project",
        auth: Auth::None,
        token_help: None,
    },
    Entry {
        name: "Context7",
        url: "https://mcp.context7.com/mcp",
        does: "Up-to-date documentation for code libraries",
        auth: Auth::None,
        token_help: None,
    },
    Entry {
        name: "Microsoft Learn",
        url: "https://learn.microsoft.com/api/mcp",
        does: "Search Microsoft's official documentation",
        auth: Auth::None,
        token_help: None,
    },
    Entry {
        name: "Hugging Face",
        url: "https://huggingface.co/mcp",
        does: "Search models, datasets and papers",
        auth: Auth::None,
        token_help: None,
    },
];

/// The catalog entry at `url`, compared without a trailing slash.
pub(super) fn at(url: &str) -> Option<&'static Entry> {
    let url = url.trim_end_matches('/');
    CATALOG
        .iter()
        .find(|entry| entry.url.trim_end_matches('/').eq_ignore_ascii_case(url))
}
