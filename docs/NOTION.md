# Connect your own Notion workspace

Notion is one of the tools you connect in **Connections**, and one sign-in does everything with
it: agents you give the Notion tool can search and write pages, asking you first; LoomWatch sends
your teams' answers to a Notion page; and agents read the Notion pages you give them.

Open **Connections** under **You** in the dock, on every screen, or at `/connections` on the same
local daemon as the editor. `⌘K → Connections…` and the URL reach the same surface. A line on a
team's page that says Notion isn't connected links to Connections.
Where the canvas says Notion isn't connected, it opens `/connections?tool=notion`, which starts
connecting Notion, or opens the Notion card's page list once Notion is connected.

## Connect Notion

1. Under **Tools**, click **Connect a tool**, then **Notion**.
2. Click **Sign in to Notion**. Notion's page opens in a new tab, so nothing on the canvas is lost;
   sign in to Notion if it asks.
3. Choose the workspace and allow LoomWatch. Because Notion sends you back to this computer
   (`http://127.0.0.1:3000/api/tools/sign-in/callback`), it first asks you to tick
   **I recognize and trust this URL**. The tab says it is connected and closes itself.
4. Back in Connections, the Notion card opens its list of pages: choose the page your teams'
   answers go under. The list starts with recent pages; type part of a title to find another.
5. Open a team, select its **Team response** node on the canvas, and turn on **Send every answer
   to Notion**. Save the team. From then on, every successful run's answer becomes a new page under
   that page, whoever started the run.

There is no developer portal, no token to copy and no page to share with an integration. The
sign-in goes through Notion's hosted MCP server (`mcp.notion.com`), the same one Notion's other AI
connections use: LoomWatch registers itself for each sign-in, proves the code with PKCE instead of
a client secret, and asks only for access to that server.

**What it can reach.** Notion's consent page lists it: the sign-in acts with your own Notion
permissions, not just on one shared page. LoomWatch uses it to search for pages when you ask, to
read the pages you give agents when their team runs, to write new pages under the page answers go
under, and to take the actions an agent you gave the Notion tool asks for, each one only after you
allow it. It holds the sign-in itself; agents never receive it.

**How long it lasts.** The sign-in renews itself. Notion ends it after 30 days without use, or after
180 days in all; then the Notion card, every delivery and every run that reads a page say to sign in
again. **Sign in again** on the Notion card keeps the page answers go under.

**Remove Notion** on its card forgets the sign-in on this computer. Agents given the tool can't use
it, and nothing is sent to Notion or read from it, until you connect it again; connecting again
sends answers to the same page. You can also remove LoomWatch in Notion's settings, under its
connections.

Workspaces where an admin lets only approved AI apps connect to Notion refuse the sign-in. An
integration token can't stand in for it, since Notion's hosted server takes only a sign-in: ask an
admin to approve LoomWatch.

## Give an agent a Notion page to read

Open a team. In the add panel on the left, **Connections** lists Notion:

1. Drag **Notion** onto an agent. A page search opens, starting with your recent pages.
2. Choose a page. It becomes a card on the canvas with a line to that agent, and a row under Notion
   that says who reads it.
3. Save the team.

To share the page, drag its row under Notion onto another agent, or draw a line from that agent to
the card. Click **Notion** without dragging to place a page card on its own and connect it later.
Give an agent as many pages as it needs, one card each. Until Notion is connected, the row says
so and opens Connections at Notion.

Each time the team runs, LoomWatch reads every page its agents are given, once per page, before any
agent starts, and gives each agent the page's text as source material. A short page is given
whole; a long one by its opening, with the full text in a file the agent can open. The agents never
get the sign-in, and nothing is written to the page. If Notion is not connected, or can no longer
open a page, the run stops before it begins and says which page.

This doesn't need the agent to have the Notion tool. Giving an agent the tool, in its **Tools**
block, is for an agent that should search or write in Notion while it works.

A whole teamspace, or a page with all its subpages, is not offered yet. A team file you did not write can name one of your
pages, so the approval it asks for lists every Notion page it reads.

## Where it is kept

The sign-in is kept with every other tool's, in one macOS Keychain item (`LoomWatch.Tools`), or on
Windows in Windows Credential Manager; with `LOOMWATCH_KEY_STORE=file`, as a trial copy is started,
in `tool-credentials.json` in that copy's state folder.

The page answers go under is kept with no credential in `notion-destination.json` in LoomWatch's
state folder (`~/Library/Application Support/LoomWatch`, or `LOOMWATCH_STATE_DIR`): its id and
title. Showing whether Notion is connected reads only `tools.json` and that file, never the
Keychain. macOS asks you to allow `loomwatchd` to read the Keychain item the first time a tool is
used after each update; **Always Allow** stops the question for that build.

**From Connections' old Notion section.** Before Notion was a tool, Connections had a Notion
section with a sign-in of its own, kept in the `LoomWatch.Notion` Keychain item. The first start of
a LoomWatch with the Notion tool moves that sign-in to the Notion tool, with the page answers go
under, and removes the old item; nothing is asked of you beyond the Keychain allowing the read. It
reads the old item only when Connections had shown Notion as connected. If a Notion tool was
already connected, it keeps its own sign-in and the old one is revoked. A connection made with an
integration token is not moved: sign in to Notion under Tools, and answers still go to the same
page.

The Notion routes (`/api/notion/connection`, `/pages`, `/destination`) are only mounted on loopback
listeners. They reject foreign origins and simple cross-site mutation requests, bound requests and
upstream responses, time out HTTPS requests, and never follow upstream redirects.

## Where answers go

The page answers go under is where they are delivered:

- **Every answer.** The Team response's switch writes a top-level `deliver: {notion: {}}` into
  the team file. Every successful run then publishes its reply as a child page of that page: runs
  from the canvas, follow-ups, retries, routines and runs from Ask. The default title is
  `{{team}} — {{date}} {{time}}`. The settings show whether Notion is connected and which page
  answers go under, and say where to fix it when something is missing.
- **One answer.** On the Run view, a finished answer offers **Send to Notion** when its team does
  not send automatically, through `POST /api/runs/{id}/deliver`. Where a delivery went, or why it
  failed, is shown on the answer itself, with **Open page** or **Try again**, or where to connect
  Notion.
- **Routines.** A `schedule` block's own `deliver.notion` (see `WATCH.md` → *Routines*) still wins for scheduled runs, titled
  from a template such as `AI, tech & business news — {{date}}`. Its default is one page a day,
  `{{team}} — {{date}}`.

Titles may use `{{date}}`, `{{weekday}}`, `{{time}}` and `{{team}}`. Before writing, the page's
children are listed, and an existing page with exactly that title makes the delivery `skipped`
instead of a duplicate. The page URL LoomWatch reports is the one Notion returns, never an agent's
claim. `POST /api/schedules/run` publishes a routine on demand, so the connection can be exercised
without waiting for the schedule.

The reply's Markdown keeps its headings, lists, quotes, dividers, code blocks, links, bold, italic
and inline code; a reply longer than 500 blocks ends with "… truncated". It is written 100 blocks
at a time, in order. Every other character Notion's format reads as markup is escaped, so a reply
that quotes a `<page>` or `<mention-user>` tag, or ends a line with `{color="red"}`, shows it as
text instead of moving a page, notifying someone or coloring a block. Notion drops a `#` heading at
the very start of a reply, because the page already has a title.

Protocol references: [Notion MCP](https://developers.notion.com/guides/mcp/overview),
[building an MCP client for Notion](https://developers.notion.com/guides/mcp/build-mcp-client) and
[Notion-flavored Markdown](https://developers.notion.com/guides/data-apis/enhanced-markdown).
