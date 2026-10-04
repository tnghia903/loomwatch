# Connect your own Notion workspace

Open **Connections** from the workspace menu (the **LW** button, top right of the canvas) or
at `/connections` on the same local daemon as the editor. The menu is the discoverable
route; `⌘K → Connections…` and the URL reach the same surface. Like the rest of that menu
it is hidden below 768px, so connecting is a desktop task.

1. Create an internal integration for your workspace in Notion's developer portal. Enable
   Read, Insert and Update content. A workspace owner may need to do this.
2. Open the destination page in Notion and add the integration through **••• → Connections**.
3. Paste the integration token into LoomWatch and click **Connect Notion**.
4. Search for the destination page and select it. Use **Load more pages** when needed.
5. Open a team, select its **Team response** node on the canvas, and turn on **Send every answer
   to Notion**. Save the team. From then on, every successful run's answer becomes a new page under
   the destination, whoever started the run.

The daemon validates the token with Notion before saving it. Credentials and the destination
are stored in macOS Keychain under `LoomWatch.Notion`, not in YAML, localStorage or the event
archive. Disconnect removes LoomWatch's saved connection; revoke it in Notion to invalidate
the token itself. Reconnecting replaces the prior connection and clears its destination.
Only one workspace connection is supported per local OS user in this increment.

The connection API is only mounted on loopback listeners. It rejects foreign origins and
simple cross-site mutation requests, disables response caching, bounds requests and upstream
responses, times out HTTPS requests, and never follows upstream redirects. Missing or locked
Keychain access is an error; there is no plaintext fallback. Windows/Linux storage is not yet
implemented.

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
exercised without waiting for the schedule. Publishing uses the same token, HTTPS client limits and
error wording as the connection API.

The connection uses a Notion internal integration token, and the token is stored only in the
macOS Keychain.

Protocol references: [Notion authorization](https://developers.notion.com/guides/get-started/authorization),
[search pages](https://developers.notion.com/reference/post-search),
[token identity](https://developers.notion.com/reference/get-self).
Requests use Notion API version `2026-03-11`.
