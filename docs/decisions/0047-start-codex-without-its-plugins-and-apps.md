# 0047 — Start Codex run agents without its plugins and apps

- **Date:** 2026-10-03
- **Status:** Accepted.
  - Daemon: `crates/loomwatch-backend/src/permissions.rs` (`WITHHELD_CODEX_FEATURES`,
    `PermissionPolicy::codex_config`), `acp.rs` (`withheld_app_config`, used by
    `AcpProcess::spawn`), `workspace.rs` (`Harness::of_spawn`).
  - UI: `ui/src/lib/library/observed.ts` (`OUTWARD_APP_SERVERS`, `outwardTool`, `outwardCalls`,
    `connectedServersByAgent`, the origin in `toolIdentity`), `ui/src/lib/watch/events.ts`
    (`ProjectedAgent.connectedServers`), `ui/src/lib/story/receipt.ts` (the check line),
    `ui/src/components/library/ComponentPalette.tsx` and `Workspace.tsx` (the "Used in this run"
    rows).
  - Docs: `docs/TEAM_CONFIG.md`, `README.md`.
- **Amends:** [ADR 0044](0044-withhold-tools-that-reach-past-the-run.md). It said Codex's tools
  were shell, patch, web search and MCP, and that run 6ebcd025 showed its MCP calls asking. That
  holds only for an MCP tool that does not call itself read-only.

## Context

The daily tech digest (`examples/usecases/daily-tech-digest.yaml`) ran as a routine on 2026-10-03
(run 4bb918c5, daemon at 32369d8). Its Gatherer runs on Codex (`codex-acp` 2.1.1, Codex 0.159.3),
and LoomWatch had put its session in Codex's ask-first mode, `read-only`. At seq 725 the Gatherer
called `mcp.cua_repl.js` with
`cua.createBrowserTab("iab", "https://github.blog/changelog/…", {visible:false})`. At seq 726 the
call failed with "Browser is not available: iab". No `session/request_permission` reached LoomWatch.

Nobody connected `cua_repl` to the Gatherer, and it is not in the operator's
`~/.codex/config.toml`. It is the MCP server of the `unified-computer-use@openai-bundled` plugin
(`.mcp.json` in the ChatGPT app's bundled plugins, 26.928.40906). It runs the ChatGPT app's Computer
Use and browser REPL. Codex's rollout of the session records the call with that `pluginId` and
`readOnlyHint: true`. Codex asks before an MCP tool call only when the tool does not say it is
read-only. That is true in every mode. The Team Bus tools declare nothing, so they asked (run
6ebcd025 recorded 12 requests). `cua_repl`'s `js` runs any code it is given, yet calls itself
read-only, so it never asks.

`codex app-server` was driven directly, with the config `codex-acp` builds. `thread/start` was
sent, then `mcpServerStatus/list`. Besides the server LoomWatch handed over, the session connected
these:

| Server | From | Tools | Self-declared read-only |
| --- | --- | --- | --- |
| `codex_apps` | the operator's ChatGPT account (Codex's `apps` feature) | 401 | many reads, such as `google_drive.search` and `github.list_repositories` |
| `cua_repl` | plugin `unified-computer-use` | 3 | `js`, `js_reset` |
| `creative_production_mcp` | plugin `creative-production` | 1 | none |
| `node_repl` | `[mcp_servers.node_repl]` in `~/.codex/config.toml`, written by the ChatGPT app | 4 | `js`, `js_add_node_module_dir`, `js_reset` |
| `agentmemory` | `[mcp_servers.agentmemory]` in `~/.codex/config.toml` | 7 | none |

Plugins also bring skills: Codex listed 18 skills, 7 of them from plugins. They bring hooks too.
`unified-computer-use` calls `cua_repl.turn_ended` whenever a turn stops.

`codex-acp` gives a client one handle on all this. It starts `codex app-server` with no flags. For
each session it sends `thread/start` (or `thread/resume`) with a `config` object of
`{...CODEX_CONFIG, projects: {cwd: trusted}, mcp_servers: <the ACP mcpServers>}`. `CODEX_CONFIG` is
an environment variable holding JSON, read once at startup. `session/new` takes no config through
`_meta`: the only `_meta` key read there is `additionalRoots`. Codex's `turn/start` has
`disabledPluginIds`, but `codex-acp` never sends it.

The record hid the call. The receipt flagged nothing. "Used in this run" listed `cua_repl · js` as
"Connected tool", as if the operator had connected it.

## Decision

1. **Plugins and apps off, through `CODEX_CONFIG`.** Every Codex run agent is spawned with
   `CODEX_CONFIG` setting `features.plugins` and `features.apps` to `false`
   (`WITHHELD_CODEX_FEATURES`). A run agent is a session with a `PermissionPolicy`, on an app that
   `Harness::of_spawn` reads as Codex. The flags are merged into the `CODEX_CONFIG` the team
   file's `spawn.env` sets, or the daemon's own, which the child would otherwise inherit.
   - **Shape.** The flags go in as a `features` object, never as dotted keys. `codex-acp` sets
     `features` itself (`cwd_relative_turn_diffs`), and Codex applies a session's config keys in
     no fixed order, so `features.plugins` could lose to it.
   - **Refusal.** A `CODEX_CONFIG` that is not a JSON object stops the agent before Codex starts,
     with a message. `codex-acp` would fail on it anyway.
   - **Scope.** The Ask assistant, model discovery and other apps are untouched. `codex-acp` uses
     the same config for `thread/resume`, so a reloaded session (`session/load`) is covered too.
   - **No secrets.** The variable carries none, which matters because the agent's own commands can
     read it.
   - **Measured.** The plugin servers and `codex_apps` are gone, and the Team Bus and connected
     tools, which still go out as ACP `mcpServers`, stay. The same flag on the app-server process
     (`--disable plugins`) took Codex's skill list from 18 to 11, with none left from plugins.
     `skills/list` is not per session, so this was not measured per session.
2. **The operator's own Codex MCP servers stay, for now.** No way to switch off the
   `[mcp_servers]` in `~/.codex/config.toml` from LoomWatch is both reliable and safe with
   `codex-acp` 2.1.1 (see "Considered"). `node_repl` and `agentmemory` keep loading into Codex run
   agents.
3. **The record says what ran anyway, by whose server it is.** A tool call to an MCP server
   LoomWatch did not hand that agent is a receipt check, unless its app asked first. Handed-over
   servers are the Team Bus plus the servers in the agent's `prompt_sections` record (`tools`,
   ADR 0029).
   - **Failed calls count.** A call to a code runner may have acted before it failed.
   - **Wording.** The check reads "Gatherer tried cua_repl, which controls the browser and apps on
     your computer, without asking you" ("used" once a call finished). `OUTWARD_APP_SERVERS` says
     what `cua_repl`, `node_repl` and `codex_apps` do. Any other server reads "which Codex brought
     and LoomWatch didn't connect".
   - **The row.** In "Used in this run", the server's row is "Built into the app", not "Connected
     tool", and says "Used without asking: …".
   - **Any app.** The rule holds on every app, so a Claude Code MCP server that the operator's own
     Claude settings allow is flagged too.
   - **Unlike ADR 0044's list.** That list of Claude tools still flags only calls that did not
     fail. This rule fails closed: a server nobody has seen yet is flagged the first time it runs
     unasked.

### Considered: switching off the operator's MCP servers

Each way was tried against Codex 0.159.3:

- **`mcp_servers.<name>.enabled = false` as dotted keys in `CODEX_CONFIG`.** This works alone. Next
  to the `mcp_servers` key `codex-acp` builds from the handed-over servers, it is a coin flip.
  Codex applies a session's keys in hash order, and over 8 sessions `node_repl` and `agentmemory`
  each stayed on or went off independently.
- **The same, as an `mcp_servers` table in `CODEX_CONFIG`.** `codex-acp` spreads `CODEX_CONFIG`
  first, then sets `mcp_servers` to the servers it was handed, which replaces the table.
- **Handing LoomWatch's servers over in `CODEX_CONFIG` too, with an empty ACP list.** This is
  reliable, since one table holds both, and it was rejected for secrets.
  - **Secrets.** The Team Bus token and connected tools' keys would sit in an environment
    variable that the agent's commands read. Codex's `command/exec` printed both `CODEX_CONFIG`
    and a `*_TOKEN` variable set beside it.
  - **Exact names.** A disabled name Codex has not loaded fails the whole session ("invalid
    transport in `mcp_servers.no_such_server`"), so the list would have to match Codex's config
    layers exactly.
  - **Ordering.** Every spawn would have to wait for the Team Bus.
- **A project `.codex/config.toml`.** It would mean writing into agent folders, the folder the
  operator chose for an agent among them. `~/loomwatch` is itself a git repository, so Codex reads
  project layers from more than one folder.
- **A separate `CODEX_HOME`.** It splits the operator's login (`auth.json`) and their session
  history from Codex's own.
- **A Codex profile, or `--ignore-user-config`.** Codex 0.159 refuses `profile =` ("legacy …
  config is no longer supported"). `--ignore-user-config` exists only on `codex exec`, and it would
  drop the operator's model settings too.
- **Asking instead.** Codex decides by the tool's own annotation. Nothing LoomWatch sends makes a
  self-declared read-only tool ask.

The fix belongs in `codex-acp`. `createSessionConfig` would merge `CODEX_CONFIG`'s `mcp_servers`
under the servers it is handed, instead of replacing them. Once it does, LoomWatch adds
`{"enabled": false}` for each server in the operator's Codex config.

## Consequences

- **Lost to Codex agents.** Codex run agents no longer get plugin skills (documents, PDF,
  spreadsheets, presentations, Google Drive, Notion and others) or the ChatGPT apps. Knowledge and
  tools are chosen ([ADR 0036](0036-knowledge-is-chosen-not-discovered.md)): connect what an agent
  needs in Build.
- **The open gap.** `node_repl` is the same kind of REPL as `cua_repl`, and its `js` also calls
  itself read-only, so a Codex run agent can still drive the browser without asking. The receipt
  now flags it, but cannot stop it. Until `codex-acp` changes, an operator can remove or set
  `enabled = false` on `[mcp_servers.node_repl]` in `~/.codex/config.toml`. The ChatGPT app may
  write it back.
- **A different safeguard.** The feature flags are not a list that has to grow with Codex's
  plugins. Every plugin and app is off, whatever it is called. The receipt rule needs no list
  either.
- **Codex's other tools.** Its hosted web search and code mode's `exec` are unchanged and were not
  audited here.

## Verification

- `acp.rs` `a_codex_run_agent_starts_without_its_plugins_and_apps`: a fake app named `codex-acp`
  fails unless a run agent's environment holds the merged `CODEX_CONFIG`. It also fails unless a
  session with no policy, and a run agent on Claude Code, get the team file's config unchanged. A
  `CODEX_CONFIG` that is not an object is refused before spawning.
- `permissions.rs` `a_codex_run_agent_starts_without_plugins_or_apps_and_keeps_its_own_config`.
- UI: `observed.test.ts`, `receipt.test.ts`, `ComponentPalette.test.tsx`.
- **Each fix removed in turn turns a test red:**
  - the injection, the policy check, the harness check;
  - the server rule, the asked check, the failed-call rule;
  - the row origin, and the projection of `connectedServers`.
- **Live, without a model turn,** through the real chain: `npx -y @agentclientprotocol/codex-acp`
  with a stdio server handed over in `session/new`.
  - **Without the variable:** Codex started the handed-over server, `cua_repl`, `node_repl` and
    `agentmemory`.
  - **With `CODEX_CONFIG={"features":{"apps":false,"plugins":false}}`:** `codex-acp`'s logged
    `thread/start` carried `features: {apps: false, plugins: false, cwd_relative_turn_diffs:
    false}` and only the handed-over server in `mcp_servers`. Codex started the handed-over server,
    `node_repl` and `agentmemory`, and no `cua_repl`.
  - **Remote servers,** which start no process: a `codex app-server` session started directly with
    the same features and a handed-over server listed no `codex_apps` or `creative_production_mcp`
    in `mcpServerStatus/list`.
