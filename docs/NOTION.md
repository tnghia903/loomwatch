# Connect your own Notion workspace

Open **Connections** from the workspace menu (the **LW** button, top right of the canvas) or
at `/connections` on the same local daemon as the editor. The menu is the discoverable
route; `⌘K → Connections…` and the URL reach the same surface. Like the rest of that menu
it is hidden below 768px, so connecting is a desktop task.

## Connect with your Notion account

1. Click **Connect Notion**. Notion's own page opens in the same tab; sign in to Notion if it
   asks.
2. Choose the workspace and allow LoomWatch. Because Notion sends you back to this computer
   (`http://127.0.0.1:3000/api/notion/sign-in/callback`), it first asks you to tick
   **I recognize and trust this URL**.
3. Back in Connections, choose the page your teams' answers go under. The list starts with pages
   from your workspace; type part of a title to find another.
4. Open a team, select its **Team response** node on the canvas, and turn on **Send every answer
   to Notion**. Save the team. From then on, every successful run's answer becomes a new page under
   the destination, whoever started the run.

There is no developer portal, no token to copy and no page to share with an integration. The
sign-in goes through Notion's hosted MCP server (`mcp.notion.com`), the same one Notion's other AI
connections use: LoomWatch registers itself for each sign-in, proves the code with PKCE instead of
a client secret, and asks only for access to that server.

**What it can reach.** Notion's consent page lists it: the sign-in acts with your own Notion
permissions, not just on one shared page. LoomWatch uses it only to search for pages when you
ask, to read the pages you give agents when their team runs, and to write new pages under the
destination you chose. It holds the sign-in itself; agents never receive it.

**How long it lasts.** The sign-in renews itself (Notion's access tokens last about eight hours).
Notion ends it after 30 days without use, or after 180 days in all; then Connections and every
delivery say to connect again. Connecting again to the same workspace keeps the destination page.

**Disconnect** removes the sign-in from this Mac and asks Notion to revoke it. You can also remove
LoomWatch in Notion's settings, under its connections.

## Advanced: connect with an integration token

For workspaces where an admin only lets approved AI apps connect. Open **Advanced: connect with an
integration token** under **Connect Notion**:

1. Create an internal integration for your workspace in Notion's developer portal. Enable
   Read, Insert and Update content. A workspace owner may need to do this.
2. Open the destination page in Notion and add the integration through **••• → Connections**.
3. Paste the integration token and click **Connect with token**.
4. Search for the destination page and select it. Use **Load more pages** when needed.

The daemon validates the token with Notion before saving it, and it uses Notion's REST API
(version `2026-03-11`) instead of the MCP server; a page an agent reads comes from its
[Markdown endpoint](https://developers.notion.com/reference/retrieve-page-markdown). An integration
sees only the pages shared with it, so add it to every page you give an agent the same way as to
the destination. Revoke the integration in Notion to invalidate the token itself.

## Give an agent a Notion page to read

Open a team. In the add panel on the left, **Connections** lists Notion:

1. Drag **Notion** onto an agent. A page search opens, starting with your recent pages.
2. Choose a page. It becomes a card on the canvas with a line to that agent, and a row under Notion
   that says who reads it.
3. Save the team.

To share the page, drag its row under Notion onto another agent, or draw a line from that agent to
the card. Click **Notion** without dragging to place a page card on its own and connect it later.
Give an agent as many pages as it needs, one card each. Until Notion is connected, the row says
so and opens Connections.

Each time the team runs, LoomWatch reads every page its agents are given, once per page, before any
agent starts, and gives each agent the page's text as source material. A short page is given
whole; a long one by its opening, with the full text in a file the agent can open. The agents never
get your Notion connection, and nothing is written to the page. If Notion is not connected, or can
no longer open a page, the run stops before it begins and says which page.

A whole teamspace, or a page with all its subpages, is not offered yet. A team file you did not write can name one of your
pages, so the approval it asks for lists every Notion page it reads.

## Where it is kept

Either kind of connection, and the destination, are stored in macOS Keychain under
`LoomWatch.Notion`, not in YAML, localStorage or the event archive. Connecting replaces the prior
connection. Only one workspace connection is supported per local OS user. Missing or locked
Keychain access is an error; there is no plaintext fallback. Windows/Linux storage is not yet
implemented.

The connection API is only mounted on loopback listeners. It rejects foreign origins and
simple cross-site mutation requests, disables response caching, bounds requests and upstream
responses, times out HTTPS requests, and never follows upstream redirects. The one route Notion's
site may send the browser to, `/api/notion/sign-in/callback`, finishes only the sign-in in
progress (its state is single-use and expires after ten minutes), only for a host on this
computer, and never passes its address on as a referrer.

## Where answers go

The saved destination is where answers are delivered:

- **Every answer.** The Team response's switch writes a top-level `deliver: {notion: {}}` into
  the team file. Every successful run then publishes its reply as a child page of the
  destination: runs from the canvas, follow-ups, retries, routines and runs from Ask. The default
  title is `{{team}} — {{date}} {{time}}`. The settings show whether Notion is connected and which
  page answers go under, and link here when something is missing.
- **One answer.** On the Run view, a finished answer offers **Send to Notion** when its team does
  not send automatically, through `POST /api/runs/{id}/deliver`. Where a delivery went, or why it
  failed, is shown on the answer itself, with **Open page**, **Try again** or **Connect Notion**.
- **Routines.** A `schedule` block's own `deliver.notion` (see `WATCH.md` → *Routines*) still wins for scheduled runs, titled
  from a template such as `AI, tech & business news — {{date}}`. Its default is one page a day,
  `{{team}} — {{date}}`.

Titles may use `{{date}}`, `{{weekday}}`, `{{time}}` and `{{team}}`. Before writing, the
destination's children are listed, and an existing page with exactly that title makes the delivery
`skipped` instead of a duplicate. The page URL LoomWatch reports is the one Notion returns, never
an agent's claim. `POST /api/schedules/run` publishes a routine on demand, so the connection can be
exercised without waiting for the schedule.

The reply's Markdown keeps its headings, lists, quotes, dividers, code blocks, links, bold, italic
and inline code; a reply longer than 500 blocks ends with "… truncated". It is written 100 blocks
at a time, in order. Through the sign-in, every other character Notion's format reads as markup is
escaped, so a reply that quotes a `<page>` or `<mention-user>` tag, or ends a line with
`{color="red"}`, shows it as text instead of moving a page, notifying someone or coloring a block.
Notion drops a `#` heading at the very start of a reply, because the page already has a title.

Protocol references: [Notion MCP](https://developers.notion.com/guides/mcp/overview),
[building an MCP client for Notion](https://developers.notion.com/guides/mcp/build-mcp-client),
[Notion-flavored Markdown](https://developers.notion.com/guides/data-apis/enhanced-markdown),
and for integration tokens [Notion authorization](https://developers.notion.com/guides/get-started/authorization),
[search pages](https://developers.notion.com/reference/post-search) and
[token identity](https://developers.notion.com/reference/get-self).
