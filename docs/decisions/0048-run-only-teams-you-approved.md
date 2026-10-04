# 0048 — Run only the team files you approved here

- **Date:** 2026-10-04
- **Status:** Accepted.
  - Daemon: `crates/loomwatch-backend/src/approvals.rs` (`TeamApprovals`, `review`),
    `runs.rs` (`check_approved` in `prepare_run`, `team_needs_review`, `POST /api/team/approve`),
    `api.rs` (`known_app_name`; `PUT /api/team` records a save), `config.rs`
    (`forbidden_spawn_env`), `acp.rs` (`daemon_only`), `permissions.rs` (`secret`),
    `chosen_knowledge.rs` (`extract_text`), `schedule.rs` (`team_files`), `main.rs` (`--state-dir`).
  - UI: `ui/src/lib/runs/client.ts` (`TEAM_NEEDS_REVIEW`, `TeamReview`, `approveTeam`),
    `ui/src/components/workspace/useRunController.ts` (the held start, `trustAndRun`),
    `ui/src/components/run/TeamReviewDialog.tsx`.

## Context

A team file is a list of programs to start: each agent's `spawn.cmd`, `args` and `env`. LoomWatch
is about to be shared with a large community, and people will share team files. Until now, a file
in the teams folder was trusted because it was there:

- The scheduler rescans every `*.yaml` under the teams folder every 30 seconds and fires any
  enabled `schedule:`. A file with `schedule: {cron: "* * * * *"}` and
  `spawn: {cmd: /bin/sh, args: ["-c", "…"]}` ran its command within about a minute of being copied
  into the folder, with no window open and no click. A security review proved this on 2026-10-04.
- A manual run started whatever the file named. A file could keep `cmd: claude-agent-acp`, so the
  card read "Claude", and set `spawn.env` to `NODE_OPTIONS`, `DYLD_INSERT_LIBRARIES`, a proxy or
  `ANTHROPIC_BASE_URL`. The app then loads other code, or sends its traffic and the sign-in it
  carries somewhere else, while looking like the app it names.
- Agents inherited the daemon's environment. That includes `DATABASE_URL`, whose password reads
  every run in the archive.
- An agent working at the team's own folder reads its files without asking. When that folder is
  the teams folder, that includes `.loomwatch/connections.json`, the keys that let a connected app
  propose and start runs.
- `pdftotext` ran on any PDF given as knowledge, with no time limit and no cap on its output.

## Decision

1. **A team file runs only in a revision the operator approved here.** `TeamApprovals` keeps, per
   team file, the `sha256:` revision approved. A revision is approved in three ways:
   - It was in the teams folder the first time this LoomWatch opened it. Those teams could already
     run, and the operator's own teams, schedules included, keep working.
   - It was saved in the editor (`PUT /api/team`). This holds when the file is new, or when the
     revision it replaced was approved. Saving a team that came from outside does not stand in for
     reviewing it.
   - The operator read what it runs and chose **Trust and run** (`POST /api/team/approve`). That
     approves exactly the revision they were shown: a file that changed since gets
     `409 stale_team_revision` and is shown again.

   The check is in `prepare_run`, the one path that manual, scheduled, follow-up and
   Control-started runs share. A refused manual start answers `409 team_needs_review` with the
   review. A refused routine records the reason as its problem and fires nothing.
2. **The review says what the team does on this computer, in plain words.** For each agent it
   names the app it runs, or quotes the command when it is not exactly how LoomWatch starts a
   known app. It also lists:
   - its settings, a folder outside the team's own, and its allow switches;
   - the folders and files it can read, and its tools and skills;
   - whether the team runs on its own, sends answers to Notion, or reads another team's memory.

   Lines worth a second look are marked: an unknown program, commands without asking, a folder
   outside the team's. A command counts as a known app only when it is the bare bridge command with
   that app's own arguments, or `npx -y` of its bridge package. `gemini --acp --yolo`,
   `./claude-agent-acp` and `npx --registry …` are shown as commands.
3. **The approvals live outside the teams folder.** They are in `~/Library/Application
   Support/LoomWatch` on macOS, or `$XDG_STATE_HOME/loomwatch` / `~/.local/state/loomwatch`
   elsewhere (`--state-dir` / `LOOMWATCH_STATE_DIR`). There is one file per teams folder, readable
   by the user only. Neither a shared download nor an agent working in the teams folder can approve
   a team.
4. **A team file cannot change what its app loads or where it connects.** `TeamConfig::parse`
   refuses these names in `spawn.env`, compared case-insensitively:
   - loader and shell variables: `PATH`, `HOME`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `PYTHONPATH`,
     and the like;
   - traffic redirects: `*_PROXY`, `*_BASE_URL`, `*_ENDPOINT`, CA bundles;
   - settings redirects: `XDG_*`, `*_HOME`, `*_CONFIG_DIR`, `NPM_CONFIG_*`, `GIT_*`,
     `OPENCODE_CONFIG*`;
   - LoomWatch's own: `DATABASE_URL`, `PGPASSWORD`, `POSTGRES_*`, `LOOMWATCH_*`.

   The operator's own environment still reaches the app: their proxy, their API keys, their
   `PATH`. `CODEX_CONFIG` stays allowed, because LoomWatch merges its own settings over it
   (ADR 0047).
5. **Agents do not inherit the daemon's own variables.** `DATABASE_URL`, `PGPASSWORD`,
   `POSTGRES_*` and `LOOMWATCH_*` are removed from every agent's environment. The container
   runner's client keeps the address and token it connects with.
6. **No agent reads the connection keys without asking.** A read of `.loomwatch/connections.json`
   is never approved by policy, wherever the agent's folder or knowledge reaches.
7. **PDF extraction is bounded.** `pdftotext` gets 15 seconds and at most 8 MiB of text per file.

## Consequences

- Downloading a team file and running it shows the review once. Its schedule waits until then, and
  its routine says why.
- Editing a downloaded team's file by hand, outside LoomWatch, means one more review at its next
  run. Edits made in LoomWatch's editor to an approved team need none.
- **Save a copy** of a team that was never reviewed creates a new file, and a new file saved in the
  editor counts as approved. A copy is an explicit choice made while looking at the team in the
  editor, so this is accepted.
- A team file with a refused `spawn.env` name no longer loads. The error names the variable and
  says to remove it. None of the example teams, and no team seen in use, sets one.
- OpenCode still acts without asking (ADR 0037). The review says so whenever a team runs it.
- A damaged approvals record stops the daemon with a message, rather than being read as approving
  everything or nothing.
