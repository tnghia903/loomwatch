# 0044 — Withhold the app tools that reach past the run

- **Date:** 2026-10-03
- **Status:** Accepted.
  - Daemon: `crates/loomwatch-backend/src/permissions.rs` (`WITHHELD_CLAUDE_TOOLS`,
    `PermissionPolicy::session_meta`), `acp.rs` (`session_params`, used by `session/new` and
    `session/load`).
  - UI: `ui/src/lib/library/observed.ts` (`OUTWARD_APP_TOOLS`, `outwardTool`, `outwardCalls`,
    `UsedInRun.outward`), `ui/src/lib/story/receipt.ts` (one check line),
    `ui/src/components/library/ComponentPalette.tsx` (the "Used in this run" row).
  - Docs: `docs/TEAM_CONFIG.md`, `README.md`.
  - Amended by [ADR 0047](0047-start-codex-without-its-plugins-and-apps.md): Codex runs an MCP
    tool that calls itself read-only without asking, so its plugins and apps are withheld too.
- **Amends:** [ADR 0037](0037-loomwatch-decides-what-agents-may-do.md). Its promise, that what an agent
  does without asking is what the operator switched on, assumed every outward action reaches the
  policy as a `session/request_permission`. For these tools it does not.

## Context

While retaking the landing-page screenshots on 2026-10-03, a demo team's Writer ran on Claude Code
(`claude-agent-acp` 0.85.1, Claude Code 2.1.286, model haiku). Its role was "Write the brief for the
leadership team.", and it said nothing about files. The Writer called Claude Code's built-in
`Artifact` tool twice and published the brief as a private artifact on the operator's claude.ai
account. The run recorded each call as `tool_call` (`name: "Artifact"`, `toolKind: "other"`), then a
completed `tool_update` saying "Published … at https://claude.ai/artifact/…". There was no
`permission` event between them. The session was in Claude Code's ask-first mode (`default`), and
in the same run, `Read` calls outside the agent's folder did ask.

Reading the Claude Code binary explains why. With Claude Code's "five-class asks" consent model, an
`Artifact` publish is ruled by operation. A write to a new artifact that the user owns and that is
not public, on a turn started by a user message, is `{ask: false}`. LoomWatch's prompt is a user
message, so the first publish allowed itself. The second publish matched "Redeploy of an artifact
already published this session" and was allowed too. Claude Code's ruling is reasonable for a person
at a terminal: the artifact starts private. A team run is different:

- **It is an outward step the operator never saw.** It uploads the team's work to Anthropic's
  servers, under the operator's account, beside LoomWatch's review stop and delivery
  ([ADR 0038](0038-send-the-team-response-to-notion.md)), not through them.
- **No mode or policy in LoomWatch can catch it.** The call never reaches `canUseTool`, so it never
  becomes an ACP permission request.
- **The record hid it.** The receipt counts sources, searches, files, commands and skills. A `tool`
  card counts for none of them, so the run read "Writer finished". "Used in this run" listed a row
  named "Artifact", described as "Built into the app" like any harmless tool.

A probe of the same SDK session (`permissionMode: default`, no prompt, `system/init`) listed more
built-in tools that reach past the run: `ArtifactComments`, `ArtifactData`, `DesignSync`,
`RemoteTrigger`, `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `PushNotification`,
`SendMessage` and `ListAgents`. The same session also loads the operator's claude.ai connectors
(Gmail, Google Drive, Notion and others) and plugin MCP servers. Those do ask: a claude.ai Notion
search reached `canUseTool` in `default` mode, so ADR 0040 already puts them to the operator.

## Decision

1. **Withhold, don't ask.** Every run agent, meaning every session with a `PermissionPolicy`, is
   started without these Claude Code tools: `Artifact`, `ArtifactComments`, `ArtifactData`,
   `ArtifactCheck`, `DesignSync`, `RemoteTrigger`, `CronCreate`, `CronDelete`, `CronList`,
   `ScheduleWakeup`, `PushNotification`, `SendMessage` and `ListAgents`
   (`WITHHELD_CLAUDE_TOOLS`). The rule is anything that reaches the operator's claude.ai account,
   their cloud routines or schedules, their devices, or their other Claude sessions. Reads are
   included: listing the operator's artifacts or sessions is discovering knowledge the operator did
   not connect ([ADR 0036](0036-knowledge-is-chosen-not-discovered.md)).
2. **Through `_meta` on `session/new` and `session/load`.** The tools go out as
   `{"_meta": {"claudeCode": {"options": {"disallowedTools": [...]}}}}`. `claude-agent-acp` passes
   `claudeCode.options` to the Agent SDK as-is, and `disallowedTools` removes the tools before the
   model sees them. The SDK probe confirmed that all thirteen leave the session's tool list and
   nothing else does. It works wherever the agent works, its own folder or one the operator chose,
   and it touches no file. Other apps ignore an unknown `_meta` key. The Ask assistant and model
   discovery have no policy and keep every tool.
3. **The record says when one ran anyway.** It can happen on an app that ignores the key, or in a
   run older than this rule. A call to one of these tools that did not fail becomes a receipt check:
   "Writer used Artifact, which publishes to your claude.ai account, without asking you (2 times)".
   The check links to the first call, whose card holds what was sent, so the answer's badge reads
   "1 thing to check" instead of "Nothing flagged". The tool's row in "Used in this run" says "Used
   without asking: publishes to your claude.ai account". `OUTWARD_APP_TOOLS` in `observed.ts`
   repeats the daemon's list. As with `switchForRequest`, the two are kept the same by hand.

### Considered: ask instead

A whole-tool ask rule would route the call to LoomWatch. With
`settings: {permissions: {ask: ["Artifact"]}}` (the `flagSettings` tier, also reachable through
`_meta`), a publish reached `canUseTool` with `matchedAskRule`. Denying it published nothing. It
was rejected for three reasons:

- **LoomWatch already owns the outward step.** It goes through the review stop, then the delivery
  the operator chose. A mid-run "Writer wants to use Artifact" card is a second, unreviewed way out,
  and a normal operator cannot judge it.
- **It would ask often and fail closed for routines.** Each publish and each redeploy would ask, a
  scheduled run would decline every one, and an unattended run would stall ten minutes on each.
- **"Allow for this run" is keyed by kind for an app's own tools.** These tools are all `other`, so
  one yes would let every other `other` tool through for the rest of the run.

## Consequences

- An agent can no longer put its work on the operator's claude.ai account, or schedule, notify or
  message outside the run. An operator who wants an artifact can publish the answer themselves, or
  a future `deliver:` target can do it after the review stop.
- The list is a deny-list, so it fails open. A new outward tool in a future Claude Code release runs
  until it is added here. The receipt check covers only the tools in this list, so it cannot catch
  that tool. Comparing a session's tool list (`_claude/sdkMessage` with `emitRawSDKMessages`)
  against a list of known tools would close the gap, but is not built. An allow-list (the SDK's
  `tools` option) was rejected for the opposite failure: it would silently drop a working tool on
  rename or addition, such as `ToolSearch`, which deferred MCP tools need, the Team Bus among them.
- Claude Code still auto-allows read-only shell commands inside the agent's folder (`cat`, `ls`) in
  `default` mode. That stays on the machine and is not covered here.
- Codex, Gemini CLI, OpenCode and Hermes were not audited for outward tools that allow themselves.
  Codex's tools are shell, patch, web search and MCP, and run 6ebcd025 showed its MCP calls asking.
- A run agent still gets every MCP server the operator configured for Claude Code, including the
  claude.ai connectors (Gmail with `send_message`, Google Drive, Claude Docs, Notion). Each call
  asks, so the operator decides it. Still, the agent sees tools the operator never connected to it,
  which is ADR 0036's concern. Starting run agents with only the servers LoomWatch hands over (the
  SDK's `strictMcpConfig`) is a separate decision, and is not made here.
- Verified live on 2026-10-03: see "Verification" below.

## Verification

- `acp.rs` `a_run_agent_starts_without_the_app_tools_that_reach_past_the_run`: a fake app fails
  unless a run agent's `session/new` carries the `_meta`, and unless a session with no policy does
  not.
- `lib.rs` `a_parked_harness_that_advertises_load_session_is_closed_and_reopened_on_the_same_id`: the
  reload fails (exit 75) unless `session/load` carries it too.
- `permissions.rs`: the list holds the outward tools and none of the working ones.
- UI: `observed.test.ts`, `receipt.test.ts`, `ComponentPalette.test.tsx`.
- With the `_meta` removed, both daemon tests fail. With the receipt loop or the row field removed,
  the UI tests fail.
- Live on an isolated daemon (:3300, scratch database), with a one-agent team whose Writer runs
  Claude Code (`npx -y @agentclientprotocol/claude-agent-acp`, haiku), role "Write the brief for the
  leadership team.". The adapter got a `CLAUDE_CODE_EXECUTABLE` wrapper that logs its arguments:
  - The Claude CLI was started with `--disallowedTools` followed by the thirteen tools and
    `AskUserQuestion`, which the adapter adds itself. The session was in `default`.
  - Asked to list its tools without calling any, the Writer listed no `Artifact`, `Cron*`,
    `DesignSync`, `PushNotification`, `RemoteTrigger`, `ScheduleWakeup`, `SendMessage` or
    `ListAgents`. Read, Write, Edit, Bash, WebSearch, WebFetch, Skill, ToolSearch and Agent were all
    there.
  - Asked to "publish it as an artifact on claude.ai", the Writer made no `Artifact` call. It reached
    instead for the operator's claude.ai Claude Docs connector (`mcp__claude_ai_Claude_Docs__batch`).
    That call asked, waited as an operator request (ADR 0040), and was denied, so nothing left the
    machine.
  - A fake app reporting two completed `Artifact` publishes printed the receipt check above. The
    answer badge read "1 thing to check", and the row read "Used without asking: publishes to your
    claude.ai account". The row's hint about the allow switches is hidden when no listed app tool
    could be switched on.
