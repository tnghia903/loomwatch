# LoomWatch — Architecture

Revision 0.3 · 2026-09-06 · implementation

This is the specification the build team works from. It supersedes two earlier designs: a
companion app for Paperclip, and a version built on Anthropic Managed Agents. Both were
dropped — see [Rejected designs](#rejected-designs) for why, so they don't get relitigated.

---

## 1. Agent model — one tier, ACP everywhere

Every agent LoomWatch runs is a **local child process speaking ACP (Agent Client Protocol)
over stdio**. There is no second kind of agent and no vendor SDK anywhere in the system.

| Agent | Spawned as | Reaches |
|---|---|---|
| Claude | `claude-agent-acp` | Claude models |
| Codex | `codex-acp` | OpenAI models |
| Gemini | Gemini CLI ACP mode | Gemini models |
| **opencode** | `opencode acp` | **Everything else** — DeepSeek, Kimi, GLM, Qwen, Mistral… |

`opencode` is the universal adapter: any model without a first-party harness is reached by
pointing opencode at it. An agent's configuration is a spawn descriptor — command, args,
env, cwd — plus the model to route through. "Reviewer = opencode + glm-5.3" is a config
row, not code.

**Consequence: LoomWatch never stores, proxies, or sees an API key.** Each harness owns its
own credentials. Do not add key handling to the backend.

---

## 2. Backend — Rust

The backend is a single static binary shipped inside the `.app`. Its job:

- **ACP client + process supervisor** — spawn, monitor, restart, and multiplex stdio for N
  agent processes
- **Team Bus** — an MCP server the agents call back into (see §3)
- **Pipeline orchestrator** — topological execution for drawn DAGs (see §4)
- **Event archive** — Postgres, the durable and unbounded history
- **WebSocket server** — live push to the macOS app, plus minimal REST for bootstrap

**Why Rust rather than TypeScript:** going vendor-neutral means no vendor SDK is usable
anyway — ACP is JSON-RPC over stdio and there is no second protocol — so the JS ecosystem
advantage disappears. What remains is process supervision, stdio multiplexing, Postgres and
WebSocket, which is systems work, plus a native application binary with no language runtime
for the user to install. Postgres remains a required local service.

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
| `handoff(agent, task)` | Full ownership transfer | A ⇒ B · handoff |
| `report(status)` | Progress signal | none — node state |
| `escalate(reason)` | Needs a human | A → user · fires a notification |

The MCP server grants the *ability* to delegate. A separately injected skill teaches the
*judgment* of when to — as a skill file where the harness supports one, as system-prompt
text where it doesn't.

### Guards — enforced in the bus, never in prompts

A delegation loop burning several vendors' API keys overnight is the failure mode that
actually costs money. All three are enforced server-side so no agent can prompt past them:

- **Depth cap** — `dispatch` carries a depth counter, refused past N
- **Cycle detection** — A → B → A is rejected
- **Budget caps** — per-agent and per-team spend ceilings

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
  working directory and budget are set on the node.
- **Two edge layers render together:** configured edges (solid, drawn by the user, real
  constraints) and observed edges (animated, derived from Team Bus events).
- **The canvas is a visual editor over version-controlled YAML on disk.** Team design must
  stay diffable and reviewable. The canvas is not the source of truth; the files are.

### Data model

```
Agent    { id, name, role, spawn{cmd,args,env,cwd}, model, budget, status }
Edge     { from, to, layer: configured|observed, kind: sequence|dispatch|ask|handoff, ts }
RunEvent { id, sessionId, agentId, seq, ts, kind: message|thought|tool_call|tool_update|
                                                   plan|permission|session_meta|usage|
                                                   turn_end|process }
```

---

## 6. macOS app

Swift 6.3 / SwiftUI. Graph rendered with `Canvas` — verified to build against the Xcode
Command Line Tools SDK, so full Xcode is not required. Packaged with Swift Package Manager.
`MenuBarExtra` for live status; `UserNotifications` for local alerts (no remote push in v1).

Writes to *configuration* are in scope for v1. Writes to *running execution* — approving,
pausing, or commenting on an agent mid-run — are deferred.

---

## 7. Build phases

| # | Phase | Produces |
|---|---|---|
| 01 | Plan & scaffold | Repo, containerized Rust toolchain, YAML schema for team config |
| 02 | ACP spine | Backend spawns a real harness, speaks ACP, archives a full session to Postgres |
| 03 | Team Bus + modes | MCP delegation server, pipeline orchestrator, guards, two agents delegating |
| 04 | Canvas | SwiftUI app: agent panel, drag-to-instantiate, edge drawing, YAML round-trip |
| 05 | Watch & alert | Observed-edge layer, timeline scrubber, attention queue, menu bar, notifications |
| 06 | Live & polish | Run a real multi-vendor team against real work |

Contracts frozen between phases: the internal event schema after 02, the WebSocket message
schema after 03.

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
