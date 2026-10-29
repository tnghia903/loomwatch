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
  [Permissions](#permissions)). It ends when the model replies without a tool call, when it has
  answered at its tool-call limit, or when it is cancelled. A turn may make 200 tool calls: the
  result of the 180th says how many are left (a summary made after it says so again), and after
  the 200th no call runs and the model is asked for its answer from what it has, once more with no
  tool it may call if it called one instead. That turn ends `max_turn_requests`, with the answer
  as its reply (ADR 0088). What the model writes alongside tool calls
  ("I'll read the notes first."), or before a web search its provider runs part way through a
  message ("Let me check the prices."), is recorded as said on the way, a paragraph of its own, and
  the turn's reply leaves it out unless it is all the turn wrote. A reply the length limit cut off
  is carried on (twice at most), and a tool call it cut off is sent back with the reason, so the
  model makes it smaller instead of repeating it. A reply may be 16,000 tokens long, or on a Claude
  key as long as the model's list says it writes, up to 64,000 and the room the context has above
  the point where it is summarised; a summary is never asked for more than 16,000. A reply Claude's provider pauses part way through
  the searches, page reads and code it runs itself is carried on within the same call, five times
  at most; one still paused after that is kept without the step the provider hadn't run (a
  conversation with a step that has no result is refused), and the model is told so and carries
  on, twice at most. Of both kinds together, at most four replies in a row are carried on with
  nothing run, whichever way they take turns and whether or not a summary comes between them;
  the next one ends the turn. How full the context is comes from the last of those requests, not their total, and within
  one request from what was sent, what the model wrote and the size of what those steps brought
  back: the provider's usage counts the conversation again for every step it ran. A long tool
  output is set aside behind an id the
  agent can read back. A conversation that nears the model's context window, or 160k tokens on a
  larger one, is replaced by a summary the model writes.
- **What the provider caches** stays the same from call to call: the tools offered (all of them
  from the first call), the opening instructions, and the conversation, which is only ever added
  to. The summary call offers the same tools, so it reads the conversation from the cache too, and
  so does the request for the answer at the tool-call limit. Only when the model calls a tool
  instead is it asked again with `tool_choice: none` and the same tools (with no tools on
  OpenRouter's chat completions), as a summary is.
  Each call carries the session's id, which keeps its calls on one OpenRouter route.
- **A provider** answers each model call. **OpenRouter** (`agent/openrouter.rs`) makes one
  streamed `POST /chat/completions` per call. A Claude from 4.6 on goes to OpenRouter's
  Anthropic-shaped `POST /messages` instead, through `agent/anthropic.rs`: there Claude's own web
  search is a block of its own between the words around it, where chat completions marks nothing.
  The offline **Demo** (`agent/demo.rs`) answers
  without a model. It runs the offline demo team (`model: fake/offline`), which needs no key and
  no internet, and the tests.
- **Built-in tools** (`agent/tools/`) are `list_files`, `read_file`, `search_files`,
  `write_file`, `edit_file`, `run_command`, `update_plan` and `read_tool_output`. A Word, Excel,
  PowerPoint, PDF or email file that `write_file` or `edit_file` changed is read back with the
  document readers, and a CSV or JSON file parsed; the tool's answer says whether it opens and
  what it holds (pages, sheets, slides, rows), or why not. Plain text and files over 10 MB aren't
  checked, and the check never fails the write. An agent allowed the web also gets OpenRouter's
  web search and fetch. Tools the daemon serves itself,
  such as the Team Bus and Ask's tools, come in through the `HostTools` trait. Calls a provider
  runs on its own side are recorded as finished tool calls named by what they were
  (`session.rs` `server_tool_title`): code Claude's web tools run is "Run code: <first line>"
  with what it printed, and a page or search that code started is named by its input, or by the
  page its result says it read.
- **Documents and pictures** (`documents.rs`): `read_file` reads a PDF, Word, Excel or
  PowerPoint file as numbered text, and an email (`.eml`, `documents/email.rs`, through
  `mail-parser`) as who wrote to whom and when, its subject, its words decoded from any transfer
  encoding and charset (HTML-only mail as its text), a forwarded message in its place and the other
  attachments by name and size; and it hands a PNG, JPEG, GIF or WebP picture to a model whose
  model list says it takes pictures, shrunk only past 2576 pixels on its long side. Each provider
  gets the picture its own way: inside Claude's `tool_result`, inside the plan's
  `function_call_output`, and on OpenRouter in a user message after the tool results. Every file
  is read in a short-lived `loomwatchd read-document` process with a time limit, so a damaged file
  costs nothing else. The same reader gives knowledge files their text.
- **Slides and Word documents as their pages** (`office.rs`, ADR 0091): the reader shows a deck as
  its slides, and a Word document as its pages, by asking `/api/files/pages`, which has `LibreOffice` (found by
  `platform::office_program`: on the search path as `soffice` or `libreoffice`, or where its
  installers and Homebrew put it) turn the file into a PDF, headless, with a profile of its own in
  `<state>/pages/profile`, one file at a time, for at most two minutes, in a process group ended
  whole if it takes longer. The PDF is kept in `<state>/pages/`, named by the file's path, size and
  last change, so a file is laid out once until it changes; the route answers it as `raw` answers
  a PDF. Without `LibreOffice` the route answers 404 and the reader shows the file's words.
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
  macOS refuses Apple Events from a sandboxed program unless its signature carries an Apple Events
  entitlement, which `/usr/bin/osascript` lacks. So at start the daemon signs a copy of
  `loomwatch-osascript` into `programs/` in its state folder, once for each build, and puts that
  folder first on commands' `PATH`. `loomwatch-osascript` (`crates/loomwatch-osascript`) is
  LoomWatch's own `osascript`: the same command line and output, through macOS's OpenScripting. A
  command can then work in Calendar, Mail or any other app once the person allows LoomWatch in
  System Settings → Privacy & Security → Automation. Calendar, Reminders, Contacts and Photos also
  ask macOS whether LoomWatch may have their data before they answer, so the app's `Info.plist`
  (`packaging/macos/Info.plist`) carries a line for each, shown under macOS's question: without
  that line macOS refuses at once and never asks the person. An app macOS quit to free memory
  stays listed as running, so AppleScript sends to it instead of starting it and gets
  "Application isn't running" (-600); `loomwatch-osascript` starts it again behind the front app
  and sends once more. The sandbox still holds the command's own writes, but not what an app it
  controls does (`SECURITY.md`). The app bundle carries `loomwatch-osascript` beside `loomwatchd`.
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
- **Fixed texts have ids** (`src/prompt_blocks/`). What an agent reads that its team file doesn't
  hold (the habits above, its place in the team, helpers, the built-in and Team Bus tools'
  descriptions, the items every check step checks) is made of `Block`s: a stable id such as
  `orientation.delegation`, and words with `{placeholders}` the code fills. `rendered.txt` there
  holds them as agents get them; a test fails at the first byte that differs, and
  `WRITE_RENDERED_PROMPTS=1` rewrites it after a change made on purpose. For the quality bench, a
  build with `--features prompt-overrides` can swap any block for a file:
  `loomwatchd --dump-prompt-blocks <dir>` writes each as `<id>.md` and lists the ids with their
  placeholders, and `LOOMWATCH_PROMPT_OVERRIDES=<dir>` starts the daemon with every file there in
  place of its block, for every agent. Any other file, or a placeholder the block doesn't fill,
  stops the start. Only the CI job that tests it turns the feature on, and a test checks that the
  program built without it holds no trace of the setting.

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
- **What a run made.** When a run ends, however it ends (finished, cancelled, cut off by a
  restart), the daemon reads its tool calls once, payloads only, and keeps the full paths its
  edit calls named in the run's `made` column (`made.rs`): calls that failed or that the person
  refused are left out, the same rule as the app's `filesWritten`, at most 100 per run. The run
  list sends it as `made`, so Home and a project's room show what the agents made without
  replaying any run. Runs recorded before it get theirs once, in the background, after a start.
- **A renamed team's history.** Rename moves the team file to the new name
  (`POST /api/team/rename`, `team_rename.rs`, ADR 0099), with `<team>.brief/`, `<team>.layout.json`
  and `<team>.files/`, and changes those names inside the file. One transaction files its `runs`,
  `chat_messages` and `work_passages` under the new path, gives rows filed by `path:<file>` the
  team's id, and names the files sent in the chat and the files its runs made in `<team>.files/`
  where they are now. The id never changes (one is written in for a team without it), so notes,
  lessons and the workspace, filed by id, stay put. The approval moves with the file only for the
  text that was approved, so a move never approves a team. It is refused while a run is live or a
  routine waits to try again, and the files go back when the history can't move.
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

### Projects

Projects hold the work, and My agents hold who does it (ADR 0097). A project is
`<teams root>/.projects/<id>.yaml` (`projects.rs`): its name, an About, folders every agent in it
may read, notes, the colour of its mark, and whether it is put away. A team names its project with
`project: <id>`; `TeamConfig::parse_in` reads the file with the team and gives every agent its
folders, `memory::TeamMemory::load_for` puts its About and notes first in the packet, and
`memory::notebook_scope` makes the Notebook the project's. A lesson the learner marks as about the
project becomes one of its notes. `GET /api/projects` lists each project with its teams' paths and
the teams in none; `PUT /api/projects/{id}` keeps one whole and `POST /api/projects/{id}/notes`
adds the person's note. The daemon keeps a copy of every team file once before the app moves each
team into a project of its own (`/api/move-into-projects`), through its normal save. Moving a
team to another project later is the same save, with only its `project` changed.

In the app, Home is the studio (`components/studio/`, `lib/projects/studio.ts`). Home and a
project's room open the same way, at a glance (`lib/projects/glance.ts`, `GlanceTiles`): four tiles
that keep their places. Needs you counts by the bell's own rules (`ticketsFrom`), so the two never
differ: what waits for the person, then work that stopped in the last day that the schedule won't
try again and that wasn't dismissed. Each has the one press that answers it: Review for work to
check, Answer for a question, a permission or a limit (on Home both open the bell's tray at that
item; in a room, the work itself); for stopped work, the fix LoomWatch knows for why it stopped
(`problemAction`, such as adding credits), or See why, which opens it in its chat. With nothing
waiting it shows the last work that went well. Then Working now; Next on a schedule in a room,
Finished today on Home; and This month, from the usage report (ADR 0073) so a ChatGPT plan is said as
a plan and a list-price estimate with "≈". Under the tiles a box gives a team work as its chat's box
does (`WorkBox`, `POST /api/chat/messages` to the team with `work`), named for the team it goes to,
with "To" when there is more than one. The first thing to do is the screen's one gold fill: the
first item's answer, or Start while nothing waits.

Home then has where the person left off (the newest things made, their chats with one agent, and
Chat with one agent), a card per project, and their agents in no project. A card lists the
project's teams, one per line, waiting first, then working, then stopped, then the next to run on a
schedule: a shape and words for how each is, its agents' figures, and its name opening its chat;
then the newest thing made there and this month's cost. A room (`/projects/<id>`) has its teams as
cards in the same order, kept while the person is in it, each with its desks, Move to and its
newest file; then Made here, everything its agents made, newest first, narrowed to one team by a
row of teams; and beside them the wall (About, folders, notes), Add an agent, New team and Ask
about the project. A made file opens in the reader over the page, with a link to ask about it in
its chat. An agent is lit only where it is now, gold at its own desk while it waits for the person:
where it is busy in another team, its figure is faint and unlit, naming that team. Where the person
checks, the desk holds the review step's ring, as on the canvas.

### Ask LoomWatch

Ask (`control/`) is the same agent, on the operator's key and the model they chose, but outside
any run. It is kept open across turns and archived as its own session. It gets the LoomWatch
Control tools and nothing else: no files, no commands, no web. The tools are `list_teams`,
`read_team`, `list_models`, `list_skills`, `list_jobs`, `read_job`, `list_my_agents`,
`list_tools`, `find_files`, `propose_team`, `start_run`, `get_run` and `draft_review_note`, all
direct calls in the daemon. They read and propose. None of them writes a team file or answers a
review stop: a proposed team is shown on the canvas and saved only when the person presses Apply.

Ask builds from what the person has (ADR 0096). Its first turn names their teams, My agents (with
the ids a team points at), skills, connected tools and ways of paying. `list_jobs` and `read_job`
give LoomWatch's built-in jobs from `schemas/built-in-jobs.json`, the list the app's palette and
agent builder place from (`ui/src/lib/library/roles.ts`), on the models `schemas/model-tiers.json`
gives each job. `list_my_agents` lists the person's agents, which a proposal points at with
`from: {agent}`. `list_tools` lists the connected tools by what each reads and changes.
`find_files` (`control/find.rs`) finds a folder or file by the person's words: first among what
their teams and agents already read, then below their home folder and, on a Mac, iCloud Drive and
each folder in `~/Library/CloudStorage`, at most five folders deep, skipping hidden folders, app
data and bundles, within 40,000 folders and 3 seconds. It reads names only, and lists a found
folder's first eight names. A folder near the top it wasn't allowed to open (macOS asks the person
before an app reads Documents, Desktop or Downloads) is named in its answer, so Ask can say how to
allow it rather than "not found". Ask is told never to ask the person for a path.

`propose_team` checks a proposal as a run would read it, before it reaches the canvas: an agent
that points at one of My agents is filled in from it, a skill must be installed, a tool connected,
and a folder or file it connects, or a folder an agent works in, must be on this computer. What the
saved team already names is let through. A check step that doesn't say how it sends work back gets
`sendBack: {rounds: 2, whenStillNotMet: ask}`, as the editor writes it, and a new team that sets no
`spend` gets `perRun: 1.00`, or `2.00` when it has three or more agents or a check step that sends
work back. Ask's first turn also says whether this computer is a Mac, where an agent's commands run
in a sandbox: there Ask gives a maker or the Analyst the edits and commands switches, so a newcomer
isn't asked to approve each program it runs; elsewhere they ask first.

Every agent Ask makes is saved to My agents and joins other teams as it is, so Ask writes its
instructions and Done when for its kind of work and puts what the request is about into the team
and its project (ADR 0097). Each agent's `part` says what this team needs from it, with Done when
items of its own, which the agent reads under `## Your part in this team` and which come first in
the Done when its check step checks. `propose_team` takes the team's `project`: one of the
person's by `{id}`, or a new one as `{name, about, folders}`, which Apply keeps before it saves the
team; a new team given neither works in a new project of its own. Its first turn lists the
person's projects, and in a project's room (`AskContext.project`) Ask is told the project's About,
folders, notes and teams. A `brief` becomes a note in the team's project when Apply runs; for a
team in no project, a Brief note beside it, written after the team file and joined to it with a
second save. Saving a team keeps the
folders and files it connected to a new agent as the team's (`specOf` in `myAgents.ts`): an agent
reads something of its own only when its builder gives it.

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
| `my_agents()` | The person's other agents in My agents the team's starting agent may bring in for a part no one on the team does, by `mine+<id>` (ADR 0092; off unless `guards.myAgents` > 0) | none — discovery |
| `dispatch(agent, task)` | Fire-and-forget assignment (team mode only). `mine+<id>` brings in one of My agents | A → B · delegation |
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

The agent loop adds one more: a turn makes at most 200 tool calls, then is asked for its answer
and ends (`max_turn_requests`). There are
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

**What the message says done looks like (ADR 0098)** is checked in both modes, as a bounded loop
on the agent whose reply is the answer, never as an edge. `runs::execute` starts the read
(`message_done::read`, one turn of the fast model) beside the run and hands the run a
`MessageDone` on its `RunLineage`; the API's `POST /api/runs/{id}/done-when` changes the same one.
Only the run's own task writes to its archive, so `MessageDone::record_in` writes each change as a
`done_when` event from the run's `EventLog`, and `close` writes the last before the run's events
are counted.

- **A check step on the answering agent** gets the message's items first in `check_items`, and
  `send_back_with_message` decides its rounds. It sends back through the Team Bus
  (`Author::Bus`), as every check step does.
- **Anywhere else** — team mode's root (`run_answerable_session`, between `open_and_work` and
  `finish_live`) or a pipeline's unchecked last stage — `check_the_answer` starts LoomWatch's own
  checker (`AgentConfig::checker`, the built-in Checker job) in the answering agent's own folder,
  so the files the reply names are where it looks, with the work as `answer.md` in the run's own
  `answer_folder` outside it, under a `PermissionAsker::reading_only` and with nothing switched on.
  Its rounds are `run_checks`'s, sending
  back into the answering agent's open session through `work_round` (`Author::Open`).
- **A number in digits is measured**: `CheckReading::settle` holds Met without a number in its
  evidence to Not sure (`measured`), for every check.

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
at the top middle of every screen shows `island.html`, a second page of the same build. Around a
MacBook's camera it draws the island; a screen without a notch has one drawn in the middle of its
menu bar, as wide as the MacBook's notch (or a 14-inch MacBook Pro's) and as tall as that menu bar,
and the same island around it (`island::with_drawn_notches`, decision 12). Only on a screen showing
no menu bar (Displays have separate Spaces off) does the panel draw nothing until its box is called
(decision 11); the app's menu bar face comes back only while no screen has the island
(`island::menu_bar_face_shows`). With the app's own API calls the page reads the runs and the
messages agents answer in the chat without starting a run (`GET /api/chat/answering`), and answers
a permission.
A figure that is out (peeking below the notch, or in front in the list's row) follows its run's
events, as the run view does, only while it is drawn, and acts out what its agent is at with the
moves of the run view's figures (`workPhase`), bobbing until the events arrive; in the menu bar a
figure at work only breathes and dips, with no connection. Each panel places its page, tells it where the pointer is, and takes the pointer only over what the
page reports. The panel on the screen the pointer is on is live: the list and the box open there,
and what the box's agent does drops out there. The teams' news (questions, results, stops) pops out
at the notch, drawn or not, of the screen the pointer is on, and stays where it was while the
pointer is on a screen with none (`island::news_screen`). A pointer at a screen's very top edge is on that screen
(`Rect::holds_pointer`, as `NSMouseInRect` has it). Results looked at on one island leave the others
(the app passes `seen` between the pages). When `WebKit` ends a page's process (a crash, or the
page breaking one of `WebKit`'s rules), the app gives back the keyboard that page held, so another
screen's island can be live, and loads the page again (`NotchPanels::page_gone`): at once up to
three times a minute, then after 30 seconds (`island::Reloads`). At rest the island is even either side of the camera:
the pinned agent's figure on the left, or LoomWatch's mark when none is pinned and no team is at
work, and the right side empty until there is something to say. Unticking **Show at the notch** in the app's menu
writes `<state dir>/app-notch-off`, closes every panel, stops watching the pointer and gives
⌃⌥Space back; the face is in the menu bar instead until it is ticked again. `loomwatchd` reads the
same file to answer `notchShown` with the pin, so My agents says to turn the notch on rather than
promise ⌃⌥Space. The box writes to the agent pinned to the notch, else the first of My agents;
switching it to another (Tab, or one of the figures beside it) or sending to one not yet pinned pins
that one (`PUT /api/pinned-agent`, kept in `<state dir>/pinned.json` by `pinned.rs`), so the box
and the island share one agent. Its figure opens its workbench under the box: the builder's 3D
bench (`AgentFigure`, read only, always in the island's dark), from the same view and labels the
builder makes (`components/agents/benchOf.tsx`), acting out the agent's newest run in its chat. It
loads with three.js only once the page is under way: the screen the pointer is on sets it up out of
sight once the pointer has been there a few seconds (`ISLAND_WAITS.benchSetUp`), not as the box
opens, where setting it up froze the box (over a second the first time after an update, while
`WebKit` compiled its shaders again), and keeps it for a while after the pointer leaves
(`ISLAND_WAITS.benchKept`). It moves into the box as the box opens and out again as it closes, set
up once (`useBenchHost`), so it is there at once under the box and when the message goes; switched
to another agent, the box hands the same bench that agent (`WorkbenchScene.set(view, another)`),
put in place as it is rather than set up again. After a message is sent, the box gives way to the
agent at its workbench for a moment (`ISLAND_WAITS.bench`), and at a notch for as long as the
pointer stays on it; without a notch it then tucks into a pill at the top of the screen, the agent
at a little desk, whose workbench opens while it is pointed at. For the agent in the box:
- the island's list opens with a box to message it, and ⌃⌥Space (a Carbon hot key), or Message
  in the app's menu, opens it from any app, on the screen the pointer is on; the message goes into that agent's own chat (`.jobs/.bench/<id>.yaml`, written as the
  agent is saved), as its Chat tab would send it, with anything dropped onto the notch as the
  chat's attachments. The panel takes the keyboard only while that message is written (focus may
  move on to Copy, Open in LoomWatch or Start; Escape gives it back), without bringing `LoomWatch` to
  the front. `AppKit` finds what ⌘V, ⌘C, ⌘X, ⌘A, ⌘Z and ⇧⌘Z do in the app's main menu, so the app
  has one that nobody sees, with only an Edit menu in it (`edit_keys.rs`): ⌘Q, ⌘W or ⌘H meant for
  the app in front still find nothing in `LoomWatch`;
- its answer is read whole before Copy can take it, and Copy carries it twice: as HTML
  (`island/answerHtml.ts`, loaded only then) for apps that paste formatting, and as plain text
  whose links keep their addresses. In the app, Copy writes both to the clipboard
  (`NotchPanels::copy`);
- a drag of a file, text or a link near the top is noticed by the drag pasteboard changing while
  the button is held (macOS sends other apps no pointer events once a drag begins, so the app
  checks every 50 ms then), and the whole panel takes the pointer so the drop lands in the page;
- files another app writes only once they are dropped (file promises: a message from Mail, a
  picture from Photos) the app takes itself (`IslandWebView::performDragOperation`), because
  `WebKit`'s own way of taking them ends the page's process. When a drag promises its files both
  the old way and the new, as Mail does, only the new are asked (`island::promises_to_ask`); the
  files are written into a new folder in the user's temporary folder, each kept once
  (`island::received_once`), and the page asks for them through a file picker the app answers
  (`ToPage::Dropped`, `pickFiles` in `island/dropped.ts`), so they arrive as a file from Finder
  does. + at the start of the box's field asks through the same picker; with no dropped files
  waiting, the app answers it with an Open panel (`choose_files` in `notch_panel.rs`), above the
  island. That is the one time `LoomWatch` comes to the front: it stays there while the box is
  written in after, so typing goes to the box, and the app that had the front has it again once the
  box gives back the keyboard, unless the person has gone to another app since. Chosen or
  cancelled, the box asks for the keyboard again;
- what is waiting shows file by file (`FileTile` in `island/PinnedAgent.tsx`), as the team chat
  holds files before they go: a picture drawn from the file itself, any other file as a page with
  its corner folded and its extension on it, each with × to take it out (`withoutFile`). As the
  message goes, each file has a line until its upload ends, then a tick (`uploaded` in
  `useIsland`). While files wait, the list shows two teams' rows and counts the rest, so the box
  keeps its room in the panel;
- what is dropped goes in only as far as the box's agent can open it (`island/readable.ts`, the
  twin of `documents::Kind::of` and `read_file`'s check for text). A HEIC, TIFF or BMP picture is
  turned into a JPEG in the page first (`createImageBitmap` and a canvas, at most 2,576 px on its
  longest side, as a model is sent). A file it can't open, one over 25 MB, a folder, or an
  eleventh file stays out, and a line for each reason under what went in says why and what to do
  instead; it stays while what went in waits. A later drop's files join those waiting
  (`withDropped` in `island/intake.ts`), so the PDF made from a refused file goes with them. A Mail message is
  called by its subject and offered email jobs;
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
           allow{web,commands,edits}, from{agent}, part{text,doneWhen}, status }
           # part: what this team needs from the agent (ADR 0097), always the team's.
           # from: one of My agents (.jobs/<agent>.yaml, ADR 0094). The team file then holds only
           # the team's fields; name, role, model, skills, tools, reads, doneWhen and allow are
           # filled in from the agent's file when the team is read (my_agents.rs, myAgents.ts).
Edge     { from, to, layer: configured|observed, kind: sequence|dispatch|ask|handoff, ts }
RunEvent { id, sessionId, agentId, seq, ts, kind: message|thought|tool_call|tool_update|
                                                   plan|permission|session_meta|usage|
                                                   turn_end|process }
```
