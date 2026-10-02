# 0038 — Send the team's response to Notion from the canvas

- **Date:** 2026-10-03
- **Status:** Accepted. Daemon: `crates/loomwatch-backend/src/config.rs` (top-level `deliver`,
  `notion_delivery_title`, `expand_template` with `{{time}}`), `runs.rs` (`deliver_title` on the
  record, the shared publisher, `deliver_when_finished`, `POST /api/runs/{id}/deliver`),
  `schedule.rs` (routines follow the run's delivery instead of publishing on their own),
  `control/mcp.rs` (Ask's instructions); `schemas/team.schema.yaml` (`deliver`, `$defs/Deliver`).
  UI: `ui/src/components/workspace/{NotionDeliverySettings,OutputEditor}.tsx`,
  `ui/src/components/run/{NotionSend,DeliveryLane}.tsx`, `ui/src/components/canvas/BuildNodeCard.tsx`
  (`BuildOutputCard`), `ui/src/components/Connections.tsx`, `ui/src/lib/notion/connection.ts`,
  `ui/src/lib/team-file/{types,document,useTeamDocument}.ts`, `ui/src/lib/runs/{client,graph}.ts`,
  `ui/src/lib/story/teamSentence.ts`, `ui/src/components/Workspace.tsx`,
  `ui/src/components/workspace/useCanvasGraph.ts`, `ui/src/styles/delivery.css`. Docs:
  `docs/NOTION.md`, `docs/TEAM_CONFIG.md`, `docs/WATCH.md`.
- **Amends:** [ADR 0010](0010-routines-and-notion-delivery.md) decision 5, "Manual runs are never
  delivered". A routine's own `schedule.deliver` keeps its meaning and its one-page-a-day title.

## Context

The operator asked how to "write the team's response to Notion" from the canvas and could not
find a way. Everything needed existed, but nothing on the canvas led to it:

- **The setting was YAML-only, and in a block the canvas cannot create.** Delivery lived at
  `schedule.deliver.notion`. The canvas shows a schedule card only when the file already has a
  `schedule:` block, and its editor carried `deliver` forward without ever letting anyone set it
  (`normalizeSchedule`: "`enabled` and `deliver` are not editable on the canvas").
- **Runs people actually start never published.** ADR 0010 delivered routine runs only. A person
  who did find the YAML, then typed a request and pressed Enter, got nothing in Notion and no
  sign of why.
- **The Team response node said nothing about where the answer goes.** Its settings named the
  deliverable, a format and the producing agent.
- **Connections ended in a dead end.** After a destination page was chosen it said only "This saves
  a destination. It does not start a pipeline or create a daily schedule." That was true, and it
  gave no next step.
- **A run's answer did not show where it went.** A published page's URL lived on the run record,
  and only Run history mentioned it, as the words "published to Notion".

## Decision

1. **Where the answer goes is a property of the team's output, so it lives on the Team response.**
   Selecting the Team response node in Build opens its settings, which gain a "Where the answer
   goes" section with one switch, **Send every answer to Notion**. The section:
   - says in place whether a page would arrive: Notion not connected, no page chosen, or "new pages
     go under *Page* in *Workspace*";
   - links to Connections in a new tab, so unsaved canvas edits are not left behind, and reads the
     connection again when the window regains focus;
   - takes an optional page title and previews the next page's title.

   When the switch is on, the node itself reads "Also sent to Notion", and the team sentence ends
   "Answers also go to Notion."
2. **It is written as a top-level `deliver` block, the same shape as the routine's.**
   `deliver: {notion: {title?}}` (`$defs/Deliver`, shared with `schedule.deliver`). Absent means
   answers stay in LoomWatch. The switch writes `notion: {}` unless the person typed a title, so
   the file stays as short as the choice.
3. **Every successful run delivers, whoever started it.** That covers a run from the canvas, a
   follow-up, a retry, a routine and a run from Ask. The title is expanded once at launch, from the
   bytes the run executes, and kept on the record as `deliverTitle`. That field is what lets the
   answer say "Sending to Notion…" between the run's end and its `delivery`. It is not stored: a
   record read back after a restart already has its delivery, or never will. The run registry
   holds the one publisher and does all publishing. The scheduler installs that publisher and only
   follows a routine's run, so the routine can report `lastDelivery`. That field is now read live
   from the run, like `lastStatus`.
4. **Titles.** A routine still prefers its own `schedule.deliver`, with the default
   `{{team}} — {{date}}`. Every other run uses the top-level block, whose default is
   `{{team}} — {{date}} {{time}}`. The extra minute is there because a person who runs a team twice
   in a day wants two answers, and the duplicate-title guard would otherwise skip the second.
   `{{time}}` (24-hour `HH:MM`) is new for both blocks. Dates and times are read in the schedule's
   zone when the team has one, else the daemon's.
5. **Any finished answer can be sent by hand.** `POST /api/runs/{id}/deliver`, with an optional
   `{title}` body, publishes a terminal run's reply now, whatever the team file says. The default
   title is the run's own `deliverTitle`, else the team's template. It answers `200` with the
   record, even when Notion refused, because `delivery` says why. It answers 404 for an unknown
   run, 409 while the run is live or its automatic delivery is in flight, 422 for a run with no
   answer, and 400 for a blank or over-long title or an unknown field. On the Run view, the answer
   card's line under "Written by" shows one of:
   - **Send to Notion**, for a team that does not deliver;
   - **Sending to Notion…**;
   - **Sent to Notion · Open page**;
   - **Already in Notion · Open page**;
   - **Not sent to Notion**, with the reason and either *Try again* or *Connect Notion*.
6. **Connections says what comes next.** Its steps end with turning the switch on, and a chosen
   destination says that answers become pages under it, naming the switch.

## Consequences

- A team with `deliver` publishes on every run, test runs included. That is what "every answer"
  promises, and the section says it next to the switch. Turning the switch off is the way to
  iterate quietly.
- A team without a top-level `deliver` behaves exactly as before ADR 0038: routine-only delivery
  through `schedule.deliver`, and no automatic publishing for runs started by hand.
- `deliverTitle` is a new optional field on the run record. Older clients ignore it. Older daemons
  do not send it, and the UI then treats the run as not delivering.
- The Notion connection is still one internal-integration token per macOS user (`NOTION.md`), so
  "where" is that one destination page. Choosing a different page per team would add
  `deliver.notion.parent` and a page picker to the section, and the Notion API already supports it.

## Deliberately not done

- **A schedule editor that adds a `schedule:` block from the canvas.** It is a separate gap
  (routines are still YAML-first to create) and does not block sending answers.
- **Retries.** A failed automatic delivery is reported on the answer. *Try again* is one click,
  and the duplicate guard stops it from creating a second page.
- **Other destinations.** `deliver` has room for keys beyond `notion`; none is added here.
