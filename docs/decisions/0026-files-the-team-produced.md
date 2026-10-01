# 0026 — Files the team produced: shown as files, opened in their own app

- **Date:** 2026-10-01
- **Status:** Accepted — daemon `crates/loomwatch-backend/src/files.rs` (`GET /api/files/stat`,
  `POST /api/files/open`); UI `ui/src/lib/files/`, `ui/src/components/ui/FileCard.tsx`,
  `ui/src/components/ui/FileChip.tsx`, wired through `MarkdownRenderer.tsx` and `DeliveryLane.tsx`;
  styles in `ui/src/styles/loom.css`

## Context

When an agent's deliverable is a file — a Word report, a deck, a spreadsheet — its reply names it
as an absolute path in inline code: `**File:** /Users/…/teams/.loomwatch/<team>/<agent>/report.docx`.
The operator then has to select the path, copy it and find the file by hand. A non-technical
operator cannot tell from a path what the file is, whether it is still there, or how to open it.
The browser cannot open local files itself, and it should not be handed `file://` links.

## Decision

**Anywhere a reply names a file, it is shown as a file.** The recogniser (`fileRefs.ts`) is
deliberately narrow so that nothing gets an Open button by mistake. It accepts an absolute path
whose last segment has an extension, written as inline code, as a Markdown link target, or as a
`file://` URL. Folders, API routes, relative paths, dotfiles and fenced code blocks stay text.

Each file appears in two places, each doing a different job:

| Where | Shows | Click |
| --- | --- | --- |
| Output header, "Files in this reply" (`FileCard`) | the deliverable, drawn as a sheet of paper stamped with its type. A status ("Ready to open"), the name read as a title ("Enterprise knowledge systems design report"), the real file name, the kind in words, size, age, and the maker's agent mark ("Made by Writer") when the file sits in that agent's workspace | **Open document** (the noun follows the type) · Show in folder · Copy path |
| In the reply's sentence (`FileChip`) | the file's icon, name and type tag on a gilt tab, in place of the path | opens it (or shows it in its folder) |

The card's left edge is a two-gold basket weave, a selvedge: the finished edge of woven cloth, for
finished work. It turns grey when the file is missing. Gold is used because opening the file is the
operator's next action. In a narrow output panel, the actions take a full-width row led by a wide
Open button. The cards are compact rows when a reply names more than two files. The full path
stays in the tooltip. The paper colour is a semantic token (`--color-paper`, `--color-paper-rule`)
so the sheet reads as paper in both themes.

**The daemon does the opening, inside one boundary.** `stat` and `open` resolve the path with the
same rule the team-file API uses: it must resolve inside the canonical teams root. That root
includes the managed workspaces under `.loomwatch/<team>/<agent>`.

- **Outside the teams root:** the daemon answers 403, and the card says so and offers only the path
  to copy.
- **Open:** limited to document, sheet, slides, PDF, image, media, Markdown, text, web, data and
  archive kinds.
- **Code and executables:** never opened. They can only be shown in their folder (422 otherwise).
- **Missing files:** 404. The card says "Not on this computer any more".
- **POST body:** must be JSON. Cross-site forms cannot send that without a preflight, which the
  daemon never answers. It also goes through the existing allowed-host check.
- **Per platform:** macOS uses `open` / `open -R`; Windows uses `cmd /C start` / `explorer /select,`;
  everything else uses `xdg-open` (on the parent folder to reveal).

## Consequences

- A deliverable is one click away and readable as what it is. The sentence around it still reads as
  a sentence.
- An older daemon without these routes degrades to "kind from the extension + copy path".
- **One lookup per file.** `lookupFile` shares in-flight requests between the chip and the card.
  The Markdown overrides live at module scope. A map rebuilt on every render remounted every
  override on each parent render, and asked about the file about once a second in the live app.
  `FileCard.test.tsx` now fails if that comes back.
- Tested in `lib/files/fileRefs.test.ts`, `lib/files/client.test.ts`, `components/ui/FileCard.test.tsx`,
  `components/run/DeliveryLane.test.tsx` and the `files.rs` / `api.rs` unit tests.
