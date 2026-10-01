# 0031 — Skills from every app, for every agent

- **Date:** 2026-10-01
- **Status:** Accepted.
  - `crates/loomwatch-backend/src/capabilities.rs`: `skill_roots`, `SkillRoot`, `SkillLayout`,
    `find_skill_files`, `without_generation`, `skill_definitions_for`.
  - `skill_routing.rs`: `route`, `translation_note`, `frontmatter_field`.
  - `workspace.rs`: `Harness::delivery_directory`, `materialise`, `copy_skill`.
- **Amends:**
  - ADR 0019, decision 5: Hermes and unknown apps are no longer refused.
  - ADR 0021: the `blocked` route is no longer produced.
- **Keeps:**
  - Skills are found, never authored, in LoomWatch.
  - A skill's source never limits where it runs (ADR 0019, decision 1).
  - Bundles are copied whole and never rewritten (decision 2).

## Context

LoomWatch finds the skills each app installed and lets any agent use them. A mapping of the scanner
on 2026-10-01 found that both halves fell short.

**Detection missed whole apps.**
- **Apps whose skills were never read:** Hermes (`~/.hermes/skills`, filed by category, and one set
  per profile), OpenClaw (`~/.openclaw/{skills,workspace/skills,plugin-skills}`), Gemini
  (`~/.gemini/skills`, extensions), pi (`~/.pi/agent/skills`) and OpenCode's documented singular
  `skill/` folder. That is about 100 skills on the reference machine, all from apps LoomWatch runs.
- **The project's own skills:** a repository's `.claude/skills` and `.agents/skills`, which Claude
  Code and Codex read natively, were not read.

**Detection read too much.**
- **Old and half-downloaded copies:** Claude Code parks every earlier plugin generation in
  `.trash/` and stages downloads in `.staging/`. Both were scanned.
- **The plugin catalog:** `marketplaces/` lists every plugin a marketplace offers, installed or
  not. It was scanned too.
- **Generation suffixes:** synced plugin folders carry a suffix (`engineering~g3`), so one plugin
  showed as several.

**Delivery picked the wrong copy and refused some apps.**
- **A trashed copy could be delivered.** The list of skill folders existed twice, once for the
  Library and once for delivery. Delivery picked a skill's copy by sorting on the source name and
  path, and `/.trash/` sorts before `/synced/`, so a wired `code-review` could resolve to a trashed
  copy.
- **Hermes and unknown apps were refused.** A run that wired any skill to such an agent failed
  before it started, although the inline route could already carry a skill in the prompt.
- **Copies overwrote each other.** A delivered copy took its source folder's name, so two plugins'
  `index` skills overwrote each other.
- **Evidence was missed.** The "skill opened" evidence matches `<skills>/<name>/SKILL.md`. It missed
  every skill whose folder name differed from its own name (`claude-design--fd7fe6db51`).
- **Spelling had to match exactly.** The Library merges skills case-insensitively, but delivery
  matched names case-sensitively.
- **Multi-line descriptions broke.** Twelve installed skills write `description: >-`. The reader
  took the literal `>-`, and a `native` route then quoted that to the model.

## Decisions

1. **One list of skill folders, in preference order** (`capabilities::skill_roots`). The Library
   and delivery both read it, so a skill that is listed can always be given to an agent. The order:
   1. The operator's own Claude Code skills.
   2. The project's `.claude/skills` and `.agents/skills`, labelled "‹name› project". A project
      folder that is the home folder adds nothing new and is dropped.
   3. Each app's own folders, in this order: Codex, OpenCode (`skills/` and `skill/`), Gemini,
      Hermes (its folder and each profile), OpenClaw, pi.
   4. The shared `~/.agents/skills`.
   5. Plugins: Codex's cache, Claude Code's plugins, and Gemini extensions.

   Each app's source checkouts and catalogs are not installed skills, and are not read. That covers
   Hermes's `hermes-agent/` and `optional-skills/`, OpenClaw's sandboxes and npm projects, and
   Claude Code's `marketplaces/`. The copy delivered is the first one in this order. Copies are no
   longer sorted by source name.

2. **Superseded copies are skipped wherever they are.** The walker skips `.trash`, `.staging` and
   `.tmp`, alongside `node_modules`, `.git`, `dist` and `target`. Plugin names lose a `~g<n>`
   generation suffix. Other hidden folders are still read: Codex's built-in skills live in
   `.codex/skills/.system`.

3. **Frontmatter values can span lines.** `skill_routing::frontmatter_field` reads one top-level
   key from frontmatter, quoted or bare. It accepts a `>`/`|` block or an indented continuation, and
   joins the lines into one. The Library and the `native` route's description now use it. It is not
   a YAML parser on purpose: a skill whose frontmatter is not valid YAML must still be listed.

4. **Every agent can use every skill.** An app that loads no skills from a project folder (Hermes,
   or an unknown app) now gets every skill `inline`:
   - its instructions travel in the prompt;
   - its files are copied to `.agents/skills/<name>/`, so any relative reference still resolves;
   - the translation note says why the skill is inline.

   The note claims the skill "was written for Claude Code" only when the skill actually assumes a
   Claude facility. Hermes still loads only the folders it trusts on its own, so this delivers the
   skill without changing that trust. `SkillRoute::Blocked` stays in the type because archived runs
   recorded it, but nothing produces it any more.

5. **A delivered copy is named for the skill.** The folder is named after the wired skill, so two
   copies cannot collide, and the run's "opened" evidence can match it. A name that cannot be a
   folder name falls back to the source folder's name. Delivery is refused rather than silently
   overwriting if two copies would still land in one folder. Wired names are matched
   case-insensitively, and the same skill wired twice is delivered once.

## Consequences

- On the reference machine the Library lists 318 skills, including 114 from Hermes, 12 from
  OpenClaw and 5 from pi. No plugin appears twice, and nothing comes from a trash, a staging folder
  or a catalog.
- The container's capability import (`container/capabilities/README.md`) accepts the new folders.
- Each scan reads more folders. The full scan still runs on every detail lookup and every
  `materialise`. A cache is a separate change, worth making if the folder count keeps growing.
- Not covered:
  - Each agent's own working folder is not scanned. The skills an agent's app would find there on
    its own are listed only when they are also in the teams project.
  - Cursor's skill folder is not read, because its location has not been verified.
  - Skills are still wired by name. Which copy is delivered follows the order above, not a source
    the operator picked.
