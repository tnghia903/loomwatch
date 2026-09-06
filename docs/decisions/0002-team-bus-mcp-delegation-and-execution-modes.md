# 0002 — Team Bus: MCP delegation, loopback HTTP transport, bus-enforced guards, two execution modes

- **Date:** 2026-09-06
- **Status:** Accepted
- **Decided by:** ARCHITECTURE.md rev 0.3 §3–§4 (operator-approved); transport per TNG-38 research; implemented in TNG-39/40/41, with TNG-42 review findings landed as TNG-45/46
- **Reverses:** none — settles choices §3–§4 left open, and narrows budget guards from "run-halting caps" to admission-time refusal (TNG-45)

## Context

ARCHITECTURE.md §3 makes delegation a structured tool call on a Team Bus MCP server and
§4 defines the two execution modes, but the MCP transport, guard mechanics, and the exact
mode boundary were open until Phase 03. TNG-38 researched MCP-server injection across the
harnesses; TNG-39/40/41 implemented the bus, guards, and pipeline orchestrator; TNG-42
reviewed all three and routed its wire findings into TNG-45/46. Recorded now because the
WebSocket message schema freezes at the end of Phase 03 (§7) on top of these choices.

## Decision

1. **MCP is the delegation mechanism.** `roster`, `dispatch`, `ask`, `handoff`,
   `report`, `escalate` are structured tool calls on a Team Bus MCP server hosted inside
   `loomwatchd` — the one injection point every harness supports. Delegation is never
   inferred from prose; the observed graph is a byproduct of execution.
2. **Transport: one shared, authenticated, loopback HTTP MCP endpoint**
   (`http://127.0.0.1:<ephemeral>/mcp`, protocol `2025-03-26`), injected into each
   agent's `session/new` `mcpServers` when the harness advertises
   `agentCapabilities.mcpCapabilities.http`, authenticated by a per-agent bearer token
   minted by `loomwatchd`. Chosen over one stdio MCP child per agent (TNG-38): guard
   state must be shared across the whole delegation graph; stdio MCP servers are
   children of the harness, not `loomwatchd` — a supervision blind spot; and every
   harness checked supports HTTP. Delegation lineage, depth, and fan-out permits live
   in server-owned token state, unforgeable by callers.
3. **Guards are enforced in the bus, never in prompts.** Four server-side checks run
   before any process spawns: depth cap (`guards.maxDispatchDepth`, default 8), fan-out
   cap (`guards.maxConcurrentDispatches`, default 8, background `dispatch`/`handoff`
   only — `ask` never consumes a permit), cycle detection over delegation lineage, and
   budget admission against per-agent and team thresholds (`budget.limitUsd` /
   `warnAtPercent`). TNG-45 narrowed budgets to **admission-time refusal**: the
   entrypoint and in-flight turns are never interrupted, so observed spend may exceed a
   threshold. Refusals archive as failed `tool_update` events; thresholds emit one-shot
   `usage` budget warnings (now discriminated by `$defs.UsagePayload`).
4. **The team file's `edges` select the mode.** Empty `edges`: team mode — the
   entrypoint self-organizes with all six tools. Non-empty `edges`: pipeline mode — the
   backend drives nodes in topological order, `dispatch`/`handoff` are withdrawn, and
   `ask` is gated on the node's `allowRecruiting`. Per TNG-46, pipeline dataflow
   follows the configured edges, not the linearized run order: single-predecessor
   nodes get that predecessor's reply verbatim; joins get every predecessor's reply,
   labeled and concatenated in edge-declaration order.
5. **No new event kinds.** Bus interactions archive through the frozen Phase-02
   `RunEvent`/`EventKind` model (`tool_call`, `tool_update`, `usage`, `process`) rather
   than a parallel wire schema — confirmed untouched by the TNG-42 review.

## Consequences

- The frozen WebSocket message schema is
  [WEBSOCKET_SCHEMA.md](../WEBSOCKET_SCHEMA.md) — a paper contract until Phase 04/05
  add the transport; the messages wrap `RunEvent` unchanged.
- Harnesses without HTTP MCP get `session_meta: team_bus_unavailable` and no bus
  access; none of the harnesses verified in TNG-38 lack it.
- A harness may echo bus tool calls under harness-specific names (`mcp__server__tool`);
  ACP carries no "this is MCP" flag (TNG-38 §3), so consumers must treat the
  bus-authored pair as authoritative.
- `handoff` marks the caller stopped but cannot cancel the caller's active ACP turn;
  the successor starts immediately and the caller is expected to return.
- Delegated agents share one dense archive session with the run, so `sessionId`
  identifies a run, not an agent.
