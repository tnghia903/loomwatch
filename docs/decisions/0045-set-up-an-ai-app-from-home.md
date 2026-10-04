# 0045 — Set up an AI app from Home

- **Date:** 2026-10-03
- **Status:** Accepted.
  - Daemon: `crates/loomwatch-backend/src/api.rs` (`SignInCheck`, `HarnessSpec::sign_in`,
    `sign_in_status`, `apply_sign_in_status`, `HealthCause`, `DetectedHarness::{health_cause,
    needs_restart}`, `GET /api/harnesses`, `GET /api/harnesses/{id}/models`).
  - UI: `ui/src/lib/appSetup.ts` (new), `ui/src/components/home/AppSetup.tsx` (new),
    `ui/src/components/home/{Home,NewTeamDialog}.tsx`, `ui/src/lib/harnesses.ts`,
    `ui/src/lib/tour/steps.ts`, `ui/src/styles/home.css`.
  - Docs: `README.md`.
- **Amends:** the rule, stated on `GET /api/harnesses` since the Gemini field report, that listing
  never starts anything. Listing now runs each vendor's own sign-in status command. It still never
  starts an app.
- **Amended 2026-10-04:** Gemini CLI has no status command, so its own settings stand in for one
  (`api/gemini_auth.rs`). Over ACP it signs in as `security.auth.selectedType` in
  `~/.gemini/settings.json` says, with a Gemini API key when nothing is chosen. A Google sign-in
  (refused for other apps unless a Google Cloud project is set), or API-key sign-in with no key in
  the environment, a `.env` file Gemini CLI loads, or the keychain item its /auth dialog saves,
  reads as `health: error` with `healthCause: needs_api_key` on the list, and the models endpoint
  refuses it without starting Gemini (decisions 4 and 5). Anything else, including an
  administrator's or a team folder's own Gemini settings, is left to the handshake. A handshake
  that fails with Gemini CLI's own "Gemini API key is missing" or "This client is no longer
  supported" gets the same reason instead of "run "gemini" in Terminal to fix", which fixes neither.
  The setup panel shows such an app as **Needs an API key**. In the same pass, the panel says
  "Press New team to make your first team" only while Home has no team (decision 7), and Claude
  Code's card also names the API-key route (`ANTHROPIC_API_KEY`), which Anthropic asks apps built on
  its Agent SDK to use.

## Context

LoomWatch drives the AI apps a person already has. Someone with none of them installed got through
`./loomwatch` (it never checks for an app), and then hit a dead end:

- Home's footer said "No AI apps found. Install Claude Code, Codex or OpenCode, sign in, then try
  again." It gave no commands and no way to know when it had worked.
- New team offered only an empty team.
- Every real team was blocked by the pre-run app check.

Three findings from building the fix changed its shape:

1. **A signed-out Claude read as healthy.** LoomWatch's health check is an ACP handshake
   (`initialize` + `session/new`). On 2026-10-03, with a scratch `CLAUDE_CONFIG_DIR`,
   `claude-agent-acp` answered `session/new` with a session for a signed-out account. It fails only
   on the first prompt. `claude auth status` printed `"loggedIn": false` in 0.3 s. Codex's bridge
   does refuse a signed-out `session/new` ("Authentication required"), and `codex login status`
   says "Not logged in" (exit 1).
2. **OpenCode needs no account at all.** With empty XDG folders, `opencode acp` offered OpenCode
   Zen's free models (`opencode/big-pickle` and others), and `opencode run` answered. A LoomWatch
   team on it ran end to end. OpenCode's docs say free models need a Zen sign-in, but the CLI did
   not ask for one.
3. **A fresh install often needs a restart.** Detection searches per-user folders such as
   `~/.opencode/bin` (`EXTRA_HARNESS_DIRECTORIES`). Runs start commands from the `PATH` LoomWatch
   was started with (`CommandStatus::OutsidePath`). OpenCode's installer writes to
   `~/.opencode/bin`, so a running LoomWatch listed it and checked it fine, yet no run could start
   it. Claude and Codex are unaffected, because their runs start through `npx` or a bridge on the
   `PATH`.

## Decision

1. **Home has a "Set up an AI app" panel.** It opens by itself whenever no app can run, judged on
   loaded lists only, so a reload never reopens a panel the person hid. It stays open while the
   person installs and signs in. When hidden, it is one footer link away ("Set up an AI app", or
   "Set up another app" once one runs), and New team links to it when no app can build a template.
   The getting-started guide's "Your AI apps" step points at it.
2. **Three apps are walked through: Claude Code, Codex and OpenCode.** Each card shows the vendor's
   own install command (checked against their install pages on 2026-10-03), the sign-in command
   (`claude auth login`, `codex login`), what the app needs ("The free Claude plan doesn't include
   it"), and a Copy button. OpenCode is marked **No account needed**, with a warning that free
   models come and go and some let their maker learn from what you send. Gemini is not walked
   through, because its ACP is refused for personal Google accounts (see the 2026-10-02 beta notes).
   Any other app already on the computer still gets a card with its status and **Check again**, so
   while the panel is open it is the one place for app problems.
3. **The panel notices progress on its own.** It reads `GET /api/harnesses` every 4 s while the
   page is visible, and at once on window focus or when the tab shows again. It checks an app (the
   models endpoint) as soon as the daemon holds no verdict for it:
   - once per install (executable plus spawn command);
   - again when a verdict it saw is gone (LoomWatch restarted, or the 10-minute record lapsed);
   - never in a loop when a check itself left no verdict. Then it waits 5 minutes, or for
     **Check …**.
4. **Sign-in is checked with the vendor's own status command, before the handshake.** Claude and
   Codex catalog entries carry a `SignInCheck`. Only a plain "signed out" counts; an unreadable
   answer, a timeout (10 s), a CLI too old for the subcommand, or a Bedrock/Vertex/Foundry setup
   reads as unknown, and the handshake decides as before. A signed-out app gets
   `health: error`, `healthCause: signed_out`, and the reason "Claude isn't signed in. Run "claude
   auth login" in Terminal, then check again.". The models endpoint then returns 502 without
   starting the bridge.
5. **Listing runs the status commands too, never the app.** `GET /api/harnesses` asks every local
   app that has a `SignInCheck` and no fresh `ok` verdict (about 0.2–0.3 s each, one after the
   other). That way Home's footer, New team and the Library never call a signed-out app ready. A
   recorded "signed out" that the CLI now contradicts is dropped, so the app reads as unchecked and
   the panel checks it again. Apps proxied from the host runner (`executable_path` `host:…`) are not
   asked.
6. **The list says when an app needs a restart.** `needsRestart` is `CommandStatus::OutsidePath`
   for the app's spawn command, worked out by a `PATH` lookup. `isHarnessRunnable` excludes it, so
   no screen offers the app before a run could start it. The panel tells the person to stop
   LoomWatch and run `./loomwatch` again from a new Terminal window.
7. **No second "create a team" control.** When an app becomes ready, the panel says "Press New
   team to make your first team" instead of adding its own button ([ADR 0043](0043-one-control-per-thing.md)).

## Consequences

- A person with no AI account can get to a first real run with one install command (OpenCode),
  plus at most one restart.
- A signed-out Claude or Codex is reported as signed out everywhere the app list is read, before
  any run tries it.
- `GET /api/harnesses` costs up to about 0.5 s more while Claude or Codex has no fresh verdict.
  `codex login status` writes a few rows to Codex's own log database each time it runs.
- Install commands are copied, not run. LoomWatch never installs software or signs in for the
  person.

## Not covered

- Ask's app list (`control::list_apps`) is separate, and still says to start LoomWatch again.
- Sign-in on the host runner's side (the Docker setup) is not checked by listing.
- Making runs search the same per-user folders as detection would remove the restart step. That
  changes how every run starts an app, so it was left for its own decision.
- Windows: the commands and the restart instructions are macOS/Linux shell.
