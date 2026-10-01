# LoomWatch — Architecture

Revision 0.5 · 2026-09-07 · implementation

This is the specification the build team works from. It supersedes three earlier designs: a
companion app for Paperclip, a version built on Anthropic Managed Agents, and a native
desktop app (SwiftUI, later Tauri). All were dropped — see [Rejected designs](#rejected-designs)
for why, so they don't get relitigated.

---

## 1. Agent model — one tier, ACP everywhere

Every agent LoomWatch runs is a **local child process speaking ACP (Agent Client Protocol)
over stdio**. There is no second kind of agent and no vendor SDK anywhere in the system.

| Agent | Spawned as | Reaches | ACP verified |
|---|---|---|---|
| Claude | `claude-agent-acp` (or `npx -y @agentclientprotocol/claude-agent-acp`) | Claude models | yes |
| Codex | `codex-acp` (or `npx -y @agentclientprotocol/codex-acp`) | OpenAI models | yes |
| Gemini | `gemini --acp` | Gemini models | yes |
| **opencode** | `opencode acp` | **Everything else** — DeepSeek, Kimi, GLM, Qwen, Mistral… | yes |
| Hermes | `hermes-acp` | Hermes' configured provider | yes — 0.21.1, `loadSession: true` |
| OpenClaw | `openclaw acp` | its gateway's configured models | yes — 2026.8.1, `loadSession: true`, **no HTTP MCP** |
| pi | — | — | **no**: `pi --mode rpc` is pi's own protocol, not ACP |

`opencode` is the universal adapter: any model without a first-party harness is reached by
pointing opencode at it. An agent's configuration is a spawn descriptor — command, args,
env, cwd — plus the model to route through. "Reviewer = opencode + glm-5.3" is a config
row, not code.

Each row's ACP invocation is verified against the installed binary with a raw `initialize`
frame before it is added to `HARNESSES` in `api.rs`. A `--help` listing an `acp` subcommand is not
sufficient evidence: several of these CLIs ship a private JSON-RPC mode that is not ACP, which is
why `pi` is detected and reported unrunnable rather than being given a spawn descriptor that
would produce an agent LoomWatch cannot drive. OpenClaw's bridge advertises
`mcpCapabilities.http: false`, so the Team Bus cannot be injected into an OpenClaw session and
`acp.rs` archives `team_bus_unavailable` for it — delegation tools do not reach an OpenClaw
agent.

**Consequence: LoomWatch never stores, proxies, or sees an API key.** Each harness owns its
own credentials. Do not add key handling to the backend.

---

## 2. Backend — Rust

The backend is `loomwatchd`, a single static binary the user runs locally. Its job:

- **ACP client + process supervisor** — spawn, monitor, restart, and multiplex stdio for N
  agent processes
- **Team Bus** — an MCP server the agents call back into (see §3)
- **Pipeline orchestrator** — topological execution for drawn DAGs (see §4)
- **Event archive** — Postgres, the durable and unbounded history
- **UI host** — serves the single-page web UI (static assets), a WebSocket for live events,
  and a minimal REST surface for bootstrap (see §6)
- **Computer use** — screen capture, input synthesis and accessibility, per-OS behind a
  trait; the daemon already holds the OS privilege to do this (deferred to a later phase)

**Why Rust rather than TypeScript:** going vendor-neutral means no vendor SDK is usable
anyway — ACP is JSON-RPC over stdio and there is no second protocol — so the JS ecosystem
advantage disappears. What remains is process supervision, stdio multiplexing, Postgres,
WebSocket and per-OS computer-use APIs, which is systems work, in one small static binary
with no language runtime for the user to install. Postgres remains a required local service.

**Decision reversal (2026-09-06):** the operator explicitly replaced SQLite WAL with
Postgres as the production event archive, and replaced host-installed rustup with a Docker
Compose development toolchain. `sqlx` is used because its Tokio-native Postgres pool and
versioned migration runner fit the existing async backend without a second runtime. The
frozen `RunEvent` wire contract and `UNIQUE(session_id, seq)` replay invariant are unchanged.
Docker is used for builds and the local Postgres service only; `loomwatchd` still runs as a
native local process.

---

## 3. Team Bus — delegation as protocol

If an agent delegates by writing *"I'll have the reviewer look at this"*, no edge can be
drawn from it. So **delegation is a structured tool call**, exposed through an MCP server
the backend hosts. MCP is the one injection point every harness supports.

| Tool | Meaning | Edge drawn |
|---|---|---|
| `roster()` | Who's on the team, capabilities, live status | none — discovery |
| `dispatch(agent, task)` | Fire-and-forget assignment | A → B · delegation |
| `ask(agent, question)` | Blocking ask / reply | A ⇄ B · query |
| `handoff(agent, task)` | Start a successor and request caller exit | A ⇒ B · handoff |
| `report(status)` | Progress signal | none — node state |
| `escalate(reason)` | Needs a human | A → user · fires a notification |

The MCP server grants the *ability* to delegate. A separately injected skill teaches the
*judgment* of when to — as a skill file where the harness supports one, as system-prompt
text where it doesn't.

### Guards — enforced in the bus, never in prompts

A delegation loop burning several vendors' allowances overnight is the failure mode that
actually costs money. All three are enforced server-side so no agent can prompt past them:

- **Depth cap** — `dispatch` carries a depth counter, refused past N
- **Fan-out cap** — only N background `dispatch`/`handoff` tasks may be outstanding
- **Cycle detection** — A → B → A is rejected

Dollar budgets were a fourth guard until [ADR 0027](decisions/0027-retire-cost-budgets.md)
retired them: on a Claude or Codex subscription a dollar figure measures nothing you pay.

`handoff` marks the caller stopped in Team Bus status, but ACP provides no cancellation hook
for the active caller turn. The caller is expected to return after the successful tool call;
the successor starts without waiting for that return.

Phase 03's Team Bus decisions — MCP delegation, shared authenticated loopback HTTP
transport, bus-enforced guards, the mode split — are recorded in
[ADR 0002](decisions/0002-team-bus-mcp-delegation-and-execution-modes.md).

---

## 4. Two execution modes

Which mode applies is decided by whether the user drew edges between nodes.

| | **Pipeline group** (edges drawn) | **Team group** (no edges) |
|---|---|---|
| Orchestrator | The backend | The entrypoint agent |
| Execution | Topological order, deterministic | Decided at runtime |
| Team Bus | Restricted — sequencing isn't the agent's call | Fully exposed |
| Observed edges | *Verify* the design; deviation is an anomaly | *Discover* what emerged |

**Working assumption:** drawn edges fix the macro sequence, but an agent may still recruit
helpers within its own step, with a per-node lock available to forbid it.

---

## 5. Canvas and configuration

- The agent panel lists **detected harnesses** (discovered on `PATH`), **configured
  endpoints**, and **saved role presets**.
- Dragging one onto the canvas instantiates a configured agent node; name, role, model,
  and working directory are set on the node.
- **Two edge layers render together:** configured edges (solid, drawn by the user, real
  constraints) and observed edges (animated, derived from Team Bus events).
- **The canvas is a visual editor over version-controlled YAML on disk.** Team design must
  stay diffable and reviewable. The canvas is not the source of truth; the files are.

### Data model

```
Agent    { id, name, role, spawn{cmd,args,env,cwd}, model, status }
Edge     { from, to, layer: configured|observed, kind: sequence|dispatch|ask|handoff, ts }
RunEvent { id, sessionId, agentId, seq, ts, kind: message|thought|tool_call|tool_update|
                                                   plan|permission|session_meta|usage|
                                                   turn_end|process }
```

---

## 6. Client — a web UI the daemon serves

`loomwatchd` serves a single-page web UI and a WebSocket for live events. You run the daemon
and open a browser. This borrows only the *deployment* shape from Paperclip (a daemon that
serves a web page) — no Electron, no native app bundle, no language runtime for the user to
install.

- **Stack:** React + Vite + [React Flow](https://reactflow.dev) for the canvas. Served by
  `axum`; `rust-embed` bakes the built `dist/` into `loomwatchd` so the binary is still
  self-contained.
- **Look and feel — a first-class goal, not a coat of paint.** Eye-catching and minimal.
  **Explicitly not Paperclip's UI**, which is dense and complex and a poor experience. Few
  primary surfaces, generous whitespace, one obvious action per screen, progressive
  disclosure of everything else. The canvas is the product; the chrome recedes. The design
  is specified in [CANVAS_SPEC.md](CANVAS_SPEC.md) as amended by
  [UX_REDESIGN.md](UX_REDESIGN.md) and the “Obsidian & Gilt” token layer in
  [DESIGN_LANGUAGE.md](DESIGN_LANGUAGE.md) (board-approved 2026-09-10, TNG-87); the
  build holds to it. Its primary surface is the prompt-to-output story of
  [TNG89_INTERACTION.md §12](TNG89_INTERACTION.md): a run is drawn as Prompt → Run →
  agents → evidence → Output, projected from archived events, never from prose.
- **Installable:** the UI ships a PWA manifest, so "install as an app" gives a dock /
  launcher icon and a standalone window with no wrapper.
- **Multi-device:** because it is a page the daemon serves, it opens from any device that
  can reach the daemon's port — LAN, Tailscale, an SSH tunnel.
- **Computer use** stays in the daemon (§2); the browser renders what the daemon captured
  and sends intent back. A browser tab never touches the OS directly.
- **Ambient status** (a menu-bar / tray "N agents running" indicator) is out of scope for
  the web UI; a small native tray helper beside the daemon can add it later. Deferred.

Writes to *configuration* are in scope for v1. Writes to *running execution* — approving,
pausing, or commenting on an agent mid-run — are deferred.

---

## 7. Build phases

| # | Phase | Produces | Status |
|---|---|---|---|
| 01 | Plan & scaffold | Repo, containerized Rust toolchain, YAML schema for team config | Shipped |
| 02 | ACP spine | Backend spawns a real harness, speaks ACP, archives a full session to Postgres | Shipped |
| 03 | Team Bus + modes | MCP delegation server, pipeline orchestrator, guards, two agents delegating | Shipped |
| 04 | Canvas | Web UI served by `loomwatchd`: agent panel, drag-to-instantiate, edge drawing, YAML round-trip | Shipped 2026-09-07 |
| 05 | Watch & alert | Archive viewer with live observed edges, timeline replay, attention queue, notifications | Implemented 2026-09-10; see [WATCH.md](WATCH.md) |
| 06 | Live & polish | Run a real multi-vendor team against real work | Next |

Contracts frozen between phases: the internal event schema after 02, the WebSocket message
schema after 03. The WebSocket message schema is frozen in
[WEBSOCKET_SCHEMA.md](WEBSOCKET_SCHEMA.md) (2026-09-06, including the TNG-42 review
findings).

---

## Rejected designs

**Paperclip companion app.** The original plan read Paperclip's REST activity feed. Rejected
because that feed is too coarse for the product's core purpose — a 500-event hard cap,
truncated comment bodies, no step-by-step trace, no `since`/`cursor` pagination. Owning the
execution layer is the only way to get full-fidelity traces.

**Anthropic Managed Agents.** A later design used CMA for the agent loop, scheduling, task
board and event stream. Rejected on two grounds: it is Claude-only and cannot run Codex or
DeepSeek, which the bring-your-own-agent requirement makes non-negotiable; and it runs
agents in a cloud container while LoomWatch's agents are local processes working in local
directories. Supporting both would mean two adapter paths and two filesystem models for one
vendor's benefit. What it traded away: cloud-side scheduling would have fired with the Mac
asleep or shut. Accepted, since agents need local repo access to be useful.

**SQLite event archive.** Revision 0.2 chose SQLite WAL for a zero-service local archive.
The operator explicitly reversed that choice on 2026-09-06 in favor of Postgres and accepted
the required local service. The already-hardened `RunEvent` contract remains unchanged; only
its storage engine changed. See
[ADR 0001](decisions/0001-postgres-event-archive-and-docker-dev-toolchain.md).

**Native desktop app (SwiftUI, then Tauri).** Revisions 0.1–0.3 specified a native macOS
SwiftUI client for phases 04–05. Reconsidered on 2026-09-06 once the product goal became a
sellable, cross-platform tool: SwiftUI is Apple-only and caps the market; a cross-platform
native shell (Tauri) adds a per-OS packaging/signing/update burden, and Electron carries the
resource cost the operator explicitly rejected. The daemon already speaks WebSocket + REST,
so the UI was always a thin client. Settled on a web UI `loomwatchd` serves — the Paperclip
model — PWA-installable, reachable from any device on the network, with computer use kept in
the daemon. Phases 01–03 are unaffected. See
[ADR 0003](decisions/0003-web-ui-served-by-the-daemon.md).
