# 0036 — Knowledge is chosen, not discovered

- **Date:** 2026-10-02
- **Status:** Accepted. Daemon: `crates/loomwatch-backend/src/capabilities.rs` (the `OpenCode`
  scan, the session-title reader and the project-folder row removed; `knowledge_snapshot`
  removed), `delivery.rs` (`resolve_knowledge` requires a path; `prepare_for` loses `teams_root`),
  `workspace.rs`, `config.rs` (doc comments); `schemas/team.schema.yaml` (descriptions only). UI:
  `ui/src/lib/composer-layout/types.ts` (`teamFileKind`), `ui/src/components/Workspace.tsx`,
  `ui/src/components/canvas/{CapabilityInspector,BuildResourceInspector,AgentContext}.tsx`,
  `ui/src/components/library/Library.tsx`, `ui/src/lib/knowledge/chosen.ts`,
  `ui/src/lib/team-file/types.ts`. Docs: `docs/TEAM_CONFIG.md`, `docs/WEBSOCKET_SCHEMA.md`,
  `README.md`.
- **Amends:** [ADR 0029](0029-deliver-knowledge-and-tools.md) decision 2, which delivered a
  Library knowledge source by name as its snapshot, and [ADR 0035](0035-folders-and-files-as-knowledge.md)
  decision 1, which made `path` optional. A knowledge capability now needs a `path`.

## Context

The Library listed three kinds of knowledge:

- team memory and imported packs;
- the project the teams live in (the teams root's parent), as "`<name>` project";
- `OpenCode`'s history, read from `~/.local/share/opencode/opencode.db` with `sqlite3`: one
  "OpenCode history" row of recent session titles, and one row per folder `OpenCode` had run in.

An operator asked why only `OpenCode` appeared, and whether every app would need its own reader.
Four findings followed.

- **The rows merged two folders.** Rows are de-duplicated by lowercased name. When the launcher
  (`1a02d55`) moved the teams root to `~/LoomWatch/teams`, the project row "LoomWatch project"
  (`~/LoomWatch`) and `OpenCode`'s "loomwatch project" (the source checkout,
  `~/Developer/loomwatch`) became one row. The row kept `OpenCode`'s name and detail. The snapshot
  then compared the folder's label with the row's name case-sensitively and dropped `~/LoomWatch`.
  An agent wired to that row was granted a different folder from the one the row named. Before the
  launcher the two rows were the same folder, so nobody had noticed.
- **What they delivered was thin.** "OpenCode history" handed an agent 60 lines of chat titles. A
  project row handed over a listing, a README and a read grant, which is what **Add folder…** (ADR
  0035) gives for any folder. The app history served only as a list of suggested folders.
- **Nobody had used them.** Across the 18 team and layout files in the current teams root and both
  reset backups of 2026-10-02, the one knowledge connection ever drawn was a sidecar edge that had
  never been delivered. The project row also no longer meant anything: `~/LoomWatch` holds only
  `archive/` and `teams/`.
- **Every other app would need its own reader.** Each app keeps its history in a private format:
  SQLite for `OpenCode`, JSONL for Claude Code and Codex, JSON for Gemini. A reader per app grows
  with every app and breaks when an app changes its storage. A general route exists: ACP
  `session/list` returns each past session's `cwd`, `title` and `updatedAt`. A probe on 2026-10-02
  found Claude Code, Codex, `OpenCode`, Hermes and `OpenClaw` advertising
  `sessionCapabilities.list`, Gemini not, and pi not an ACP app. Using it still means starting every
  app, caching the result, paging past 1,000 sessions and filtering scratch folders, all to produce
  a list of suggestions.

## Decisions

1. **The Library lists team memory as its only knowledge.** The `OpenCode` scan, the `sqlite3`
   call, the session-title reader and the project-folder row are removed. The project's own skill
   folders (`.claude/skills`, `.agents/skills`) are still listed: they are skills, not knowledge.

2. **Knowledge is a path.** A knowledge capability without a `path` fails the run with what to do:
   remove it in the agent's Context, then use **Add folder…** or **Add file…**. A name that is a
   team's memory still gets the existing message pointing at `memory.inherits`. It is a run-time
   refusal, not a parse error, so the team still opens and the operator can fix it in place. Two
   knowledge entries with the same label are refused, as two paths already were.

3. **The canvas never writes knowledge by name.** `teamFileKind` returns `null` for every knowledge
   card, so:
   - drawing an edge to a knowledge card that is not memory is refused, with where knowledge is
     chosen now;
   - **Deliver on the next run** skips such edges;
   - the card's short panel and full inspector say it is not delivered, and the full inspector has
     no agent picker;
   - in CONTEXT, a knowledge entry without a path reads "No folder or file · disconnect it and add
     one below".

4. **Folder suggestions, if they return, use `session/list`.** One code path for every ACP app,
   rows keyed by canonical folder rather than by name, one row per folder naming every app that
   worked there. Not built: nothing yet shows operators want suggestions over the folder picker.

## Consequences

- A team file with a knowledge entry that has no path stops running until the entry is replaced.
  None of the checked team files has one.
- A canvas may still hold a knowledge card placed from the old Library. It renders, is never
  delivered, and its inspector says so; the operator removes it.
- Records of earlier runs keep their provenance strings (`LoomWatch`, `OpenCode`, or both). New
  records carry only `Linked folder` or `Added file`.
- The daemon no longer shells out to `sqlite3`.
- Skills and tools are still de-duplicated by name, on purpose: the same skill installed for two
  apps is one row. Knowledge can no longer collide that way, because the Library merges nothing
  into a knowledge row.
