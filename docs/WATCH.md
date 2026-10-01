# Watch and replay

Watching lives in the workspace itself. A run started from the composer (`POST /api/runs`)
or by `loomwatchd run` is projected onto the canvas as one causal story — **Prompt · user
request → Run NN → Agent A · lead → its evidence → Agent B · responder → Output / response**
— from the exact events in the PostgreSQL archive. The viewer never starts processes;
`POST /api/runs` does (see *Run control* below).

## Start

Build the UI, set `DATABASE_URL` to the same PostgreSQL database used by `loomwatchd run`,
and start the daemon:

```sh
cd ui
npm install
npm run build
cd ..
cargo run -- serve --listen 127.0.0.1:3000 --teams-root teams
```

`serve` accepts `--database-url` or `DATABASE_URL`. Without either, the team editor works
and the composer explains that the archive is disabled. With an archive configured,
`serve` rejects non-loopback listeners. Exact archive evidence may contain harness inputs,
paths, and other private data; this implementation does not publish it on the LAN.

## Reading a run

Open a team, type a goal in the composer and press **Run** (`⌘↵`; a dirty document offers
**Save & run** instead — a run executes an exact snapshot of the file, so there is no “run
without saving”). The canvas then shows:

- the **Prompt** card (the operator's own words, `Original kept`), the **Run NN** card
  (attempt, state, elapsed) and named arrows `starts` / `assigns lead` / `responds with` /
  `completes as`;
- each agent card with a live task row — `Agent A · lead · RUNNING · $ cargo test` — a blue
  breathing perimeter while it executes, and its spend against its budget;
- one **evidence card per accepted event**: tool calls, commands, file reads and edits,
  searches, fetched sources, Team Bus delegations, permission requests and plans, each with
  owner, ordinal, elapsed time, status and relationship word. Click one for its input,
  output and raw events;
- observed delegations as gold dashed *weft* edges (or a shuttle and `×n` badge on the
  configured edge they coincide with; an anomaly badge when a pipeline deviates);
- the **Output** card streaming the canonical responder's reply, with `Live` / `Replay`
  and the failure or cancellation strip when a run ends abnormally; **Show provenance**
  opens the six-category coverage summary;
- a lifecycle strip under the document chip: lead task, run state, result, elapsed, spend,
  and a scrubber (`←` / `→`) that replays any earlier event as a complete, byte-equivalent
  picture. Scrubbing never alters execution or YAML.

The history button beside the composer (`⌘P`) lists live runs and the 100 most recently
active archived sessions with their prompts; selecting one opens it in **replay**. Deep
links use `?run=<id>`; the legacy `/watch?session=<id>` route redirects there. A run the
daemon no longer remembers (restart) is read from the archive alone.

Escalations, budget warnings, abnormal turn endings, crashes and rejected Team Bus calls
collect in an **Attention** panel; browser notifications are offered only after an explicit
permission action (⌘K → *Enable notifications*). Dismissing an alert affects this view only.
Connection loss never starts, cancels, or restarts a team. Reconnect uses the last verified
sequence, rejects gaps, and deduplicates replay. The browser retains up to 50,000 events;
use `loomwatchd show --session <id>` for larger sessions.

Below 768 px the coordinate graph becomes a reading column in the same causal order, with
the relationship words kept on the cards.

## Verifying without a paid harness

Any executable that speaks ACP over stdio is a harness. For a deterministic end-to-end
check, point an agent's `spawn.cmd` (an absolute path) at a shell script that answers
`initialize`, `session/new` and `session/prompt` and streams a few `session/update`
notifications (`agent_thought_chunk`, `tool_call` / `tool_call_update` with a `kind`,
`agent_message_chunk`) before replying `{"stopReason":"end_turn"}` — the backend tests in
`crates/loomwatch-backend/src/runs.rs` (`COMPLETING_HARNESS`) show the minimal shape. Put
the team file in a scratch `--teams-root` so the fake never lands next to real teams.

## Evidence transport

These are legacy **session** endpoints, separate from the proposed immutable **run** API:

| Route | Result |
|---|---|
| `GET /api/sessions` | Up to 100 recent session summaries, each with `prompt` (text of the first archived user `message`, or `null`) and `firstAgentId` |
| `GET /api/session/events?session=ID&afterSeq=-1&limit=200` | Ordered array of exact `RunEvent`s; exclusive cursor, limit 1–500 |
| `GET /api/session/stream?session=ID&afterSeq=-1` | WebSocket, one unwrapped `RunEvent` per text frame |

A session with no matching events returns an empty page; its stream can wait for future
archive entries. The server polls PostgreSQL every 500 ms after catching up. Database
failure closes the stream; the client retries with bounded backoff and archive recovery.
All evidence routes validate loopback Host and same-origin Origin/Fetch Metadata headers,
return no CORS grants, and disable HTTP caching. The service worker never caches API data.

The graph shows **observed process state**, not a durable run status. In particular,
`turn_end` alone does not complete a team, and a process exit does not prove that a whole
pipeline completed. Helper output is not combined into a canonical answer. Immutable run
creation, completion barriers, normalized provenance, redacted sharing, and response
assembly remain separate work described in `RUN_PROVENANCE_CONTRACT.md`.

## Run control

`POST /api/runs` starts a team from the browser; the run is then watched through the
evidence transport above. These routes sit behind the same loopback-only boundary as the
evidence routes (loopback `Host`, same-origin `Origin`/Fetch Metadata, `no-store`), and they
require the archive: without `DATABASE_URL` they answer 503. See
[ADR 0008](decisions/0008-run-control-api.md).

| Route | Result |
|---|---|
| `POST /api/runs` | Start a run; `202 Accepted` with the run record |
| `GET /api/runs` | Every run since the daemon started, newest first |
| `GET /api/runs/{id}` | One run record, or 404 |
| `POST /api/runs/{id}/cancel` | Abort a live run: 200 with the record; 409 with the record when it already finished; 404 when unknown |

Request body:

```json
{ "teamPath": "research-team.yaml", "prompt": "Summarise what ACP session/new negotiates." }
```

`teamPath` is relative to the daemon's `--teams-root` (an absolute path is accepted only if it
still resolves below the root) and must be an existing regular file; `prompt` is trimmed and
must be non-empty and at most 64 KiB. Rejections: 400 (empty or oversized prompt, malformed
JSON, path is not a regular file), 403 (path resolves outside the teams root, symlinks
included), 404 (no such file), 422 (`TeamConfig` validation failed; `error` carries the
message verbatim), 503 (archive disabled).

Response (`202 Accepted`):

```json
{
  "runId": "6f0c1c4e-2b7a-4c1e-9b0e-3f2a1d5c8e77",
  "sessionId": "6f0c1c4e-2b7a-4c1e-9b0e-3f2a1d5c8e77",
  "teamPath": "research-team.yaml",
  "prompt": "Summarise what ACP session/new negotiates.",
  "status": "queued",
  "mode": "pipeline",
  "entrypoint": "researcher",
  "responder": "reviewer",
  "agentIds": ["researcher", "reviewer"],
  "createdAt": "2026-09-10T09:12:44.118Z",
  "startedAt": null,
  "finishedAt": null,
  "error": null,
  "exitCode": null,
  "errorCode": null,
  "stopReason": null,
  "eventCount": null,
  "reply": null,
  "trigger": "manual",
  "delivery": null
}
```

- `runId` **is** the archive `sessionId`: open
  `GET /api/session/stream?session=<runId>` as soon as the run is accepted; the first
  frame is the entrypoint's `process`/`spawned` event.
- `status` moves forward only: `queued` → `starting` (the task began; `startedAt` set)
  → `running` (the first `process`/`spawned` event is archived; polled every 250 ms)
  → `succeeded` (`exitCode`, `eventCount`, `reply` = the responder's reply) or `failed`
  (`error` is the runner's message verbatim, plus `exitCode`/`eventCount` when the archive
  knows them) or `cancelled`. `finishedAt` is set on every terminal state. Terminal states
  never change.
- `mode` is `team` when the file has no edges and `pipeline` otherwise. `responder` is fixed from
  the optional root team-file setting; when that setting is absent, it falls back to the entrypoint
  in team mode and the last node of the topological order in pipeline mode.
- Cancel aborts the run task. ACP children are spawned with `kill_on_drop`, so the harness,
  any delegated helpers, and the run's Team Bus listener are torn down. No cancellation
  event is archived; the run record is the source of truth for terminal classification.
- The registry is in memory: a daemon restart forgets `GET /api/runs`, while the archive
  keeps every event and `GET /api/sessions` still lists the session with its `prompt`.
- `trigger` is `manual` for `POST /api/runs` and `schedule` for routine runs (below);
  `delivery` stays `null` for manual runs and for routine runs until their delivery is
  decided.

## Routines

A team file may carry a `schedule` block: run the team on a cron schedule with a fixed
prompt and deliver the canonical reply to the operator's connected Notion destination.
`teams/daily-news.yaml` is a complete example; the design is
[ADR 0010](decisions/0010-routines-and-notion-delivery.md).

```yaml
schedule:
  cron: "0 8 * * *"             # 5-field cron, minute resolution (6/7-field seconds form also accepted)
  timezone: "Asia/Singapore"    # optional IANA zone; default: the daemon's local zone
  prompt: "Prepare the {{weekday}} {{date}} AI, tech and business news digest."
  enabled: true                 # optional, default true; "Run now" ignores it
  deliver:                      # optional
    notion:
      title: "AI, tech & business news — {{date}}"   # optional, default "{{team}} — {{date}}"
```

- **Templates** in `prompt` and `title`: `{{date}}` → `YYYY-MM-DD` and `{{weekday}}` →
  `Thursday`, both read in the schedule's zone at fire time; `{{team}}` → the team `name`.
- **Cron** uses the standard 5-field numbering (`0` or `7` = Sunday, so `1-5` is Mon–Fri;
  names such as `Mon-Fri` work too). A 6/7-field expression is handed to the `cron` crate
  as written, where `1` = Sunday. `@daily`-style shorthands are accepted.
- **Validation** happens in `TeamConfig::parse`: a bad expression, unknown zone or blank
  prompt is a 422 from `PUT /api/team` and `POST /api/runs`, and the schema
  (`$defs.Schedule`) rejects unknown keys.

The scheduler is in memory. Every 30 s it rescans the teams root (hidden directories are
skipped), recomputes a routine's next fire only when its cron or timezone changed or it
fired, and starts every enabled routine whose time has passed through the same path as
`POST /api/runs`. Fires missed while the daemon was down are skipped — `nextAt` is
computed from "now" at start. A routine whose previous scheduled run is still live skips
that fire and reports `problem: previous scheduled run <id> is still running`. A file whose
schedule does not parse stays listed with `problem` set and no `nextAt`. Nothing about a
routine (last run, last delivery) survives a restart.

Endpoints, behind the same loopback-only boundary as run control (503 without the archive):

| Route | Result |
|---|---|
| `GET /api/schedules` | Every routine, sorted by path; `[]` when nothing is scheduled |
| `POST /api/schedules/run` | Run the routine now: `202 Accepted` with the run record. 404 when the team has no `schedule` block, 409 while its previous scheduled run is live, 422 when the block does not parse, plus the path errors of `POST /api/runs` |

`POST /api/schedules/run` takes `{ "teamPath": "daily-news.yaml" }`, expands the
templates, launches with `trigger: "schedule"` and delivers exactly like a timed fire, so
delivery can be tested without waiting for the clock. One routine as listed:

```json
{
  "teamPath": "daily-news.yaml",
  "teamName": "Daily AI, tech & business news",
  "cron": "0 8 * * *",
  "timezone": "Asia/Singapore",
  "describe": "daily at 08:00 Asia/Singapore",
  "prompt": "Prepare the {{weekday}} {{date}} edition …",
  "enabled": true,
  "nextAt": "2026-09-12T00:00:00.000Z",
  "lastRunId": "6f0c1c4e-…",
  "lastStatus": "succeeded",
  "lastFiredAt": "2026-09-11T00:00:03.412Z",
  "lastDelivery": { "target": "notion", "status": "published", "url": "https://www.notion.so/…", "pageId": "…", "message": "Published \"AI, tech & business news — 2026-09-11\".", "deliveredAt": "2026-09-11T00:06:40.001Z" },
  "deliver": { "notion": { "title": "AI, tech & business news — {{date}}" } },
  "problem": null
}
```

`describe` is a human summary for the simple shapes (daily, weekdays, weekends, one
weekday, hourly) and the cron text otherwise; `timezone` is `null` when the daemon's local
zone applies; `nextAt` is RFC 3339 UTC; `lastStatus` is read live from the run registry;
`deliver` is `null` when the routine delivers nowhere.

**Delivery** happens only for routine runs (timed or "Run now") that `succeeded` with a
non-empty reply while `deliver.notion` is configured; manual runs are never delivered. The
reply is published as a child page of the connected destination (`docs/NOTION.md`), titled
from the template, with the Markdown turned into Notion blocks — `#`/`##`/`###` headings,
`-` and `1.` lists, `>` quotes, `---` dividers, fenced code, paragraphs, and inline links,
bold, italic and code; at most 500 blocks. The outcome is stored on the run record as
`delivery` and on the routine as `lastDelivery`:

| `status` | Meaning |
|---|---|
| `published` | A new page was created; `url` and `pageId` are what Notion returned |
| `skipped` | A child page with exactly this title already existed; `url` points at it and nothing was written (`A page with this title already exists.`) |
| `failed` | Nothing was written; `message` says why — `Notion is not connected. Open Connections and choose a destination page.` when no workspace or destination is connected, otherwise the same wording the Connections page uses for Notion's errors |

### Unattended runs

A routine only works if the harness never has to ask. LoomWatch answers every ACP
`session/request_permission` with a rejection, so a tool the harness must confirm is simply
refused. For Claude's adapter that means a `.claude/settings.json` in the agent's `cwd`
whose `permissions.allow` covers the tools the run needs (for the news digest `WebSearch`,
`WebFetch`, `Read`, `Glob`, `Grep`) and whose `deny` list keeps the rest closed;
`teams/daily-news/.claude/settings.json` is the worked example. Installed adapters still do
not imply a logged-in account or a usable model — a routine that fails for that reason
shows up as a `failed` run, not a delivery.

## Team-file revisions

Team GET/PUT responses include `revision: "sha256:<hex>"` and the corresponding quoted
strong ETag. Updates require `If-Match: "sha256:<hex>"`; creating a file requires
`If-None-Match: *`. Missing preconditions return 428; stale updates and existing create
targets return 412. Rejected writes leave the file unchanged.

The daemon serializes precondition checks and replacements among its API clients. Creation
uses an atomic no-overwrite link. External editors that do not participate in the daemon's
write lock can still change a file between its check and replacement; this is not the
capability-based snapshot guarantee proposed for future run acceptance. Save a copy never
silently overwrites an existing destination. The UI preserves local edits after a 412 and
lets the user compare, reload, or explicitly keep the local version.

## Harness readiness

`GET /api/harnesses` includes `acpAvailable`. A detected vendor CLI is not sufficient
when its separate ACP adapter is missing. The Library shows the missing executable and
disables that drag source until the adapter is on the daemon's PATH. Discovery checks
executable presence, not authentication or provider connectivity.

## Installation

The manifest lets supporting browsers install LoomWatch as a standalone app. Its service
worker caches only an offline explanation and the public app icon. If the daemon is
unreachable, the offline page explains how to reconnect. It does not cache team documents,
execution evidence, or credentials, and does not queue offline writes.
