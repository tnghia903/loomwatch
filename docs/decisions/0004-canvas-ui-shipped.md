# 0004 — Canvas UI shipped: SPA serving, config API, YAML round-trip, Library, node/edge canvas

- **Date:** 2026-09-07
- **Status:** Shipped
- **Decided by:** Implementation of ADR 0003 by the build team; reviewed by operator in TNG-58
- **Implements:** ADR 0003's Phase 04 scope — "the web UI `loomwatchd` serves"

## Context

ADR 0003 (2026-09-06) reversed the client from SwiftUI/Tauri to a web UI served by the
daemon, and scoped Phase 04 to the agent Library, drag-to-instantiate, edge drawing, node
inspector, and YAML round-trip. Over five commits the build team delivered that scope.

## What shipped (2026-09-07)

| Commit | TNG | Deliverable |
|---|---|---|
| `a2cc0a9` | 51 | `rust-embed` SPA serving via `axum` — baked `ui/dist/` into the binary; SPA fallback for client-side routes |
| `cd69911` | 52 | Daemon config API: `GET /api/harnesses`, `GET /api/team?path=`, `PUT /api/team` (body `{path,yaml}`), `GET /api/config/schema` |
| `1bd6b1c` | 53 | CST-preserving `TeamFileModel` — YAML load/edit/save with comment and key-order preservation |
| `67dc34c` | 54 | Library panel over `GET /api/harnesses`; drag-to-instantiate with defaults-on-drop rules |
| `7c9e54d` | 55 | Agent node rendering, configured edges with draw/reconnect/delete, inspector with live validation, `PUT /api/team` save gate, canvas mechanics |

## Deviations from the spec

None material. Three items surfaced as deferred (recorded in `CANVAS_SPEC.md §15`):

1. **Node layout persistence** (§7.3) — sidecar `.layout.json` recommended but not implemented;
   the canvas falls back to deterministic `dagre` auto-layout on every load.
2. **Teams directory endpoint** (§15.4) — `GET /api/teams` shipped in TNG-74 (2026-09-08),
   providing the listing half. New-file creation is **create-on-save**: the existing
   `PUT /api/team` creates a missing path with an existing parent beneath the teams root, so
   no separate `POST`/create route is needed. **Change notification** remains deferred; see
   updated §15.4.
3. **Harnesses endpoint completeness** (§15.3) — not-installed-list is a client-side constant;
   advertised models are absent; endpoints and presets have no backend.

`?path=` is explicitly a placeholder pending §15.4. The UI documents this in
`useTeamDocument.ts` (TNG-53).

## Consequences

- Phase 04 ship completes ADR 0003's scope. Phase 05 (Watch & alert) is the next build phase.
- The frozen WebSocket schema (`WEBSOCKET_SCHEMA.md`) remains untouched; the observed edge
  layer builds against fixture data until Phase 05 connects the socket.
- The `ui/` directory is now a production artifact with its own build, test, and lint chain.
- The daemon is the only distribution artifact; the UI bundles into it at compile time.