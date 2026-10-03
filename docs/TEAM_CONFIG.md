# Team configuration contract

LoomWatch team files are YAML documents validated against
[`schemas/team.schema.yaml`](../schemas/team.schema.yaml). The initial contract is schema
version `1`; readers must reject a version they do not understand instead of guessing.

The root document stores stable, user-authored configuration only: the team identity,
entrypoint, optional responder, guard policy, agents, and configured pipeline edges. Observed edges,
agent status, and run events are runtime records archived in Postgres. Their shared wire
shapes are defined as `$defs.Edge` and `$defs.RunEvent` in the same schema so Phase 02 and
later can reference one contract.

See [`examples/research-team.yaml`](../examples/research-team.yaml) for a complete team.

## Semantic rules

JSON Schema validates each value's shape. Loaders must additionally enforce the rules that
depend on the document as a whole:

- Agent IDs are unique, and `entrypoint` names an agent in `agents`.
- Optional `responder` names the agent whose reply becomes the canonical team output. In pipeline
  mode it may name any agent in the configured pipeline; later stages still run, but their replies
  do not replace the selected output. In team mode it must equal `entrypoint`, because the entrypoint
  owns the self-organizing root turn. When omitted, compatibility inference applies: `entrypoint`
  responds in team mode and the last topological pipeline stage responds in pipeline mode.
- An optional `schedule` block (`$defs.Schedule`) turns the team into a routine: `cron`
  must parse (standard 5-field form with `0`/`7` = Sunday, or the 6/7-field seconds form),
  `timezone` must be an IANA zone when present, and `prompt` must not be blank. Loaders
  reject the document otherwise. See `WATCH.md` → *Routines* and ADR 0010.
- An optional top-level `deliver` block (`$defs.Deliver`) sends every successful run's answer
  somewhere besides the Run view, whoever started the run. Today that is `notion: {title?}`, a new
  child page of the Notion destination chosen in Connections. The default title is
  `{{team}} — {{date}} {{time}}`, and a blank `title` is rejected. A routine's own
  `schedule.deliver` wins for scheduled runs. The canvas writes it from the Team response's
  **Send every answer to Notion**. See `NOTION.md` and ADR 0038.
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
  with more than one configured predecessor β€” a join in the DAG, e.g. a diamond `a→b`,
  `a→c`, `b→d`, `c→d` β€” receives every predecessor's reply, each labeled with its agent ID
  and concatenated in the order those edges are declared in the team file, so a branch is
  never silently dropped. Only the entrypoint (`pipeline_order()`'s first node) receives the
  run's original prompt.
- Every edge and run-event `ts` must parse as RFC 3339 or the loader rejects it. The schema
  `format` keyword is an annotation in Draft 2020-12 and must not be relied on for this;
  the companion `pattern` constrains shape only, so the loader still range-checks the
  fields. RFC 3339 spells its literals case-insensitively, and `RunEvent.ts` is minted
  upstream, so the lowercase `t` and `z` separators are accepted on read. LoomWatch emits
  the uppercase form.
- Child processes inherit the LoomWatch process environment. `spawn.env` entries are
  applied on top as literal overrides; LoomWatch performs no shell expansion, and team
  files must not contain credentials. An override of `PATH` changes resolution of a bare
  `spawn.cmd`, so an untrusted team file must be treated with the same care as a script.
- `Agent.model` stores the harness model id. Optional `Agent.thinkingEffort` stores the
  harness's reasoning-effort id separately; at session start LoomWatch applies both through
  ACP configuration. Older combined selectors such as `gpt-6-astra[high]` remain readable.
- `budget` (team or agent level) is retired ([ADR 0027](decisions/0027-retire-cost-budgets.md)).
  Readers accept it in any shape and ignore it, so older team files still load; writers must not
  add it. LoomWatch neither tracks spend nor refuses a delegation because of it.
- `usage` payloads are discriminated (`$defs.UsagePayload` in the schema): harness-reported
  updates carry `sessionUpdate: "usage_update"` (or a bare `costUsd` delta) and are archived as
  evidence only. Runs archived before ADR 0027 may also hold LoomWatch's own
  `phase: "budget_warning"` events; nothing writes them now.
- `guards.maxDispatchDepth` and `guards.maxConcurrentDispatches` both default to `8` when
  absent. The Team Bus refuses delegation beyond the depth limit and refuses a background
  `dispatch` or `handoff` while the configured number of those tasks is still running.
  Delegation lineage and concurrency permits are server-owned, so callers cannot forge the
  counter, erase an ancestor to bypass cycle detection, or race past the fan-out cap.
  Synchronous `ask` calls do not consume a background-dispatch permit. `Agent.allowRecruiting`
  defaults to `true`; `false` forbids that agent from recruiting helpers within its own
  pipeline step.
- `handoff` starts the target as a background task and marks the caller's roster status as
  `stopped`, but it cannot cancel the caller's current ACP turn. The caller must return after
  a successful handoff; provider spend can continue until that turn exits.
- `status` is a runtime annotation. Team-file writers must not persist it, and team-file
  readers must ignore it if an older or external document contains it.
- Run-event IDs are unique. `RunEvent.agentId` names an agent in the team document. `seq`
  is strictly increasing per session across all agents and is the sole replay order;
  timestamps are descriptive and do not replace sequence order.
- A `tool_update` event's `callId` matches a prior `tool_call` in the same session, and the
  update's `seq` is greater than the tool call's `seq`.

Paths in `spawn.cwd` may be absolute or relative. A relative path is resolved against the
directory containing the team file. `spawn.cmd` must be either a bare executable name
resolved on the effective `PATH` after applying `spawn.env`, or an absolute path. Relative
commands containing a path separator are rejected. The command is executed directly with
`spawn.args`; it is never passed through a shell.

## Capabilities

`agents[].capabilities` lists what the daemon delivers to an agent before it runs. A skill or a
tool is `{ kind, name }`, where `name` is the capability's name in the Library:

```yaml
capabilities:
  - { kind: skill, name: claude-design } # copied into the workspace, required in the prompt
  - { kind: tool, name: Agent Memory }    # your MCP server, handed to the harness
```

Team memory is not a capability: wire another team's memory or an imported pack through
`memory.inherits` (see [Team memory](TEAM_MEMORY.md)).

**Knowledge** is a folder or file you chose, so it always has a `path`. The agent panel's
**Add folder…** and **Add file…** write it ([ADR 0035](decisions/0035-folders-and-files-as-knowledge.md)),
and `name` is only its label:

```yaml
capabilities:
  - { kind: knowledge, name: Market research, path: /Users/me/Documents/Market research } # linked
  - { kind: knowledge, name: Q3 memo.pdf, path: news-desk.files/Q3 memo.pdf }              # added
```

On the canvas every folder or file is one card, keyed by its `path`, with a line from each agent
whose `capabilities` name that path. Drawing a line from another agent adds the same `path` to it
under a label of its own; taking the last line away keeps the card in `<team>.layout.json` with its
`path`. Skills and tools named in the team file get a card the same way, whether or not the layout
file has one.

Knowledge without a `path` fails the run and says to add it again. The Library used to list the
project the teams live in and the folders OpenCode had worked in, and an entry could name one of
those; it no longer does ([ADR 0036](decisions/0036-knowledge-is-chosen-not-discovered.md)).

A **folder** is linked where it is: the agent gets its top-level listing and README, plus a read
grant for the folder, so each run sees what is in it then. A **file** added in
the panel is copied beside the team file under `<team>.files/`, and a relative `path` resolves
against the team file's folder (`~/` against your home folder). The agent gets the file's text,
up to 12,000 characters, and a read grant for that one file. A PDF's text is extracted with
`pdftotext` when it is installed (`brew install poppler`); without it, the agent is told where the
PDF is. When a file is longer than that, the prompt carries its opening, and the full text is put
in the prepared folder as `knowledge/<file>`, which the prompt names. Only `knowledge` may have a
`path`.

**Knowledge** is supplied in the agent's opening prompt as the snapshot described above: a
folder's top-level listing and README, or a file's text. It is framed as source material, never as
instructions. A folder or file is also a read grant for it. For an agent that starts in the
prepared folder on Claude Code, LoomWatch writes `permissions.additionalDirectories` and a
`Read(//<folder>/**)` allow rule into that folder's `.claude/settings.json`. Every app also asks
LoomWatch before reading outside its folder, and LoomWatch approves reads of connected folders and
files. One agent's knowledge is capped at
64 KiB, and a run over the cap fails rather than shortening it.

**Tools** are MCP servers you already configured for Claude Code (`~/.claude.json`,
`~/.claude/settings.json`), Codex (`~/.codex/config.toml`) or OpenCode
(`~/.config/opencode/opencode.json`). LoomWatch reads the definition, preferring the receiving
agent's own app, and passes it to the harness in ACP `session/new` beside the Team Bus. That works
on any ACP app: stdio servers always, HTTP and SSE servers only when the app advertises them.
`${VAR}` (Claude Code), `{env:VAR}` (OpenCode) and Codex's `env_vars`, `bearer_token_env_var` and
`env_http_headers` are resolved from the daemon's environment. Values reach only the harness
process; the run record keeps names. On Claude Code, LoomWatch also writes an `mcp__<server>` allow
rule. A server that is disabled, needs a variable the daemon lacks, or uses a setting ACP cannot
carry (a Codex `cwd` or tool filter) fails the run with the reason. See
[ADR 0029](decisions/0029-deliver-knowledge-and-tools.md).

LoomWatch prepares `<team dir>/.loomwatch/<team>/<agent>/` for an agent that declares
capabilities. It copies each wired skill's whole bundle from whichever harness or shared location
supplied it into the target harness's project-local discovery directory: `.claude/skills/` for
Claude Code and `.agents/skills/` for Codex and the other supported Agent Skills harnesses. Where
the agent *starts* depends on its `spawn.cwd` ([ADR 0042](decisions/0042-sources-on-the-canvas.md)):

- **The team's own folder** (`cwd: .`, or any folder that holds the team file): it starts in the
  prepared folder instead, so it never reads or changes your other team files. The declared
  folder's `.claude/settings.json` is carried across. The same happens to an agent allowed to edit
  files, or one whose Brief is kept in its app's memory file.
- **A folder you chose**: it starts there, however much is connected. Its skills and the full texts
  of long files are read from the prepared folder by the full paths its prompt names, and LoomWatch
  approves those reads. Nothing is written into your folder, so the Brief reaches the agent in its
  prompt only.

An agent that declares nothing keeps its `spawn.cwd` exactly as before. Naming a capability grants nothing: the
harness still authorises every use. A skill that is not installed, or a harness whose project
skill directory LoomWatch does not know, fails the run before anything spawns rather than silently
doing nothing. See [ADR 0012](decisions/0012-capability-delivery.md) and
[ADR 0019](decisions/0019-cross-harness-skill-delivery.md).

`agents[].allow` says what an agent may do without asking. LoomWatch puts each run agent's app in its
ask-first mode (`default` on Claude Code and Gemini CLI, `read-only` on Codex) and answers every
`session/request_permission` itself. It always approves the Team Bus, the agent's connected tools
and reads of its connected folders and files, and it approves what a switch allows, by the kind the
app gives the tool call. Anything else is put to the operator while the app waits (ADR 0040): the
run shows "Researcher wants to use the web" with **Allow**, **Allow for this run**, **Always allow**
(which turns the switch on here) and **Deny**, and so does the Needs-you tray. It is declined when
nobody answers within 10 minutes, and at once in a scheduled run, which has nobody watching:

```yaml
allow:
  web: true       # `fetch`: search the web and read web pages
  edits: false    # `edit`: change files inside the agent's own folder, never `.claude/`, `.git/` and the like
  commands: false # `execute`: run commands in a terminal
```

Every switch defaults to `false`, and an absent block means all off. An approval selects the app's
one-time option, never "always". A decline selects the app's one-time rejection. When an app ends
its turn on that rejection, as Codex does, LoomWatch asks the agent, in the same session, to carry
on without what was declined, up to three times per turn
([ADR 0046](decisions/0046-a-declined-request-does-not-end-the-turn.md)). An agent allowed to edit whose declared `spawn.cwd` holds its own
team file (`cwd: .`) runs in its managed folder instead. An operator node takes no `allow:`. An app
that offers no ask-first mode, OpenCode among them, decides for itself, and the run records that.
See [ADR 0037](decisions/0037-loomwatch-decides-what-agents-may-do.md).

No switch lets a run agent publish, post or send outside the run. Claude Code would publish an
artifact to the operator's claude.ai account without asking, even in its ask-first mode. So each
run agent's session starts without Claude Code's `Artifact`, `ArtifactComments`, `ArtifactData`,
`ArtifactCheck`, `DesignSync`, `RemoteTrigger`, `CronCreate`, `CronDelete`, `CronList`,
`ScheduleWakeup`, `PushNotification`, `SendMessage` and `ListAgents` tools. They are sent as
`_meta.claudeCode.options.disallowedTools` on `session/new` and `session/load`, and other apps
ignore that key. A team's answer leaves through its review and its delivery (`deliver:`). If one of
these tools still runs, the receipt flags it. See
[ADR 0044](decisions/0044-withhold-tools-that-reach-past-the-run.md).

Codex runs an MCP tool that declares itself read-only without asking, even in its `read-only` mode.
Its plugins and the operator's ChatGPT apps bring such tools, among them the ChatGPT app's
`cua_repl`, which drives the operator's browser and apps. So a Codex run agent is spawned with
`CODEX_CONFIG` setting `features.plugins` and `features.apps` to `false`, merged into any
`CODEX_CONFIG` the team file's `spawn.env` sets. That must be a JSON object, or the agent does not
start. The Team Bus and connected tools still go out on `session/new`, so they stay. MCP servers in
the operator's own `~/.codex/config.toml` still load. The receipt flags a call, made without asking,
to any MCP server LoomWatch did not connect to that agent, on any app. See
[ADR 0047](decisions/0047-start-codex-without-its-plugins-and-apps.md).

Connected skills are required: their complete copied `SKILL.md` instructions are also supplied in
the agent's opening prompt. Preparation fails if the instructions cannot be read or exceed the
128 KiB aggregate limit for that agent. The archive records the source, receiving harness, exact
instruction fingerprint, and a receipt after the prompt is sent. This verifies instruction delivery,
not whether every instruction was followed. See [ADR 0020](decisions/0020-delivery-lane-and-required-skill-receipts.md).

## Conversation

`conversation` bounds what a pipeline stage hands forward and what it may ask back.

```yaml
conversation:
  brief:
    summaryChars: 1200   # character budget for the handover summary
    maxFindings: 8       # standalone findings carried forward
  ask:
    maxPerStage: 3       # questions a stage may put to the stage before it
```

A stage does not receive its predecessor's transcript. When its own work is done, each non-final
stage is asked — in the session it already built — to write a handover under fixed headings, and
that is what the next stage reads. The predecessor then stays alive while its successor runs, so
anything the brief left out can be pulled with the Team Bus `ask` tool and answered from the
context that produced it. `allowRecruiting: false` does not block such a question: that flag
governs recruiting a helper, not talking to the stage before you.

Every field is optional and the defaults above apply. Raise them for a stage whose output genuinely
cannot be summarised; the cost of raising them is paid by every stage downstream.
See [ADR 0013](decisions/0013-pipeline-conversation.md).

## Memory

`memory` is what the team knows before a run starts. The Brief is Markdown beside this file, so it
is diffable and reviewable like the rest of the design; Postgres holds only what agents write.

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
- The whole Brief is read once, at run acceptance, before any harness spawns. Every stage and
  every delegated helper in one run is supplied the same bytes.
- Pinned content exceeding `packet.maxChars` for any agent refuses the run, naming the entries and
  the overage — the same contract an undeliverable capability has.
- `deliverAs: native-file` (the default) also writes the Brief as the harness's own project memory
  file in `<team dir>/.loomwatch/<team>/<agent>/`, so the agent runs there instead of its declared
  `spawn.cwd` — exactly as declaring a capability already does. `packet-only` on an agent keeps
  its `cwd` and costs it the one delivery channel that survives a harness-side compaction.
- A harness LoomWatch does not recognise gets no native memory file at all, and reaches the Brief
  through the context packet alone.

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
  `checkpoint` from `tools/list` **and** refuses a call, so a harness holding a cached list cannot
  write. A team with no `memory:` block has no notebook and no memory tools at all.
- A note is written scoped to its run and to the writing agent, attributed from the bus token.
  Agents can never pin, never keep, and never write into an inherited scope.
- `keep: review` means the operator promotes what is worth keeping after the run. There is no
  `auto`: a run's observations becoming standing memory with nobody reading them is how a team
  accumulates confident nonsense.

The rendered section is `## What the team knows`, placed after the agent's role and before its
task. See [TEAM_MEMORY.md](TEAM_MEMORY.md) and [ADR 0014](decisions/0014-team-memory-brief-and-packets.md).

Two `session_meta` subtypes are archived immediately before each opening prompt: `context_packet`
(how much memory was supplied, and the per-section selection rationale) and `prompt_sections`
(what the composed prompt is made of). Both are additive; no event kind was added and
`run_events` is unchanged. See [WEBSOCKET_SCHEMA.md](WEBSOCKET_SCHEMA.md) §3.

## Reusable runtime definitions

Schema-aware consumers can validate runtime values directly with these references:

- `schemas/team.schema.yaml#/$defs/Agent`
- `schemas/team.schema.yaml#/$defs/Edge`
- `schemas/team.schema.yaml#/$defs/RunEvent`

The `RunEvent.payload` shape is selected by `kind`. Message and thought events retain a
role, optional upstream message ID, and structured ACP content block. Tool calls and tool
updates project the call ID, title, kind, status, input/output, content, and locations when
present. Plan, permission, session-metadata, usage, turn-end, and process events cover the
rest of the ACP and supervisor lifecycle. Every harness-originated event also stores the
complete JSON-RPC frame in top-level `raw`, because ACP presentation and status metadata
cannot be reconstructed safely from the normalized projection.


## Operator review stops and questions

A pipeline agent may declare `kind: operator` with `role` as its question and optional `name`
(default `You`). It must omit `spawn`, `model` and `thinkingEffort`. Operator nodes
cannot be the entrypoint or appear in team mode; consecutive stops are allowed. The app must
start a pipeline containing stops, so answers have a loopback operator endpoint.

`conversation.stop.keepAliveMinutes` defaults to 15 (minimum 1). A harness advertising
`agentCapabilities.loadSession` is closed and reloaded on demand. Other harnesses are kept alive
until this window expires, then released with a coordinator checkpoint. No model call is made
just because the timer expired. `ask_user` is available in either mode when the run has an operator
desk; it records a question and instructs the agent to end its turn immediately.

See [ADR 0017](decisions/0017-operator-stops-and-answers.md) for REST and archive details, and
[operator-stop.yaml](../examples/operator-stop.yaml) for an offline example.
