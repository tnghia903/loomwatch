# Team configuration contract

LoomWatch team files are YAML documents validated against
[`schemas/team.schema.yaml`](../schemas/team.schema.yaml). The initial contract is schema
version `1`; readers must reject a version they do not understand instead of guessing.

The root document stores stable, user-authored configuration only: the team identity,
entrypoint, optional responder, guard policy, agents, and configured pipeline edges. Observed edges,
agent status, and run events are runtime records kept in the run archive (SQLite). Their shared wire
shapes are defined as `$defs.Edge` and `$defs.RunEvent` in the same schema, so every reader
references one contract.

See [`examples/research-team.yaml`](../examples/research-team.yaml) for a complete team.

## Agents

Every agent runs on LoomWatch's own agent, inside the `loomwatchd` daemon. Nothing else is
started, and there is no other app to install or sign in to. Each agent is a session in the daemon.
It calls its model through [OpenRouter](https://openrouter.ai) with your OpenRouter API key, and
works with LoomWatch's own tools (see [Tools an agent has](#tools-an-agent-has)).

An agent needs an `id`, a `name`, a `role` and a `model`:

```yaml
agents:
  - id: researcher
    name: Researcher
    role: Research the question and report what you find, with a source for each finding
    model: anthropic/claude-sonnet-5.5
    thinkingEffort: medium # optional
    allow:
      web: true
```

- **The key.** You enter it in LoomWatch, with **Add your OpenRouter key** on Home or under
  **AI models** in **Connections…**. LoomWatch checks a key with OpenRouter and keeps it only if
  OpenRouter accepts it. On a Mac it is kept in the Keychain as `LoomWatch.OpenRouter`, and on
  Windows in Windows Credential Manager. On Linux it is kept in `<state dir>/keys.json`, which only
  your account can read. An `OPENROUTER_API_KEY`
  in the environment is ignored. The key goes to OpenRouter and nowhere else: never to an agent, a
  command an agent runs, a team file, the run archive or a log. Without a key, a run stops before
  its first model call and says to add one.
- **`model`** is an OpenRouter model id (`vendor/model`), such as `anthropic/claude-opus-5.5` (what
  new agents get) or `openai/gpt-6.1-sol`. The model picker lists the OpenRouter models that can use
  tools. `fake/offline` is the offline demo model: it answers with fixed text and calls no model,
  so it needs no key.
- **`thinkingEffort`** says how hard the model reasons. LoomWatch sends it to OpenRouter as
  `reasoning.effort`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, with `ultra`
  read as `max`. If it is absent or set to `default`, the model decides. The older combined form
  `model[effort]`, such as `openai/gpt-6.1-sol[high]`, still works, and `thinkingEffort` wins when
  a file has both. LoomWatch's built-in jobs and starter teams set the effort by job: `low` for
  tidying, `medium` for most work, `high` for checking, analysis and code.
- **`spawn`** is optional, and only `spawn.cwd` is used: the agent's work folder. It may be absolute
  or relative to the team file's folder, and the folder must exist. Without `spawn`, the agent works
  in the team file's own folder. Write it only when the work folder matters:

  ```yaml
    - id: builder
      name: Builder
      role: Fix the failing test in this project
      model: anthropic/claude-opus-5.5
      spawn: { cwd: ../my-project }
      allow: { edits: true, commands: true }
  ```

  An agent may still start in a folder LoomWatch prepares for it instead. See
  [Where an agent starts](#where-an-agent-starts).

### Older team files

Team files written for an earlier LoomWatch, which started an AI app for each agent, still load
as they are:

- `spawn.cmd`, `spawn.args` and `spawn.env` are accepted and ignored, like the retired `budget`.
  Nothing is started, and no variable in `env` reaches anything. Writers must not add them.
- An old `model` name is read as an OpenRouter id, by the daemon and by the app alike:

  | In the team file | Read as |
  |---|---|
  | `opus` or `best` | `anthropic/claude-opus-5.5` |
  | `sonnet` | `anthropic/claude-sonnet-5.5` |
  | `haiku` | `anthropic/claude-haiku-5.5` |
  | `default`, or empty | the default model, `anthropic/claude-opus-5.5` |
  | `claude-<name>-<version>`, such as `claude-sonnet-5-5` or `claude-haiku-4-5` | `anthropic/claude-sonnet-5.5`, `anthropic/claude-haiku-4.5`; a `[1m]` suffix is dropped |
  | `claude-<name>` without a version | `anthropic/claude-<name>-5.5` |
  | `gpt-…`, `o3…` or `o4…`, such as `gpt-5.5` | `openai/gpt-5.5` |
  | `gemini-…`, such as `gemini-3.8-flash` | `google/gemini-3.8-flash` |
  | `openrouter/<id>` or `openrouter:<id>` | `<id>`, such as `openai/gpt-6.1-sol` |
  | any other `vendor/model`, `fake/offline` included | kept as written |
  | anything else | the default model, `anthropic/claude-opus-5.5` |

  Loading never changes the file. The model picker shows the id a name is read as, and choosing a
  model writes that id.

## Semantic rules

JSON Schema validates each value's shape. Loaders must additionally enforce the rules that
depend on the document as a whole:

- Agent IDs are unique, and `entrypoint` names an agent in `agents`. An agent (`kind: harness`, the
  default) without a `model` is refused.
- Optional `responder` names the agent whose reply becomes the canonical team output. In pipeline
  mode it may name any agent in the configured pipeline; later stages still run, but their replies
  do not replace the selected output. In team mode it must equal `entrypoint`, because the entrypoint
  owns the self-organizing root turn. When omitted, compatibility inference applies: `entrypoint`
  responds in team mode and the last topological pipeline stage responds in pipeline mode. A
  pipeline that ends on a review stop answers with the work approved there, not with what you typed
  to approve it: the stage feeding the stop responds (through stops in a row, and then the
  check-step rule below). A final stop fed by more than one stage responds itself.
- An optional `schedule` block (`$defs.Schedule`) turns the team into a routine: `cron`
  must parse (standard 5-field form with `0`/`7` = Sunday, or the 6/7-field seconds form),
  `timezone` must be an IANA zone when present, and `prompt` must not be blank. Loaders
  reject the document otherwise. See `WATCH.md` → *Routines*.
- An optional top-level `deliver` block (`$defs.Deliver`) sends every successful run's answer
  somewhere besides the Run view, whoever started the run. Today that is `notion: {title?}`, a new
  child page of the page chosen on the Notion tool's card in Connections. The default title is
  `{{team}} — {{date}} {{time}}`, and a blank `title` is rejected. A routine's own
  `schedule.deliver` wins for scheduled runs. The canvas writes it from the Team response's
  **Send every answer to Notion**. See `NOTION.md`.
- An empty `edges` array selects team mode: the entrypoint receives the initial goal and
  self-organizes. A non-empty `edges` array selects pipeline mode: the backend executes the
  graph, and `entrypoint` must be a source node with no incoming configured edge.
- Edge endpoints name agents in the same document, self-edges are rejected, and duplicate
  configured edges with the same `from` and `to` are rejected.
- Configured edges form a directed acyclic graph. Every configured edge has
  `layer: configured` and `kind: sequence`.
- Pipeline dataflow follows the configured edges, not just the linearized run order: each
  non-entrypoint node's prompt is built from the replies of its own configured predecessors,
  looked up by `to`/`from`, not from whichever node happens to run immediately before it in
  `pipeline_order()`. A node with exactly one configured predecessor receives that
  predecessor's reply verbatim (so every linear chain, including
  [`examples/research-team.yaml`](../examples/research-team.yaml), is unaffected). A node
  with more than one configured predecessor — a join in the DAG, e.g. a diamond `a→b`,
  `a→c`, `b→d`, `c→d` — receives every predecessor's reply, each labeled with its agent ID
  and concatenated in the order those edges are declared in the team file, so a branch is
  never silently dropped. Only the entrypoint (`pipeline_order()`'s first node) receives the
  run's original prompt.
- Every edge and run-event `ts` must parse as RFC 3339 or the loader rejects it. The schema
  `format` keyword is an annotation in Draft 2020-12 and must not be relied on for this;
  the companion `pattern` constrains shape only, so the loader still range-checks the
  fields. RFC 3339 spells its literals case-insensitively, so the lowercase `t` and `z`
  separators are accepted on read. LoomWatch emits the uppercase form.
- Team files must not contain credentials. An agent needs none, and `spawn.env` is ignored.
- A team file says which models its agents use and what they may read and do without asking. So a
  file that did not come from LoomWatch's editor shows a review before its first run, and its
  schedule waits until the operator trusts it. The review says, for each agent, "Researcher runs on
  LoomWatch with anthropic/claude-sonnet-5.5", which switches it has on, and what it can read.
  Approval covers the file's exact bytes, so a file changed outside the editor is reviewed again.
- Optional `Agent.doneWhen` is up to five short statements (each at most 160 characters) that
  the finished result must satisfy. They are stated under the role as `## Done when`; the agent
  checks its result against them before it replies, fixes what it can, and lists any it could not
  meet under `## Not met`. A later stage and any check step read it with the work. On the team's
  answer, the daemon takes it off the end, with a `## Missing` list (the Writer job's) and
  `## Not changed` (below). It records them as a `session_meta` `answer_notes` event, which the
  verdict beside the answer shows, so what is delivered is the work alone. No second turn
  is taken on the agent's own say-so: a check step with `sendBackOnce` is what sends work back.
- Optional `Agent.checks` makes a pipeline agent a check step. It names the agent whose work it
  checks, which must hand its work straight to it. That agent writes no summary for it.
  - **What it is handed.**
    - The work as written.
    - What that agent was given: each stage result that fed it (one part per stage at a join), the
      operator's direction from a review stop, and what the team knows. These share
      `conversation.check.givenChars` fairly (8,000 by default; 0 shows none). A part longer than
      its share keeps its head and tail.
    - The numbered items the work must satisfy: the agent's `doneWhen` (or "Does what the request
      asked" when it has none), then always "No claim contradicts its source or the request".
  - **How it checks.** It traces each claim to what the agent was given first. Then it checks for
    itself every claim it cannot trace and every claim the work rests on: it opens the source,
    reads the file or runs the check. Nothing caps how many.
  - **How it answers.** It ends its reply with a `## Check` block, one numbered line per item
    (`1. Met | Not met | Not sure — item — evidence`), and every problem it found must be a Not
    met line there.
  - **Reading the block.**
    - Each line is matched to its item by its words, or else by its number.
    - Lines may put the verdict first or the item first, be numbered or not, use bold or a mark
      such as ✅, or be table rows.
    - An item it leaves out is Not sure ("Not checked"). Met with no evidence is Not sure, and
      "partly met" is Not met.
    - A line naming none of the items is kept as a problem of its own.
    - A reply with no readable block is recorded as unreadable (`readable: false` on the
      `check_result` event), and the answer then says the check could not be read.
  - **The answer.** When the pipeline ends on a check step and no `responder` is set, the checked
    agent's reply is the team's answer, and the checks show beside it.
  - **A check step mid-pipeline.** It hands the stages after it the work it checked (as revised),
    followed by what it could not confirm. Its own reply is not handed on, and it writes no handover.
  - **`sendBackOnce: true`.**
    - Missed checks go back to the checked agent's open session once, with what the check step
      wrote about the problems.
    - They go as findings that can be wrong: the agent changes a fact only when a finding's
      evidence is stronger than its own source. It lists what it kept under `## Not changed`,
      which is set aside from the answer like `## Not met`.
    - The recheck covers only the items that were Not met or Not sure, plus what the revision
      changed. It is told that a reason under `## Not changed` is not evidence. An item it leaves
      out keeps a Met it had.
  - **What is recorded.** Every round is recorded as a `check_result` event. A send-back is
    recorded as `check_sent_back` (with its round, findings and problem text) before the turn it
    starts, or as `check_send_back_skipped` when the checked agent had already finished. The team
    chat shows each round as an exchange: what was sent back, the revised work as the reply, and
    the next verdict. A round with nothing missing is one line.
  - **Defaults.**
    - The daemon treats a missing `sendBackOnce` as off, so existing files behave as before.
    - LoomWatch's editor turns it on whenever it makes a check step: the "Research, write and
      check" template, and connecting work into a Checker.
    - So does Ask's `propose_team`, for a proposed check step that does not set it.
    - The checkup suggests it for any other check step. Without it, the check costs about half a
      run and changes nothing in the answer.
    - The editor sets the check step's effort from one table keyed by the checked agent's job:
      high for every job, for now.
  - **Verdict words.** A verdict word is read as a whole word, so "Metrics …" is not "Met".
  - Operator nodes may not set either field.
- `spend.perRun` (team level) is what one run may spend on model calls, in US dollars. Absent
  means no limit; new teams and the starter teams are written with `1.00`. Every agent of the run draws on it: stages, the lead, Team Bus helpers,
  summaries, checkpoints and handovers. The daemon adds up the exact cost OpenRouter reports for
  each call. Before each call, an agent whose run has used its figure waits, and the run shows a
  stop: "Add $0.50 and carry on" grows this run's figure (the file is not changed), and "Finish
  with what it has" ends the run as done, with the last words an agent wrote as its answer, stop
  reason `spend_limit`, and its checkpoints kept. A scheduled run has nobody to ask: it fails with
  code `spend_limit`, says so, keeps its checkpoints and delivers nothing. A call's cost is known
  only after it is made, so the calls under way when the figure is reached, one for each agent at
  work, can take a run a few cents past it.
- `spend.perRun` on an agent is that agent's own guard, for an agent that runs away; there is
  none unless set. At it, that agent waits, and "Stop it here" ends its turn with what it wrote
  while the rest of the team carries on. Operator nodes spend nothing and may not set it. The
  monthly cap, which also covers Ask LoomWatch and every schedule, is a limit on the OpenRouter
  key itself, set at openrouter.ai.
- `spend.web` (team or agent level) is how much web reading one model call may do, for an agent
  allowed the web. A page read stays in the conversation and is read again on every later call.
  - `maxPageTokens` (default 16000, about 12,000 words): how much of one page is read. A longer page
    is cut.
  - `maxPages`: pages one call may read.
  - `maxSearches`: searches one call may run.
  - `maxSteps`: searches and page reads together in one call.

  The last three have no default: absent leaves them to OpenRouter (30 steps a call). Quality
  comes first, so a lower figure waits for a quality benchmark to show the work stays as good. On
  an agent, each figure it leaves out is the team's, and one left out everywhere is the default,
  so a file without the block behaves as described. A figure outside the schema's range refuses
  the file. The daemon sends them as OpenRouter's server-tool `parameters` (`max_content_tokens`,
  `max_uses`) and `max_tool_calls`. A model whose provider refuses them is asked again without
  them, and reads the web without them for as long as the daemon runs, so a run never fails over a
  limit.
- `budget` (team or agent level) is retired.
  Readers accept it in any shape and ignore it, so older team files still load; writers must not
  add it. `spend` replaced it.
- `usage` payloads are discriminated (`$defs.UsagePayload` in the schema). An agent's
  `sessionUpdate: "usage_update"` carries how much of the model's context is in use and the cost
  OpenRouter reported. Older runs may also hold a bare `costUsd` delta. Both are archived as a
  record only. Older runs may also hold LoomWatch's own `phase: "budget_warning"` events; nothing
  writes them now.
- `guards.maxDispatchDepth` and `guards.maxConcurrentDispatches` both default to `8` when
  absent. The Team Bus refuses delegation beyond the depth limit and refuses a background
  `dispatch` or `handoff` while the configured number of those tasks is still running.
  Delegation lineage and concurrency permits are server-owned, so callers cannot forge the
  counter, erase an ancestor to bypass cycle detection, or race past the fan-out cap.
  Synchronous `ask` calls do not consume a background-dispatch permit. `Agent.allowRecruiting`
  defaults to `true`; `false` forbids that agent from recruiting helpers within its own
  pipeline step.
- `handoff` starts the target as a background task and marks the caller's roster status as
  `stopped`, but it does not end the caller's current turn. The caller must return after a
  successful handoff; its model calls go on until that turn ends.
- What a `dispatch` or `handoff` agent replies comes back to the agent that started it: once all
  of its delegated work has finished, that agent gets one more turn with each reply (or why it
  failed), and its reply to that turn is its answer. Each result is also archived as a
  `session_meta` event with `phase: "delegated_result"`.
- An agent answering an `ask` answers from what it has: it may not start another agent with `ask`,
  `dispatch` or `handoff`, though it may still `ask` an agent whose session is open. An `ask` is
  withdrawn when the agent that asked ends its turn before the answer comes back; the answering
  agent's turn is stopped (archived as `turn_interrupted` with reason `ask_withdrawn`), or a helper
  started for it is ended.
- `status` is a runtime annotation. Team-file writers must not persist it, and team-file
  readers must ignore it if an older or external document contains it.
- Run-event IDs are unique. `RunEvent.agentId` names an agent in the team document. `seq`
  is strictly increasing per session across all agents and is the sole replay order;
  timestamps are descriptive and do not replace sequence order.
- A `tool_update` event's `callId` matches a prior `tool_call` in the same session, and the
  update's `seq` is greater than the tool call's `seq`.

Paths in `spawn.cwd` may be absolute or relative. A relative path is resolved against the
directory containing the team file, and the folder must exist when the run starts.

## Capabilities

`agents[].capabilities` lists what the daemon delivers to an agent before it runs. A skill is
`{ kind: skill, name }`, where `name` is the skill's name in the Library:

```yaml
capabilities:
  - { kind: skill, name: report-design } # copied into the agent's folder, required in its prompt
```

See [`examples/capability-delivery.yaml`](../examples/capability-delivery.yaml) for a team that
wires one.

Team memory is not a capability: wire another team's memory or an imported pack through
`memory.inherits` (see [Team memory](TEAM_MEMORY.md)).

**Knowledge** is a folder or file you chose, so it always has a `path`. The agent panel's
**Add folder…** and **Add file…** write it,
and `name` is only its label:

```yaml
capabilities:
  - { kind: knowledge, name: Market research, path: /Users/me/Documents/Market research } # linked
  - { kind: knowledge, name: Q3 memo.pdf, path: news-desk.files/Q3 memo.pdf }              # added
```

On the canvas every folder or file is one card, keyed by its `path`, with a line from each agent
whose `capabilities` name that path. Drawing a line from another agent adds the same `path` to it
under a label of its own; taking the last line away keeps the card in `<team>.layout.json` with its
`path`. Skills named in the team file get a card the same way, whether or not the layout file has
one.

Knowledge without a `path` fails the run and says to add it again: a name alone points at nothing.

A **folder** is linked where it is: the agent gets its top-level listing and README, plus a read
grant for the folder, so each run sees what is in it then. A **file** added in
the panel is copied beside the team file under `<team>.files/`, and a relative `path` resolves
against the team file's folder (`~/` against your home folder). The agent gets the file's text,
up to 12,000 characters, and a read grant for that one file. A PDF's text is extracted with
`pdftotext` when it is installed (`brew install poppler`); without it, the agent is told where the
PDF is. When a file is longer than that, the prompt carries its opening, and the full text is put
in the prepared folder as `knowledge/<file>`, which the prompt names. Only `knowledge` may have a
`path`.

Knowledge can also be a **Notion page**, named by `notion.page` (its page id) instead of a `path`;
`name` is the page's title when it was chosen. Drag **Notion** from **Connections** in the add panel
onto an agent and choose the page; see [Notion](NOTION.md#give-an-agent-a-notion-page-to-read).

```yaml
capabilities:
  - kind: knowledge
    name: Q3 roadmap
    notion: { page: 0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0 }
```

When a run starts, LoomWatch reads every page its agents are given through your own Notion
connection, once per page, before any agent starts. Each agent gets the page's text the way it gets
an added file's: all of it up to 12,000 characters, else the opening and a full copy at
`knowledge/<title>-<id>.md`. No agent is given the connection or a read grant. A page that cannot
be read, or Notion not being connected, fails the run before it starts and names the page. Only
`knowledge` may name a Notion page, and never together with a `path`.

**Knowledge** is supplied in the agent's opening prompt as the snapshot described above: a
folder's top-level listing and README, or a file's text. It is framed as source material, never as
instructions. A folder or file is also a read grant: the agent reads anything inside it without
asking (see [Permissions](#permissions)). One agent's knowledge is capped at 64 KiB, and a run over
the cap fails rather than shortening it.

**Skills** live in LoomWatch's own skills folder, one folder per skill
(`<state dir>/skills/<name>/`, each with its `SKILL.md`), and `<state dir>/skills.json` records
where each one came from. The Skills page fills that folder: it brings skills in from the AI apps on
this computer, installs them from GitHub, skills.sh or ClawHub, or you put a folder there by hand.
The Library lists that folder plus the `.agents/skills` and `.claude/skills` folders of the project
your teams live in, which travel with the team files.

Every agent is offered skills. Its instructions list the name and description of each skill in its
work folder's `.agents/skills` and `.claude/skills` and in LoomWatch's skills folder, and the agent
reads a skill's `SKILL.md` itself when its task calls for it. A skill turned off for the agent on
the canvas is left out of that list.

A **wired** skill (`kind: skill`) is required. Before the agent starts, LoomWatch copies the
skill's whole folder into `.agents/skills/<name>/` in the agent's prepared folder. The opening
prompt then carries a `## Required skill: <name>` section, which usually holds the skill's
description and tells the agent to read that `SKILL.md` in full before it starts. Some skills
depend on things the agent may not have: subagents, scripts, slash commands, or tools named for one
app. Others set how the agent works, such as a review standard or a style. For these, the skill's
instructions go into the prompt itself, followed by a short note (`## Reading <name> on LoomWatch`)
that maps what the skill assumes onto what this agent has. Nothing in the skill's own files is
changed. A skill that is not installed fails the run before the agent starts, and so do wired
instructions over 128 KiB for one agent: they are never shortened to fit. The archive records where
each skill came from, the fingerprint of the delivered file, how it was delivered, and a receipt
once the prompt is sent. This verifies delivery, not whether every instruction was followed.

**Tools** (`kind: tool`) name a tool connected in LoomWatch (Connections → Tools, or the agent's
Tools block; see [Give agents tools](TOOLS.md)), ignoring case. The agent is offered that tool's
actions, and asks you before each one unless the entry's `alwaysAllow` names it (by the tool's own
name for the action):

```yaml
capabilities:
  - kind: tool
    name: Linear
    alwaysAllow: [list_teams]   # every other Linear action asks first
```

A name with no connected tool, such as an MCP server from another AI app's settings, still loads
and runs: the agent is told it doesn't have that tool and asked to say in its reply what the tool
would have let it do, and the run records the tool as unavailable.

### Where an agent starts

LoomWatch prepares `<team dir>/.loomwatch/<team>/<agent>/` for an agent that wires capabilities,
gets the Brief as a file, or would otherwise start in the team's own folder. The prepared folder holds
the agent's wired skills under `.agents/skills/`, the full texts of long added files under
`knowledge/`, and `AGENTS.md` when the Brief is delivered that way. The skill and knowledge copies
are rebuilt on every run, so one disconnected since does not linger. Where the agent *starts*
depends on its `spawn.cwd`:

- **The team's own folder** (`cwd: .`, no `spawn` at all, or any folder that holds the team file):
  it starts in the prepared folder instead, whatever it is allowed, so what it writes and the
  commands it runs stay out of your team files. A command's sandbox on a Mac lets it write only in
  its working folder and temporary folders.
- **A folder you chose**: it starts there, however much is connected. Its wired skills and the
  full texts of long files are read from the prepared folder by the full paths its prompt names,
  and it may read them without asking. Nothing is written into your folder, so the Brief reaches
  the agent in its prompt only.

An agent whose `spawn.cwd` is a folder you chose, with nothing wired and no Brief file, works in
that folder exactly. Wiring a capability grants nothing beyond reading it: every other use still goes through
the agent's permissions.

### Tools an agent has

Every agent in a run works with LoomWatch's own tools:

- **Files** in its work folder: `list_files`, `read_file`, `search_files`, `write_file` and
  `edit_file`.
- **Commands**: `run_command` runs a shell command in the agent's work folder (with `cmd.exe` on
  Windows) and stops it, and everything it started, after two minutes, or up to ten if the agent
  asks. The command's environment has every provider key and
  LoomWatch's own settings removed, so a script cannot read your key or LoomWatch's database
  address. That means any variable ending in `_API_KEY`, `_API_TOKEN` or `_AUTH_TOKEN`, any starting
  with `OPENROUTER_`, `ANTHROPIC_`, `OPENAI_`, `GEMINI_`, `GOOGLE_API`, `LOOMWATCH_` or `POSTGRES_`,
  and `DATABASE_URL` and `PGPASSWORD`. On a Mac a command also runs in a sandbox: it can change
  files only in the agent's folder and temporary folders, and it can reach the network only when the
  agent is allowed the web. Windows and Linux have no such sandbox: there a command can change any
  file you can, so asking before each one is the only check.
- **The web**, only for an agent with `allow.web: true`: OpenRouter's web search and page fetch.
  OpenRouter runs them, and the run shows each search and each page read. An agent without the
  switch has no web tools.
- **Its plan**: `update_plan`, plus `read_tool_output` for reading the rest of a long output that
  was set aside.
- **Tools you connected and gave it** (`kind: tool`): each action named `<tool>__<action>`, such as
  `linear__create_issue`. LoomWatch takes the action with the sign-in or token it keeps; the agent
  never holds it. Each action asks you first unless always allowed.
- **The Team Bus**: `roster`, `ask`, `report` and `ask_user`. In team mode it also gets `dispatch`
  and `handoff`. With a notebook it also gets `memory_search`, `memory_read`, `memory_write` and
  `checkpoint`, and in a run started from the app it gets `earlier_work`. These are calls straight
  into the daemon, made as that agent; the agent connects to no server for them.

No built-in tool publishes, posts or sends anything outside the run; a tool you connected can, in
your account on that service, which is why each of its actions asks first. A team's answer leaves
through its review and its delivery (`deliver:`). A command can do anything you can, which is
why commands ask first unless switched on.

### Permissions

`agents[].allow` says what an agent may do without asking. LoomWatch's permission policy decides
every tool call that goes beyond reading the agent's own folder. It always allows the Team Bus, and
reads inside the agent's folder, its connected knowledge and its prepared folder. It never lets an
agent read LoomWatch's own files (the key, the database, the approvals) without asking. Beyond
that, it allows what the switches allow:

```yaml
allow:
  web: true       # search the web and read web pages
  edits: false    # create and change files inside the agent's own folder, never in .agents/, .claude/, .git/ or .loomwatch/
  commands: false # run commands
```

Every switch defaults to `false`, and an absent block means all off. `web` decides whether the
agent has web tools at all. `edits` and `commands` decide whether a file change or a command runs
without asking. An agent whose `spawn.cwd` holds its own team file (`cwd: .`) works in its
prepared folder, so neither an edit nor a command reaches the team files. An operator node takes no
`allow:`.

Anything else is put to the operator while the agent waits. The run shows, for example,
"Researcher wants to run a command", with these answers:

- **Allow** lets this one call run.
- **Allow for this run** lets every call of this kind from this agent run until the run ends.
- **Allow for the whole team**, shown when the run has more than one agent, lets the same thing run
  for every agent until the run ends.
- **Always allow** also turns the switch on in the team file, so later runs do not ask.
- **Deny** declines the call.
- **Edit, then allow** runs the call once with the command line as you changed it.
- **Answer instead** runs nothing and gives the agent your words as the tool's result.

The Needs-you tray offers **Allow**, **Allow for this run** and **Deny**, plus **Allow for the
whole team** when the run has more than one agent. A request is declined if nobody answers within 10 minutes, and at once in a scheduled run,
which has nobody watching. The agent is told the call was declined and carries on without it.

A team in Auto mode lets its agents run, without asking, the commands that only read or download.
It is the "Commands · Ask me / Auto" switch beside the team chat's message box:

```yaml
permissions:
  mode: auto # `ask` (the default) puts every command a switch leaves open to the operator
```

Auto mode applies after the switches and after an earlier **Allow for this run**. A command
(`kind: execute`) then runs without asking in two cases. The first is when every part of it is a
reading program (`ls`, `cat`, `grep`, `wc`, `sort`, `jq`, …), `find` without actions, `sed` that
only prints or substitutes, or read-only `git`, on paths inside the agent's folder, its knowledge
or the temporary folder. The second is a plain `curl`/`wget` GET of an `http(s)` address, for an
agent allowed the web. Output may go to the temporary folder, or into the agent's folder when it may
edit files.

A fixed list always asks: administrator commands, deleting, `git push`/`reset --hard`/`clean -f`,
publishing, deploying, stopping programs, system settings, credential paths, and anything built
from text — `$(…)`, `eval`, `xargs`, a shell, or an interpreter given `-c`, a here-document or its
script on stdin. Everything else asks as above, and the card says why Auto mode left it to you.
The decision is made on this computer from the command line alone; `permission_answered` records
`outcome: auto_approved` for what ran.

## Conversation

`conversation` bounds what a pipeline stage hands forward and what it may ask back.

```yaml
conversation:
  brief:
    asWrittenUpTo: 24000 # longest reply handed on as written (at most 24000)
    summaryChars: 1200   # character budget for a handover's summary
    maxFindings: 8       # standalone findings a handover carries forward
  ask:
    maxPerStage: 3       # questions one agent may put to another in a run
    roundsPerQuestion: 3 # times the asked agent may ask back about one question
    replyChars: 20000    # most of one answer handed back to the asker
  check:
    givenChars: 8000     # how much of what the checked agent was given a check step is shown
```

A stage does not receive its predecessor's transcript. It receives its reply, as written, when the
reply fits: up to `asWrittenUpTo` characters, shared equally where several stages feed one stage, so
a join is never cut. A review stop passes its share on to the stage after it, so you read the work
itself, and the stage after the stop works from the same text you approved. Only a longer reply is
summarised: the stage is asked, in the session it already built, to write a handover under fixed
headings, keeping with each finding the evidence it rests on (a link, a file path, a figure, a date)
and saying what it could not confirm. Any link in the full reply that the handover leaves out is
listed under it. A step that checks its predecessor is handed the work as written either way, with
what that predecessor was given; the stage after a check step receives the work it checked.

A finished stage's session stays open while the stages it feeds take their turn, so anything its
work left out can be pulled with the Team Bus `ask` tool and answered from the context that
produced it. This follows the edges, not the run order: the source of a fan-out stays open for
every branch, and every input of a join for the join. A stage followed by a review stop is put away
for you instead, and a stage that finished in an earlier run you continue from has no session at
all. Each stage is told which of the stages feeding it are open; asking one that has finished is
refused with where its work is, rather than starting a fresh copy that knows nothing.
`allowRecruiting: false` does not block a question to an open stage: that flag governs recruiting a
helper, not talking to the stage before you.

Every `ask`, in a pipeline or a team, follows the same rules. One agent may put `maxPerStage`
questions to another in a run. The question reaches an open stage saying who asks and asking for a
brief answer from the work it already did. An agent that needs something from the asker first ends
its answer with a `## Question back` section, never by asking the asker, which is waiting on it.
The asker's next question to it answers that and continues the same question, so it is not
counted. One question may go back and forth `roundsPerQuestion` times; on the last round the asked
agent is told it can't ask back again, and answers with its best assumption, saying which. A fresh
helper asked to clarify is handed the question so far, so this works the same in team mode. The
answer comes back as written, cut in the middle past `replyChars` so its conclusion is kept. Every
round, and every question that was refused and why, shows in the team's chat.

Every field is optional and the defaults above apply. Lower `asWrittenUpTo` for a long pipeline on
a model without prompt caching; the cost of raising the other bounds is paid by every stage
downstream.

## Memory

`memory` is what the team knows before a run starts. The Brief is Markdown beside this file, so it
is diffable and reviewable like the rest of the design; the run archive holds only what agents write.

```yaml
memory:
  brief:
    - path: brief/constraints.md   # supplied to every agent
    - path: brief/tone.md
      appliesTo: [writer]          # optional; default is every agent
  inherits:
    - team: research-team          # another team under the same teams root, by id
      include: [brief, kept]       # brief | kept | both; omit for both
      appliesTo: [reviewer]        # optional; omit for the whole team
      exclude: [brief/tone.md]     # optional; inherited entries this team declines
    - pack: onboarding-pack.memory # an exported pack folder under the teams root
  notebook:
    enabled: true                  # agents get memory_search/read/write and checkpoint
    keep: review                   # review | never; `auto` is deliberately absent
  packet:
    maxChars: 8000                 # memory's share of an opening prompt, in characters
  deliverAs: native-file           # or packet-only, per agent
```

Omitting the block, or `enabled: false`, keeps every prompt byte-for-byte what it was before
memory existed.

Loader rules beyond the schema:

- Brief paths are relative to the team file and must resolve — symlinks followed — under the team
  file's own directory. An absolute path or an escape is refused, naming the entry.
- A Brief file that is missing, unreadable, or not valid UTF-8 refuses the run rather than being
  skipped.
- The whole Brief is read once, at run acceptance, before any agent starts. Every stage and
  every delegated helper in one run is supplied the same bytes.
- Pinned content exceeding `packet.maxChars` for any agent refuses the run, naming the entries and
  the overage — the same contract an undeliverable capability has.
- `deliverAs: native-file` (the default) also writes the Brief as `AGENTS.md` in the agent's
  prepared folder, `<team dir>/.loomwatch/<team>/<agent>/`. The agent reads it into its standing
  instructions at the start of every session, so it runs there instead of its declared
  `spawn.cwd`, as wiring a capability does. This happens only when the declared folder holds the
  team file. An agent working in a folder you chose gets the Brief through the context packet
  alone, so nothing is written into your project.
- `packet-only` on an agent keeps its `cwd`, but costs it a channel that lasts: when a long
  conversation is summarised to make room, the standing instructions are kept and the opening
  prompt may not be.

Inheritance rules:

- `inherits` entries name **exactly one** of `team` (an `id`, resolved among team files under the
  teams root) or `pack` (a `<name>.memory/` folder under the teams root). Both, or neither, is
  refused at load.
- Inheritance is **transitive**, and a cycle is refused at load naming the chain
  (`alpha → beta → alpha`). Depth is bounded at 8. Every inherited entry is attributed to the team
  whose file declared it, not to whichever team passed it along.
- Inherited memory is read-only by construction: no token issued for this team carries a write
  grant for another team's scope, and `memory_write` always lands in the caller's own team.
- An inherited Brief entry's `appliesTo` (the origin's) and the `inherits` entry's `appliesTo`
  (this team's) are **intersected**: an agent is supplied it only if both scopes admit it.
- Inherited Brief entries are read at run acceptance like the team's own, and are ordered after
  them — so when the budget runs out, what a team wrote about itself survives and what it borrowed
  is cut.
- A `pack:` entry pins the pack's Brief. Its kept notes arrive by an explicit import
  (`POST /api/memory/packs` with `action: import`), which copies them into this team's scope
  carrying the origin id; a run start never imports anything.

Notebook rules:

- `notebook.enabled: false` withdraws `memory_search`, `memory_read`, `memory_write` and
  `checkpoint` from the tools the agent is offered **and** refuses a call that names one anyway. A
  team with no `memory:` block has no notebook and no memory tools at all.
- Only a team with a notebook is asked, as each pipeline stage's last turn, where its work stands.
  A team without one skips that turn; a stage that parks on a question still checkpoints first,
  and a failed or cancelled run still gets a checkpoint per stage from the archive.
- A note is written scoped to its run and to the writing agent, attributed from the bus token.
  Agents can never pin, never keep, and never write into an inherited scope.
- `keep: review` means the operator promotes what is worth keeping after the run. There is no
  `auto`: a run's observations becoming standing memory with nobody reading them is how a team
  accumulates confident nonsense.

The rendered section is `## What the team knows`, placed after the agent's role and before its
task. See [TEAM_MEMORY.md](TEAM_MEMORY.md).

Two `session_meta` subtypes are archived immediately before each opening prompt: `context_packet`
(how much memory was supplied, and the per-section selection rationale) and `prompt_sections`
(what the composed prompt is made of). Both are additive; no event kind was added and
`run_events` is unchanged.

## Reusable runtime definitions

Schema-aware consumers can validate runtime values directly with these references:

- `schemas/team.schema.yaml#/$defs/Agent`
- `schemas/team.schema.yaml#/$defs/Edge`
- `schemas/team.schema.yaml#/$defs/RunEvent`

The `RunEvent.payload` shape is selected by `kind`. Message and thought events retain a
role, optional message ID, and structured content block. Tool calls and tool updates project the
call ID, title, kind, status, input/output, content, and locations when present. Plan, permission,
session-metadata, usage, turn-end, and process events cover the rest of a session's lifecycle.

An agent's updates are recorded in the shapes of ACP's `session/update` notifications, which the
archive has always stored. So a run recorded when LoomWatch still started AI apps replays the same
way as one recorded now. Every event an agent's session produces also keeps, in top-level `raw`,
the frame it was recorded from.

## Operator review stops and questions

A pipeline agent may declare `kind: operator` with `role` as its question and optional `name`
(default `You`). It must omit `spawn`, `model`, `thinkingEffort`, `allow`, `turnedOff`,
`doneWhen`, `checks` and `sendBackOnce`. Operator nodes cannot be the entrypoint or appear in team
mode; consecutive stops are allowed. A pipeline with stops must be started from the app, so that
someone can answer: `loomwatchd run` on the command line has nobody to ask, so its run fails when
it reaches a stop.

No process stays running while an agent waits. At a review stop, the agent before the stop is
parked; on an `ask_user` question, the agent that asked is parked, after writing a checkpoint of
where its work stands. A parked agent is a snapshot of its conversation kept in LoomWatch's
database. When you answer or send a note back, it is reopened in the same conversation, however
long you took. No model call is made while it waits. A restart of LoomWatch ends a run that was
waiting, as it ends any run in progress: the parked agent is let go, and its checkpoint is where a
new run picks the work up.

`conversation.stop.keepAliveMinutes` (default 15, minimum 1) is still accepted, but it no longer
limits a wait. It bounded how long a session could be kept running while the operator decided, and
a parked agent has nothing running. Older team files may keep it.

`ask_user` is available in either mode in a run started from the app. It records a question and
tells the agent to end its turn at once; the answer arrives as the agent's next turn.

See [operator-stop.yaml](../examples/operator-stop.yaml) for an example that runs offline, on
`fake/offline`, with no key.
