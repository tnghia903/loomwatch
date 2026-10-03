# 0040 — Ask the operator for permission during the run

- **Date:** 2026-10-03
- **Status:** Accepted.
  - Daemon:
    - `crates/loomwatch-backend/src/permissions.rs`: `PermissionRequest`, `PermissionDecision`,
      `PermissionAsker`, `OpenRequest`, `describe`, `PERMISSION_WAIT`.
    - `acp.rs`: `ProcessSpec::asker`; `ask_operator` in the reader loop; `request_approved`;
      `client_response`.
    - `runs.rs`: the record's `permissionRequests`, the registry's waiting room and per-run grants,
      and `POST /api/runs/{id}/permissions`.
    - `operator.rs` (`OperatorDesk::registry`), `lib.rs` (`agent_process_spec`), `team_bus.rs`
      (helpers ask too).
  - UI:
    - `ui/src/components/run/PermissionPrompt.tsx` and `ui/src/lib/runs/permissionRequests.ts`.
    - `ui/src/lib/runs/client.ts`.
    - The Needs-you tray: `ui/src/lib/story/{needsYou,useNeedsYou}.ts` and
      `ui/src/components/workspace/NeedsYouTray.tsx`.
    - `ui/src/components/Workspace.tsx` and `ui/src/styles/permission.css`.
    - Copy: `AgentPermissions.tsx`, `lib/story/receipt.ts`.
  - Docs: `README.md`, `docs/TEAM_CONFIG.md`, `docs/WATCH.md`.
- **Amends:** [ADR 0037](0037-loomwatch-decides-what-agents-may-do.md). It said `LoomWatch` "cannot
  ask the operator in the middle of a run", so a request no switch allowed was declined on the spot.
  The policy and the switches stay. What changes is what happens to a request the policy does not
  approve.

## Context

An operator watched a research run fail its searches. The Researcher (Claude Code) asked to run
WebSearch, which is kind `fetch`, and "Search the web" was off for that agent. The app reported
"User refused permission to run tool", the timeline showed five of the Researcher's calls in red,
and the team carried on without the sources. The operator was at the keyboard the whole time and
would have said yes.

ADR 0037 declined such requests because nobody could be asked, but the premise no longer held:

- **`LoomWatch` already asks during a run.** Review stops and `ask_user` (ADR 0017) park a run on
  the operator, and the Needs-you tray polls every run.
- **A permission request does not race the ACP timeout.** The app is blocked on our reply and sends
  nothing while it waits. The ten-minute request timeout in `read_response` only runs while a line
  is being awaited, and no line is awaited until we answer. So holding the reply, unlike holding a
  tool call, costs no timeout and needs no session parking.
- **The post-run fix came too late.** The receipt's "Allow from now on" fixes the next run. The
  answer the operator was waiting for was already written without the search.

## Decision

1. **A request the policy declines is put to the operator while the app waits.** `read_response`
   gives a declined `session/request_permission` to the agent's `PermissionAsker`. The asker puts a
   `PermissionRequest` on the run record (`permissionRequests`) and waits for the decision. The
   request carries:
   - the agent and its name;
   - the app's title and kind;
   - the switch that would have allowed it (`fetch`→`web`, `execute`→`commands`, `edit`→`edits`);
   - the query, command, address or path, when there is one;
   - `since` and `expiresAt`.

   The decision becomes the reply: `allow_once` selects the app's one-time option, exactly as a
   switch would. Every run agent asks this way: the team-mode lead, every pipeline stage, and Team
   Bus helpers. Each one's asker lives in its `ProcessSpec`, so a respawned stage keeps asking.
2. **Four answers, two of them kept by `LoomWatch`.**
   - **Allow** lets this request through.
   - **Allow for this run** also remembers it for that agent until the run ends, so the next
     search does not ask again. It remembers the app's tool kind — every web search, every
     command — but one MCP tool exactly. Apps label MCP calls with a broad kind (Codex calls every
     one `execute`, a shell command's kind), and allowing one tool must never allow every command
     (`grant_scope`). For the same reason, an MCP tool is offered no switch.
   - **Always allow** switches the agent's `allow:` on in the team file, the same edit as the
     receipt's "Allow from now on", and lets the rest of the run through. It is offered only when a
     switch covers the request and the team can be edited.
   - **Deny** declines it.

   No answer ever selects the app's own "always" option: that would outlive the run in the app's
   settings, where `LoomWatch` cannot see it.
3. **Nobody waits forever.**
   - A request nobody answers is declined after `PERMISSION_WAIT` (10 minutes), and the card says so.
   - A routine's run (`trigger: schedule`) is not asked, because nobody is watching: it declines at
     once, as before. The receipt still offers "Allow from now on".
   - A cancelled or finished run drops its open requests, and dropping each sender releases the
     blocked app with a decline.
4. **The question is wherever the operator is.** The Run view docks a card under the header, over
   the lane and the canvas alike. It reads "Researcher wants to use the web", then the query, then
   "Researcher is paused until you answer. Declines by itself in 9 min if nobody answers." The
   Needs-you tray shows the same request as a **Permission** ticket from any screen, with Allow,
   Allow for this run and Deny (keys A and D). It also counts in the tab title and turns the tab
   icon's dot red.
5. **The record says who decided.** Around the request and the reply, the archive gains
   `session_meta` events with `awaiting_permission` and `permission_answered`. The `outcome` is one
   of `allow_once`, `allow_run`, `allowed_for_run`, `deny` or `timed_out`. A request the operator
   allowed is no longer a refusal on the receipt; one they denied, or nobody answered, still is.

## Consequences

- A request the switches do not cover now pauses that agent, not the whole run: other stages and
  helpers keep working, and each pending request is its own card.
- A person-started run left unattended can stall for up to 10 minutes per new kind of request.
  "Allow for this run" or the switches avoid that, and so does a routine, which never asks.
- `permissionRequests` is a new optional field on the run record, and older clients ignore it.
  Older daemons never send it; the UI then shows nothing and the app's request is declined as
  before.
- A daemon restart ends every live run (ADR 0016), so an open request cannot outlive the process
  holding the app's reply. It is deliberately not stored.

## Deliberately not done

- **System notifications.** The tab title and icon already change. A macOS notification, a sound or
  a mobile push would reach an operator who is not looking at the tab, which is a separate decision.
- **Asking in a routine.** A routine could wait for an answer if someone happened to be watching,
  but "nobody is watching" is the safe default for an unattended run.
- **An editable wait.** Ten minutes is a constant. A per-team setting can come once someone needs
  another value.
