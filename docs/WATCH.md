# Watch and replay

Watching lives in the team's chat. A run started there (`POST /api/runs`) or by `loomwatchd run`
is a piece of work in the chat, and its **Details** beside the chat show how it was made, all from
the exact events in the run archive. The viewer never starts processes; `POST /api/runs` does (see
*Run control* below).

## Start

Build the UI and start the daemon:

```sh
cd ui
pnpm install --frozen-lockfile
pnpm run build
cd ..
cargo run -- serve --listen 127.0.0.1:3000 --teams-root teams
```

The archive is one SQLite file: `loomwatch.db` in the state folder (`LOOMWATCH_STATE_DIR`), or
the file `--database` or `LOOMWATCH_DATABASE` names. `loomwatchd run` and `show` take the same
option, so they read and write the same history. `serve` rejects non-loopback listeners (unless
`--allow-container-listener`). Exact archive evidence may contain prompts, file contents, command
output, paths and other private data; this implementation does not publish it on the LAN.

## Reading a run

Open a team's **Chat** (or press **Run team** in Workflow) and send the team a request with
`@team`. Unsaved changes to the team file are saved first: a run executes an exact snapshot of the
file, so there is no “run without saving”. The run is then a piece of work in the chat, and
**Details** beside it shows:

- once the run ends, its **receipt**: what was asked, who did what, what failed and what happened
  instead, and what is worth a second look;
- the **timeline**: each agent's work on a line of its own, with a mark for each call it made
  (one that failed is marked as failed) and for each time the work passed to another agent. Drag
  across it to replay what happened, and when; replaying never alters execution or YAML;
- the team in one row, described below;
- **What was recorded**: every accepted event behind the cards, grouped into six categories with
  how much of each was captured. Tool calls, commands, file reads and edits, searches, fetched
  sources, Team Bus delegations, permission requests and plans each carry owner, ordinal, elapsed
  time, status and relationship word. Click one for its input, output and raw events.

Each piece of work in the team's chat shows **what they said to each other**: each pipeline handover,
every Team Bus `ask` with the answer it got (and whether the asked agent answered from its open
session or from a fresh start), `dispatch` and `handoff` tasks, `ask_user` questions with your
answers, and your answers at a review step. It reads as a group chat inside the team's chat: each
agent has its own colour and initials, numbered as its card is, and your messages sit on the
right. A review's **Approve** and **Send back** stand where your reply goes, under the handover
they decide. A question names who it is for with an @mention, and its answer quotes it. A handover
shows as a document shared with the stage it was for. An answer still owed shows as someone
writing while the run is live, and as **No answer** after it ends. A plain approval is a short
note in the chat; a review you approved with a note is one message from you to the stage it went
on to, and the direction and handover that stage was then given fold into it, as they only
repeat it. A long message shows its first lines and **Read more** shows it verbatim; **Info**
says how long the answer took, what the agent did meanwhile, and leads to the record.
`ui/src/lib/watch/messages.ts` collects the messages in the same pass as the rest of the
projection, and the timeline's **Read the message** in Details opens the piece in the chat and
lands on that message.

Who said what to whom is read from the record, not from the team file as it is now:

| Recorded on | Field | Says |
|---|---|---|
| `session_meta` `prompt_sections` | `stageResultsFrom` | The stages a handover was built from (the edges into the stage, as `pipeline_node_prompt` reads them). A review step's own record names whose handover it read, so a handover it passed on is shown as written by that stage, *through your review*. |
| `session_meta` `prompt_sections` | `directionFrom` | The review stops a stage's direction came from. |
| `operator_answer` message, `raw` | `askedBy` | Whose question or review your answer closes. |
| `operator_answer` message, `raw` | `sendBack` | The stage your answer sent the work back to; absent for an approval. |
| `operator_answer` message, `raw` | `to` | The kept-alive agent a follow-up of yours went to; its next turn is shown as the answer. |

All five are additive: runs archived before them still read, and a handover sender that had to be
taken from the team's connections says so when its row is opened.

Past work lives in each team's chat: the Chat tab lists the team's runs as pieces of
work, oldest first. The newest piece and any piece still working show the talk between agents as
it happens; older pieces fold it to one line. **Details** on a piece opens this view beside the
chat, and Esc closes it. The chat holds what was said and Details how it was made: a piece's
answer is read only in the chat, with its record's verdict (which opens the review), the files it
names, **Copy**, **Download** and **Send to Notion** under it; Details shows the receipt (the
run's tokens, and its cost on each turn's `turn_end`: as OpenRouter reported it, ≈ at Claude's list
prices, or "ChatGPT plan"), timeline,
and the team in one row: your request, a card for each agent, and the team's answer, joined by
the lines the work moves along. While the run is watched, an agent's figure acts out what it is
at (reading, thinking, using a tool, typing), what it is thinking or the call it is on floats over
its card, and its last words show as it types; the work slides along the line to the next agent,
or back when a check sends it back, which leaves a dashed arc under that line. An agent's skills
hang under its card and light up as it opens them. Each card's marks count what that agent used:
skills (a required one it never had, once the run is over, leaves the mark dashed), the web
(pages read and searches, with the programs its model ran to search), files, commands, plan. A
mark opens its list under the row: the pages read by site, marked when the team's answer links
them, and what each search found; each skill's receipt; or the calls, each opening its record.
The request and the answer themselves are read in the chat, not again here. What the work made
is a tab of the pane beside the chat, after **Details**: first a long answer (or a titled one past
a few lines), as the chat shows a message, by the figure and name of the agent who gave it, in a
bubble, with its title on hover; then, past a thin line, each file its answer names that
LoomWatch can show and that is on this computer, by its name and the mark of its kind. In the chat
such an answer stays short, a card with its title, opening words and length, whose **Open** shows
its tab. Once the work has finished well, the pane following
the newest work switches to what it came to: the first page, document, sheet or picture it wrote,
else its long answer. Code, and files it only read, wait as tabs; work that stopped keeps its
record on screen. Each tab has its own ×, and closing the one on screen shows the next; a tab
closed stays closed for that work until **Read** on the file's card (or **Open** on the answer's)
brings it back in its place. Past the pane's width the tabs scroll under **Details**, which stays
put. A file that has been on screen stays a tab until its × is pressed. It stays when newer work
starts, so a change to a part asked about can be seen, and when **Read** opens a file from other
work, which gets its own tab. The pane's own × closes them all. Mark
any words in a file to ask about them (ADR 0077): **Ask** puts them in the message box, **Explain**
asks at once. The answer opens beside the words: first the agent writing, then its answer,
formatted as in the chat. If the work changed those words, the answer opens at the top of the file,
and stays in the chat. Each part asked about keeps a marker stroke and, after it, a bubble with the
face of the agent asked: it types while the agent works and shows a gold dot until you open the
answer here (remembered in this browser). Ask several agents about the same words and each gets
its own bubble after them, stacked in the order you asked; ask the same agent again and its bubble
shows the newer answer, under what you asked it before and what it said. **Reply** under an answer
puts the words you marked back in the message box, addressed to the agent that answered, so your
follow-up is about that part too; its answer shows under the first one. In the chat, every answer
an agent gave you has **Reply** under it when you point at it: under an answer about a marked part
it does the same, and under any other it quotes the answer. Pointing at a bubble brings it to the front with the agent's card, as its
face in the chat does, and what you asked it. Ask about words that overlap words asked about
before and only the newer words keep the stroke, with the earlier bubbles beside them; an earlier
answer then opens at the newer words and says which words it is about. A bubble opens its own
answer, and the marked words open the one still waiting for you, or else the newest; Esc or ×
closes it. A web page the agent made is marked the same way. It runs in a sandbox of its own, and
the data, clips, pictures and fonts beside it load as they would from the page's folder (a
dashboard's `fetch('sales.csv')` works; LoomWatch reads them for it): its own folder and the folders
in it only, never anything above it. Point at a chart, a picture or a video in the page and a small
mark shows at its top left; press it (or reach it with Tab) to ask about that thing, and the page's
tip says so while it has one. Dragging works as the page made it, so a chart that zooms on a drag
still does; a drag across a chart's own labels marks the chart. The agent is sent a picture of the
thing as it is shown, when the page can draw it, and told where it is in the page's code; once
asked, it stays outlined with the agent's bubble at its corner. On a picture (ADR 0091), drag over
any part of it to mark a box, or click to mark all of it: the bubble leans in over the box, and the part
goes with its picture, the box cut out of the picture, which the agent you ask sees when its model
sees pictures. So **Explain** on a picture starts the agent's work rather than a quick answer in the
chat. The agent is told where the box is as well, so it can open the file itself. The box stays on
the picture with the bubble of each agent asked at its corner, and the box or its bubble opens the
answer. A PDF is shown as its pages, and you mark its words as in any file. Drag over a picture or
a chart on a page to mark a box there; to mark all of a page with one, press Tab until the page is
ringed, then Enter (or tap it, on a touch screen). The agent is told the page and where the box is,
and sent a sharp picture of the box. A PDF that can't be shown as its pages shows only its words. A CSV or TSV file and an Excel workbook are shown as a sheet: a workbook's sheets behind
tabs, the first row as the column names, the rows numbered. Drag across any cells to ask about them,
or press (or drag across) column names or row numbers for whole columns or rows; from the keyboard,
Enter on a column's name or a row's number does the same, and ⌘C copies the marked cells. The agent
is given the cells' words under their column names and after their row names, and told which cells
they are and on which sheet (the workbook's sheets are drawn from the words LoomWatch reads out of
it, as the agents read them). The cells stay marked with the agent's bubble beside them; a press on
them opens the answer, and a sheet's tab shows a small box while it holds cells asked about. The chat
quotes cells with their rows kept ("By region · Q1, Q2 · 120, 140"). A video or a sound recording
plays in the reader, however large, and you can skip to any point (LoomWatch sends it in pieces as
it plays). Under it is a bar, with the agent's face at its start: click it to ask about that moment,
or drag along it for a stretch, and the recording skips there; the arrow keys move along it and
Enter marks where it is. On a paused video, drag over the picture to mark a box on that frame. The
agent is told the time to the millisecond, so a cut it is asked for lands where you put it, and is
sent the frame, a stretch's first, middle and last frames, or the box cut out of its frame (for a
sound recording the agent gets only the time). A box or a moment always starts the agent's work, so
it can open the file, rather than a quick answer in the chat from the words alone. Each part stays
on the bar with the agent's bubble above it; click the bubble to open the answer and skip to that
moment. Drag the edge between the
chat and the pane to resize; double-click resets it. The chat is paged from `GET /api/chat`. The magnifier in its header finds words anywhere in the
team's chat (`GET /api/chat/find`, ADR 0081): what you asked, the answers, your notes and what the
agents said to each other, in any order and any form of a word, with or without Vietnamese accents.
What matches shows in place of the chat, best first; a line opens the chat at that message with
the words lit, and **← Back to the list** returns to it.

Pictures and files go with a message (ADR 0082): paste one into the message box, drop files on the
chat (a dashed gold line goes round it while you drag), or press the paperclip. Each is kept the
moment it is added, with `PUT /api/chat/files?teamPath=&name=` (raw bytes, 25 MB at most), in
`<team>.files/chat/` beside the team file, and shows as a chip above the box; a message carries up
to 10 and still needs words. `POST /api/chat/messages` names them in `files: [{path}]`, and the
daemon refuses any path outside that team's `chat/` folder. Every agent of the team may read them
without asking. Each agent the work reaches finds them listed under its task, by path, and the
agent the message reaches first is shown the pictures with its words when its model sees pictures;
a note's pictures go to the agent it is for. A message with files always starts work, never a quick
answer in the chat. Your sent message shows the pictures small, opening full size in the reader
beside the chat, and other files as cards. An answer to an agent's question takes words only, and
the box says so while files are in it. A dropped folder isn't sent: the folder picker opens, its
button waits until that folder is open, and it is added for every agent of the team as a linked
source, with a line over the box saying so. Deep links use `?run=<id>`, which opens the chat with that run's Details; the legacy
`/watch?session=<id>` route redirects there, and a bare `/watch` opens the team list. A run the
daemon no longer remembers (restart) is read from the archive alone.

Escalations, abnormal turn endings, crashes and rejected Team Bus calls
collect in an **Attention** panel; browser notifications are offered only after an explicit
permission action (⌘K → *Enable notifications*). Dismissing an alert affects this view only.
Connection loss never starts, cancels, or restarts a team. Reconnect uses the last verified
sequence, rejects gaps, and deduplicates replay. The browser retains up to 50,000 events;
use `loomwatchd show --session <id>` for larger sessions.

## Verifying without a model provider

For a deterministic end-to-end check, give the team's agents `model: fake/offline`. That is
LoomWatch's built-in offline demo model: it needs no OpenRouter key, no network and nothing
installed, and it calls no provider. Each agent answers with fixed text, and answers handover,
send-back and checkpoint turns too, so a run, its review stops, its handovers and the team's chat
can all be checked without spending anything. A team whose agents all use it runs without a key.
[`examples/operator-stop.yaml`](../examples/operator-stop.yaml) is a complete team on it. The
backend's own tests use scripted stand-ins of the same provider, which can also call tools
(`crates/loomwatch-backend/src/agent/demo.rs`). Put the team file in a scratch `--teams-root` so
the demo never lands next to real teams.

## Evidence transport

These **session** endpoints read the archive. Starting and stopping runs is *Run control*, below:

| Route | Result |
|---|---|
| `GET /api/sessions` | Up to 100 recent session summaries, each with `prompt` (text of the first archived user `message`, or `null`) and `firstAgentId` |
| `GET /api/session/events?session=ID&afterSeq=-1&limit=200` | Ordered array of exact `RunEvent`s; exclusive cursor, limit 1–500 |
| `GET /api/session/stream?session=ID&afterSeq=-1` | WebSocket, one unwrapped `RunEvent` per text frame |

Both take `lean=true`, which leaves out each event's `raw` frame except on `message`,
`session_meta` and `turn_end` events, the only ones whose frame the browser reads; without it
every frame is sent. On a long run the frames of tool output are most of the trace.

A session with no matching events returns an empty page; its stream can wait for future
archive entries. A page read first flushes the batching writer, so it sees every event appended
before it. After catching up, the stream waits for the writer to commit a batch and sends what it
committed (within the writer's 100 ms window), with a 30 s re-read as a safety net; it never makes
the writer commit early. Database failure closes the stream; the client retries with bounded
backoff and archive recovery. The browser opens one read and one stream per session however many
views show it, and none for a finished run once its recorded `eventCount` has arrived.
All evidence routes validate loopback Host and same-origin Origin/Fetch Metadata headers,
return no CORS grants, and disable HTTP caching. The service worker never caches API data.

The graph shows **what the archive observed**, not a durable run status. In particular,
`turn_end` alone does not complete a team, and an agent's session closing (its `process`
`exited` event) does not prove that a whole pipeline completed. Helper output is not combined
into a canonical answer. The run record (*Run control*, below) is what says how a run ended.

## Run control

`POST /api/runs` starts a team from the browser; the run is then watched through the
evidence transport above. These routes sit behind the same loopback-only boundary as the
evidence routes (loopback `Host`, same-origin `Origin`/Fetch Metadata, `no-store`). The daemon
always has its archive; a router built without one (tests) answers 503.

| Route | Result |
|---|---|
| `POST /api/runs` | Start a run; `202 Accepted` with the run record |
| `GET /api/runs` | Every run since the daemon started, newest first; `?preview=true` cuts each `reply` to its first 400 characters, which is what the browser's lists read; `?finishedWithin=<seconds>` keeps the runs still under way and those that finished in that many seconds, which is what the Mac menu bar, the island at a MacBook's notch and the Windows notification-area menu read |
| `GET /api/runs/{id}` | One run record, or 404 |
| `GET /api/chat/answering` | The messages agents are answering in the team chat themselves, where no run starts (a greeting, or a quick question such as **Explain** on a part of a file), and those answered in the last hour, oldest first; `?finishedWithin=<seconds>` keeps the ones still being answered and those answered in that many seconds. Each answer is cut to its first 400 characters; an agent whose answer failed (out of credit, too slow) is listed under `answers.failed` with why, in a stopped run's words. Kept in memory for an hour; a restart clears it. The island at a MacBook's notch reads it beside `GET /api/runs` |
| `POST /api/runs/{id}/cancel` | Abort a live run: 200 with the record; 409 with the record when it already finished; 404 when unknown |
| `GET /api/pinned-agent` | `{"agent": "<id>", "notchShown": true}`, the one of My agents pinned to the notch, which the Mac app's box (⌃⌥Space) opens with, or `{"agent": null, …}`; an agent taken out of My agents is no longer pinned. The box pins the agent it is switched to, and the first it sends to while none is pinned (`PUT /api/pinned-agent`). `notchShown` is `false` while Show at the notch is unticked in the Mac app's menu (it keeps `app-notch-off` in the state folder): the pin stays, but there is no island or ⌃⌥Space to reach the agent, so My agents says to turn it on. The island reads it beside `GET /api/runs`, and a message from its box goes into that agent's own chat through `POST /api/chat/messages` |
| `PUT /api/pinned-agent` | Pin `{"agent": "<id>"}` in place of any other, or unpin with `{"agent": null}`; only from `LoomWatch`'s own page (`X-LoomWatch-Request: 1`, else 403), and 404 for an id that is not one of My agents. Answers as `GET` does. Only the agent is kept, in `pinned.json` in the state folder |
| `GET /api/team-requests` | The pinned agent's requests for one of your teams (`ask_team`), oldest first: `{id, askedBy: {runId, agent, chatPath}, team: {path, name}, request, status, runId, problem, createdAt, finishedAt}`, `status` one of `waiting`, `started`, `declined`, `done`, `failed`. Waiting and started ones always; the others within `?finishedWithin=<seconds>`, and for an hour at most. Kept in memory; a restart clears them. The island reads it beside `GET /api/runs` |
| `POST /api/team-requests/{id}` | `{"decision": "start" \| "decline"}`. Start runs the team on the request as the person would (`team_needs_review` and spend limits apply; a refusal becomes `failed` with a plain `problem`); once it ends, its answer is sent into the agent's chat and starts its next turn. That chat message carries `handedBack: {teamPath, teamName, agent, fromAgent, request, heading}` in `GET /api/chat`, and the chat shows it as the team's; a page cannot set it. 404 for an unknown id, 409 once answered |

Request body:

```json
{ "teamPath": "research-team.yaml", "prompt": "Compare three note-taking apps for a small team." }
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
  "prompt": "Compare three note-taking apps for a small team.",
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
  frame is the entrypoint's `process`/`spawned` event. Nothing is started for it: each agent is
  a session of LoomWatch's own agent inside the daemon, and the event marks that session opening,
  in the same shape older runs were recorded in. Its `cwd` is the folder the agent works in, by its
  full path (absent in runs recorded before it), so a file its answer links from there
  (`./guide.html`) can be found even when a command made it.
- `status` moves forward only: `queued` → `starting` (the task began; `startedAt` set)
  → `running` (the first `process`/`spawned` event is archived; polled every 250 ms)
  → `succeeded` (`exitCode`, `eventCount`, `reply` = the responder's reply) or `failed`
  (`error` is the runner's message verbatim, plus `exitCode`/`eventCount` when the archive
  knows them) or `cancelled`. `finishedAt` is set on every terminal state. Terminal states
  never change.
- `mode` is `team` when the file has no edges and `pipeline` otherwise. `responder` is fixed from
  the optional root team-file setting; when that setting is absent, it falls back to the entrypoint
  in team mode and the last node of the topological order in pipeline mode.
- Cancel aborts the run task. Every agent's session ends where it is, delegated helpers are
  aborted with it, and a command an agent was still running is killed with everything it started
  (its process group, or on Windows its job). No cancellation event is archived; the run record is the source of truth for
  terminal classification.
- The registry is in memory: a daemon restart forgets `GET /api/runs`, while the archive
  keeps every event and `GET /api/sessions` still lists the session with its `prompt`.
- `trigger` is `manual` for `POST /api/runs` and `schedule` for routine runs (below).
  A run whose agent lost its way to its AI source (no network, the provider's address didn't
  answer, or the connection dropped part way) fails with `errorCode: "source_unreachable"`; one the
  source answered with a refusal (a refused key, no credit, a plan's limit) is `app_error`.
  `retryOfRunId` names the run this one tries again from the start. `nextTryAt` is set on a
  scheduled run that could not reach its source when its routine will try it again (below), in the
  same step as `failed`, so no reader sees the stop without it; it clears once that try starts or
  won't come, and is live only.
  `deliverTitle` is present when the run will publish its answer once it succeeds: the team's
  top-level `deliver`, or a routine's `schedule.deliver`. It is fixed at launch and not
  stored. `delivery` stays `null` until a delivery is decided, automatically after such a run
  succeeds, or by `POST /api/runs/{id}/deliver`, which sends any finished answer now: an optional
  `{ "title": "…" }`, `200` with the record (a refusal is recorded in `delivery`), 404 for an
  unknown run, 409 while it is live or already sending, 422 without an answer.
- `teamName` (the team file's `name`) and `agentNames` (each agent's name by id, its id when it
  has none) are fixed at launch, so a client that has not read the team file, such as the menu
  bar, can say who `working` is. Runs recorded before they were kept have neither.
- `spend` is what the run has spent and may spend on model calls, in US dollars: `{limitUsd,
  spentUsd, agents: {id: {spentUsd, limitUsd?, stopped?}}, added: [{agent?, atUsd, addUsd}],
  stopped?}`. `limitUsd` is the team's `spend.perRun` plus whatever was added this run (absent: no limit);
  an agent's `limitUsd` is its own guard. `spentUsd` adds up the dollars of every call of the run:
  the exact cost OpenRouter reported, or a Claude call's cost at list prices. Calls on the ChatGPT
  plan cost no dollars. `stopped` is `finished` once the operator finished the run at its limit,
  or `nobody_to_ask` once a scheduled run stopped there. It is stored with the run; runs recorded
  before spend limits have none.
- `spendStops` lists the limits the run is waiting at: `{id, agent?, name?, limitUsd, spentUsd,
  addUsd, since}`, with `agent` set when it is that agent's own guard. Every agent that reaches
  the limit waits at the same stop, and nothing is spent while it waits. It is live only, like
  `permissionRequests`. `POST /api/runs/{id}/spend` with `{ "stopId": "…", "decision": "add" |
  "finish", "addUsd": 0.5 }` answers one and returns `200` with the record. `add` grows this run's
  limit by `addUsd` (the stop's `addUsd` when absent; above $0 and at most $1,000, or 409). `finish`
  at the team's limit ends the run with what it has. At an agent's guard, it stops that agent and
  the rest of the team carries on. It returns 404 when the stop is no longer waiting. A run that
  ended at its limit has `stopReason: "spend_limit"`. If the operator finished it, it `succeeded`,
  with the last words an agent wrote as its `reply`. A scheduled run `failed` with `errorCode:
  "spend_limit"`. Either way its checkpoints are kept. The archive records `session_meta` events
  with `phase: "awaiting_spend"`, `"spend_answered"` (`decision`, `limitUsd`, `addedUsd`) and
  `"spend_stopped"` (`reason: "nobody_to_ask"`), each with the stop's `stopId`, `scope` (`team` or
  `agent`), `agent`, `limitUsd`, `spentUsd` and `addUsd`.
- `permissionRequests` lists what an agent is waiting on the operator for: `{id, agent, name,
  title, kind, switch, detail, since, expiresAt}`, plus `auto` (why Auto mode left a command to
  you, in a run in Auto mode) and `edit` (`{field, value}`: the whole command, when it may be
  changed before it runs). `kind` is the tool's kind (`read`, `search`, `edit`, `execute`, …) and
  `switch` the `allow:` switch that would let it through without asking. It is live only, emptied
  when the run ends and never stored. `POST /api/runs/{id}/permissions` with `{ "requestId": "…",
  "decision": "allow_once" | "allow_run" | "allow_team" | "deny" | "edit" | "answer", "text": "…" }`
  answers one and returns `200` with the record. `allow_run` lets that agent do the same thing
  again until the run ends; `allow_team` lets every agent in the run do it, and answers any agent
  already waiting on it. `edit` runs the command in `text` instead, this once. `answer` runs nothing
  and hands `text` back to the agent as the tool's result. Both need a `text` of at most 4,000
  characters; without one, or for an `edit` of a request that has nothing to change, it returns 409
  and the request keeps waiting. It returns 404 when that request is no longer waiting: it was
  answered, timed out after 10 minutes, or its run ended. The app's **Always allow** is `allow_run`
  plus switching that switch on for the agent in the team file. The archive records `session_meta`
  events with `phase: "awaiting_permission"` (with the request's `requestId`, `title`, `kind`,
  `switch`, `detail`, `expiresAt` and `autoNote`) and `phase: "permission_answered"` (`outcome`:
  `allow_once`, `allow_run`, `allow_team`, `allowed_for_run`, `auto_approved`, `deny`, `edited`
  with the command that ran as `edited`, `answered` with your words as `answer`, `timed_out`, or
  `not_asked` in a routine's run) between the request and the answer the agent gets. The team chat
  shows each asked request as the agent's message to you, answered there, and keeps how it was
  settled in the conversation. While a request waits, Details says the agent is waiting for you,
  and its timeline names what it asked to do: the call is open in the record, but has not run.

## Routines

A team file may carry a `schedule` block: run the team on a cron schedule with a fixed
prompt and deliver the canonical reply to the operator's connected Notion destination.
`teams/daily-news.yaml` is a complete example.

```yaml
schedule:
  cron: "0 8 * * *"             # 5-field cron, minute resolution (6/7-field seconds form also accepted)
  timezone: "Asia/Singapore"    # optional IANA zone; default: the daemon's local zone
  prompt: "Prepare the {{weekday}} {{date}} AI, tech and business news digest."
  enabled: true                 # optional, default true; "Run now" ignores it
  deliver:                      # optional
    notion:
      title: "AI, tech & business news — {{date}}"   # optional, default "{{team}} — {{date}}"
  retryAfterMinutes: [1, 2, 5, 10, 30]   # optional, this is the default; [] never tries again
```

- **Templates** in `prompt` and `title`: `{{date}}` → `YYYY-MM-DD`, `{{weekday}}` →
  `Thursday` and `{{time}}` → `08:00`, all read in the schedule's zone at fire time; `{{team}}` →
  the team `name`.
- **Delivery** for a routine is `schedule.deliver` when present, else the team's top-level
  `deliver`. The run registry publishes it like any other run's, and the routine
  reports the outcome as `lastDelivery`.
- **Cron** uses the standard 5-field numbering (`0` or `7` = Sunday, so `1-5` is Mon–Fri;
  names such as `Mon-Fri` work too). A 6/7-field expression is handed to the `cron` crate
  as written, where `1` = Sunday. `@daily`-style shorthands are accepted.
- **Trying again**: a timed run that fails with `errorCode: "source_unreachable"`, as one that
  fires in the first seconds after the computer wakes, before its network is back, is tried again
  from the start after each wait in `retryAfterMinutes` in turn: one new run per entry, with the
  same prompt and `trigger: "schedule"`, whose `retryOfRunId` names the try before it. At most 20
  waits of 1 to 1,440 minutes each. Each try starts the work over and pays for what it uses, under
  the team's spend limit; a try that lost its connection part way pays again for what it had
  done. Only that failure is tried again: a refused key, an ended sign-in, no credit or a plan's
  limit needs the person, and so does a run started with "Run now". The routine's next time, "Run
  now" or pausing the routine stops the wait, as does removing its `schedule` block.
- **Validation** happens in `TeamConfig::parse`: a bad expression, unknown zone, blank
  prompt or a wait out of range is a 422 from `PUT /api/team` and `POST /api/runs`, and the schema
  (`$defs.Schedule`) rejects unknown keys.

The scheduler is in memory. Every 30 s it rescans the teams root (hidden directories and a
team's own `<team>.files/` and `<team>.brief/` are skipped), recomputes a routine's next fire
only when its cron or timezone changed or it fired, and starts every enabled routine whose
time has passed through the same path as `POST /api/runs`. Fires missed while the daemon was down are skipped — `nextAt` is
computed from "now" at start. A routine whose previous scheduled run is still live skips
that fire and reports `problem: previous scheduled run <id> is still running`. A file whose
schedule does not parse stays listed with `problem` set and no `nextAt`. A try waiting to be made
is listed as `nextTryAt` and started by the first tick at or after it, so within 30 s. Nothing
about a routine (last run, last delivery, a try still to come) survives a restart.

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
  "problem": null,
  "nextTryAt": null
}
```

`describe` is a human summary for the simple shapes (daily, weekdays, weekends, one
weekday, hourly) and the cron text otherwise; `timezone` is `null` when the daemon's local
zone applies; `nextAt` is RFC 3339 UTC; `lastStatus` is read live from the run registry;
`deliver` is `null` when the routine delivers nowhere; `nextTryAt` is when the routine tries its
last run again, `null` when it isn't waiting to.

The team chat shows a routine's tries at one job as one piece, at its newest try: while it waits,
the try says when the schedule tries again, in place of the stop and its Try again; the try after it
has one line for the tries before it. A try the schedule will try, or has tried, again is not in
Needs you, its agent's face does not glow red, the team list says "Trying again soon", and the menu
bar says "couldn't connect, trying again soon" rather than "stopped with an error". The last try,
with none to come, is a stop like any other.

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
| `failed` | Nothing was written; `message` says why — `Notion is not connected yet. Open Connections, connect Notion under Tools, and choose the page answers go under.` when Notion isn't connected or no page is chosen, otherwise the same wording the Connections page uses for Notion's errors |

### Unattended runs

A routine only works if its agents never have to ask. A routine's run has nobody to ask, so
every request that an agent's `allow:` switches (or the team's Auto mode) do not already cover is
declined at once, recorded as `not_asked`, and the agent carries on without it. Reading inside an
agent's own folder and what it was given needs no switch; for a news digest, `web: true` is all
the agents need. [`examples/usecases/daily-tech-digest.yaml`](../examples/usecases/daily-tech-digest.yaml)
is the worked example: only its web switches are on. A routine also needs each of its agents' ways
of paying connected, and credit or plan allowance for its models. Before it fires, it checks every
agent's way of paying is connected; one that isn't is recorded as the routine's problem instead of
a failed run each time. One that fails for credit or a plan's limit mid-run shows up as a `failed`
run, not a delivery.

## Team-file revisions

Team GET/PUT responses include `revision: "sha256:<hex>"` and the corresponding quoted
strong ETag. Updates require `If-Match: "sha256:<hex>"`; creating a file requires
`If-None-Match: *`. Missing preconditions return 428; stale updates and existing create
targets return 412. Rejected writes leave the file unchanged.

The daemon serializes precondition checks and replacements among its API clients. Creation
uses an atomic no-overwrite link. External editors that do not participate in the daemon's
write lock can still change a file between its check and replacement. Save a copy never
silently overwrites an existing destination. The UI preserves local edits after a 412 and
lets the user compare, reload, or explicitly keep the local version.

## Models and how they are paid

Every agent is a session of LoomWatch's own agent inside the daemon, and calls the model its team
file names, paid the way its `model` says (ADR 0073): on the operator's ChatGPT plan, on their
Claude API credit, or through OpenRouter with their OpenRouter key. Each is connected in LoomWatch,
on Home or in Connections. Like the Notion connection, these routes are mounted only on a loopback
listener:

| Route | Result |
|---|---|
| `GET /api/ai` | `{ "openrouter": { connected, label, spent, limitRemaining, freeTier, checkedAt, problem } }`: what OpenRouter said about the key the last time it was checked. It never reads the key, so opening the app never brings up a Keychain prompt |
| `PUT /api/ai/openrouter` | `{ "key": "sk-or-…" }`: checks the key with OpenRouter, then keeps it. A key OpenRouter refuses is never kept (400) |
| `POST /api/ai/openrouter/check` | Asks OpenRouter about the kept key again |
| `DELETE /api/ai/openrouter` | Forgets the key |
| `GET /api/ai`, `anthropic` | `{ connected, label, models, checkedAt, problem }` for the Claude API key, from its last check |
| `PUT /api/ai/anthropic` | `{ "key": "sk-ant-api…" }`: lists the key's models with Anthropic, which costs nothing, then keeps it. A key Anthropic refuses, a Claude sign-in token (`sk-ant-oat…`) or an Admin key is never kept (400) |
| `POST /api/ai/anthropic/check` | Lists the kept key's models again |
| `DELETE /api/ai/anthropic` | Forgets the key |
| `GET /api/ai`, `chatgpt` | `{ available, connected, email, planUse, models, signedInAt, problem }`. `available` is false in a build without the `chatgpt` feature; `planUse` says whether the sign-in allowed plan use |
| `POST /api/ai/chatgpt/sign-in` | `{ "url": … }`: the address of ChatGPT's sign-in page for a new sign-in, which comes back to `GET /api/ai/chatgpt/callback` on `127.0.0.1` within 10 minutes |
| `POST /api/ai/chatgpt/check` | Lists the plan's models again, which also proves the sign-in still works |
| `DELETE /api/ai/chatgpt` | `{ chatgpt, revoked }`: asks OpenAI to revoke the sign-in, then forgets it; `revoked` says whether OpenAI confirmed |
| `GET /api/models` | The models an agent can use: OpenRouter's public catalog, cut down to the models that can call tools, with a short recommended list and the default, plus `anthropic` (the Claude key's models, ids `anthropic:…`, priced as OpenRouter lists them) and `chatgpt` (the plan's models, ids `chatgpt:…`, no price). Fetched when first asked for and kept an hour; the last copy is saved in the state folder, so the list still shows offline. 502 when there is no list at all |

Requests that change a key or a sign-in need the `X-LoomWatch-Request: 1` header the app sends, so
another site cannot set one.

`GET /api/usage?days=30`, served with the run history, says what LoomWatch's model calls used over
the last days: by source (with the last five hours and seven days), by day and by agent, from the
`model_calls` table every recorded call fills. Neither OpenAI nor Anthropic tells an app what is
left of a plan or credit, so the Usage page shows LoomWatch's own count and links to each company
for the rest. Its table names a helper after its agent ("Writer's helper 2"). Calls LoomWatch makes
outside a team's run show as LoomWatch: "Working out what your messages need" (`reader`, which
reads each chat message before the team starts on it) and "Learning from your feedback"
(`learner`).

`model` is `chatgpt:<slug>` on the ChatGPT plan, `anthropic:<id>` on the Claude credit, or an
OpenRouter id such as `anthropic/claude-opus-5.5`, and `thinkingEffort` its reasoning effort (an
effort written into the model, `…[high]`, still reads). Names written for an earlier LoomWatch
still load and are read as OpenRouter ids: `opus`, `sonnet` and `haiku` become
Anthropic's models, `gpt-…` OpenAI's and `gemini-…` Google's, an `openrouter/` prefix is dropped,
and a name LoomWatch does not know becomes the default model. `fake/offline` is the offline demo
(*Verifying without a model provider*, above).

Build blocks Run while an agent's way of paying isn't connected: the composer names it and who
needs it, and offers to move those agents to a connected source with the same models in one
click, or to connect it. A run started anyway (a routine, or a client of `POST /api/runs`) fails at
that agent with, for example, "This agent runs on your ChatGPT plan. Sign in with ChatGPT on
LoomWatch's Connections page, then run the team again." An agent never moves to another way of
paying by itself. A key refused later, credit run out or a plan's limit fails the turn with a
reason in plain words, such as "Your Claude API credit is used up." Its `turn_failed` note carries
`problem: { kind, source, url? }`, with `kind` one of `not_connected`, `key_refused`,
`out_of_credits`, `rate_limited`, `plan_limit`, `plan_not_eligible`, `plan_use_off` and
`sign_in_again`, so the app can offer the fix, such as **Manage usage**. A team whose agents all
run on `fake/offline` needs nothing connected.

A team file written for an earlier LoomWatch may carry a `spawn` block naming an AI app to start.
Only its `cwd`, the agent's folder, is read; `cmd`, `args` and `env` are accepted and ignored, and
nothing they name is ever started.

## Installation

The manifest lets supporting browsers install LoomWatch as a standalone app. Its service
worker caches only an offline explanation and the public app icon. If the daemon is
unreachable, the offline page explains how to reconnect. It does not cache team documents,
execution evidence, or credentials, and does not queue offline writes.
