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

The saved destination is where routines deliver. A team file's `schedule` block (see
`WATCH.md` → *Routines* and [ADR 0010](decisions/0010-routines-and-notion-delivery.md))
runs the team on a cron schedule and, when `deliver.notion` is set, publishes each
successful run's reply as a child page of the destination, titled from a template such as
`AI, tech & business news — {{date}}`. Before writing, the destination's children are
listed and an existing page with exactly that title makes the delivery `skipped` instead of
a duplicate; the page URL LoomWatch reports is the one Notion returns, never an agent's
claim. `POST /api/schedules/run` publishes on demand so the connection can be exercised
without waiting for the schedule. Publishing uses the same token, HTTPS client limits and
error wording as the connection API.

What remains: public OAuth onboarding (a registered public integration, state/callback
handling, token refresh and revocation) — the connection is still an internal integration
token — and credential storage on Windows/Linux. Both stay listed in `DAILY_NEWS_QA.md`.

Protocol references: [Notion authorization](https://developers.notion.com/guides/get-started/authorization),
[search pages](https://developers.notion.com/reference/post-search),
[token identity](https://developers.notion.com/reference/get-self).
Requests use Notion API version `2026-03-11`.
