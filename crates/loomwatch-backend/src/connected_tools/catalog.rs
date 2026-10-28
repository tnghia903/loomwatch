//! A list of tools to start from, sorted by topic as the Skills page sorts skills, each with
//! something to try.
//!
//! Every address was checked on 2026-10-29:
//! - The open ones answered an anonymous hello and listed their calls.
//! - For the sign-in ones, `LoomWatch` registered itself as it does at each sign-in, with a return
//!   address on this computer, and the site then showed its sign-in or consent page.
//!
//! Left out on purpose:
//! - Slack, `HubSpot`, Asana and Box sign in only apps they registered by hand, and take no token.
//!   So do Dropbox and Figma, though they publish where to register.
//! - Gamma refuses a return address on this computer.
//! - Gmail, Google Calendar, Google Drive and Outlook have no tool server any app can sign in to.
//! - Zapier needs its actions set up on its own site first.
//! - Google Maps answers only with a Google key in its own header, and `LoomWatch` sends a token
//!   as a bearer token.
//! - Excalidraw draws in the AI app's own window, which `LoomWatch` doesn't show.
//! - Jina's web search needs a key, so Jina is listed for reading pages only.
//!
//! The app says why when someone searches for one of these (`cantConnectYet` in the app's
//! `lib/tools/client.ts`). Any other tool can still be connected by pasting its address.
use serde::Serialize;

use super::Auth;

/// What a tool is for: the topics the list starts from, in the order it is shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Topic {
    Tasks,
    Notes,
    Meetings,
    Design,
    Research,
    Travel,
    Payments,
    Customers,
    Websites,
    Code,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Entry {
    pub name: &'static str,
    /// The service's home page, where its icon is found (`icons.rs`).
    pub site: &'static str,
    pub url: &'static str,
    /// What it lets an agent do, in a few words.
    pub does: &'static str,
    pub auth: Auth,
    pub topic: Topic,
    /// Something to ask an agent given it, so a newcomer sees what it's for.
    pub example: &'static str,
    /// For a token: where the operator makes one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_help: Option<&'static str>,
}

pub(super) const CATALOG: &[Entry] = &[
    // Tasks: the lists and boards work is planned on.
    Entry {
        name: "Todoist",
        site: "https://todoist.com",
        url: "https://ai.todoist.net/mcp",
        does: "Add, find and finish your to-dos",
        auth: Auth::SignIn,
        topic: Topic::Tasks,
        example: "Add “Call the printer” to my Todoist for Friday morning.",
        token_help: None,
    },
    Entry {
        name: "Linear",
        site: "https://linear.app",
        url: "https://mcp.linear.app/mcp",
        does: "Find, create and update issues and projects",
        auth: Auth::SignIn,
        topic: Topic::Tasks,
        example: "List my open Linear issues and say which one to do first.",
        token_help: None,
    },
    Entry {
        name: "Jira and Confluence",
        site: "https://www.atlassian.com",
        url: "https://mcp.atlassian.com/v1/mcp",
        does: "Find and update Jira issues and Confluence pages",
        auth: Auth::SignIn,
        topic: Topic::Tasks,
        example: "Which Jira issues assigned to me are due this week?",
        token_help: None,
    },
    Entry {
        name: "monday.com",
        site: "https://monday.com",
        url: "https://mcp.monday.com/mcp",
        does: "Read and update your boards and items",
        auth: Auth::SignIn,
        topic: Topic::Tasks,
        example: "What’s overdue on my monday.com project board?",
        token_help: None,
    },
    Entry {
        name: "ClickUp",
        site: "https://clickup.com",
        url: "https://mcp.clickup.com/mcp",
        does: "Find, create and update tasks and docs",
        auth: Auth::SignIn,
        topic: Topic::Tasks,
        example: "Make a ClickUp task to send the invoice by Thursday.",
        token_help: None,
    },
    Entry {
        name: "Airtable",
        site: "https://airtable.com",
        url: "https://mcp.airtable.com/mcp",
        does: "Read and update the rows in your Airtable tables",
        auth: Auth::SignIn,
        topic: Topic::Tasks,
        example: "Which rows in my Airtable content plan are due this week?",
        token_help: None,
    },
    // Notes and files: the places your work already lives.
    Entry {
        name: "Notion",
        site: "https://www.notion.so",
        // Its sign-in also sends teams' answers to Notion and reads pages for agents (ADR 0070).
        url: crate::notion::MCP_URL,
        does: "Search, read and write pages, and keep your teams’ answers",
        auth: Auth::SignIn,
        topic: Topic::Notes,
        example: "Find my meeting notes from last week and list the decisions.",
        token_help: None,
    },
    // Meetings: bookings, and what was said in them.
    Entry {
        name: "Cal.com",
        site: "https://cal.com",
        url: "https://mcp.cal.com/mcp",
        does: "See your calendar bookings and find free times",
        auth: Auth::SignIn,
        topic: Topic::Meetings,
        example: "What meetings do I have booked tomorrow?",
        token_help: None,
    },
    Entry {
        name: "Granola",
        site: "https://www.granola.ai",
        url: "https://mcp.granola.ai/mcp",
        does: "Search your meeting notes",
        auth: Auth::SignIn,
        topic: Topic::Meetings,
        example: "What did we agree in Tuesday’s call with the printer?",
        token_help: None,
    },
    Entry {
        name: "Fireflies",
        site: "https://fireflies.ai",
        url: "https://api.fireflies.ai/mcp",
        does: "Search your meeting recordings and their notes",
        auth: Auth::SignIn,
        topic: Topic::Meetings,
        example: "Sum up my last sales call in five bullets.",
        token_help: None,
    },
    // Design: make something to look at.
    Entry {
        name: "Canva",
        site: "https://www.canva.com",
        url: "https://mcp.canva.com/mcp",
        does: "Find and create designs",
        auth: Auth::SignIn,
        topic: Topic::Design,
        example: "Find my Canva designs about the summer sale.",
        token_help: None,
    },
    Entry {
        name: "Miro",
        site: "https://miro.com",
        url: "https://mcp.miro.com/",
        does: "Read your whiteboards and add sticky notes",
        auth: Auth::SignIn,
        topic: Topic::Design,
        example: "Put these five ideas on my Miro board as sticky notes.",
        token_help: None,
    },
    Entry {
        name: "Lucid",
        site: "https://lucid.co",
        url: "https://mcp.lucid.app/mcp",
        does: "Find and make diagrams in Lucidchart",
        auth: Auth::SignIn,
        topic: Topic::Design,
        example: "Find my Lucidchart diagram of the office layout.",
        token_help: None,
    },
    Entry {
        name: "Mermaid Chart",
        site: "https://www.mermaidchart.com",
        url: "https://mcp.mermaidchart.com/mcp",
        does: "Draw flowcharts and diagrams",
        auth: Auth::SignIn,
        topic: Topic::Design,
        example: "Draw a flowchart of how a new customer signs up.",
        token_help: None,
    },
    Entry {
        name: "Replicate",
        site: "https://replicate.com",
        url: "https://mcp.replicate.com/mcp",
        does: "Make pictures with AI models, on your Replicate credits",
        auth: Auth::SignIn,
        topic: Topic::Design,
        example: "Make a watercolor picture of a fox reading a book.",
        token_help: None,
    },
    // Research: read and look things up.
    Entry {
        name: "Exa",
        site: "https://exa.ai",
        url: "https://mcp.exa.ai/mcp",
        does: "Search the web and read what it finds",
        auth: Auth::None,
        topic: Topic::Research,
        example: "Find three recent reviews of the Kindle Scribe and sum them up.",
        token_help: None,
    },
    Entry {
        name: "Jina Reader",
        site: "https://jina.ai",
        url: "https://mcp.jina.ai/v1",
        does: "Read any web page or PDF, and take screenshots",
        auth: Auth::None,
        topic: Topic::Research,
        example: "Read https://example.com and sum it up in three bullets.",
        token_help: None,
    },
    Entry {
        name: "Apify",
        site: "https://apify.com",
        url: "https://mcp.apify.com",
        does: "Collect facts from websites, such as prices or reviews, on your Apify credits",
        auth: Auth::SignIn,
        topic: Topic::Research,
        example: "Collect the prices of the ten best-selling kettles on Amazon.",
        token_help: None,
    },
    Entry {
        name: "Hugging Face",
        site: "https://huggingface.co",
        url: "https://huggingface.co/mcp",
        does: "Search AI models, datasets and papers",
        auth: Auth::None,
        topic: Topic::Research,
        example: "Find three popular open models for translating Vietnamese.",
        token_help: None,
    },
    Entry {
        name: "Microsoft Learn",
        site: "https://learn.microsoft.com",
        url: "https://learn.microsoft.com/api/mcp",
        does: "Search Microsoft’s official documentation",
        auth: Auth::None,
        topic: Topic::Research,
        example: "How do I share an Excel workbook so others can edit it?",
        token_help: None,
    },
    // Travel: no sign-in at all.
    Entry {
        name: "Kiwi.com",
        site: "https://www.kiwi.com",
        url: "https://mcp.kiwi.com",
        does: "Search flights by city and date",
        auth: Auth::None,
        topic: Topic::Travel,
        example: "Find the cheapest flight from Hanoi to Tokyo in mid-November.",
        token_help: None,
    },
    Entry {
        name: "Peek",
        site: "https://www.peek.com",
        url: "https://mcp.peek.com",
        does: "Find tours and things to do in a city",
        auth: Auth::None,
        topic: Topic::Travel,
        example: "What fun things can two people do in Da Nang this weekend?",
        token_help: None,
    },
    // Payments: for people who run a shop.
    Entry {
        name: "Stripe",
        site: "https://stripe.com",
        url: "https://mcp.stripe.com",
        does: "Look up and make payments, invoices and refunds",
        auth: Auth::SignIn,
        topic: Topic::Payments,
        example: "How many payments failed this week, and why?",
        token_help: None,
    },
    Entry {
        name: "Square",
        site: "https://squareup.com",
        url: "https://mcp.squareup.com/mcp",
        does: "See and change your sales, items and customers",
        auth: Auth::SignIn,
        topic: Topic::Payments,
        example: "What were my five best-selling items last month?",
        token_help: None,
    },
    Entry {
        name: "PayPal",
        site: "https://www.paypal.com",
        url: "https://mcp.paypal.com/mcp",
        does: "Look up and make invoices and refunds",
        auth: Auth::SignIn,
        topic: Topic::Payments,
        example: "Which of my PayPal invoices are still unpaid?",
        token_help: None,
    },
    // Customers: the people you sell to and talk with.
    Entry {
        name: "Intercom",
        site: "https://www.intercom.com",
        url: "https://mcp.intercom.com/mcp",
        does: "Read customer conversations and help articles",
        auth: Auth::SignIn,
        topic: Topic::Customers,
        example: "What did customers ask about most this week?",
        token_help: None,
    },
    Entry {
        name: "Attio",
        site: "https://attio.com",
        url: "https://mcp.attio.com/mcp",
        does: "Find and update the people and companies you work with",
        auth: Auth::SignIn,
        topic: Topic::Customers,
        example: "Which companies in Attio haven’t heard from us in a month?",
        token_help: None,
    },
    Entry {
        name: "Close.com",
        site: "https://www.close.com",
        url: "https://mcp.close.com/mcp",
        does: "Find leads, and note calls and emails",
        auth: Auth::SignIn,
        topic: Topic::Customers,
        example: "List my Close leads I should follow up with today.",
        token_help: None,
    },
    Entry {
        name: "Klaviyo",
        site: "https://www.klaviyo.com",
        url: "https://mcp.klaviyo.com/mcp",
        does: "See your email campaigns and how they did",
        auth: Auth::SignIn,
        topic: Topic::Customers,
        example: "Which of last month’s Klaviyo emails was opened most?",
        token_help: None,
    },
    // Websites: make one, put it online, or find it a name.
    Entry {
        name: "Webflow",
        site: "https://webflow.com",
        url: "https://mcp.webflow.com/mcp",
        does: "Change your Webflow site’s pages and content",
        auth: Auth::SignIn,
        topic: Topic::Websites,
        example: "Add a blog post called “Our new opening hours” to my Webflow site.",
        token_help: None,
    },
    Entry {
        name: "Wix",
        site: "https://www.wix.com",
        url: "https://mcp.wix.com/mcp",
        does: "Look after your Wix site, shop and bookings",
        auth: Auth::SignIn,
        topic: Topic::Websites,
        example: "How many bookings did my Wix site get this week?",
        token_help: None,
    },
    Entry {
        name: "Netlify",
        site: "https://www.netlify.com",
        url: "https://netlify-mcp.netlify.app/mcp",
        does: "Put sites online and look after them",
        auth: Auth::SignIn,
        topic: Topic::Websites,
        example: "Is my Netlify site’s latest release live?",
        token_help: None,
    },
    Entry {
        name: "Vercel",
        site: "https://vercel.com",
        url: "https://mcp.vercel.com",
        does: "See your sites, their releases and their logs",
        auth: Auth::SignIn,
        topic: Topic::Websites,
        example: "Why did my last Vercel release fail?",
        token_help: None,
    },
    Entry {
        name: "Instant Domain Search",
        site: "https://instantdomainsearch.com",
        url: "https://mcp.instantdomainsearch.com/mcp",
        does: "Check which website names nobody has taken yet",
        auth: Auth::None,
        topic: Topic::Websites,
        example: "Suggest five .com names for a cozy bakery that nobody has taken yet.",
        token_help: None,
    },
    // Apps and code: for people who make software.
    Entry {
        name: "GitHub",
        site: "https://github.com",
        url: "https://api.githubcopilot.com/mcp/",
        does: "Read code, issues and pull requests",
        auth: Auth::Token,
        topic: Topic::Code,
        example: "Sum up the open issues in my GitHub project.",
        token_help: Some("https://github.com/settings/personal-access-tokens/new"),
    },
    Entry {
        name: "GitLab",
        site: "https://gitlab.com",
        url: "https://gitlab.com/api/v4/mcp",
        does: "Read code, issues and merge requests",
        auth: Auth::SignIn,
        topic: Topic::Code,
        example: "Which merge requests in my GitLab project are waiting for review?",
        token_help: None,
    },
    Entry {
        name: "Sentry",
        site: "https://sentry.io",
        url: "https://mcp.sentry.dev/mcp",
        does: "Look into errors and issues in your apps",
        auth: Auth::SignIn,
        topic: Topic::Code,
        example: "What’s the most common error in my app today?",
        token_help: None,
    },
    Entry {
        name: "Supabase",
        site: "https://supabase.com",
        url: "https://mcp.supabase.com/mcp",
        does: "Look at and change your app’s database",
        auth: Auth::SignIn,
        topic: Topic::Code,
        example: "How many people signed up to my app this week?",
        token_help: None,
    },
    Entry {
        name: "Neon",
        site: "https://neon.com",
        url: "https://mcp.neon.tech/mcp",
        does: "Look at and change your Neon databases",
        auth: Auth::SignIn,
        topic: Topic::Code,
        example: "List the tables in my Neon database and what each holds.",
        token_help: None,
    },
    Entry {
        name: "Cloudflare",
        site: "https://www.cloudflare.com",
        url: "https://bindings.mcp.cloudflare.com/mcp",
        does: "Look after the apps, storage and databases you run on Cloudflare",
        auth: Auth::SignIn,
        topic: Topic::Code,
        example: "List my Cloudflare apps and when each was last changed.",
        token_help: None,
    },
    Entry {
        name: "PostHog",
        site: "https://posthog.com",
        url: "https://mcp.posthog.com/mcp",
        does: "See how people use your app",
        auth: Auth::SignIn,
        topic: Topic::Code,
        example: "Which page do most people leave my app from?",
        token_help: None,
    },
    Entry {
        name: "Context7",
        site: "https://context7.com",
        url: "https://mcp.context7.com/mcp",
        does: "Look up current guides for code libraries",
        auth: Auth::None,
        topic: Topic::Code,
        example: "Show the current way to set up routing in Next.js.",
        token_help: None,
    },
    Entry {
        name: "DeepWiki",
        site: "https://deepwiki.com",
        url: "https://mcp.deepwiki.com/mcp",
        does: "Ask questions about any public GitHub project",
        auth: Auth::None,
        topic: Topic::Code,
        example: "How does facebook/react schedule updates? Answer in plain words.",
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
            assert!(entry.site.starts_with("https://"), "{}", entry.name);
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
            assert!(
                entry.name.chars().count() <= super::super::MAX_NAME_CHARS,
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
        assert_eq!(
            at("https://mcp.miro.com").map(|entry| entry.name),
            Some("Miro")
        );
    }

    /// The list reads as the topics, in the order the app's chips name them: each topic's entries
    /// together, and no topic left empty.
    #[test]
    fn every_topic_holds_its_entries_together_in_order() {
        const ORDER: [Topic; 10] = [
            Topic::Tasks,
            Topic::Notes,
            Topic::Meetings,
            Topic::Design,
            Topic::Research,
            Topic::Travel,
            Topic::Payments,
            Topic::Customers,
            Topic::Websites,
            Topic::Code,
        ];
        let mut topics: Vec<Topic> = CATALOG.iter().map(|entry| entry.topic).collect();
        topics.dedup();
        assert_eq!(topics, ORDER);
    }
}
