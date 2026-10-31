# Give agents tools

Every agent can already read and write files in its own folder, search and read the web, and run
commands, as you allow in its **What it may do without asking** row. A **tool** lets it use a
service too: add a to-do to Todoist, search flights on Kiwi.com, read a page with Jina. Each thing a
tool can do, such as "Create issue" or "Search flights", is an **action**.

LoomWatch talks to the service for the agent. Nothing is installed on your computer, and the agent
never gets your sign-in.

## Connect a tool

Open an agent's **Tools it can use** row and click **Connect a new tool**, or open
**Connections** and find **Tools**. Pick a topic to see its tools, type what you need (such as
"jira" or "invoices") to find one, or paste a tool's address in the same box.

| Topic | Tools | How it connects |
|---|---|---|
| Tasks | Todoist, Linear, Jira and Confluence, monday.com, ClickUp, Airtable | Sign in |
| Notes and files | Notion | Sign in |
| Meetings | Cal.com, Granola, Fireflies | Sign in |
| Design | Canva, Miro, Lucid, Mermaid Chart, Replicate (uses your Replicate credits) | Sign in |
| Research | Exa, Jina Reader, Hugging Face, Microsoft Learn, Apify (signs in, uses your Apify credits) | No sign-in |
| Travel | Kiwi.com (flights), Peek (things to do) | No sign-in |
| Payments | Stripe, Square, PayPal | Sign in |
| Customers | Intercom, Attio, Close.com, Klaviyo | Sign in |
| Websites | Webflow, Wix, Netlify, Vercel, Instant Domain Search (no sign-in) | Sign in |
| Apps and code | GitHub (token), GitLab, Sentry, Supabase, Neon, Cloudflare, PostHog, Context7 (no sign-in), DeepWiki (no sign-in) | Sign in |

Some popular services can't be connected yet. Gmail, Google Calendar, Google Drive and Outlook
don't offer an "MCP server" address. Slack, HubSpot, Asana, Box, Dropbox and Figma let in only apps
they approved by hand, and Gamma's sign-in won't send you back to an app on this computer. Search
for one and the list says so.

Each tool shows its own icon. LoomWatch fetches it from the service's own website the first time
it's shown and keeps a copy for a week. The icons belong to their makers and aren't part of
LoomWatch. A site that won't hand one over shows the tool's first letter instead.

There are three ways a tool connects:

- **No sign-in.** The tool answers anyone, so it connects at once.
- **Sign in.** The tool's site opens in a new tab, so whatever you were writing stays put. Sign in
  and allow LoomWatch there. Because the site sends you back to this computer
  (`http://127.0.0.1:…/api/tools/sign-in/callback`), it may ask you first to confirm you trust that
  address. When you're done, the tab says so and LoomWatch carries on by itself. LoomWatch asks only
  for the access the tool itself says it needs.
- **A token.** A few services, such as GitHub, don't offer a sign-in LoomWatch can use. Make a token
  on their site, paste it, and click **Connect**. A token the service refuses is never kept.

**Any other tool.** A service that works with AI assistants usually lists an "MCP server" address,
which often ends in `/mcp`. Paste it in the box at the top of the list. LoomWatch connects over
`https://` only.

LoomWatch keeps sign-ins and tokens in your Mac's Keychain (or Windows Credential Manager), never in
team files, and agents never get them.

## Give it to an agent

Connected tools show under **Give it a tool you connected** in every agent's Tools row. Give one,
and the agent can use that tool's actions. A tool from the list also says what to try asking, for
example "Find the cheapest flight from Hanoi to Tokyo in mid-November." In a team, the tool also
shows on the team's canvas, on its Team tab, as a card wired to the agent.

## It asks you first

A tool works in your own account on that service, so **the agent asks you before each action**,
even one that only reads. The card says which tool, which action, and what it would send:

> Researcher wants to use Linear
> Linear: Create issue · {"title":"Fix login"}

You can answer in three ways:

- **Allow** lets it through this once.
- **Allow for this run** lets that action through until the run ends.
- **Always allow this** lets that one action through for that agent from now on. Its other actions
  still ask. The agent's Tools row lists what it always may do, with a × to take each back.

On a schedule the run still asks you, and waits 12 hours for your answer. If nobody answers by
then, the action is declined and the agent carries on without it.

## When something goes wrong

- **Your sign-in has expired.** Click **Sign in again** in the agent's Tools row or in
  Connections.
- **Not connected in LoomWatch.** The team names a tool LoomWatch doesn't have (perhaps one you
  removed). The agent is told it doesn't have it and works without it. Connect it, or take it away.
- **That address isn't a tool's address.** Check that you pasted the "MCP server" address the
  service lists, not its website.

**Remove** a tool in Connections to forget it and its sign-in. Agents given it then work without
it until you connect it again.
