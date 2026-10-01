# 0022 — A first-time operator reaches a running team without reading a spec

- **Date:** 2026-10-01
- **Status:** Accepted — implemented in `ui/src/components/home/`, `ui/src/lib/team-file/templates.ts`,
  `ui/src/components/composer/Composer.tsx`, `ui/src/lib/team-file/validation.ts`,
  `ui/vite.config.ts` and `crates/loomwatch-backend/src/api.rs` (`GET /api/teams`)
- **Amends:** `docs/CANVAS_SPEC.md` §4.5 (new agents start with an empty role and model) and
  `TNG89_INTERACTION.md` §1.2 (↵ inserts a newline; only ⌘↵ submits)

## Context

A walkthrough of the product as a new user, on 2026-10-01, found that every step of the first run
asked for knowledge only the specs contain:

| Step | What the operator met |
| --- | --- |
| Start | A logo, "New team", and "or open an existing team" — which asked for a YAML path "relative to the daemon teams directory". Existing teams were not listed. |
| New team | Immediately "3 problems", two of them raw ajv output: `/entrypoint must match pattern "^[A-Za-z0-9][A-Za-z0-9._-]*$"`. |
| First agent | "Role: Required" and "Model: Required" although the harness had already reported its default model; a toast "Capability wiring: failed to resolve team file …: No such file or directory (os error 2)". |
| Run | ↵ did nothing; only ⌘↵ submitted. |
| Review stop | "Continue" stayed disabled until something was typed, so "looks good" was the hardest answer to give. "Send back to researcher" used the agent id. |
| Output | "Assigned to Agent C · responder" — anonymous letters and daemon vocabulary for "Writer". |
| Everywhere | "Harness", "entrypoint", "canonical response", "packet", "Harness not recorded" on the operator's own review step; 7–9 px labels. |

Separately, the UI shipped as one 1.14 MB script (346 kB gzip): the Markdown stack (only needed
once a run has an answer) and ajv (only needed after the schema arrives, which is already
asynchronous) were a quarter of it.

## Decisions

1. **Home lists teams by name.** `GET /api/teams` gains `teams: TeamSummary[]` (path, `name`,
   agent count, modified time) alongside the unchanged `files`, so older clients keep working and a
   newer client falls back to `files` against an older daemon. Discovery skips hidden folders and
   `node_modules` — `.loomwatch` managed workspaces can hold whole repositories — and runs on a
   blocking thread.
2. **New teams start from a template.** *One assistant*, *Researcher and writer* and *Research,
   your approval, then writing* are written to disk as complete, schema-valid files using the
   chosen app's **own current model** (`currentModelId` from model discovery), so the first screen
   after creating a team can run it. *Empty team* keeps the old unsaved-document path. File names
   never collide (`blog-writer-2.yaml`), because a new file is created with `If-None-Match: *`.
3. **A new agent is runnable when placed.** It gets a general instruction, and its model is filled
   from the harness catalog once that loads — the value the harness itself would use.
4. **↵ sends, ⇧↵ adds a line, ⌘↵ still sends.** IME composition (`isComposing`, keyCode 229) never
   sends. A bare ↵ in an empty box never retries a finished run; retry stays a deliberate ⌘↵.
5. **A review stop can be approved without a comment.** The daemon still requires text, so the UI
   sends an explicit "Approved. Continue as planned." Sending work back, and answering an agent's
   question, still require words.
6. **Plain words in the product, ids and spec terms in the file.** Validation messages name the
   place and the rule ("The starting agent can only use letters…"), an empty team shows one
   unfinished item instead of three errors, run credit uses agent names, and app labels say
   "Claude", "You (review step)" or "Custom command: python3".
7. **The bundle is split by when code is needed.** Markdown rendering and ajv are dynamic imports
   (the answer shows as plain text for the moment before its renderer arrives); React, React Flow
   and `yaml` are long-lived vendor chunks. First load is now ~873 kB (≈268 kB gzip).

## Consequences

- The YAML file is still the source of truth and the spec vocabulary is unchanged on disk and in
  the API; only presentation changed. `docs/CANVAS_SPEC.md` §4.5's "role and model stay empty"
  is superseded by decision 3.
- Templates are tested against the real `schemas/team.schema.yaml`
  (`ui/src/lib/team-file/templates.test.ts`), so a schema change that breaks them fails CI.
- Components that render Markdown must use `components/ui/Markdown.tsx`, not `react-markdown`
  directly, or the stack returns to the initial bundle.
