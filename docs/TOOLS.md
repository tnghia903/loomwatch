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
| On this Mac | Apple Calendar, Apple Reminders, Apple Notes, Apple Contacts | Your Mac asks you first |
| From your iPhone | Apple Health | Turned on in the LoomWatch iPhone app |
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

There are five ways a tool connects:

- **From your iPhone.** Apple Health's data lives on your iPhone, not your Mac. In LoomWatch on your
  iPhone, open Settings, then Apple Health, and choose what to send: steps, active energy,
  exercise minutes, heart rate, resting heart rate, heart rate variability, weight, sleep and
  workouts. The iPhone sends one figure a day for each, plus each night's sleep and each workout,
  to the computer it's connected to. Apple Health connects once the first readings arrive. Agents
  read them, and can log a meal, water or a weight, each asking you first. To let them, turn on
  "Let agents log to Health" in the same place on your iPhone; the iPhone saves each entry in
  Health, and an agent can take back only what it logged. Removing Apple Health in Connections, or
  removing the iPhone under Your devices, deletes the readings, and the list of what was logged,
  from this computer.

- **On this Mac.** Calendar, Reminders, Notes and Contacts are your Mac's own apps, so they show
  only when LoomWatch runs on a Mac. Connecting one asks macOS: the first time, macOS asks you
  whether LoomWatch may use that app. If you said no, or you missed the question, Connections says so
  and opens the right page of System Settings (Privacy & Security, then Calendars, Reminders,
  Contacts, or Automation for Notes). Allow LoomWatch there (for Calendar and Reminders, with Full Access) and click **Check again**.
  LoomWatch reaches the app itself; nothing goes over the internet, and the agent runs no
  command to get there. Deleting a note moves it to Notes' Recently Deleted.

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
  still ask. The agent's Tools row lists what it always may do, with a × to take each back. In the
  LoomWatch iPhone app the same button shows when one of your agents asks in its own chat, after
  Face ID or your passcode.

What can't be undone, such as deleting an event, a reminder or a contact, asks every time. (A deleted note stays in Notes' Recently Deleted, so it asks like any other action.) Its card
says "This can't be undone" and offers only **Allow** and **Deny**.

On a schedule the run still asks you, and waits 12 hours for your answer. If nobody answers by
then, the action is declined and the agent carries on without it.

## When something goes wrong

- **Your sign-in has expired.** Click **Sign in again** in the agent's Tools row or in
  Connections.
- **Not connected in LoomWatch.** The team names a tool LoomWatch doesn't have (perhaps one you
  removed). The agent is told it doesn't have it and works without it. Connect it, or take it away.
- **Your Mac hasn't let LoomWatch use it.** For Calendar, Reminders, Notes or Contacts, click
  **Open System Settings** in Connections, turn LoomWatch on, then **Check again**.
- **That address isn't a tool's address.** Check that you pasted the "MCP server" address the
  service lists, not its website.

**Remove** a tool in Connections to forget it and its sign-in. Agents given it then work without
it until you connect it again.
