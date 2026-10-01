# 0010 — Routines: a `schedule` block, an in-memory scheduler, and Notion delivery

- **Date:** 2026-09-11
- **Status:** Accepted — implemented in `crates/loomwatch-backend/src/{config,schedule,notion,runs}.rs`
- **Builds on:** [0008](0008-run-control-api.md) (runs are started through `runs::launch`,
  the one path `POST /api/runs` uses) and the Notion connection shipped with
  `docs/NOTION.md`
- **Closes:** the "daily scheduler" and "Notion publishing stage" blockers in
  `docs/DAILY_NEWS_QA.md`

## Context

The daily-news journey needs a team to run every morning with a fixed prompt and land its
digest on one Notion page without an operator at the keyboard. Runs could only be started
by hand, and the saved Notion destination was not connected to anything that executes.

## Decisions

1. **The routine lives in the team file.** `TeamConfig` gains an optional `schedule`
   block — `cron`, optional `timezone`, `prompt`, optional `enabled` (default true) and
   optional `deliver.notion.title` — validated in `TeamConfig::parse`, so a bad cron
   expression, unknown IANA zone or blank prompt is a 422 from `PUT /api/team` and
   `POST /api/runs`, and the JSON schema (`$defs.Schedule`) rejects unknown keys. Templates
   `{{date}}`, `{{weekday}}` and `{{team}}` expand at fire time in the schedule's zone.
   Cron is the standard 5-field form (`0`/`7` = Sunday; a 5-field expression is rewritten
   into the `cron` crate's seconds form with its day-of-week renumbered) or the crate's own
   6/7-field form.
2. **The scheduler is in memory and rescans the disk.** `schedule::spawn` runs one tokio
   task every 30 s: it rescans the teams root (hidden directories skipped), keeps one
   entry per file with a `schedule` key, recomputes `nextAt` only when the cron/timezone
   changed or the routine fired, and fires every enabled routine whose time has passed
   through `runs::launch(.., RunTrigger::Schedule)`. A file whose schedule fails to parse
   stays listed with `problem` set and no `nextAt`.
3. **Missed fires are skipped, never replayed.** `nextAt` is computed from "now" when the
   daemon starts; a fire that fell while it was down does not happen late. Delivery is
   idempotent enough (see 5) that replaying would only add noise.
4. **No overlap.** A routine whose previous scheduled run is still non-terminal skips the
   fire, records `problem: previous scheduled run <id> is still running`, and advances
   `nextAt`. `POST /api/schedules/run` answers 409 in the same situation.
5. **Delivery is a consequence of a routine run, not a pipeline stage.** After a scheduled
   fire (timed or "run now") a task follows the run; only a `succeeded` run with a
   non-empty reply and `deliver.notion` configured is published, as a child page of the
   connected destination, titled from the template, with the Markdown reply translated
   into Notion blocks (capped at 500). Before writing, the destination's children are
   listed and an existing `child_page` with exactly this title makes the delivery
   `skipped` with that page's URL — the duplicate-title guard that keeps a daily title
   unique. The outcome (`published` with Notion's own page URL, `skipped`, or `failed`
   with the operator-facing message) is stored on the run record (`delivery`) and on the
   routine (`lastDelivery`). Manual runs are never delivered.
6. **Same boundary as run control.** `GET /api/schedules` and `POST /api/schedules/run`
   sit behind `local_evidence` and answer 503 without the archive, because a routine's run
   would otherwise be invisible.

## Deliberately not done

- **Persistence.** `lastRunId`, `lastFiredAt` and `lastDelivery` are lost on restart, like
  the run registry (0008). The archive still holds every event and the Notion page exists;
  the duplicate guard, not a durable delivery key, is what prevents a second page.
- **Retries and reconciliation.** A failed delivery is reported, not retried; the operator
  reruns the routine (`Run now`) and the guard prevents duplicates.
- **OAuth.** The connection stays an internal integration token in macOS Keychain.
- **Other targets.** `deliver` has one key today; the shape leaves room for more.
- **Execution preflight.** An unattended run still depends on the harness never asking:
  for Claude's adapter that means a `.claude/settings.json` in the agent's `cwd` whose
  `permissions.allow` covers the tools the run needs (`teams/daily-news/.claude/settings.json`
  is the worked example), because LoomWatch answers `session/request_permission` with a
  rejection.
