# 0007 — Agent org restructure as-built: two-tier reporting under Chief Secretary

- **Date:** 2026-09-09
- **Status:** Accepted — executed and confirmed complete by the Board ("restructure complete", TNG-96 thread, 2026-09-09)
- **Decided by:** Board
- **Supersedes:** the flat one-tier end state intended by [0006](0006-agent-org-chart-restructure.md)

## Decision

The org chart moves from a single tier under the Chief Secretary to two tiers. As-built
(verified via `paperclipai agent list` / `agent get`, 2026-09-09):

**Root**

- Chief Secretary (`b62be493`)

**Tier 1 — reports to Chief Secretary**

- Rust Systems Engineer (`2d3b6f7c`)
- Product/UX Designer (`05404f9d`)
- Code Reviewer (`b9c1fb06`)
- Protocol Researcher (`06847408`)
- Summarizer (`876dde21`)
- Reflection Coach (`fa4c5eb8`, `opencode_local` — 0006 mutation executed)

**Tier 2**

- Backend Implementer (`cc0d98cc`) → Rust Systems Engineer
- Data Implementer (`940b6ea3`) → Protocol Researcher
- Hannah (`739167c4`) → Protocol Researcher
- Web UI Engineer (`7f6ba759`) → Product/UX Designer
- Docs & Decisions Scribe (`c3c3bed6`) → Product/UX Designer

## Open item

ChatGPT-UX-Planner (`6883bb08`) still has `reportsTo: null` — the orphan-root fix planned
in 0006 was not executed. Its correct tier under the new structure is undecided. Owner:
Board / Chief Secretary.

**Update 2026-09-10:** Tier decided — directly under Chief Secretary (Tier 1), per
approved TNG-98 plan revision 1. Mutation applied by Chief Secretary 2026-09-10T12:06Z
(`reportsTo` set, `adapterConfig.model` = `gpt-5.6-sol`, `codex_local` kept) and
DB-verified by the Scribe. Summarizer and Reflection Coach verified compliant (Tier 1,
`opencode_local`, `openrouter/z-ai/glm-5.3-flash`). No open items remain from the
restructure.

## Consequences

- Implementer agents are managed by their engineering leads rather than the root.
- Docs & Decisions Scribe escalation path changes from Chief Secretary to Product/UX
  Designer; standing agent instructions naming Chief Secretary as reports-to are stale.
- Records org state only; no product code or product documentation changes.
