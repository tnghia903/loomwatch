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
started, and there is no other app to install. Each agent is a session in the daemon. It calls its
model the way its `model` says it is paid: on your ChatGPT plan, on your Claude API credit, or
through [OpenRouter](https://openrouter.ai) with your OpenRouter API key. It works with LoomWatch's
own tools (see [Tools an agent has](#tools-an-agent-has)).

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

- **How it is paid.** You connect each way on Home or in **Connections** (under **You**) (ADR 0073): **Continue
  with ChatGPT** for a ChatGPT Plus or Pro plan, a Claude API key from the Console organization
  linked to a Claude Max or Team plan, or an OpenRouter key. LoomWatch checks each with its company
  and keeps it only if it is accepted. On a Mac the OpenRouter key is kept in the Keychain as
  `LoomWatch.OpenRouter`, and the Claude key and ChatGPT sign-in as `LoomWatch.Plans`; on Windows
  they are in Windows Credential Manager. On Linux they are kept in `<state dir>/keys.json` and
  `<state dir>/plans.json`, which only your account can read. An `OPENROUTER_API_KEY`,
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment is ignored. Each key goes to its own
  company and nowhere else: never to an agent, a command an agent runs, a team file, the run
  archive or a log. An agent whose way of paying isn't connected stops before its first model call
  and says which one to connect. It never moves to another way by itself.
- **`model`** says the model and how it is paid:

  | Paid by | `model` | Example |
  |---|---|---|
  | OpenRouter | an OpenRouter model id (`vendor/model`) | `anthropic/claude-opus-5.5`, `openai/gpt-6.1-sol` |
  | Your ChatGPT plan | `chatgpt:<slug>`, a model your plan lists | `chatgpt:gpt-6.1-sol` |
  | Your Claude API credit | `anthropic:<Anthropic model id>` | `anthropic:claude-opus-5-5` |

  The model picker shows each way of paying in its own section, with what it costs, and lists only
  models that can use tools. Its suggestion picks the model first, then a plan you've connected
  that offers it, else OpenRouter, else your plan's own model for that kind of work. `fake/offline`
  is the offline demo model: it answers with fixed text and calls no model, so it needs no key.
- **`followsSuggestion: true`** says the agent's `model` follows the model LoomWatch suggests for
  it (ADR 0072). An agent added in the app starts that way. When its configuration changes there,
  LoomWatch moves `model` to the new suggestion and shows what it was, with Undo. Its
  `thinkingEffort` moves too, to the one suggested for that kind of work, unless you set it by
  hand. Picking any other
  model in its model list takes the line out, and the model stays as picked. A run always uses
  `model`, so a file edited elsewhere keeps its model until the agent is next changed in the app.
- **`thinkingEffort`** says how hard the model reasons: `none`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, `max` or `ultra`. LoomWatch sends it to OpenRouter as `reasoning.effort`, with `ultra` read as
  `max`. On the Claude credit it goes as `output_config.effort`, with `none` and `minimal` read as
  `low` and `ultra` as `max`; on the ChatGPT plan as `reasoning.effort`, with `minimal` read as `low`.
  Either takes the nearest effort at or below it that the model offers, and none if there is none.
  The app's effort slider shows the efforts each model offers. If it is absent or set to `default`, the model decides. The older combined form
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

### One of My agents

Every agent the app saves in a team is one of My agents (ADR 0094), kept as
`<teams root>/.jobs/<agent>.yaml`. The team file points at it with `from` and holds only what is
the team's:

```yaml
agents:
  - id: researcher
    from: { agent: researcher }
    part:                            # what this team needs from it (ADR 0097)
      text: Find two or three options for the campus gate, with their trade-offs.
      doneWhen: [Names the option each source supports]
    spawn: { cwd: ../my-project }   # where it works in this team
    capabilities:                    # what this team connects to it beyond its own
      - { kind: knowledge, name: Notes, path: notes }
      - { kind: skill, name: slides }
    turnedOff:                       # its own, off in this team (ADR 0060)
      - { kind: tool, name: Gmail }
```

- **Filled in when the team is read.** An entry with `from` and no `role` of its own is filled in
  from the agent's file each time the daemon or the app reads the team: its `name`, `role` (the
  file's `instructions`), `model` and `thinkingEffort` when the agent names a model, its skills,
  its tools with their `alwaysAllow` calls, what it reads (as `knowledge`, labelled apart from the
  team's), `doneWhen`, `allow` and `allowRecruiting`. A skill or tool the entry turns off is left
  out. A change saved to the agent reaches every team that uses it from that team's next run; a
  run's record keeps the agent as it ran.
- **The team's own.** `part`, `spawn`, knowledge, skills and tools the team connects beyond the
  agent's own, `memory`, `turnedOff`, `checks`, `sendBack`, `spend` and `learns` stay in the entry, and so does
  `model` (with `followsSuggestion`) when the agent names none. In the app, a skill or tool wired on
  a team's canvas is given in that team only, and taking one of the agent's own off it turns it off
  there; the agent's own skills and tools change on its workbench. Taking one of the agent's own
  reads off a team's canvas takes it off the agent, as knowledge isn't turned off for one team.
- **Written out in full.** An entry that writes its own `role` runs as it is written, which is how
  `examples/` and hand-written files work; `from` then only names whose lessons it reads. The app
  makes it one of My agents the next time it saves the team: an agent with exactly the same setup
  is joined, and one whose name is taken gets the team's name after it (`Writer · Market brief`).
  The folders, files and pages the team connected to it, and its `part`, stay in the team: an
  agent reads something of its own only when its builder gives it, so it fits any team (ADR 0097).
  `from.version`, which an earlier LoomWatch wrote, is read and ignored.
- **Read in its teams folder.** A pointer needs its teams folder: `loomwatchd run team.yaml` uses the
  nearest folder that holds `.jobs`, from the file's own folder upward, or the file's own folder
  when none does. An agent file that is missing stops the team with a message that names the
  agent.
- **Reviewed like a team file.** An agent file that appears or changes outside LoomWatch holds every
  team that uses it until the operator reviews it, as a team file does (ADR 0048).
  `DELETE /api/jobs/{id}` refuses an agent that a team still uses, naming the teams.

### Older team files

Team files written for an earlier LoomWatch, which started an AI app for each agent, still load
as they are:

- `spawn.cmd`, `spawn.args` and `spawn.env` are accepted and ignored, like the retired `budget`.
  Nothing is started, and no variable in `env` reaches anything. Writers must not add them.
- A `model` that doesn't start `chatgpt:` or `anthropic:` is OpenRouter's, and an old name is read
  as an OpenRouter id, by the daemon and by the app alike:

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
  reject the document otherwise. `retryAfterMinutes` (default `[1, 2, 5, 10, 30]`) is the waits
  before each new try of a timed run that couldn't reach its AI source, as one that starts before
  the network is back after the computer wakes. It allows at most 20 waits of 1 to 1,440 minutes;
  `[]` never tries again. `waitForYouMinutes` (default 720, 12 hours; from 1 minute to a week, 10,080) is how long
  a routine's run waits for you when it asks something: a permission, more money at its spending
  limit, or an agent's question (ADR 0090). The schedule editor keeps both as written. See
  `WATCH.md` → *Routines*.
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
  meet under `## Not met`. A later stage and any check step read it with the work. No second turn
  is taken on the agent's own say-so: a check step with `sendBack` is what sends work back.
- Optional `Agent.part` says what this team needs from the agent (ADR 0097): `text`, a line or two
  (at most 1,000 characters), and `doneWhen`, up to five items of its own. It is the team's, never
  the agent's: one of My agents keeps instructions and a Done when for its kind of work, and each
  team says here what it needs from it. The agent reads `text` under `## Your part in this team`,
  after what the team knows and before anything the run hands it, and the part's items come first
  in its `## Done when`, so a check step checks them too. An item in both lists is stated once.
- Optional `Agent.learns: false` stops an agent learning from the operator's feedback on its work
  (ADR 0078, [How agents learn](LEARNING.md)). It is on when absent: the operator's words about a
  finished answer, and a check step's item that was not met and then met after the send-back,
  become short lessons in the agent's standing instructions, each shown in the chat with Undo.
  With `false` it learns nothing new and is given none of its lessons. One of My agents keeps one
  list of lessons in every team that uses it (`from: {agent}`); when a team's own agent becomes one
  of My agents, its lessons go with it.
- **Notes set aside from the answer.** Some sections an agent ends its reply with are for the
  operator, not the answer's reader:
  - `## Not met`: the `doneWhen` items it could not meet.
  - `## Missing`: what it needed and was not given (the Writer job's), and what the Editor job
    flagged.
  - `## Not changed`: the findings of a send-back it kept its work against (below).
  - `## Changes`: the edits it made to the work it was handed (the Editor job's).

  When the team's answer ends with any of these, in any order, the daemon takes them off it. It
  also drops a `---` rule drawn above them. It records them as a `session_meta` `answer_notes`
  event (`not_met`, `missing`, `not_changed`, `changes`), so what is delivered and copied is the
  work alone.
  - **How they are read.** A heading counts written as `## Changes`, `**Changes**`, or `Changes:`
    alone on its line, so a role written before these were headings still works.
  - **When they stay in the answer.** A section with any other section after it is part of the
    work. So is an answer that is nothing but notes.
  - **The cost.** A piece whose own last section is headed `Changes`, such as release notes, has it
    set aside too, and it shows in the review instead of the answer.
  - **Where they show.** In the review beside the answer. The first three are worth a look and
    are counted on its badge. Changes are listed apart from them and not counted, because an edit
    is not a problem.
  - **Between stages.** A stage's notes are handed on with its work: the Editor carries the Writer's
    `## Missing` into its own.
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
    - Bold, italics and code inside an item or its evidence are kept, and the app shows them. Bold
      around a whole item or evidence, and a mark left without its partner, are dropped.
    - An item it leaves out is Not sure ("Not checked"). Met with no evidence is Not sure, and
      "partly met" is Not met.
    - A line naming none of the items is kept as a problem of its own.
    - A reply with no readable block is recorded as unreadable (`readable: false` on the
      `check_result` event), and the answer then says the check could not be read.
  - **The answer.** When the pipeline ends on a check step and no `responder` is set, the checked
    agent's reply is the team's answer, and the checks show beside it.
  - **A check step mid-pipeline.** It hands the stages after it the work it checked (as revised),
    followed by what it could not confirm. Its own reply is not handed on, and it writes no handover.
  - **`sendBack`.** What happens when a check is not Met.

    ```yaml
    sendBack:
      rounds: 2               # 1–3: how many times the work may go back
      whenStillNotMet: ask    # answer (the default) or ask
    ```

    - **Each round.** What is not Met goes back to the checked agent's open session, with what
      the check step wrote about the problems. Not met goes as "found these not met"; Not sure
      goes as "could not confirm these", for the agent to show where it comes from or correct.
      Only Met is quality reached.
    - **Findings, not direction.** They can be wrong: the agent changes a fact only when a
      finding's evidence is stronger than its own source. It lists what it kept under
      `## Not changed`, which is set aside from the answer like `## Not met`.
    - **The recheck** covers only the items that were open, plus what the revision changed. It is
      told that a reason under `## Not changed` is not evidence. An item it leaves out keeps a
      Met it had. With more than one round, the send-back says which round it is ("round 2 of
      3"), and only the last round's recheck says it is the last.
    - **It stops** when every check is Met; when the work has gone back `rounds` times; when a
      round met none of what it went back for (another would cost the same and most likely fix
      nothing); when what is still open is the check step's own gap (an item it gave no verdict,
      or Met without evidence), which the agent cannot fix; or when the checked agent had already
      finished.
    - **`whenStillNotMet: answer`** shows the answer with what is still not met marked.
    - **`whenStillNotMet: ask`** stops the run on a review of the checked agent's latest work,
      with the checks beside it. It is the review stop's park: `waiting_on` has `kind:
      review_stop`, `node` is the check step, `handoverFrom` is the checked agent, and a `check`
      block holds the open checks, how many are met, how many times the work went back, why it
      stopped, and the check step's account of the problems. It waits in Needs you, a scheduled
      run too, and nothing is shown or delivered until the person answers. Nothing runs while it
      waits.
      - **Approve** keeps the work as it is: it is the answer, or is handed on with what the check
        step could not confirm, and what the person wrote is direction for the stages after it.
        It is recorded as `check_approved`.
      - **Send back** sends the person's note to the checked agent as direction, with the checks
        still open, and to the check step beside the recheck. Still not met, it asks again. Each
        send-back is one more round past `rounds`, bounded by the person's click.
      - A `loomwatchd run` has nobody to ask, so its run fails, saying what was not met, rather
        than show the work.
    - **Spend limits** (ADR 0068) stop a loop as they stop any call: each call checks the spool
      first, and the next call waits at the spend card when it is used. A scheduled run waits there
      too, for its schedule's `waitForYouMinutes`, then finishes with what it has (at an
      agent's own limit, that agent stops).
    - **`sendBackOnce: true`**, the older form, still reads as `sendBack: {rounds: 1,
      whenStillNotMet: answer}`. A file may not set both.
  - **What is recorded.** Every round is recorded as a `check_result` event. A send-back is
    recorded as `check_sent_back` (with its round, findings, problem text, and the person's
    `direction` when it was they who sent it back) before the turn it starts, or as
    `check_send_back_skipped` when the checked agent had already finished. How the rounds ended
    is `check_stopped`, with the last round, how many times the work went back, the `reason`
    (`all_met`, `rounds`, `no_progress`, `unchecked` or `not_open`) and the `exit` (`answer` or
    `ask`). The team chat shows each round as an exchange: what was sent back, the revised work
    as the reply, and the next verdict. A round with nothing missing is one line.
  - **Defaults.**
    - The daemon treats a missing `sendBack` as off, so existing files behave as before.
    - LoomWatch's editor sets `sendBack: {rounds: 2, whenStillNotMet: ask}` whenever it makes a
      check step: the "Research, write and check" template, and connecting work into a Checker.
    - So does Ask's `propose_team`, for a proposed check step that does not say.
    - The checkup suggests it for any other check step. Without it, the check costs about half a
      run and changes nothing in the answer.
    - The editor sets the check step's effort from one table keyed by the checked agent's job:
      high for every job, for now.
  - **Verdict words.** A verdict word is read as a whole word, so "Metrics …" is not "Met".
  - **A number is measured.** Met on an item with a number in digits ("At most 250 words") is
    Not sure unless its evidence gives a number too; the check step is told to count, or to run what
    measures it. A count in words ("names the three tools") is left to the check: naming them
    meets it. An item that does not apply needs only its reason.
  - Operator nodes may not set either field.
- `conversation.check.fromMessage` (ADR 0098) is what a person's message says done looks like:
  "in a few lines", "at most 250 words", "exactly three sections", "stop after 5 tries".

  ```yaml
  conversation:
    check:
      fromMessage:
        read: true             # false: a message's words are never turned into checks
        rounds: 2              # send-backs when the message names no number of tries
        maxRounds: 5           # the most a message may ask for (1–10)
        whenStillNotMet: ask   # or answer
  ```

  - **The read.** When a run starts from a message a person wrote, one turn of the fast model, with
    no tools, reads it with the conversation so far and lists the conditions it states, at most 5
    of at most 160 characters, and how many tries it gives the work. It runs beside the work, so it
    adds no wait and the working agent's prompt is unchanged. An item is kept only when its numbers
    and most of its words are the message's own; a number of tries only when the message names it.
    A routine's message, a team on stand-in models, and a daemon with no model settings are not
    read. A read that fails or is slow checks nothing.
  - **What it is checked by.** When a check step checks the agent whose reply is the answer, the
    message's items come first in its items, then that agent's Done when, "Does what the request
    asked" and the contradiction item, and the check step sends the work back as the message's
    tries allow, even when it sets no `sendBack` of its own. Anywhere else (one agent, a team with
    no fixed order, a pipeline whose last stage is not checked), LoomWatch checks the reply itself
    against the message's items and "Does what the request asked": the built-in Checker job, at
    its effort, on the `check` tier's model, or the `strong` tier's when that is another maker
    than the checked agent's. It works in the checked agent's folder, so it finds the files the
    work made and used, and has the work in an `answer.md` of its own, outside that folder, to
    count and measure. It changes no file there: it runs commands that only read, and every
    other command is declined without asking. What is not met goes back into the answering agent's still-open session, as a
    check step sends it back. A pipeline that ends on a review stop is the person's own check, and
    gets none.
  - **Tries.** A try is the first work or one revision: "5 tries" is 4 send-backs, never more than
    `maxRounds`. With no number, the work goes back `rounds` times. The stop and the chat count
    tries when the message named them (`tries: true` on `check_stopped` and on the stop's `check`).
  - **What is recorded.** Each change is a `done_when` event under the id `loomwatch:check`: the
    items with whether each is still checked, the tries, the send-backs the check will allow, the
    checker's model and whether its maker is the checked agent's, and whether the check has ended.
    LoomWatch's own check records its rounds under the same id.
  - **Taking an item off.** `POST /api/runs/{id}/done-when` with `{"item": 0, "checked": false}`
    takes an item off the check from the next round on; `"checked": true` puts it back. Refused
    once the check has ended.
- `spend.perRun` (team level) is what one run may spend on model calls, in US dollars. Absent
  means no limit; new teams and the starter teams are written with `1.00`, and so is a new team Ask
LoomWatch proposes, or `2.00` when it has three or more agents or a check step that sends work
back. Every agent of the run draws on it: stages, the lead, Team Bus helpers,
  summaries, checkpoints and handovers. The daemon adds up each call's dollars: the exact cost
  OpenRouter reports, or for a call on the Claude credit its cost at Claude's list prices. A call on
  the ChatGPT plan costs no dollars and counts against the plan's limits instead. Before each call, an agent whose run has used its figure waits, and the run shows a
  stop: "Add $0.50 and carry on" grows this run's figure (the file is not changed), and "Finish
  with what it has" ends the run as done, with the last words an agent wrote as its answer, stop
  reason `spend_limit`, and its checkpoints kept. A scheduled run waits at the stop too, for its
  schedule's `waitForYouMinutes` (12 hours by default); if nobody answers by then it finishes with
  what it has, or at an agent's own limit that agent stops, and the run's spend record says nobody
  answered (ADR 0090). A call's cost is known
  only after it is made, so the calls under way when the figure is reached, one for each agent at
  work, can take a run a few cents past it.
- `spend.perRun` on an agent is that agent's own guard, for an agent that runs away; there is
  none unless set. At it, that agent waits, and "Stop it here" ends its turn with what it wrote
  while the rest of the team carries on. Operator nodes spend nothing and may not set it. The
  monthly cap, which also covers Ask LoomWatch and every schedule, is set with each company: a
  limit on the OpenRouter key at openrouter.ai, a spend limit on the Claude key's workspace in the
  Claude Console, and LoomWatch's share of the ChatGPT plan in ChatGPT's settings.
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
  `sessionUpdate: "usage_update"` carries how much of the model's context is in use and the call's
  cost: what OpenRouter reported, or, with `paidBy: "anthropic"` and `costEstimated: true`, a Claude
  call priced from list prices, or, with `paidBy: "chatgpt"`, $0 for a call the ChatGPT plan paid.
  Older runs have neither field and were all paid through OpenRouter. Older runs may also hold a
  bare `costUsd` delta. Both are archived as a
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
- **Helpers (ADR 0079).** An agent working alone — the only agent of its team that runs on a model,
  as in an agent's own chat — may bring in helpers with the Team Bus tool `start_helper`
  (`title`, `task`, `send_back`): copies of itself, each started fresh on the brief it writes, with
  its instructions, model, skills, tools, folders and switches, working in its own folder.
  - `guards.maxHelpers` (default `4`, `0` turns helpers off for the team) is how many may work at
    once. `Agent.allowRecruiting: false` turns them off for that agent; the agent builder's
    "Brings in helpers for big tasks" switch writes it.
  - A helper's id is the agent's, `~`, and its number (`writer~2`), which no team-file id can be.
    It brings in no helpers of its own, puts no questions to the person, and leaves out the
    agent's `doneWhen`, check duties and own spending guard; the run's `spend.perRun` covers it.
  - What every helper sends back reaches the agent in one more turn, once all have finished
    (up to three rounds). A helper that fails or is stopped does not fail the run: the agent is
    told, and does that part itself.
  - `POST /api/runs/{id}/agents/{helper}/stop` stops one helper; "Allow for this run" given to the
    agent or any of its helpers covers all of them.
- **One of My agents brought in (ADR 0092).** In a team with no connections, the `entrypoint`,
  which is also an agent working alone in its own chat, may bring in another of the person's
  agents from My agents for a part no one on the team does. It lists them with the Team Bus tool
  `my_agents` and starts one with `dispatch`, by the id the list gives (`mine+<id>`, which no
  team-file id can be). Nobody else is offered it: not its teammates, not a stage, a helper, an
  agent answering a question, or an agent brought in this way.
  - `guards.myAgents` is how many of the person's agents the list holds, most recently saved
    first, with a count of the rest. It defaults to `0`, which turns bringing in off, until the
    bench shows it helps. `Agent.allowMyAgents: false`, filled in from the agent's own
    `bringsIn: false` in My agents, turns it off for that agent.
  - The list leaves out the agents the team already points at (`from.agent`: the team's own
    comes first), an agent whose file waits for the person's review (ADR 0048), and one whose
    model's source isn't connected. A name a team agent has resolves to that agent.
  - The agent brought in works as it is saved in My agents, filled in as a team's pointer is,
    on the lead's model when it names none. It has a folder of its own in the team's workspace
    (`.loomwatch/<team>/mine+<id>`), reads its own reads and what the whole team is given (not
    what the team gave particular agents), learns into its one list (`agent:<id>`), and is kept
    open for more work like a teammate. It counts against `maxConcurrentDispatches` and
    `maxDispatchDepth`, and the run's `spend.perRun` covers it.
  - The `dispatch` answer and its `delegated_result` carry its `name` and `from: {agent}`, so the
    chat names it and says once who brought it in. "Always allow" given to it turns on its own
    switch in My agents, for every team.
- `handoff` starts the target as a background task and marks the caller's roster status as
  `stopped`, but it does not end the caller's current turn. The caller must return after a
  successful handoff; its model calls go on until that turn ends.
- What a `dispatch` or `handoff` agent replies comes back to the agent that started it: once all
  of its delegated work has finished, that agent gets one more turn with each reply (or why it
  failed), and its reply to that turn is its answer. Each result is also archived as a
  `session_meta` event with `phase: "delegated_result"`.
- In a team with no fixed order (team mode), each teammate keeps one conversation for the whole
  run. A `dispatch`, `handoff` or `ask` that reaches a teammate whose last turn has ended
  continues that conversation, so the teammate builds on what it already did and was told.
  - A call that reaches a teammate still working starts a separate copy, which is closed after its
    turn. Nothing ever waits for a busy teammate.
  - At most `guards.maxConcurrentDispatches` teammates hold a conversation at once. Past that, a
    teammate starts fresh each time and is closed after its turn.
  - The call's result says which happened: `continues: true`, or `fresh: "busy"` or
    `fresh: "limit"`.
  - Each turn of a kept teammate ends with a `session_meta` event with `phase: "kept_open"`.
    Every kept conversation closes when the run ends, and records its exit then.
  - A teammate whose round failed, or that was stopped at its own spending limit, is closed; the
    next call starts it fresh.
  - Pipeline stages and the helpers they recruit are unchanged.
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
grant for the folder, so each run sees what is in it then. The prompt names the folder by its full
path. A read by a name inside it, as its listing shows (`drafts/prices.md`), finds the file there
when the agent's own folder has nothing by that name. A **file** added in
the panel is copied beside the team file under `<team>.files/`, and a relative `path` resolves
against the team file's folder (`~/` against your home folder). The agent gets the file's text,
up to 12,000 characters, and a read grant for that one file. The text of a PDF, Word (`.docx`),
Excel (`.xlsx`, `.xls`, `.ods`) or PowerPoint (`.pptx`) file, or of an email (`.eml`), is read by
LoomWatch itself, with nothing to install; when there is none to read, such as in a scanned PDF,
the agent is told where the file is. A picture is described, and an agent on a model that can see pictures looks at it with
`read_file`. When a file's text is longer than 12,000 characters, the prompt carries its opening,
and the full text is put in the prepared folder as `knowledge/<file>`, which the prompt names. Only
`knowledge` may have a `path`.

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
Tools it can use row; see [Give agents tools](TOOLS.md)), ignoring case. The agent is offered that tool's
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
  `edit_file`. After writing a Word, Excel, PowerPoint, PDF, CSV or JSON file, the agent is told
  whether it opens.
- **Commands**: `run_command` runs a shell command in the agent's work folder (with `cmd.exe` on
  Windows) and stops it, and everything it started, after two minutes, or up to ten if the agent
  asks. The command's environment has every provider key and
  LoomWatch's own settings removed, so a script cannot read your key or LoomWatch's database
  address. That means any variable ending in `_API_KEY`, `_API_TOKEN` or `_AUTH_TOKEN`, any starting
  with `OPENROUTER_`, `ANTHROPIC_`, `OPENAI_`, `GEMINI_`, `GOOGLE_API`, `LOOMWATCH_` or `POSTGRES_`,
  and `DATABASE_URL` and `PGPASSWORD`. On a Mac a command also runs in a sandbox: it can change
  files only in the agent's folder and temporary folders, and it can reach the network only when the
  agent is allowed the web. A command can still work in your Mac's apps, such as Calendar, Mail or
  Notes, through `osascript`. macOS asks you the first time an agent works in each app (for now,
  again after each LoomWatch update); you can change your answer later in System Settings → Privacy
  & Security → Automation → LoomWatch. For Calendar, Reminders, Contacts and Photos, macOS then
  asks a second question: whether LoomWatch may read and change what's in them. You can change
  that answer in System Settings → Privacy & Security → Calendars (or Reminders, Contacts,
  Photos). An app you allow can do what the sandbox stops a command
  doing itself: Mail can send email as you, Finder can move or delete any file, and Terminal can run
  any command. Allow only the apps your agents' work needs. Windows and Linux have no such sandbox: there a command can change any
  file you can, so asking before each one is the only check. For an agent allowed the web, a Python
  script's page requests go out as `LoomWatch/<version> (+https://loomwatch.github.io/)` rather
  than Python's own name, which some sites refuse; a name the script sets itself still wins.
- **The web**, for an agent with `allow.web: true`: OpenRouter's web search and page fetch.
  OpenRouter runs them, and the run shows each search and each page read.
- **The web, asked for**, for an agent without `allow.web` (ADR 0104): `search_web` and
  `read_page`, as edits and commands still have their tools when their switch is off. The agent is
  told they ask first, so it reaches for them rather than for a command. Each asks you ("Research
  lead wants to use the web", with the search or the address), and your yes gives that agent the
  web search and page fetch above, and its commands the network, until the run ends: one search is
  rarely enough, so a web request has one **Allow**, and an Allow from the tray, the notch or a
  phone counts the same. **Always allow** turns `allow.web` on. `read_page` reads a link you wrote in your message, or in
  a note while the run works, without asking: LoomWatch fetches it, as a web page's words, a PDF's
  text or plain text. A link in a file, a page, a teammate's brief or another team's request is
  not yours, so it asks, and an agent can't send what it read anywhere without your yes. A redirect
  from a site on the internet to one on your computer or network isn't followed, and an address of
  the agent's own on your computer or network is never read. A page that builds its words with
  script reads as empty. On a Mac, a command that reaches for the network while the web is off is
  answered with why it couldn't, even when it printed nothing.
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

Every switch defaults to `false`, and an absent block means all off. A switch decides whether a
search or page read, a file change or a command runs without asking; off, the agent still has the
tool, is told it asks first, and you answer each time (ADR 0104). An agent whose `spawn.cwd` holds its own team file (`cwd: .`) works in its
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
whole team** when the run has more than one agent. A request is declined if nobody answers within 10 minutes, or in a scheduled run within its
schedule's `waitForYouMinutes` (12 hours by default). The wait is counted by the clock, so a
computer that slept through it declines the request on waking (ADR 0090). The agent is told the call was declined and carries on without it.

A team in Auto mode lets its agents run, without asking, the commands that only read or download.
It is set in the team file:

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

## Project

`project` names the one project the team works in (ADR 0097), a file of its own in the teams
folder, `<teams root>/.projects/<id>.yaml`:

```yaml
# .projects/sutd-final-project.yaml
name: SUTD final project
about: |                 # what it is, who it is for, the person's requirements and decisions
  Colin's final project: a gate for the campus library, in two parts, ekis-gate and ekis-kb.
folders:                 # every agent in the project may read these without asking
  - { name: SUTD, path: /Users/colin/Documents/SUTD }
notes:                   # kept from earlier work: the person's, and lessons about the project
  - { text: Colin picked option B., at: 2026-10-27T09:00:00Z }
  - { text: The course staff read every report., by: Researcher }
mark: sky                # the colour of the small mark beside its name
putAway: true            # optional: shown on Home with the others put away
```

```yaml
# the team file
project: sutd-final-project
```

- **Read with the team.** When a team is read in its teams folder, its project file is read too,
  each time, so a change reaches every team of the project from its next run. Every agent of the
  team is given the project's folders as a folder connected to it is (their listing, and reading
  anything in them without asking), and reads the project's About and notes first under
  `## What the team knows`, before the team's own Brief. A review stop reads nothing.
- **One Notebook for the project.** The notes a team's agents keep are the project's: every team
  in it reads them. Notes a team kept before it joined the project stay readable.
- **Lessons about the project.** When the person's feedback teaches an agent something about the
  project rather than about its kind of work, the learner keeps it as one of the project's notes,
  by that agent, never in the agent's own lessons, which go with it to other work (ADR 0078).
- **A project that is gone** stops the team with a message saying to choose its project again.
- **Deleting a project** (ADR 0100, Delete project… in its "…") leaves its teams in no project:
  each file loses only its `project:` line, and LoomWatch doesn't move them into a project of
  their own. The project's file moves to `.projects/.removed/`, and a new project never takes its
  id.
  A team read on its own (`loomwatchd run team.yaml` with no teams folder) runs without it.
- **Every team works in one.** The app moves each team that names no project into a project of its
  own, named after it, the first time it opens after projects arrived (and any later team it
  finds without one): the team's Brief becomes the About (one for some agents only stays the
  team's), and every folder or file connected to its agents becomes one of the project's folders,
  while the agents keep their own. The daemon keeps a copy of every team file in
  `<state dir>/backups/<date>-before-projects-<key>/` before the first move.
- **One team in several projects** (ADR 0103). A team set up once can work in more than one
  project, each with a place of its own: a team file of its own in each, all naming the same
  `shares:` id.

  ```yaml
  # coffee.yaml                      # coffee-bikes.yaml
  id: market-research                id: market-research-bikes
  shares: market-research            shares: market-research
  project: coffee                    project: bikes
  name: Market research              name: Market research
  # …the same agents and edges…      # …the same agents and edges…
  ```

  Each place keeps its own `id`, `project`, `schedule`, `deliver` and `memory` (the Brief beside
  its file), so its chat, run history, files and Notebook are that project's. Everything else is
  the team's setup: saving any place in LoomWatch writes it into the others, from their next run,
  and keeps each approved. In a room, a team's ⋯ has **Add to another project** (a new place beside
  its file, with no schedule or delivery yet), **Take out of** the project (that place goes to the
  trash when the team works elsewhere; a last place stays, in no project) and **Delete team…**
  (every place). **Add a team** in a room lists your teams that aren't there yet. Deleting a project
  removes only the places there of teams that work elsewhere. Edit a place's file by hand and the
  others keep their setup until the next save in LoomWatch.
- **Limits.** A name of at most 80 characters, an About of at most 4,000, each note at most 500
  and 40 notes (the oldest goes first); folders by full path or from `~/`.

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
(default `You`). It must omit `spawn`, `model`, `followsSuggestion`, `thinkingEffort`, `allow`, `turnedOff`,
`doneWhen`, `part`, `checks`, `sendBack` and `sendBackOnce`. Operator nodes cannot be the entrypoint or appear in team
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
