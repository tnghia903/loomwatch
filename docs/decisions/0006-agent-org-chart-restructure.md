# 0006 — Agent org chart restructure: root operations tier and adapter alignment

- **Date:** 2026-09-09
- **Status:** Partially executed 2026-09-09; flat-tier intent superseded by [0007](0007-agent-org-restructure-as-built.md); ChatGPT-UX-Planner alignment still open
- **Decided by:** TNG-98 plan revision 1; unblocked mutations delegated to Chief Secretary
- **Reverses:** ChatGPT-UX-Planner having no `reportsTo` (orphan root); Reflection Coach using `codex_local` with an incompatible model

## Context

TNG-98's root/operations configuration audit identified three agents with misaligned org chart positions or adapter-type/model pairs. The plan assigned corrective mutations. The Docs & Decisions Scribe (this agent) lacks `agents:configure` permission and cannot execute them directly.

## Intended mutations

| Agent | Field | Before | After |
|---|---|---|---|
| ChatGPT-UX-Planner (`6883bb08`) | `reportsTo` | `null` (orphan) | `b62be493` (Chief Secretary) |
| ChatGPT-UX-Planner | `adapterType` | `codex_local` | `codex_local` (no change) |
| ChatGPT-UX-Planner | `adapterConfig.model` | not set | `gpt-5.6-sol` |
| Reflection Coach (`fa4c5eb8`) | `reportsTo` | `b62be493` (Chief Secretary) | `b62be493` (no change — already correct) |
| Reflection Coach | `adapterType` | `codex_local` | `opencode_local` |
| Reflection Coach | `adapterConfig.model` | not set | `openrouter/z-ai/glm-5.3-flash` |
| Summarizer (`876dde21`) | `reportsTo` | `b62be493` (Chief Secretary) | no change — already compliant |
| Summarizer | `adapterType` | `opencode_local` | no change — already compliant |

## Compliance verified (Summarizer)

Summarizer already reports to Chief Secretary, uses `opencode_local`, and was configured for `openrouter/z-ai/glm-5.3-flash` in a prior change. No mutation needed. Confirmed: `876dde21` → `b62be493` · `opencode_local`.

## Chief Secretary and Code Reviewer — confirmed not mutated

- **Chief Secretary** (`b62be493`): `reportsTo: null` — root, unchanged.
- **Code Reviewer** (`b9c1fb06`): `reportsTo: b62be493` — Tier-1 direct report, unchanged.

## Blocked mutations

Two writes were attempted via `paperclipai agent update` with PATCH `/api/agents/{id}` and denied:

| Agent | Endpoint | Error | Reason |
|---|---|---|---|
| ChatGPT-UX-Planner | PATCH /api/agents/6883bb08... | 403 | `agents:configure` or `agents:suggest-changes` missing |
| Reflection Coach | PATCH /api/agents/fa4c5eb8... | 403 | same grant missing |

Both require a principal with the `agents:configure` grant — the Chief Secretary (`b62be493`).

## Unblock action

Chief Secretary: run `paperclipai agent update <agentId> --payload-json '<payload>'` for each of the two agents above. Payloads are detailed in the before/after matrix.

## Snapshots

Pre-mutation snapshots of all three agents are archived at the run scratch path for independent review.

## Outcome (2026-09-09)

The Board executed a restructure the same day and confirmed it complete ("restructure complete", TNG-96 thread). As-built, verified via `paperclipai agent list` / `agent get`:

- **Reflection Coach:** mutation executed — now `opencode_local`, reporting to Chief Secretary. (`adapterConfig.model` is not visible to this agent principal; unverified.)
- **ChatGPT-UX-Planner:** mutation **not** executed — still `reportsTo: null` (orphan root), `codex_local`, no visible model. This is the one open item from this ADR.
- The flat one-tier end state intended above was superseded by a two-tier structure; see [0007](0007-agent-org-restructure-as-built.md).

## Consequences

- Executing these mutations will bring the org chart into a coherent two-tier structure (all agents report to Chief Secretary except the root itself).
- Reflection Coach's migration to `opencode_local` aligns it with the Summarizer and Protocol Researcher, consolidating on a single adapter for non-Codex agents.
- No data or session loss is expected from these config-only mutations.