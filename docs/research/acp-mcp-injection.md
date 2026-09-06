# ACP MCP-server injection across harnesses

Research for TNG-38 (phase 03 parent: TNG-37). Answers how `loomwatchd` should populate the
`mcpServers` argument it currently sends empty in `session/new` (`negotiate_session`,
`crates/loomwatch-backend/src/acp.rs:241`), so the Team Bus MCP server (ARCHITECTURE.md §3)
actually reaches each spawned harness.

**Protocol version pinned by this doc:** LoomWatch's `initialize` call sends
`"protocolVersion": 1` (`acp.rs:227`) — the **stable v1 schema**
(`agentclientprotocol.com/protocol/v1/...`, package export
`@agentclientprotocol/sdk/dist/schema/*`), not the `v2/draft` schema
(`@agentclientprotocol/sdk/dist/v2/schema/*`). The two schemas shape MCP capability
negotiation differently (§5). Every citation below is the v1/stable shape unless marked
`[v2 draft]`.

---

## 1. The `mcpServers` schema on `session/new`

Source: [agentclientprotocol.com/protocol/v1/session-setup#mcp-servers](https://agentclientprotocol.com/protocol/v1/session-setup#mcp-servers),
cross-checked against the installed SDK types at
`~/.paperclip/cli/installs/npm/2026.824.1/node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts:4642-4832`.

`NewSessionRequest.mcpServers` is a **required** (non-optional) `Array<McpServer>` — LoomWatch
already satisfies this by always sending `[]` rather than omitting the field. `McpServer` is a
tagged union on an optional `type` string, with **stdio as the untagged default variant**:

```ts
type McpServer =
  | (McpServerHttp & { type: "http" })
  | (McpServerSse  & { type: "sse"  })
  | (McpServerAcp  & { type: "acp"  })   // UNSTABLE, experimental
  | McpServerStdio;                       // no "type" field at all
```

| Transport | Discriminator | Required fields | Notes |
|---|---|---|---|
| **stdio** | *(absent)* | `name`, `command` (absolute path), `args: string[]`, `env: EnvVariable[]` | **Spec text is explicit: "All Agents MUST support connecting to MCP servers via stdio... This is the default transport mechanism."** No capability check needed before using it. |
| **http** | `"http"` | `name`, `url`, `headers: HttpHeader[]` (required array, may be empty) | Gate: `agentCapabilities.mcpCapabilities.http`. |
| **sse** | `"sse"` | `name`, `url`, `headers: HttpHeader[]` | Deprecated by the MCP spec itself; gate: `agentCapabilities.mcpCapabilities.sse`. |
| **acp** | `"acp"` | `name`, `serverId` | `[v2 draft]`/UNSTABLE only — not part of the v1 schema LoomWatch speaks. MCP traffic rides the ACP JSON-RPC channel itself via `mcp/connect`/`mcp/message`/`mcp/disconnect`. Ignore for now. |

`EnvVariable`/`HttpHeader` are both `{ name: string, value: string }[]`.

**`[v2 draft]` divergence to note now, before anyone builds against it:** the draft schema
makes `mcpServers` *optional*, adds a proper `type: "stdio"` tag, and moves capability
advertisement from a flat `agentCapabilities.mcpCapabilities.{http,sse}` map to a nested
`agentCapabilities.session.mcp.{stdio,http}` object map (object presence, not boolean, is
"supported"; `acp` stays experimental there too). If LoomWatch or a harness ever bumps
`protocolVersion` to 2, the capability-check code path in §5 has to change, not just add a
case.

---

## 2. Per-harness support, confirmed hands-on

### `opencode acp` (universal fallback) — **confirmed by live probe**

Installed locally at 1.18.23. Raw JSON-RPC `initialize` response:

```json
{"protocolVersion":1,"agentCapabilities":{"loadSession":true,
  "mcpCapabilities":{"http":true,"sse":true},
  "promptCapabilities":{"embeddedContext":true,"image":true},
  "sessionCapabilities":{"close":{},"fork":{},"list":{},"resume":{}}},
 "authMethods":[...], "agentInfo":{"name":"OpenCode","version":"1.18.23"}}
```

Supports stdio (mandatory, unadvertised) + http + sse. No MCP-specific auth beyond whatever
`headers` you put on an http/sse entry — opencode does not add its own bearer/OAuth layer on
top of client-provided MCP servers. Probe reproduced with:

```
opencode acp   # then JSON-RPC lines: initialize, session/new
```

### `@agentclientprotocol/claude-agent-acp` (the real `claude-agent-acp`, npm `0.75.1`) — **confirmed from source**

This is the actual package LoomWatch's `claude-agent-acp` spawn target names (the older
`@zed-industries/claude-code-acp` is deprecated in favor of it). Source:
`src/acp-agent.ts` (`github.com/agentclientprotocol/claude-agent-acp`).

- `initialize` response: `agentCapabilities.mcpCapabilities: { http: true, sse: true }` —
  same flat v1 shape as opencode. Stdio is implicit/mandatory, not listed.
- `session/new` handling (`acp-agent.ts` NewSessionRequest branch) builds a
  `Record<string, McpServerConfig>` for the Claude Agent SDK:
  - `"type" in server && (type === "http" || type === "sse")` → forwarded as
    `{ type, url, headers: Object.fromEntries(headers) }`.
  - `!("type" in server)` → treated as stdio: `{ type: "stdio", command, args, env }`.
  - The resulting map is merged with any `_meta.claudeCode.options.mcpServers` the caller also
    supplied (a Claude-specific escape hatch LoomWatch does not need).
- No extra auth/header mechanism beyond the HTTP `headers` array — same as opencode.
- **Important:** do not confuse this with Paperclip's own `@paperclipai/adapter-claude-local`.
  That adapter does *not* speak ACP to Claude at all — it drives the Claude Agent SDK
  in-process and injects MCP servers via a hand-written `--mcp-config`-style JSON file
  (`adapter-claude-local/dist/server/claude-config.js`). It is not a reference for the ACP
  transport question; it bypasses ACP entirely. Do not model LoomWatch's injection on it.

### `@agentclientprotocol/codex-acp` (the real `codex-acp`, npm `1.10.0`) — **confirmed from README**

`codex-acp` is a stdio ACP server that wraps Codex's own App Server. Its README states
directly: *"Client-provided MCP servers over command-based stdio config and HTTP transport."*
So it supports stdio + http (SSE not mentioned — likely unsupported or folded into http; verify
against a live `initialize` response once the package is actually installed for phase 03, it
was not present on this research machine). Auth for the MCP servers themselves is just the
HTTP transport's header array, same pattern as the other two.

As with Claude, **Paperclip's own `@paperclipai/adapter-codex-local` is not a reference** —
it drives the native `codex` CLI and injects MCP servers by writing
`[mcp_servers.<name>]` blocks straight into `~/.codex/config.toml` (`codex-home.js:240-270`),
bypassing ACP `session/new` entirely. Different product, different integration point.

### Gemini CLI ACP mode

`gemini --acp` (also `--experimental-acp`, deprecated alias) is confirmed present
(`gemini --help`) and is Gemini CLI's own ACP mode, not a separate wrapper package. Gemini also
ships a native `gemini mcp` config subcommand for its interactive/non-ACP modes — do not let
that native mechanism leak into the ACP integration; when spawned via `--acp`, MCP servers
should go through `session/new.mcpServers` like every other harness. **Not yet verified
hands-on** (the probe script hung against the installed `gemini` binary on this machine,
likely pending an interactive auth/trust prompt) — flag this as an open item for whoever
brings up the Gemini harness in phase 03/04: confirm its `initialize.agentCapabilities.mcpCapabilities`
before assuming http support, and confirm `--acp` doesn't require `--yolo`/`--skip-trust` to
run non-interactively under a supervisor.

### Summary table

| Harness | stdio | http | sse | Extra auth on MCP entries |
|---|---|---|---|---|
| `opencode acp` 1.18.23 | ✅ (mandatory) | ✅ | ✅ | none beyond `headers` |
| `@agentclientprotocol/claude-agent-acp` 0.75.1 | ✅ (mandatory) | ✅ | ✅ | none beyond `headers` |
| `@agentclientprotocol/codex-acp` 1.10.0 | ✅ (mandatory) | ✅ | unconfirmed | none beyond `headers` (per README) |
| Gemini CLI `--acp` | presumed ✅ (spec mandatory) | **unverified** | **unverified** | **unverified** |

**Conclusion for point 2:** every harness LoomWatch actually spawns is expected to accept a
plain **stdio** MCP server with zero capability negotiation required — it's the one transport
the v1 spec makes mandatory for every ACP agent. That is the transport to build against first.

---

## 3. How MCP tool calls surface back to the client

Confirmed against [agentclientprotocol.com/protocol/v1/tool-calls](https://agentclientprotocol.com/protocol/v1/tool-calls)
and LoomWatch's own `record_frame`/`project_tool` (`acp.rs:577-723`).

There is **no separate channel**. The ACP spec has no concept of "this tool call came from an
MCP server" at the wire level — an MCP-backed tool and a harness-native tool (Read, Bash, …)
both surface identically as `session/update` notifications:

- `sessionUpdate: "tool_call"` — creation, with `toolCallId`, `title`, `kind`
  (`read|edit|delete|move|search|execute|think|fetch|other`), `status`.
- `sessionUpdate: "tool_call_update"` — every subsequent status/content change, keyed by the
  same `toolCallId`; all fields except `toolCallId` are optional deltas.

`project_tool` in `acp.rs` already normalizes both into `EventKind::ToolCall` /
`EventKind::ToolUpdate`, capturing `title`, `name`, `kind → toolKind`, `status`, `rawInput`,
`rawOutput`, `content`, `locations`. **This code path needs no changes for Team Bus tool
calls** — `roster`/`dispatch`/`ask`/`handoff`/`report`/`escalate` will arrive as ordinary
`tool_call`/`tool_call_update` frames once the Team Bus is a connected MCP server.

**Gap that *does* matter for the Team Bus guard/edge design (ARCHITECTURE.md §3, §5):** the
ACP tool-call schema carries no first-class "which MCP server, which underlying MCP tool name"
field — only `title` (human string) and `name`/`kind` (harness-supplied, inconsistent). Claude
Code's SDK convention names MCP-backed tools `mcp__<serverName>__<toolName>` in `name`; other
harnesses are not guaranteed to follow that convention (unverified for opencode/codex-acp on
this pass). **The observed-edge drawing logic that turns a Team Bus tool call into a
`dispatch`/`ask`/`handoff` graph edge cannot rely on any ACP-level "this is MCP" flag — it has
to pattern-match `title`/`name`/`rawInput` against the Team Bus's own tool names, per harness,
and that matching rule is not portable across harnesses without per-harness verification.**
Recommend the Team Bus implementation issue budget time to verify the exact `name`/`title`
shape each harness reports for the bus's six tools before wiring edge-drawing to it.

---

## 4. One bus process per agent (stdio) vs. one shared HTTP/SSE endpoint

**Recommendation: one shared HTTP endpoint per `loomwatchd` process, injected into every
spawned agent's `session/new.mcpServers` as an `http` entry pointing at
`http://127.0.0.1:<port>/mcp` (or a Unix socket if the MCP SDK LoomWatch picks supports one)
with a per-session bearer token in `headers`.** Not per-agent stdio.

Reasoning, against §2 of ARCHITECTURE.md (supervise-N-local-children):

- **Guard state must be shared, not partitioned.** Depth cap, cycle detection, and budget caps
  are explicitly "enforced in the bus, never in prompts" (§3) and operate on the whole team's
  delegation graph (A → B → A cycle detection needs visibility across every agent's calls). A
  stdio bus is one subprocess per ACP connection — Team Bus state would have to be hoisted into
  a shared parent structure and each stdio child would just be a dumb forwarder to it, which is
  strictly more process-management complexity than starting one HTTP listener the backend
  already owns.
- **The backend already runs an HTTP/WebSocket server** (§2: "WebSocket server — live push to
  the macOS app, plus minimal REST for bootstrap"). Adding one more route (`/mcp`) to the
  existing Axum/whatever HTTP stack is cheaper than spawning, piping, and lifecycle-managing N
  additional stdio child processes alongside N agent processes — doubling the process count the
  supervisor (§2: "spawn, monitor, restart, and multiplex stdio for N agent processes") has to
  track.
- **stdio MCP servers are child processes of the *agent*, not of `loomwatchd`.** Per the v1
  spec's stdio entry (`command`, `args`, `env`), the *harness* spawns that process, not the ACP
  client. That inverts LoomWatch's ownership model: `loomwatchd` would be handing each harness a
  command to exec on its behalf, with no direct handle on the resulting process for the
  supervisor to monitor/restart/kill alongside the agent — a supervision blind spot the
  architecture's "spawn, monitor, restart" responsibility doesn't cover today. An HTTP endpoint
  keeps 100% of the runtime inside the one process LoomWatch already controls.
- **Every harness confirmed above (§2) supports http.** Stdio is the only *mandatory* transport,
  but http is available everywhere actually tested, so there's no fallback tax for choosing it.
  Recommend picking http (not sse — deprecated at the MCP-spec level and one harness's support
  is still unconfirmed).
- **Auth is trivial and already the pattern other integrations use.** Mint one bearer token per
  session (or per agent) and put it in `headers: [{name: "Authorization", value: "Bearer …"}]`
  on that agent's `McpServerHttp` entry — the same shape Paperclip's own gateway-auth adapters
  use for Codex's config.toml (`headers = { Authorization = "Bearer <token> }"`) and for its
  generic `acpx-engine` runtime (`headers: [{name: "Authorization", value: "Bearer <token>"}]`,
  `execute.js:928-932`). Per-agent tokens let the bus attribute every tool call to a caller
  without trusting `name`/`title` heuristics (§3) for *authorization* — only for edge-drawing
  cosmetics.

**Consequence for `negotiate_session`:** `acp.rs:241`'s `"mcpServers": []` becomes
`"mcpServers": [{"type": "http", "name": "loomwatch-team-bus", "url": "http://127.0.0.1:<port>/mcp", "headers": [{"name": "Authorization", "value": "Bearer <per-agent-token>"}]}]`,
built per spawned agent right before the existing `session/new` call.

---

## 5. `initialize` capability negotiation gating MCP support

Confirmed from spec + all three probed/sourced harnesses (§2). Sequence:

1. Client sends `initialize` with `protocolVersion` and `clientCapabilities`
   (`{ fs: { readTextFile, writeTextFile }, terminal }` in LoomWatch's case — already correct,
   `acp.rs:226-234`).
2. Agent responds with `agentCapabilities.mcpCapabilities: { http?: boolean, sse?: boolean }`
   (v1 flat map) or, on a `protocolVersion: 2` connection, `agentCapabilities.session.mcp: { stdio?: {}, http?: {} }`
   (`[v2 draft]` nested object map — not what LoomWatch speaks today).
3. **stdio needs no negotiation** — every ACP v1 agent MUST support it per spec text, so
   LoomWatch can unconditionally offer a stdio Team Bus entry with zero capability check, if it
   ever needs a per-agent fallback path.
4. Before offering an `http` (or `sse`) entry, the client MUST check
   `initializeResult.agentCapabilities.mcpCapabilities.http` (`=== true`); omitted/`false`
   means unsupported and the client must not send that transport type.

**What LoomWatch must advertise in `clientCapabilities`: nothing MCP-related.** MCP capability
negotiation in ACP v1 is one-directional — the *agent* advertises what transports it accepts;
there is no corresponding "client supports MCP" flag in `ClientCapabilities`
(`types.gen.d.ts:4132-4172`: `fs`, `terminal`, `session`, `plan`, auth — no `mcp` field at all).
LoomWatch's existing `initialize` call needs no changes for this feature; only the post-`initialize`,
pre-`session/new` step needs new logic: read `initializeResult.agentCapabilities.mcpCapabilities.http`,
and choose the `http` Team Bus entry from §4 if true, else fall back to a stdio entry (spawning
a small local stdio↔http bridge, or — simpler — refuse to grant that harness Team Bus access
and record a `session_meta` note; recommend the former only if a harness without http support is
ever actually onboarded, since none of the three probed/sourced above lack it).

---

## Recommendation the Team Bus impl issue can start from

1. Team Bus is **one shared HTTP MCP server inside `loomwatchd`**, not one process per agent.
2. Right before each agent's existing `session/new` call, check
   `agentCapabilities.mcpCapabilities.http` from that agent's own `initialize` response, and
   send `mcpServers: [{type: "http", name: "loomwatch-team-bus", url: "http://127.0.0.1:<port>/mcp", headers: [{name: "Authorization", value: "Bearer <per-agent-token>"}]}]`.
   All three concretely-checked harnesses (opencode, claude-agent-acp, codex-acp) support this.
3. Depth cap, cycle detection, and budget caps (ARCHITECTURE.md §3) live entirely in the bus's
   HTTP handler, keyed by the per-agent bearer token — not derived from any ACP-level identity,
   since ACP tool-call frames carry none.
4. `roster`/`dispatch`/`ask`/`handoff`/`report`/`escalate` need **no new event-archive
   plumbing** — they arrive as standard `tool_call`/`tool_call_update` `session/update` frames
   that `record_frame`/`project_tool` already normalize into `EventKind::ToolCall`/`ToolUpdate`.
5. Open risk to close before wiring observed-edge drawing to those events: per-harness `name`/
   `title` shape for an MCP-backed tool call is not standardized by ACP and must be verified
   per harness (Claude Code's SDK convention is `mcp__<server>__<tool>`; opencode/codex-acp
   unverified on this pass) before the canvas trusts it for anything beyond display.
6. Follow-up for whoever onboards the Gemini harness: this doc could not get a live
   `initialize` response from `gemini --acp` in this environment (probe hung, likely on an
   auth/trust prompt) — confirm its `mcpCapabilities` and non-interactive startup flags before
   assuming parity with the other three.
