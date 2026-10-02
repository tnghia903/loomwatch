# 0035 — A folder or file the operator chooses is knowledge

- **Date:** 2026-10-02
- **Status:** Accepted. Daemon: `crates/loomwatch-backend/src/chosen_knowledge.rs` (new),
  `config.rs` (`CapabilityRef::path`), `capabilities.rs` (`KnowledgeSnapshot::{files, text_copy}`),
  `delivery.rs` (`resolve_knowledge`, file grants), `workspace.rs` (`knowledge/` in the working
  folder), `memory.rs` (the file sentence in a knowledge section), `api.rs` (`GET /api/folders`,
  `PUT /api/team/files`); `schemas/team.schema.yaml`. UI: `ui/src/components/canvas/{AgentContext,
  FolderPicker}.tsx`, `ui/src/lib/knowledge/{client,chosen}.ts`, `ui/src/lib/team-file/types.ts`,
  `ui/src/components/Workspace.tsx`, `ui/src/styles/app.css`.
- **Amends:** [ADR 0029](0029-deliver-knowledge-and-tools.md). That ADR said a knowledge source is
  a Library entry; it can now also be a path. `schemas/team.schema.yaml` `$defs/Capability` gains
  `path` (knowledge only). `docs/WEBSOCKET_SCHEMA.md` gains `knowledge[].files` (additive).

## Context

An operator asked whether they could share a PDF or a folder with a team. They could not. The
Library lists the knowledge it discovers: the project folder, folders `OpenCode` has run in, and
team memory. Nothing let an operator point at their own folder. Nothing read a PDF: Brief files
must be UTF-8 Markdown, and the Library snapshot reads a README and a listing.

Three facts shaped the design.

- **The browser cannot name a folder.** `<input type=file>` gives a page a file's bytes, never its
  path, and a directory picker uploads every file inside, which is wrong for a code folder. The
  daemon runs on the operator's own computer (the launcher runs it natively; only Postgres is in
  Docker), so it can list folders for the page.
- **A file and a folder want different lifetimes.** A folder is usually a living thing — reports
  that keep arriving, a project — so it should be read where it is, every run. A document is
  usually a fixed input, and keeping a copy with the team makes the team self-contained and
  portable.
- **Context engineering wants a small prompt and nothing hidden.** Pasting a 40-page PDF into
  every prompt spends the budget on text the task may not need, and fails ADR 0029's 64 KiB cap.
  Silently cutting it hides content. The usual pattern is a preview in the prompt and the rest
  where the agent can read it when it needs to.

## Decisions

1. **A knowledge capability may carry a `path`.** It is then read from that path, and `name` is
   only its label. Only `knowledge` may have one. The schema says so with `if`/`then`, and
   `TeamConfig::parse` refuses it on any other kind. A relative path resolves against the team
   file's folder, and `~/` resolves against home.

2. **Add folder links a folder in place.** A folder picker served by the daemon (`GET /api/folders`)
   walks the computer's folders. It shows names only, leaves hidden entries out, and starts from
   Home, Desktop, Documents and Downloads. The agent gets the same snapshot a Library folder gets —
   listing and README — and the same read grant (ADR 0029 decision 3).

3. **Add file copies a file beside the team.** The operating system's own file picker reads the
   bytes, and `PUT /api/team/files` writes them under `<team>.files/` next to the team file:
   - the name is reduced to its last component, without control characters or a leading dot;
   - an identical file is reused;
   - a different file with the same name gets a numbered name rather than replacing one an agent
     may already use;
   - the limit is 25 MB — bigger documents belong in a linked folder.

4. **An added file is supplied as text.**
   - **A PDF** is converted with `pdftotext` when it is installed. The lookup tries the daemon's
     `PATH` and also Homebrew's directories, because a daemon started outside a login shell does
     not see them. When `pdftotext` is missing, the agent is told where the PDF is, and the panel
     says how to fix it (`brew install poppler`). No PDF library was added to the daemon: poppler
     extracts far better than the pure-Rust options, and its absence costs a clear sentence, not a
     failed run.
   - **A UTF-8 file** is supplied as it is.
   - **Anything else** is described by type and size, with its location.

5. **Preview, then read on demand.** A file's text goes into the prompt whole up to 12,000
   characters, about 3,000 tokens. Past that, the prompt carries the opening, cut at a line break,
   and then says how many characters remain and that the full text is in `knowledge/<file>` in the
   agent's working folder. The daemon writes that copy, so every app can read it without a grant or
   a PDF reader. The `knowledge/` folder is rebuilt on every run, like the skill trees, so a
   disconnected file's text does not linger. Five large documents stay inside the 64 KiB knowledge
   budget.

6. **An added file is granted on its own.** On Claude Code, the grant is `Read(//<file>)` for that
   file. It is never `<team>.files/**`, because that folder holds every file added to the team and
   this agent was given one. The record lists it in `knowledge[].files`, and `readAccess` covers
   files as well as folders.

7. **The panel says what each item is.** In CONTEXT, a linked folder reads "Linked folder · its
   files may be opened", and an added file reads "Added file · its text is supplied". Adding
   several files at once is one team-file change, so they cannot overwrite each other. A failure
   names the file. A team that has never been saved cannot take a file yet, because there is no
   folder to copy it into, and the panel says so.

## Consequences

- An added file is written to disk when it is added, before the team is saved. If the operator
  discards the change, the copy stays in `<team>.files/`, unused.
- Both routes are behind the daemon's host check, like every other route.
  - `PUT /api/team/files` accepts only `application/octet-stream`, so another site cannot send it
    without a CORS preflight the daemon never answers.
  - `GET /api/folders` returns names, never contents.
- A PDF inside a *linked folder* is listed, not extracted. The agent can open it if its app reads
  PDFs. Extracting every document in a folder is a different, heavier feature.
- Not covered: remote knowledge (a URL, a Notion page) is still unmodelled (ADR 0029). Container
  deployments (ADR 0018) see only the folders mounted into them, so the picker lists what the
  container can read.
