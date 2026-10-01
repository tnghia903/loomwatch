# Daily tech-news → Notion acceptance test

Date: 2026-09-10. Tested the user's running app at http://127.0.0.1:3001.

Target journey: create a collector → editor → publisher pipeline; collect current tech
news with source links; consolidate into one Notion page; repeat daily without duplicate
publication. This journey is **not production-ready yet**. No real digest has been published.

## Live observations and fixes

| ID | Severity | Evidence / reproduction | Fix / status |
|---|---|---|---|
| NEWS-01 | High | Welcome showed “4 harnesses ready”; Library showed missing Claude and Codex ACP adapters. | Count only confirmed installed adapters; avoid implying authentication or model readiness. Verified live: “2 agent adapters installed.” |
| NEWS-02 | High | Empty canvas only instructed users to drag; Library had no add button. | Native add buttons support mouse, keyboard and touch. Verified live by adding Gemini with its + button. |
| NEWS-03 | Medium | New-team form required Enter; no visible Create or Cancel action. | Added both buttons; verified live team creation using Create. |
| NEWS-04 | High | Library offered mock Reviewer/Protocol Researcher presets with unverified model IDs. | Removed fixtures from production Library; actual configured presets can be added later. |
| NEWS-05 | High | Role, model and working-directory fields had no accessible names; role was one line. | Added accessible names, renamed working folder, expanded role into a multiline instructions box. |
| NEWS-06 | Medium | Workspace links collided with the Inspector header. | Moved navigation out of the Inspector area. |
| NEWS-07 | Critical | Code inspection: `last_agent_reply` returned only the last ACP delta. A multi-chunk article was truncated before the next stage. | Assemble complete text within the individual ACP process; freeze it before session close. Regression exercises a split reply. |
| NEWS-08 | Critical | First attempted aggregation by agent ID mixed overlapping dispatch/ask replies; existing concurrent Team Bus test reproduced it. | Use process-local reply assembly, never a shared archive scan keyed only by agent ID. Concurrent regression passes. |
| NEWS-09 | High | Code inspection: configured roles were not supplied to ACP prompts; downstream nodes received only predecessor output. | Include each agent's role, original task and labeled upstream material. Applies to pipeline, root and delegated agents. |
| NEWS-10 | Critical | No user-facing Notion connection exists. | Added Connections page, token validation, macOS Keychain storage, page search/pagination, destination validation and disconnect. Real workspace authorization still required for integration acceptance. |

Screenshots and accessibility trees for the welcome screen and editor were captured and
inspected through the authorized browser connector in this task. Backend-only findings
are explicitly identified above; they were not inferred from screenshots.

## Remaining release blockers

(As written on 2026-09-10; the dated status block below records what has closed since.)

- Browser run creation and lifecycle supervision are not implemented. Follow the existing
  `RUN_PROVENANCE_CONTRACT.md` snapshot, authorization, idempotency and recovery requirements.
  — *Closed 2026-09-10 by ADR 0008 (`POST /api/runs`, cancel, in-memory registry); snapshots
  and idempotency keys remain deferred there.*
- A daily scheduler, timezone selection, missed-run policy and overlap prevention are absent.
  — *Closed 2026-09-11 by ADR 0010.*
- The saved Notion destination is not yet an executable pipeline publishing stage.
  Publishing needs a durable delivery key, retry/reconciliation semantics and a verified
  resulting page URL; never report success merely because an agent says it published.
  — *Closed 2026-09-11 by ADR 0010 for routine runs (verified URL, duplicate-title guard);
  a durable delivery key and retries are deliberately deferred.*
- The new connection method is an internal integration token, not OAuth. Public onboarding
  requires a registered Notion public connection, OAuth state/callback handling and token
  refresh/revocation support. macOS is the supported credential-store platform for this increment.
- Installed agent adapters do not imply login, a usable model or web-access readiness.
  Execution preflight must verify these before accepting a run.
- Validate a real authorized workspace end to end: connect, select page, publish, retrieve
  contents, retry without duplicates, revoke access, and verify actionable recovery.

## Status 2026-09-11

Shipped ([ADR 0010](decisions/0010-routines-and-notion-delivery.md), `WATCH.md` → *Routines*):

- **Scheduler.** A team file's `schedule` block (`cron`, `timezone`, `prompt`, `enabled`,
  `deliver.notion.title`) is validated with the team; `teams/daily-news.yaml` declares
  `0 8 * * *` in `Asia/Singapore`. The daemon rescans the teams root every 30 s, computes
  the next fire in the schedule's zone, skips fires missed while it was down, and refuses
  to overlap a routine's previous scheduled run (skipped with `problem`; 409 from "Run
  now"). `GET /api/schedules` lists routines with `nextAt`, last run, last delivery and any
  problem; `POST /api/schedules/run` fires one immediately for testing.
- **Notion delivery.** A routine run that `succeeded` with a reply is published as a child
  page of the connected destination, Markdown translated into Notion blocks. The delivery
  outcome (`published` with the URL Notion returned, `skipped` when a child page with the
  same title already exists, or `failed` with the operator-facing reason) is recorded on
  the run (`delivery`) and the routine (`lastDelivery`); success is never inferred from an
  agent's words. Manual runs are not delivered.
- **Unattended execution.** `teams/daily-news/.claude/settings.json` allows `WebSearch`,
  `WebFetch`, `Read`, `Glob`, `Grep` and denies shell and writes, because LoomWatch rejects
  every `session/request_permission`.

Verified: 99 backend tests pass (schedule parsing incl. 5/6/7-field cron and standard
weekday numbering, template expansion across a zone boundary, next-fire computation,
rescan/reconcile, due selection with overlap skipping, Markdown → blocks, schema
acceptance/rejection of the block, and an end-to-end "run now" against the fake ACP harness
whose delivery reports *Notion is not connected*); `cargo fmt`, `cargo check` and Clippy
(pedantic) are clean. No Notion credential was used.

Still open:

- Public OAuth onboarding and non-macOS credential storage (unchanged).
- Execution preflight for adapter login / model / web access (unchanged); an unattended
  failure surfaces as a `failed` run rather than being prevented.
- End-to-end validation against a real authorized workspace, including a real published
  digest, a duplicate-title rerun and revocation — not performed in this increment.
- Persistence of `lastFiredAt` / `lastDelivery` across daemon restarts, and delivery
  retries (deferred by ADR 0010).

## Verification

Frontend tests cover connection errors, secret clearing, search, destination selection,
disconnect, and keyboard-compatible agent addition. Backend checks cover secret-free status,
Notion page title parsing/deleted-page filtering, same-origin protections, streamed handoffs,
original task/role retention and overlapping delegation. Real Notion credentials are never
fixtures, captured in screenshots, or committed to the repository.

Final checks for this increment: 125 frontend tests, 63 backend tests and 3 schema tests
passed; frontend typecheck/build/lint and Rust formatting/Clippy passed. The updated daemon
was restarted on the original port 3001 with the original `--teams-root teams` setting.
Live Notion onboarding and invalid-token recovery were verified against Notion's API with
a deliberately invalid test token. No credential was saved. The user chose to connect later,
so successful authorization, page selection against a real workspace and publication remain
unverified. The temporary port 3002 instance was stopped.
