# LoomWatch — Architecture

How LoomWatch is put together, for people reading or changing the code.

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

The backend is `loomwatchd`, a single binary the user runs locally. Its job:

- **ACP client + process supervisor** — spawn, monitor, restart, and multiplex stdio for N
  agent processes
- **Team Bus** — an MCP server the agents call back into (see §3)
- **Pipeline orchestrator** — topological execution for drawn DAGs (see §4)
- **Event archive** — PostgreSQL, the durable and unbounded history
- **UI host** — serves the single-page web UI (static assets), a WebSocket for live events,
  and a REST surface (see §5)

**Why Rust:** going vendor-neutral means no vendor SDK is usable anyway — ACP is JSON-RPC over
stdio — so a JavaScript ecosystem advantage disappears. What remains is process supervision,
stdio multiplexing, PostgreSQL and WebSocket work, in one binary with no language runtime for the
user to install.

Run history lives in PostgreSQL, through `sqlx`: its Tokio-native pool and versioned migrations
fit the async backend. Every event is a `RunEvent` row, ordered by `UNIQUE(session_id, seq)`, which
is what makes a run replayable. The launcher runs PostgreSQL in Docker; `loomwatchd` itself runs
as a native process, so it can start the AI apps already installed for the user.

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

A delegation loop running all night is the failure mode that actually costs money. These guards
are enforced server-side so no agent can prompt past them:

- **Depth cap** — `dispatch` carries a depth counter, refused past N
- **Fan-out cap** — only N background `dispatch`/`handoff` tasks may be outstanding
- **Cycle detection** — A → B → A is rejected

There are no dollar budgets: each agent's usage counts toward its own app's account.

`handoff` marks the caller stopped in Team Bus status, but ACP provides no cancellation hook
for the active caller turn. The caller is expected to return after the successful tool call;
the successor starts without waiting for that return.

---

## 4. Two execution modes

Which mode applies is decided by whether the user drew edges between nodes.

| | **Pipeline group** (edges drawn) | **Team group** (no edges) |
|---|---|---|
| Orchestrator | The backend | The entrypoint agent |
| Execution | Topological order, deterministic | Decided at runtime |
| Team Bus | Restricted — sequencing isn't the agent's call | Fully exposed |
| Observed edges | *Verify* the design; deviation is an anomaly | *Discover* what emerged |

Drawn edges fix the macro sequence, but an agent may still recruit helpers within its own step,
with a per-node lock available to forbid it.

---

## 5. Canvas, configuration and the web UI

- The agent panel lists **detected harnesses** (discovered on `PATH`), **configured
  endpoints**, and **saved role presets**.
- Dragging one onto the canvas instantiates a configured agent node; name, role, model,
  and working directory are set on the node.
- **Two edge layers render together:** configured edges (solid, drawn by the user, real
  constraints) and observed edges (animated, derived from Team Bus events).
- **The canvas is a visual editor over YAML on disk.** Team design stays diffable and
  reviewable. The canvas is not the source of truth; the files are. See
  [TEAM_CONFIG.md](TEAM_CONFIG.md).

`loomwatchd` serves a single-page web UI and a WebSocket for live events: you run the daemon and
open a browser, with no Electron and no native app bundle.

- **Stack:** React + Vite + [React Flow](https://reactflow.dev) for the canvas, served by `axum`;
  `rust-embed` bakes the built `dist/` into `loomwatchd`, so the binary is self-contained.
- **Look and feel:** eye-catching and minimal. Few primary surfaces, one obvious action per
  screen, progressive disclosure of everything else. A run is drawn as Prompt → Run → agents →
  evidence → Output, projected from archived events, never from prose.
- **Installable:** the UI ships a PWA manifest, so "install as an app" gives a dock or launcher
  icon and a standalone window.
- **On this computer only:** the daemon listens on `127.0.0.1` and refuses requests from other
  sites; see [SECURITY.md](../SECURITY.md).

### Data model

```
Agent    { id, name, role, spawn{cmd,args,env,cwd}, model, status }
Edge     { from, to, layer: configured|observed, kind: sequence|dispatch|ask|handoff, ts }
RunEvent { id, sessionId, agentId, seq, ts, kind: message|thought|tool_call|tool_update|
                                                   plan|permission|session_meta|usage|
                                                   turn_end|process }
```
