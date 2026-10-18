//! A short list of tools to start from, grouped by what they're for, each with something to try.
//!
//! Every address was checked on 2026-10-18:
//! - The open ones answered an anonymous hello and a real call (a flight search, a region search,
//!   a domain search, a page read).
//! - The sign-in ones publish where to sign in and let any app register itself with a return
//!   address on this computer, as `LoomWatch` must.
//!
//! Left out on purpose:
//! - Gamma refuses a return address on this computer.
//! - Dropbox, Asana and Box sign in only partners they approved by hand.
//! - Zapier needs its actions set up on its own site first.
//! - Jina's web search needs a key, so Jina is listed for reading pages only.
//!
//! Any other tool can still be connected by pasting its address.
use serde::Serialize;

use super::Auth;

/// What a tool is for, for the headings the list is shown under.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Group {
    Work,
    Create,
    Travel,
    LookUp,
    Build,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Entry {
    pub name: &'static str,
    pub url: &'static str,
    /// What it lets an agent do, in a few words.
    pub does: &'static str,
    pub auth: Auth,
    pub group: Group,
    /// Something to ask an agent given it, so a newcomer sees what it's for.
    pub example: &'static str,
    /// For a token: where the operator makes one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_help: Option<&'static str>,
}

pub(super) const CATALOG: &[Entry] = &[
    // Work: the places your work already lives.
    Entry {
        name: "Notion",
        url: "https://mcp.notion.com/mcp",
        does: "Search, read and write pages in your workspace",
        auth: Auth::SignIn,
        group: Group::Work,
        example: "Find my meeting notes from last week and list the decisions.",
        token_help: None,
    },
    Entry {
        name: "Todoist",
        url: "https://ai.todoist.net/mcp",
        does: "Add, find and finish your to-dos",
        auth: Auth::SignIn,
        group: Group::Work,
        example: "Add “Call the printer” to my Todoist for Friday morning.",
        token_help: None,
    },
    Entry {
        name: "Linear",
        url: "https://mcp.linear.app/mcp",
        does: "Find, create and update issues and projects",
        auth: Auth::SignIn,
        group: Group::Work,
        example: "List my open Linear issues and say which one to do first.",
        token_help: None,
    },
    Entry {
        name: "Airtable",
        url: "https://mcp.airtable.com/mcp",
        does: "Read and update records in your bases",
        auth: Auth::SignIn,
        group: Group::Work,
        example: "Which rows in my Airtable content plan are due this week?",
        token_help: None,
    },
    Entry {
        name: "Cal.com",
        url: "https://mcp.cal.com/mcp",
        does: "See your bookings and find free times",
        auth: Auth::SignIn,
        group: Group::Work,
        example: "What meetings do I have booked tomorrow?",
        token_help: None,
    },
    // Create: make something to look at.
    Entry {
        name: "Miro",
        url: "https://mcp.miro.com/",
        does: "Read your whiteboards and add sticky notes",
        auth: Auth::SignIn,
        group: Group::Create,
        example: "Put these five ideas on my Miro board as sticky notes.",
        token_help: None,
    },
    Entry {
        name: "Canva",
        url: "https://mcp.canva.com/mcp",
        does: "Find and create designs",
        auth: Auth::SignIn,
        group: Group::Create,
        example: "Find my Canva designs about the summer sale.",
        token_help: None,
    },
    Entry {
        name: "Mermaid Chart",
        url: "https://mcp.mermaidchart.com/mcp",
        does: "Draw flowcharts and diagrams",
        auth: Auth::SignIn,
        group: Group::Create,
        example: "Draw a flowchart of how a new customer signs up.",
        token_help: None,
    },
    Entry {
        name: "Replicate",
        url: "https://mcp.replicate.com/mcp",
        does: "Make pictures with AI models, on your Replicate credits",
        auth: Auth::SignIn,
        group: Group::Create,
        example: "Make a watercolor picture of a fox reading a book.",
        token_help: None,
    },
    // Travel and fun: no sign-in at all.
    Entry {
        name: "Kiwi.com",
        url: "https://mcp.kiwi.com",
        does: "Search flights by city and date",
        auth: Auth::None,
        group: Group::Travel,
        example: "Find the cheapest flight from Hanoi to Tokyo in mid-November.",
        token_help: None,
    },
    Entry {
        name: "Peek",
        url: "https://mcp.peek.com",
        does: "Find tours and things to do in a city",
        auth: Auth::None,
        group: Group::Travel,
        example: "What fun things can two people do in Da Nang this weekend?",
        token_help: None,
    },
    Entry {
        name: "Instant Domain Search",
        url: "https://mcp.instantdomainsearch.com/mcp",
        does: "Check which website names are free",
        auth: Auth::None,
        group: Group::Travel,
        example: "Suggest five free .com names for a cozy bakery.",
        token_help: None,
    },
    // Look things up: read and research, no sign-in.
    Entry {
        name: "Jina Reader",
        url: "https://mcp.jina.ai/v1",
        does: "Read any web page or PDF, and take screenshots",
        auth: Auth::None,
        group: Group::LookUp,
        example: "Read https://example.com and sum it up in three bullets.",
        token_help: None,
    },
    Entry {
        name: "DeepWiki",
        url: "https://mcp.deepwiki.com/mcp",
        does: "Ask questions about any public GitHub project",
        auth: Auth::None,
        group: Group::LookUp,
        example: "How does facebook/react schedule updates? Answer in plain words.",
        token_help: None,
    },
    Entry {
        name: "Hugging Face",
        url: "https://huggingface.co/mcp",
        does: "Search AI models, datasets and papers",
        auth: Auth::None,
        group: Group::LookUp,
        example: "Find three popular open models for translating Vietnamese.",
        token_help: None,
    },
    Entry {
        name: "Microsoft Learn",
        url: "https://learn.microsoft.com/api/mcp",
        does: "Search Microsoft's official documentation",
        auth: Auth::None,
        group: Group::LookUp,
        example: "How do I share an Excel workbook so others can edit it?",
        token_help: None,
    },
    Entry {
        name: "Context7",
        url: "https://mcp.context7.com/mcp",
        does: "Up-to-date documentation for code libraries",
        auth: Auth::None,
        group: Group::LookUp,
        example: "Show the current way to set up routing in Next.js.",
        token_help: None,
    },
    // Build and sell: for people who make software or run a shop.
    Entry {
        name: "GitHub",
        url: "https://api.githubcopilot.com/mcp/",
        does: "Read code, issues and pull requests",
        auth: Auth::Token,
        group: Group::Build,
        example: "Summarise the open issues in my repository.",
        token_help: Some("https://github.com/settings/personal-access-tokens/new"),
    },
    Entry {
        name: "Stripe",
        url: "https://mcp.stripe.com",
        does: "Look up customers, payments and invoices",
        auth: Auth::SignIn,
        group: Group::Build,
        example: "How many payments failed this week, and why?",
        token_help: None,
    },
    Entry {
        name: "Sentry",
        url: "https://mcp.sentry.dev/mcp",
        does: "Look into errors and issues in your apps",
        auth: Auth::SignIn,
        group: Group::Build,
        example: "What's the most common error in my app today?",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_is_https_named_once_and_says_what_to_try() {
        for (index, entry) in CATALOG.iter().enumerate() {
            assert!(entry.url.starts_with("https://"), "{}", entry.name);
            assert!(
                !entry.does.is_empty() && !entry.example.is_empty(),
                "{}",
                entry.name
            );
            assert_eq!(
                entry.token_help.is_some(),
                entry.auth == Auth::Token,
                "{}",
                entry.name
            );
            for other in &CATALOG[index + 1..] {
                assert!(
                    !entry.name.eq_ignore_ascii_case(other.name),
                    "{} twice",
                    entry.name
                );
                assert!(at(other.url).is_some_and(|found| found.name == other.name));
            }
        }
        // Each group's entries sit together, so the list reads as sections.
        let groups: Vec<Group> = CATALOG.iter().map(|entry| entry.group).collect();
        let mut seen = Vec::new();
        for (index, group) in groups.iter().enumerate() {
            if index == 0 || groups[index - 1] != *group {
                assert!(!seen.contains(group), "{group:?} is split");
                seen.push(*group);
            }
        }
        assert_eq!(
            at("https://mcp.miro.com").map(|entry| entry.name),
            Some("Miro")
        );
    }
}
