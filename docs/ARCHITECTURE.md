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
  has made 200 tool calls, or when it is cancelled. What the model writes alongside tool calls
  ("I'll read the notes first."), or before a web search its provider runs part way through a
  message ("Let me check the prices."), is recorded as said on the way, a paragraph of its own, and
  the turn's reply leaves it out unless it is all the turn wrote. A reply the length limit cut off
  is carried on (twice at most), and a tool call it cut off is sent back with the reason, so the
  model makes it smaller instead of repeating it. A long tool output is set aside behind an id the
  agent can read back. A conversation that nears the model's context window, or 160k tokens on a
  larger one, is replaced by a summary the model writes.
- **What the provider caches** stays the same from call to call: the tools offered (all of them
  from the first call), the opening instructions, and the conversation, which is only ever added
  to. The summary call offers the same tools, so it reads the conversation from the cache too.
  Each call carries the session's id, which keeps its calls on one OpenRouter route.
- **A provider** answers each model call. **OpenRouter** (`agent/openrouter.rs`) makes one
  streamed `POST /chat/completions` per call. A Claude from 4.6 on goes to OpenRouter's
  Anthropic-shaped `POST /messages` instead, through `agent/anthropic.rs`: there Claude's own web
  search is a block of its own between the words around it, where chat completions marks nothing.
  The offline **Demo** (`agent/demo.rs`) answers
  without a model. It runs the offline demo team (`model: fake/offline`), which needs no key and
  no internet, and the tests.
- **Built-in tools** (`agent/tools/`) are `list_files`, `read_file`, `search_files`,
  `write_file`, `edit_file`, `run_command`, `update_plan` and `read_tool_output`. An agent
  allowed the web also gets OpenRouter's web search and fetch. Tools the daemon serves itself,
  such as the Team Bus and Ask's tools, come in through the `HostTools` trait. Calls a provider
  runs on its own side are recorded as finished tool calls named by what they were
  (`session.rs` `server_tool_title`): code Claude's web tools run is "Run code: <first line>"
  with what it printed, and a page or search that code started is named by its input, or by the
  page its result says it read.
- **Documents and pictures** (`documents.rs`): `read_file` reads a PDF, Word, Excel or
  PowerPoint file as numbered text, and hands a PNG, JPEG, GIF or WebP picture to a model whose
  model list says it takes pictures, shrunk only past 2576 pixels on its long side. Each provider
  gets the picture its own way: inside Claude's `tool_result`, inside the plan's
  `function_call_output`, and on OpenRouter in a user message after the tool results. Every file
  is read in a short-lived `loomwatchd read-document` process with a time limit, so a damaged file
  costs nothing else. The same reader gives knowledge files their text.
- **Files sent in the chat** (`chat_files.rs`, ADR 0082) are kept in `<team>.files/chat/`, a
  folder `PermissionPolicy::for_run_agent` lets every agent of the team read. The run carries them
  on `RunLineage::files` (a note on `QueuedNote::files`), and they are listed by path under the
  task as each agent's prompt is composed, so the run's own `prompt` stays the words that were
  typed. The agent a message reaches first gets its pictures on the user turn itself
  (`Message::User { pictures }`, `Session::prompt_showing`), within the conversation's picture
  limits; each provider writes them before the words, in its own shape. The turn's archived user
  message lists them under `pictures`.
- **Commands** run in the agent's work folder, through `/bin/sh -c` on macOS and Linux and
  `cmd.exe /d /s /c` on Windows (`agent/tools/command.rs`). Every provider key and LoomWatch
  setting is removed from their environment. A command stops at its time limit or when its turn
  is cancelled, with everything it started: its process group, or on Windows the job it runs in
  (`platform::ProcessTree`), which also ends whatever it leaves running when it finishes. On a
  Mac they also run in a Seatbelt sandbox (`agent/sandbox.rs`): they can change files only in the
  work folder and temporary folders, and reach the network only when the agent may use the web.
  Windows and Linux have no sandbox, so the permission check is the only line there. For an agent
  that may use the web, a `sitecustomize.py` written for each command and put first on
  `PYTHONPATH` gives Python's `urllib` the name `LoomWatch/<version>` in place of
  `Python-urllib/3.x`, which Read the Docs refuses; a name the script sets itself still wins.
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
asking. The model says how it is paid (ADR 0073), with an optional reasoning effort
(`vendor/model[high]`):

| Paid by | `model` | Example |
| --- | --- | --- |
| OpenRouter | an OpenRouter id, `openrouter:…`, or an older short name | `anthropic/claude-opus-5.5` |
| The operator's ChatGPT plan | `chatgpt:<slug from the plan's model list>` | `chatgpt:gpt-6.1-sol` |
| The operator's Claude API credit | `anthropic:<Anthropic model id>` | `anthropic:claude-opus-5-5` |

`ai::ModelRef` reads it (`parseModelRef` in `ui/src/lib/ai/modelIds.ts` is its twin, with the same
test cases), and `ModelRef::on` names the same model on another source:
`anthropic:claude-opus-5-5` is `anthropic/claude-opus-5.5` on OpenRouter, and `chatgpt:<slug>` is
`openai/<slug>`. A model never moves to another source by itself: an agent on a source that isn't
connected stops with a problem that names it. For anything that isn't `chatgpt:` or `anthropic:`,
`ai::openrouter_id` maps model names from older team files to OpenRouter ids: Claude Code's
`opus` and `sonnet` become Anthropic's, `gpt-…` becomes OpenAI's and `gemini-…` Google's. A name
it doesn't know runs on the default model. Older team files still have
`spawn.cmd`, `args` and `env`, which are read and ignored. Putting the reviewer on a different
model is a change to one row of the team file, not to code.

### Keys and sign-ins

Models are reached three ways, each connected on the Connections page (ADR 0073): the operator's
OpenRouter key; a Claude API key from the Console organization linked to their Claude Max or Team
plan, which spends the plan's monthly API credit; and their ChatGPT Plus or Pro plan, through
OpenAI's Sign in with ChatGPT for open-source apps (`ai/chatgpt.rs`: PKCE, a callback on
`127.0.0.1` under `/api/ai/chatgpt/callback`, the ID token's issuer, audience, expiry and nonce
checked). A Claude sign-in is never used: Anthropic doesn't allow it in other apps. The ChatGPT
source is behind the `chatgpt` Cargo feature, on by default, so a build can leave it out. The
backend guards all three:

- **Where they are kept.** `ai/keys.rs` keeps the OpenRouter key in the macOS Keychain as
  `LoomWatch.OpenRouter`, and on Windows in Credential Manager (the `keyring` crate's Windows
  backend) as `api-key.LoomWatch.OpenRouter`. The Claude key and the ChatGPT refresh token share
  one more item, `LoomWatch.Plans` (`plans.LoomWatch.Plans` on Windows), so updating LoomWatch
  asks about one more Keychain item, not two. ChatGPT's access token lives in memory only. On
  Linux they are in `<state dir>/keys.json` and `<state dir>/plans.json`, readable by this
  account only. `LOOMWATCH_KEY_STORE=file` uses the file on a Mac and Windows too, for trial
  copies. It covers connected tools' sign-ins as well (Notion's among them, ADR 0070), which then
  go in `<state dir>/tool-credentials.json`, so a trial copy with its own state folder never reads
  or writes any of the installed app's credentials. An
  `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the daemon's environment is
  ignored, and LoomWatch never looks for another app's credentials.
- **How they are checked.** A key is checked with its company before it is kept
  (`PUT /api/ai/openrouter`, `PUT /api/ai/anthropic`, which lists the key's models for free), and
  a key that is refused is never kept. A ChatGPT sign-in is kept only once its ID token checks
  out, and lists the plan's models. `GET /api/ai` reports each one's last check from status files
  (`openrouter.json`, `anthropic.json`, `chatgpt.json`) without reading a secret, so opening the
  app never brings up a Keychain prompt.
- **Where they go.** A key is held in an `ApiKey`: its `Debug` hides it and it has no `Display`.
  It goes into the one request header that carries it, and nowhere else. It never reaches an
  agent, a command's environment, a file, the archive or a log, and `redact` cuts anything shaped
  like a key or a JWT out of an error. Agents cannot read the state folder without asking, except
  its `skills` folder.

### How a model is paid

`engine::provider_for` turns an agent's `ModelRef` into its provider: `agent/openrouter.rs` (Chat
Completions), `agent/anthropic.rs` (the Messages API: thinking blocks replayed byte for byte, with
the `thinking-binding-controls` beta as a safety net, and summaries sent with the same tools and
`tool_choice: none`) or `agent/chatgpt.rs` (the Responses API as plan usage takes it: `store:
false`, the system prompt in `instructions`, tools in a `loomwatch` namespace, reasoning items
replayed; a web search's results, which the API shows only inside the response that ran it, handed
back after their step as the output of a `web_results` call). Each call's `Usage` says who paid (`paid_by`): a ChatGPT call costs $0 and counts against
the plan, and a Claude call is priced from the list prices OpenRouter's catalogue shows (or
`agent::list_price`), marked `cost_estimated`. Spend limits count dollars only. A refusal comes back
as a `Problem` (`not_connected`, `key_refused`, `out_of_credits`, `plan_limit`,
`plan_not_eligible`, `plan_use_off`, `sign_in_again`) that the app turns into a button, such as
Manage usage. Every call is a row in `model_calls`, filled from the run events, and
`GET /api/usage` sums it by source, day and agent for the Usage page: neither OpenAI nor Anthropic
tells an app how much of a plan or credit is left. `scripts/mock-vendors.py` stands in for both
companies in end-to-end checks.

Each model tier (`schemas/model-tiers.json`, ADR 0057) names its model first; then a connected plan
that offers it pays, else OpenRouter, else a connected plan's own model for the tier
(`ModelTiers::model_on`, and `modelForTier` in the app).

`ai/models.rs` holds the model catalogue. It is OpenRouter's public model list, cut down to the
models that can use tools. It is fetched when first asked for, kept for an hour, and saved in
the state folder so the list still shows offline. `GET /api/models` serves it.

### What agents know about you

The operator can tell every agent their name and a few lines about themselves: what they do, the
language they want answers in, how much detail they like. They write it in the first run or on the
About you page (`/you`), which ask the same three questions (what you do, answer in, how long), each
choice writing one plain sentence into the text, and `you.rs` keeps it in `<state dir>/you.json`
(0600), not in a team file. `agent/prompt.rs` puts it in every agent's instructions: the first
sentence names them, and `## The person you work for` quotes their words and says to follow what
they ask of answers unless the task says otherwise. That covers team steps, check steps, one-agent
chats, the builder's test bench, scheduled runs and Ask LoomWatch. The helper that rewrites agents'
instructions is left out, so a language preference never translates them. With nothing saved, the
instructions are exactly as before. The text goes to OpenRouter with each agent's work, and the page
says so.

`ai/reading.rs` reads an agent's whole setup for its model suggestion, and only once the operator
turns on Let AI choose (`AiChoice.tsx`), off by default, under the suggestion in an agent's model
list. The app suggests a model from an agent's name and a few words of its instructions, for free
(`ui/src/lib/team-file/modelSuggestion.ts`). When those can't place an agent (`agentSetup.ts`,
`needsReading`), its model list shows how sure the suggestion is, and with the toggle on, an open
list asks `POST /api/models/reading`. The daemon then asks TypeSafe's Jev (`typesafe/jev-1.14`,
pinned) on OpenRouter's Decisions API, with the operator's key, which kind of work the agent
does: gather, produce or check. The app's rules still apply after it: the team's answer stays on
the strongest model, and a check step uses another maker's model. Each answer is kept in
`model-readings.json` under a hash of exactly what was sent, so a setup is paid for once. The
daemon makes one call at a time, at most 50 a day, and none for ten minutes after one fails.
`model-reading.json` holds the switch and what readings have cost. Only the agent's own setup is
sent, by name: never a skill's text, a file, a folder's path, the Brief or its teammates. Its
instructions go as written, up to 6,000 characters, so whatever they mention goes with them.
`modelSuggestion.eval.test.ts` measures the suggestion with and without readings.

An agent with `followsSuggestion: true` in its team file follows its suggestion (ADR 0072): a team's
own agent added in the app starts that way, picking the suggestion in its model list sets it, and
picking any other model takes it out. `ui/src/lib/team-file/useModelFollowing.ts` watches the open
team: when a following agent's configuration settles after a change, it works the suggestion out
again (with a reading when Let AI choose is on) and moves `model`, and the model list says what it
was, with Undo, which pins it back. The team as it opened is left as it is, except who pays: a
following agent whose model a plan connected since offers moves onto that plan. A following agent
moves from OpenRouter onto a plan, or onto its tier's first choice, but never onto OpenRouter by
itself. The daemon never reads the flag; a run uses `model`.

---

## 2. Backend — Rust

The backend is `loomwatchd`, a single binary the user runs locally. Its job:

- **Agent engine:** every agent's session, its tools and its run record (see §1)
- **Models:** the operator's keys and ChatGPT sign-in, the model catalogue, and what each call
  used (`ai/`, `archive/usage.rs`)
- **Permissions:** what each agent may do without asking, and the operator's cards for the rest
  (`permissions.rs`, `auto_mode.rs`)
- **Team Bus:** the delegation tools agents call (see §3)
- **Pipeline orchestrator:** topological execution for drawn DAGs (see §4)
- **Skills:** LoomWatch's own skills folder, and installing skills into it (`skills_store.rs`,
  `marketplace.rs`, `skills_api.rs`)
- **Ask LoomWatch:** an assistant that builds and runs teams (`control/`)
- **Schedules:** runs a team at its `schedule` time and tries again a run that couldn't reach its
  AI source (`schedule.rs`)
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
- **Finding in a team's chat** (`chat_find.rs`, ADR 0081) searches every request, answer, note and
  line of the agents' talk (handovers, check verdicts, questions, Team Bus messages), cut into
  passages of at most 1,200 characters in `work_passages`. The words are matched on a copy that
  LoomWatch folds itself, because SQLite's `remove_diacritics` leaves `đ` alone: lower case,
  accents off, `đ` as `d`, so "da nang" finds "Đà Nẵng". A word of four letters or more, or the
  one still being typed, also finds longer words; an English plural or verb ending comes off
  ("clipping" finds "clip"). Triggers on `runs` and `chat_messages` queue what changed; a
  background task indexes it, and every search indexes what is still queued first.
  `GET /api/chat/find?teamPath=&q=` returns the pieces that hold the most of the words first,
  each with the lines that matched, named as the chat names them so the app opens the chat at
  that very line.

`loomwatchd backup <file>` writes a consistent copy while LoomWatch runs (`VACUUM INTO`). The
apps' Update and restart saves one before it installs a release, and so does the source launcher's
`update` before it rebuilds. Versions before 0.5 kept the history in PostgreSQL in
Docker; 0.5.0 is the last release that copies such a history into the file. `loomwatchd` runs as a native process. The container
image (`Dockerfile`, `docker-compose.yml`) runs the same binary, with the state folder on a
volume. There the keys are in `keys.json` and `plans.json`.

### Schedules

`schedule.rs` keeps the routines in memory. Every 30 s it rescans the teams root and starts each
team whose `schedule` time has come, through the same `runs::launch` as `POST /api/runs`. A
follower task watches each run it started to the end, for its delivery.

A computer that wakes at a routine's time often has no network for its first seconds. A turn that
can't reach its AI source fails with `AgentError::Network`, which `engine` carries as an
`AppReportedError` marked `unreachable`, and the run is recorded with
`errorCode: "source_unreachable"`. Each timed run, and each try of one, is launched knowing the next
wait in `schedule.retryAfterMinutes` (1, 2, 5, 10 and 30 minutes by default), so the registry puts
`nextTryAt` on the run in the same step that marks it failed: no reader sees the stop alone. The
follower then gives the routine that try to make, and the first tick after its time starts it: a
new run with the same prompt, whose `retryOfRunId` names the run before it, so the tries read as one
job. A source that answered (a refused key, no credit, a plan's limit) is not tried again, and
neither is a run started with Run now: those need the person. The routine's own next time, Run now,
or pausing the routine lets a waiting try go.

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
`read_team`, `list_models`, `list_skills`, `propose_team`, `start_run`, `get_run` and
`draft_review_note`, all direct calls in the daemon. They read and propose. None of them writes a
team file or answers a review stop: a proposed team is shown on the canvas and saved only when the
person presses Apply. A skill Ask gives an agent is wired by name (`kind: skill`), as the canvas
wires one, from the skills `list_skills` reports, the same list a run delivers from. A proposal
that wires a skill no run could find is refused, unless the saved team already wires it.

---

## 3. Team Bus — delegation as protocol

If an agent delegates by writing *"I'll have the reviewer look at this"*, no edge can be
drawn from it. So **delegation is a structured tool call** on the Team Bus (`team_bus.rs`).

Each agent in a run gets a `TeamBusConnection` that says which agent it is. The engine offers the
bus's tools beside the agent's built-in ones. A call goes from `TeamBusConnection::call` to
`TeamBus::call_tool` as a direct function call, with no network in between. Authorship, scope and
lineage come from the connection, never from a tool argument, so an agent cannot act as another.
The bus records each call itself, as a `Team Bus: <tool>` tool call. The team's chat shows those
records as what the agents said to each other, and Details' timeline marks them; they are not
drawn on the canvas.

| Tool | Meaning | Recorded as |
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

In team mode each teammate keeps one conversation for the run. A lead that sends work back ("fix
this") reaches the same conversation, so the teammate keeps its sources and what it was told, and
the lead need not paste the earlier work back in. A teammate still working is never waited for: a
call that finds it busy starts a separate copy, as before. At most `guards.maxConcurrentDispatches`
teammates hold a conversation; past that, each call starts fresh. Every kept conversation closes
when the run ends.

---

## 4. Two execution modes

Which mode applies is decided by whether the user drew edges between nodes.

| | **Pipeline group** (edges drawn) | **Team group** (no edges) |
|---|---|---|
| Orchestrator | The backend | The entrypoint agent |
| Execution | Topological order, deterministic | Decided at runtime |
| Team Bus | Restricted — sequencing isn't the agent's call | Fully exposed |
| Recorded delegations | *Verify* the design | *Discover* what emerged |

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
- **The canvas draws configured edges** (solid, drawn by the user, real constraints). What the
  agents asked and handed each other in a run is read in the team's chat and its Details, not
  drawn here.
- **The canvas is a visual editor over YAML on disk.** Team design stays diffable and
  reviewable. The canvas is not the source of truth; the files are. See
  [TEAM_CONFIG.md](TEAM_CONFIG.md).

`loomwatchd` serves a single-page web UI and a WebSocket for live events: you run the daemon and
open a browser, with no Electron. On a Mac, `LoomWatch.app` is only a launcher. It starts
`loomwatchd`, opens LoomWatch in the browser and stays in the notch (ADR 0083): a see-through panel
at the top middle of every screen, around the camera on a MacBook, shows `island.html`, a second
page of the same build. With the app's own API calls it reads the runs and the messages agents
answer in the chat without starting a run (`GET /api/chat/answering`), and answers a permission.
A figure that is out (peeking below the notch, or in front in the list's row) follows its run's
events, as the run view does, only while it is drawn, and acts out what its agent is at with the
moves of the run view's figures (`workPhase`), bobbing until the events arrive; in the menu bar a
figure at work only breathes and dips, with no connection. Each panel places its page, tells it where the pointer is, and takes the pointer only over what the
page reports. Only the island on the screen the pointer is on is live: it opens the list and drops
questions and answers out, while the others stay at rest beside their notch, so nothing comes and
goes as the pointer moves between screens. A pointer at a screen's very top edge is on that screen
(`Rect::holds_pointer`, as `NSMouseInRect` has it). Results looked at on one island leave the others
(the app passes `seen` between the pages). At rest the island is even either side of the camera:
the pinned agent's figure on the left, or LoomWatch's mark when none is pinned and no team is at
work, and the right side empty until there is something to say. Unticking **Show at the notch** in the app's menu
writes `<state dir>/app-notch-off`, closes every panel, stops watching the pointer and gives
⌃⌥Space back; the face is in the menu bar instead until it is ticked again. `loomwatchd` reads the
same file to answer `notchShown` with the pin, so My agents says to turn the notch on rather than
promise ⌃⌥Space. One of My agents can be pinned to the notch
(`GET`/`PUT /api/pinned-agent`, kept in `<state dir>/pinned.json` by `pinned.rs`):
- the island's list opens with a box to message it, and ⌃⌥Space (a Carbon hot key) opens it from
  any app; the message goes into that agent's own chat (`.jobs/.bench/<id>.yaml`, written as the
  agent is saved), as its Chat tab would send it, with anything dropped onto the notch as the
  chat's attachments. The panel takes the keyboard only while that message is written (focus may
  move on to Copy, See answer or Start; Escape gives it back), without bringing `LoomWatch` to
  the front;
- its answer is read whole before Copy can take it, and Copy carries it twice: as HTML
  (`island/answerHtml.ts`, loaded only then) for apps that paste formatting, and as plain text
  whose links keep their addresses. In the app, Copy writes both to the clipboard
  (`NotchPanels::copy`);
- a drag of a file, text or a link near the top is noticed by the drag pasteboard changing while
  the button is held (macOS sends other apps no pointer events once a drag begins, so the app
  checks every 50 ms then), and the whole panel takes the pointer so the drop lands in the page;
- the pinned agent may ask one of the person's teams to do part of a job (`my_teams`, `ask_team`
  on the Team Bus, `team_requests.rs`): the request waits at `GET /api/team-requests` until the
  person presses Start (`POST /api/team-requests/{id}`), the team runs as any run, and its answer
  is sent back into the agent's chat, which starts the agent's next turn. That message is stored
  with `handed_back` (the team, its answering agent, the request and the words before the answer),
  so the chat shows it as the team's, under its name and that agent's figure, not as the person's.
  Only the daemon sets it: `POST /api/chat/messages` ignores one sent from a page.

`notch_panel.rs` is the one module in the workspace that calls `AppKit` directly.

- **Stack:** React + Vite + [React Flow](https://reactflow.dev) for the canvas, served by `axum`;
  `rust-embed` bakes the built `dist/` into `loomwatchd`, so the binary is self-contained.
- **Teams open in place:** going to another team (the team rail, Home, Back and Forward) changes
  the address without a page load (`ui/src/lib/team-file/teamPage.ts`). The next team's file is
  read first, then the team's own part of the page, canvas included, starts fresh under a new
  React key, as it would on a load. The page frame, the team rail and the app's own data (what
  waits on you, the teams, your saved agents, the schema's checker) stay. With changes not saved,
  the move is a page load, so the browser asks first.
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
