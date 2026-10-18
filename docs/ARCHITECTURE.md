# LoomWatch — Architecture

How LoomWatch is put together, for people reading or changing the code.

---

## 1. Agent model — one engine, inside the daemon

Every agent LoomWatch runs is a **session of LoomWatch's own agent loop, inside `loomwatchd`**.
No other AI app is started and nothing is spawned per agent. There is no second kind of agent: a
team's researcher, the helper it recruits and the Ask assistant are the same loop with different
instructions and tools.

`crates/loomwatch-backend/src/agent/` is the loop:

- **A turn** adds the prompt to the conversation and streams the model's reply. It then works
  through every tool call the model asks for, each one allowed or declined first (see
  [Permissions](#permissions)). It ends when the model replies without a tool call, when the turn
  has made 200 tool calls, or when it is cancelled. A reply the length limit cut off is carried on
  (twice at most), and a tool call it cut off is sent back with the reason, so the model makes it
  smaller instead of repeating it. A long tool output is set aside behind an id the agent can read
  back. A conversation that nears the model's context window, or 160k tokens on a larger one, is
  replaced by a summary the model writes.
- **What the provider caches** stays the same from call to call: the tools offered (all of them
  from the first call), the opening instructions, and the conversation, which is only ever added
  to. The summary call offers the same tools, so it reads the conversation from the cache too.
  Each call carries the session's id, which keeps its calls on one OpenRouter route.
- **A provider** answers each model call. **OpenRouter** (`agent/openrouter.rs`) makes one
  streamed `POST /chat/completions` per call. The offline **Demo** (`agent/demo.rs`) answers
  without a model. It runs the offline demo team (`model: fake/offline`), which needs no key and
  no internet, and the tests.
- **Built-in tools** (`agent/tools/`) are `list_files`, `read_file`, `search_files`,
  `write_file`, `edit_file`, `run_command`, `update_plan` and `read_tool_output`. An agent
  allowed the web also gets OpenRouter's web search and fetch. Tools the daemon serves itself,
  such as the Team Bus and Ask's tools, come in through the `HostTools` trait.
- **Commands** run in the agent's work folder, through `/bin/sh -c` on macOS and Linux and
  `cmd.exe /d /s /c` on Windows (`agent/tools/command.rs`). Every provider key and LoomWatch
  setting is removed from their environment. A command stops at its time limit or when its turn
  is cancelled, with everything it started: its process group, or on Windows the job it runs in
  (`platform::ProcessTree`), which also ends whatever it leaves running when it finishes. On a
  Mac they also run in a Seatbelt sandbox (`agent/sandbox.rs`): they can change files only in the
  work folder and temporary folders, and reach the network only when the agent may use the web.
  Windows and Linux have no sandbox, so the permission check is the only line there.
- **The opening instructions** (`agent/prompt.rs`) are the same for every agent, so the
  provider's prompt cache keeps them. The team's role, task and "Done when" come in the first
  user message. Skills are listed by name and description only, from the agent's folder
  (`.agents/skills`, `.claude/skills`) and LoomWatch's skills folder. The agent reads a skill's
  `SKILL.md` itself when the task calls for it. An `AGENTS.md` in the work folder is read in as
  project notes.

`src/engine/` is the run engine, built on the `agent::Session` API. `AgentRun` is what the
pipeline, team mode, the Team Bus, chat and Ask hold for one agent: open a session, take a turn,
park, reopen, finish. `engine/bridge.rs` joins a session to its run:

- its events and permission records go down one channel to the run's `Recorder`, which writes
  them while the turn is still running;
- its permission requests go to the run's policy and operator;
- its Team Bus calls go straight to the bus.

A parked agent, waiting for the operator's answer or for work it delegated, is only data (a
`Snapshot`), kept in the `agent_sessions` table rather than in memory. Nothing runs while it waits.
Reopening it takes the row out, and the end of its stop or of its run removes whatever is left.

A session reports its work in the update shapes the archive has always stored
(`agent_message_chunk`, `tool_call`, `plan`, `usage_update`, …), under the same event kinds. A
run recorded when LoomWatch still drove other AI apps opens and replays the same way as a new one.

An agent's configuration is its role, its model, its work folder and what it may do without
asking. The model is an OpenRouter id (`vendor/model`), with an optional reasoning effort
(`vendor/model[high]`). `ai::openrouter_id` maps model names from older team files to OpenRouter
ids: Claude Code's `opus` and `sonnet` become Anthropic's, `gpt-…` becomes OpenAI's and `gemini-…`
Google's. A name it doesn't know runs on the default model. Older team files still have
`spawn.cmd`, `args` and `env`, which are read and ignored. Putting the reviewer on a different
model is a change to one row of the team file, not to code.

### The key

Models are reached through OpenRouter with the operator's own API key, entered on the
Connections page. The backend handles exactly one key, and it guards it:

- **Where it is kept.** `ai/keys.rs` keeps it in the macOS Keychain as `LoomWatch.OpenRouter`,
  and on Windows in Credential Manager (the `keyring` crate's Windows backend) as
  `api-key.LoomWatch.OpenRouter`. On Linux it is in `<state dir>/keys.json`, readable by this
  account only. `LOOMWATCH_KEY_STORE=file` uses the file on a Mac and Windows too, for trial
  copies. It covers connected tools' sign-ins as well (Notion's among them, ADR 0070), which then
  go in `<state dir>/tool-credentials.json`, so a trial copy with its own state folder never reads
  or writes any of the installed app's credentials. An
  `OPENROUTER_API_KEY` in the daemon's environment is ignored, and LoomWatch never looks for
  another app's credentials.
- **How it is checked.** A key is checked with OpenRouter before it is kept
  (`PUT /api/ai/openrouter`), and a key OpenRouter refuses is never kept. `GET /api/ai` reports
  the last check without reading the key, so opening the app never brings up a Keychain prompt.
- **Where it goes.** The key is held in an `ApiKey`: its `Debug` hides it and it has no
  `Display`. It goes into the one request header that carries it, and nowhere else. It never
  reaches an agent, a command's environment, a file, the archive or a log. Agents cannot read
  the state folder without asking, except its `skills` folder.

`ai/models.rs` holds the model catalogue. It is OpenRouter's public model list, cut down to the
models that can use tools. It is fetched when first asked for, kept for an hour, and saved in
the state folder so the list still shows offline. `GET /api/models` serves it.

`ai/reading.rs` reads an agent's whole setup for its model suggestion, and only once the operator
turns that on in Connections; it is off by default. The app suggests a model from an agent's name
and a few words of its instructions, for free (`ui/src/lib/team-file/modelSuggestion.ts`). When
those can't place an agent (`agentSetup.ts`, `needsReading`) and its model picker is open, the
app asks `POST /api/models/reading`. The daemon then asks TypeSafe's Jev (`typesafe/jev-1.14`,
pinned) on OpenRouter's Decisions API, with the operator's key, which kind of work the agent
does: gather, produce or check. The app's rules still apply after it: the team's answer stays on
the strongest model, and a check step uses another maker's model. Each answer is kept in
`model-readings.json` under a hash of exactly what was sent, so a setup is paid for once. The
daemon makes one call at a time, at most 50 a day, and none for ten minutes after one fails.
`model-reading.json` holds the switch and what readings have cost. Only the agent's own setup is
sent, by name: never a skill's text, a file, a folder's path, the Brief or its teammates. Its
instructions go as written, up to 6,000 characters, so whatever they mention goes with them.
`modelSuggestion.eval.test.ts` measures the suggestion with and without readings.

---

## 2. Backend — Rust

The backend is `loomwatchd`, a single binary the user runs locally. Its job:

- **Agent engine:** every agent's session, its tools and its run record (see §1)
- **Models:** the operator's OpenRouter key and the model catalogue (`ai/`)
- **Permissions:** what each agent may do without asking, and the operator's cards for the rest
  (`permissions.rs`, `auto_mode.rs`)
- **Team Bus:** the delegation tools agents call (see §3)
- **Pipeline orchestrator:** topological execution for drawn DAGs (see §4)
- **Skills:** LoomWatch's own skills folder, and installing skills into it (`skills_store.rs`,
  `marketplace.rs`, `skills_api.rs`)
- **Ask LoomWatch:** an assistant that builds and runs teams (`control/`)
- **Event archive:** one SQLite file, the durable and unbounded history
- **UI host:** serves the single-page web UI (static assets), a WebSocket for live events, and a
  REST surface (see §5)

**Why Rust:** the agent loop needs no vendor SDK. Every model call is one streamed HTTP request
in OpenAI's chat shape, through OpenRouter, so a JavaScript ecosystem advantage disappears. What
remains is the loop itself, running commands in a sandbox, streaming, storage and WebSocket work.
All of it fits in one binary with no language runtime for the user to install.

Run history lives in one SQLite file (`<state dir>/loomwatch.db`, or `--database`). It is built
into the program through `sqlx` with its versioned migrations, so installing LoomWatch needs
nothing else running. Every event is a `RunEvent` row, ordered by `UNIQUE(session_id, seq)`,
which is what makes a run replayable. How it stays fast as history grows:

- **One writer.** The file is opened in WAL mode with `synchronous=NORMAL`. One connection
  writes, and a few read-only ones read beside it without waiting. Run events go through a
  batching writer (`archive.rs`). It writes them in the order they were handed over, one
  transaction per 100 ms or 256 events, so a burst of streamed tokens is a handful of commits.
  Every read of `run_events` flushes the writer first, so nothing reads around a batch.
- **A summary per session.** `run_sessions` holds what the session list shows. A trigger keeps it
  as each event is inserted, so listing sessions costs the same at any history size.
- **Raw frames without repeats.** Each event keeps `raw`, the whole `session/update` frame it was
  recorded from. A tool update's frame carries its output again, which the projected payload
  already holds. So `raw` is stored as the frame minus the values it shares with `payload`,
  compressed when that is smaller (`archive/codec.rs`). It is read back byte for byte.
- **Search** in the Notebook is SQLite FTS5 with English stemming.

`loomwatchd backup <file>` writes a consistent copy while LoomWatch runs (`VACUUM INTO`). The
launcher saves one before every update. Versions before 0.5 kept the history in PostgreSQL in
Docker; 0.5.0 is the last release that copies such a history into the file. `loomwatchd` runs as a native process. The container
image (`Dockerfile`, `docker-compose.yml`) runs the same binary, with the state folder on a
volume. There the key is in `keys.json`.

### Permissions

Any tool call that reaches past reading the agent's own folder is a permission request. One
policy answers it (`permissions.rs`), from the agent's `allow:` switches (`web`, `commands`,
`edits`), its folder and the knowledge connected to it:

- **Approved on the spot:** reads and searches inside the agent's folder or its knowledge, a
  fetch with `web` on, a command with `commands` on, and an edit inside its folder with `edits`
  on.
- **Auto mode:** a team whose file says `permissions: {mode: auto}` (`auto_mode.rs`) also runs
  commands that only read or download without asking. Each command is judged from its command
  line alone. A fixed list always goes to the operator: deleting, pushing, publishing,
  credentials, and any command built from text.
- **Everything else** goes to the operator of the run through `PermissionAsker`, while the agent
  waits. The operator can:
  - allow it once, for this agent for the rest of the run, or for every agent in the run;
  - deny it;
  - edit the command or address, then allow it, and the agent runs the edited version;
  - answer in the agent's place, so nothing runs and the agent reads the answer as the tool's
    result.
- **Declined:** a request nobody answers within ten minutes, or one nobody can be asked about,
  such as a request from a scheduled run.

Every decision that was not the policy's own is recorded with who made it. Ask and one-turn
helpers have no policy, and they are offered no tool that would need one.

### Skills

Agents use the skills in LoomWatch's own folder, `<state dir>/skills/<name>/`.
`<state dir>/skills.json` records where each one came from (`skills_store.rs`). The Skills page
(`/skills`) fills the folder in three ways:

- **Install** from skills.sh, ClawHub or GitHub (`marketplace.rs`). The daemon downloads the
  skill into a staging folder and lists every skill folder in it with its license, files and
  scripts. It copies in only the ones the person picks. Nothing downloaded is run, and a skill
  whose license says "All rights reserved" is refused.
- **Bring in skills from your apps** copies skills from other AI apps' skill folders
  (`~/.claude/skills`, `~/.codex/skills`, …). It runs only when the person presses the button,
  and it reads skill folders only, never an app's settings or sign-in.
- **By hand:** a skill put in the folder directly.

Removing a skill moves its folder to `skills/.removed/`. The routes are in `skills_api.rs`.

A skill wired to an agent on the canvas is copied into that agent's workspace
(`.loomwatch/<team>/<agent>/.agents/skills`) by `workspace.rs`. A tool wired from another app's
MCP settings is not delivered (`delivery::WiredTool`): LoomWatch's agents don't take servers from
other apps' settings, which hold those apps' credentials. The run records the tool as unavailable
(`tools_unavailable`) and goes on without it.

### Ask LoomWatch

Ask (`control/`) is the same agent, on the operator's key and the model they chose, but outside
any run. It is kept open across turns and archived as its own session. It gets the LoomWatch
Control tools and nothing else: no files, no commands, no web. The tools are `list_teams`,
`read_team`, `list_models`, `propose_team`, `start_run`, `get_run` and `draft_review_note`, all
direct calls in the daemon. They read and propose. None of them writes a team file or answers a
review stop: a proposed team is shown on the canvas and saved only when the person presses Apply.

---

## 3. Team Bus — delegation as protocol

If an agent delegates by writing *"I'll have the reviewer look at this"*, no edge can be
drawn from it. So **delegation is a structured tool call** on the Team Bus (`team_bus.rs`).

Each agent in a run gets a `TeamBusConnection` that says which agent it is. The engine offers the
bus's tools beside the agent's built-in ones. A call goes from `TeamBusConnection::call` to
`TeamBus::call_tool` as a direct function call, with no network in between. Authorship, scope and
lineage come from the connection, never from a tool argument, so an agent cannot act as another.
The bus records each call itself, as a `Team Bus: <tool>` tool call, and the observed edges are
drawn from those records.

| Tool | Meaning | Edge drawn |
|---|---|---|
| `roster()` | Who's on the team, their roles, models and live status | none — discovery |
| `dispatch(agent, task)` | Fire-and-forget assignment (team mode only) | A → B · delegation |
| `ask(agent, question)` | Blocking ask / reply | A ⇄ B · query |
| `handoff(agent, task)` | Start a successor and stop (team mode only) | A ⇒ B · handoff |
| `report(status)` | Progress signal | none — node state |
| `ask_user(question, context?)` | A question for the person running the team. Returns at once; the answer arrives as the agent's next turn | none — the run waits on the operator |
| `memory_search`, `memory_read`, `memory_write`, `checkpoint` | The team's Notebook, when the team turns it on (see [TEAM_MEMORY.md](TEAM_MEMORY.md)) | none |
| `earlier_work(work)` | Read one earlier piece of the team's work in full. Offered in runs started from the app, which have a team chat to read | none |

The bus grants the *ability* to delegate. The *judgment* of when to comes with it:

- Each tool's description says what a brief must hold, because the agent it starts sees nothing
  but that text.
- The opening prompt's `## Your place in the team` section (`orientation.rs`) names the teammates
  the agent can hand work to, and who reads its work.

### Guards — enforced in the bus, never in prompts

A delegation loop running all night is the failure mode that actually costs money. These guards
are enforced server-side so no agent can prompt past them:

- **Depth cap:** `dispatch` carries a depth counter, refused past `guards.maxDispatchDepth`
- **Fan-out cap:** only `guards.maxConcurrentDispatches` background `dispatch`/`handoff` tasks
  may be outstanding
- **Cycle detection:** A → B → A is rejected

The agent loop adds one more: a turn stops after 200 tool calls (`max_turn_requests`). There are
no dollar budgets. Every model call is billed to the operator's OpenRouter account, and each
turn's record carries its tokens and OpenRouter's exact cost.

`handoff` marks the caller stopped in Team Bus status, but it does not cut the caller's turn
short. The tool tells the caller to end its turn, and the successor starts without waiting for
that.

What a `dispatch` or `handoff` agent replies comes back to the agent that started it. It arrives
as one more turn, once all of that agent's delegated work has finished, so the work reaches the
answer. An agent answering an `ask` may not start another agent. An `ask` is withdrawn when the
agent that asked ends its turn first: an answer nobody waits for is never worth its tokens.

---

## 4. Two execution modes

Which mode applies is decided by whether the user drew edges between nodes.

| | **Pipeline group** (edges drawn) | **Team group** (no edges) |
|---|---|---|
| Orchestrator | The backend | The entrypoint agent |
| Execution | Topological order, deterministic | Decided at runtime |
| Team Bus | Restricted — sequencing isn't the agent's call | Fully exposed |
| Observed edges | *Verify* the design; deviation is an anomaly | *Discover* what emerged |

Drawn edges fix the macro sequence, but an agent may still recruit helpers within its own step,
with a per-node lock available to forbid it.

---

## 5. Canvas, configuration and the web UI

- The add panel lists **jobs to hire** (role presets, each placed with working instructions on a
  model suited to its kind of work), **your agents** (ones you built or kept), **skills**,
  **connections** such as Notion, the team's **folders and files**, and **team memory**.
- Dragging a job or an agent onto the canvas instantiates an agent node. Its name, role, model
  (from the OpenRouter catalogue), working folder and what it may do without asking are set on
  the node.
- **Two edge layers render together:** configured edges (solid, drawn by the user, real
  constraints) and observed edges (animated, derived from Team Bus events).
- **The canvas is a visual editor over YAML on disk.** Team design stays diffable and
  reviewable. The canvas is not the source of truth; the files are. See
  [TEAM_CONFIG.md](TEAM_CONFIG.md).

`loomwatchd` serves a single-page web UI and a WebSocket for live events: you run the daemon and
open a browser, with no Electron. On a Mac, `LoomWatch.app` is only a launcher. It starts
`loomwatchd`, opens LoomWatch in the browser and stays in the menu bar.

- **Stack:** React + Vite + [React Flow](https://reactflow.dev) for the canvas, served by `axum`;
  `rust-embed` bakes the built `dist/` into `loomwatchd`, so the binary is self-contained.
- **Look and feel:** eye-catching and minimal. Few primary surfaces, one obvious action per
  screen, progressive disclosure of everything else. A run is drawn as Prompt → Run → agents →
  evidence → Output, projected from archived events, never from prose.
- **Installable:** the UI ships a PWA manifest, so "install as an app" gives a dock or launcher
  icon and a standalone window.
- **On this computer only:** the daemon listens on `127.0.0.1` and refuses requests from other
  sites; see [SECURITY.md](../SECURITY.md).

### Data model

```
Agent    { id, name, role, kind: harness|operator, spawn{cwd}, model,
           allow{web,commands,edits}, status }
Edge     { from, to, layer: configured|observed, kind: sequence|dispatch|ask|handoff, ts }
RunEvent { id, sessionId, agentId, seq, ts, kind: message|thought|tool_call|tool_update|
                                                   plan|permission|session_meta|usage|
                                                   turn_end|process }
```
