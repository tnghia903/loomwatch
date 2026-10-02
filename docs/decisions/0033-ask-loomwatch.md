# 0033 — Ask LoomWatch: your own AI app builds and runs teams, you keep the decisions

- **Date:** 2026-10-02
- **Status:** Accepted. Proposal reviewed as the "Ask LoomWatch" page, 2026-10-02. Amended
  2026-10-02: the person chooses the app and model (see *Choosing the app*).

## Context

Building a team means choosing agents, apps, models and an order, then wiring them on the canvas.
People already describe that work in a sentence ("every weekday at 8, collect AI news, have Codex
check it, let me approve it, then write a brief"). The AI apps LoomWatch drives can turn that sentence
into a team, but until now nothing let them see or change LoomWatch.

Two constraints shaped the design. A team run spends the user's AI plans, and the review stop exists
so a person, not an AI, decides whether work goes further.

## Decision

**One tool server, LoomWatch Control, reached two ways.**

1. **Inside LoomWatch, with no setup.** An *Ask* panel (header button on every screen, a
   *Describe the job* box on Home, *Ask LoomWatch…* in ⌘K) talks to one of the user's own AI apps.
   LoomWatch starts that app over ACP outside any run and hands it the LoomWatch Control tools at
   `session/new`, the same way every agent already receives the Team Bus. The app is the one the
   person chose in the panel, else the first one found of Claude, Codex, Gemini, OpenCode and
   Hermes, and the panel says which. OpenClaw cannot receive HTTP tool servers and is not offered.
2. **From another app, one click.** Settings → Connections lists the AI apps found on this computer.
   *Connect* registers LoomWatch with that app's own command (`claude mcp add`, `codex mcp add`,
   `gemini mcp add`, `code --add-mcp`), shown (token masked) before it runs; *Disconnect* runs the
   app's own remove where it has one. OpenCode and Claude Desktop have no such command and get a
   snippet to paste instead, shown once. Each connection gets its own token; Codex reaches the HTTP
   server through `loomwatchd mcp`, a stdio bridge.

**The tools propose; the person decides.**

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_teams`, `read_team` | read | Teams, their file, and the team file's text |
| `list_apps` | read | AI apps found here, their ready-to-use `spawn` block and default model |
| `propose_team` | proposes | Validates a complete team file and stores it as a proposal |
| `start_run` | proposes (acts when allowed) | Asks the person to start a run; starts it directly only when they turned that on |
| `get_run` | read | Status, stages, the open review question, and the team response |
| `draft_review_note` | proposes | Suggests a note for an open review stop |

- A proposal never writes the team file. The Build canvas shows it in preview — added and changed
  agents dashed and tagged *New* or *Changed*, Build's heading turned into "Check the proposed
  changes" with the list of changes, *Discard* and *Apply* — until the person presses *Apply*. A new
  team asked for on Home opens as an unsaved team; *Discard* goes back to Home. After *Apply*, *Undo*
  restores the previous file as well as the canvas. Saving any other way (⌘S) counts as applying it,
  and ⌘Z back to the person's own version counts as discarding it.
- Runs ask first. The panel shows the team, the request and the apps that will be used, and waits
  for *Start run*. A per-browser setting allows "run when I ask".
- **There is no tool that answers a review stop.** The panel explains the open question and can put
  a drafted note into the review box. Only the person presses *Approve* or *Send back*.
- What a connected app proposes, starts or drafts is listed at the top of the Ask panel ("From your
  connected apps"), and the header button shows a dot until the person has seen it. The app is told
  that is where the person will find it.
- No loops: team agents never receive these tools, and the tool server refuses any token that is not
  an Ask conversation or a connected app.
- Everything is recorded: an Ask conversation is archived as its own session, replayable like a
  run. The tool server answers only on loopback with a bearer token; the browser-facing endpoints
  keep run control's loopback and origin checks.

**ChatGPT and claude.ai on the web are out of scope.** They connect from the cloud, so reaching a
local LoomWatch would need a public, authenticated address for something that starts agents on the
user's computer. That is a separate decision.

## Consequences

- Every Ask turn is a turn of the user's own AI app and uses its plan, like any run.
- Proposals are validated by the same rules as a saved team — `TeamConfig::parse`, then the team
  schema the editor checks before it saves (which made `jsonschema` a runtime dependency) — so the
  model gets the exact error and can fix its file before the person sees anything, and nothing
  reaches the canvas that *Apply* would refuse.
- Proposals live in the daemon's memory. The conversation archive records each one whole, so after a
  restart the panel shows a proposal from its recorded copy.
- Finding each app's models starts the app, so a new conversation starts that lookup straight away;
  the first "make me a team" does not wait for it.
- Claude's ACP adapter runs tools without asking only when its working folder allows them, and
  LoomWatch declines permission prompts. The Ask session therefore runs in its own folder whose
  `.claude/settings.json` allows exactly the LoomWatch Control tools and denies shell and file writes,
  and LoomWatch approves permission prompts for its own Control tools in that session only.
- Tests use a scripted ACP app that calls the tools over HTTP; no model provider is used.
  `LOOMWATCH_ASK_COMMAND` runs the same script as the assistant for an offline demo.

## The panel

One conversation follows the person across Home, Build and Run (each team opens as a page, so the
conversation's id and the panel's open state are kept for the browser tab, and the transcript is read
back from the archive). It docks where the inspector does, 320 px on the right, and waits behind a
selected agent or other right-hand panel; the header button, ⌘J or ⌘K's *Ask LoomWatch…* bring it
back. Words ⌘K has no command for are offered to Ask. Each tool call is one plain line ("Checked your
AI apps", "Found a problem in the draft"), and cards carry the decisions: a proposal (*Show on
canvas*), a run waiting for *Start run* or *Not now*, a drafted review note (*Put it in the review
box*, which closes the panel so the box shows in full). The panel itself is loaded on first open.

Motion follows the motion tokens and stops under reduced motion: the panel slides in while its glass
stays put, messages and cards rise in, a step's spinner turns into a check, the thinking dots
breathe, a proposal's dashed edge travels while a gold arc circles each proposed agent, and applied
agents settle with one glow.

## Choosing the app

The panel's "Using Claude on this computer" names the app as a button. It opens a list of the apps
Ask can use (one that can't run here is shown, with why, but can't be picked) and, under it, that
app's models: *Its default* first, then the rest of what the app lists through
`GET /api/harnesses/{id}/models`. Finding them starts the app, so the list says it is looking and
keeps what it read for the page. Choosing an app keeps the list open on its models; choosing a model
closes it.

- The choice is kept for the browser, like *Ask me before starting a run*. A chosen app that later
  can't run gives way to the first app that can, without forgetting the choice.
- `POST /api/ask/conversations` takes `model` beside `app`. Empty or absent is the app's default;
  anything that can't be a model id (over 200 characters, or a control character) is refused before
  the app starts. The model is set when the session opens, the same way a team agent's is, and is
  recorded with the conversation's status, so the transcript says which model answered. An app that
  turns the model down fails the conversation with a sentence saying to choose another model or the
  default.
- A conversation is one session of one app, so changing the app or model ends the conversation and
  starts the next message in a new one. The list says so while a conversation is under way. A
  conversation kept from another tab shows the app it started with until the person changes it.
- There is no per-conversation thinking-effort choice; the app's own default applies.
