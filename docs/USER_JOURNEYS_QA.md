# Everyday user journeys QA

Verified 2026-10-01 against the current uncommitted workspace. The aim was to walk LoomWatch the
way a normal, non-technical user would, write each step down as a test case, and fix whatever
stopped one from passing.

## How it was tested

A separate daemon ran on `127.0.0.1:3300` with its own PostgreSQL database
(`loomwatch_usertest_20261001`) and a scratch teams folder, so the real run history and the other
servers on `:3000`/`:3100`/`:3200` were not touched. The UI ran from `vite` on `:5176` against it.
Both are in `.claude/launch.json` as `loomwatchd-usertest` and `loomwatch-ui-usertest`.

Runs used the bundled offline demo (`examples/operator-stop.yaml`) and a team whose app is not
installed. No provider account or model usage was involved. Creating a team from a template does
start the chosen app once to read its model list, as it does for every user.

The main viewport was 1440×900, with spot checks at 1280×720 and 375×812, in dark and light themes.

## Test cases and results

**Pass** passed on the first try. **Fixed** failed first, was fixed, and was re-run in the browser.

| ID | What the user does | Expected | Result |
| --- | --- | --- | --- |
| U01 | Opens LoomWatch | Home explains the app, offers **New team**, lists teams and the AI apps found | Pass |
| U02 | Opens a team, then presses Back or clicks the logo | Workspace opens; Back and the logo return Home | Pass |
| U03 | Follows a link to a team that no longer exists | Plain message, teams still listed, leaving asks nothing | Fixed (leave prompt) |
| U04 | Has a broken YAML file and a non-team YAML file in the folder | Home still lists them honestly; opening one explains the problem | Fixed (crash, labels) |
| U05 | Creates "Trip planner" from **One assistant** | Saved, opened, ready to run; buttons visible on a laptop screen | Fixed (buttons below the fold) |
| U06 | Leaves the name blank or types only spaces | **Create team** stays disabled | Pass |
| U07 | Creates a second team with the same name | Existing team untouched; the new one is independent | Fixed (shared Notebook id) |
| U08 | Uses punctuation and emoji in the name | Valid file name; the name shows as typed | Pass |
| U09 | Picks **Empty team** and clicks **Run team** | Guidance to add an agent; **Run** disabled with the reason | Pass |
| U10 | Cancels the dialog (Cancel, Escape, click outside) | Nothing is created | Pass |
| U11 | Clicks **Run team**, types a request, presses Enter | Run starts and pauses at **You** | Fixed (request box not focused) |
| U12 | Presses Shift+Enter, or Enter with nothing typed | New line; nothing sent | Pass |
| U13 | Reads the handover and sends it back with a note | Researcher revises; timeline says what happened | Fixed ("You opened Your answer.") |
| U14 | Approves without a comment | Writer runs; **Finished**; Team response shown | Pass |
| U15 | Reloads the page while the team waits | Still waiting, still approvable | Pass |
| U16 | Stops a run | Stopped; receipt tells the truth; a new run is possible | Fixed (duration, states, green status) |
| U17 | Reopens an earlier run and replays it | Run opens; replay steps through moments | Pass |
| U18 | Asks for a follow-up, or starts something new | Follow up, Redo from, Retry, history and **New run** are on screen | Fixed (controls hidden, no New run) |
| U19 | Presses Enter twice quickly | One run starts | Pass |
| U20 | Adds an agent, renames it, edits its instructions, saves | Saved to disk | Pass |
| U21 | Connects agents with **Hand work along in this order instead** | Numbered steps; sentence updates | Pass |
| U22 | Deletes an agent, then presses ⌘Z | Plain confirmation; undo restores agent and connection | Fixed (wording) |
| U23 | Renames the team | New name shown everywhere and saved | Fixed (not possible before) |
| U24 | Uses **Organize**, then **Undo organize** | Cards line up, then return | Pass |
| U25 | Runs a team whose AI app is not installed | Failure is red and says what to do | Fixed (green chip, raw error) |
| U26 | Writes a Brief note and saves | Note visible and kept; other teams unaffected | Fixed (no feedback, shared folder) |
| U27 | Switches to light theme and reloads | Readable; theme persists | Pass |
| U28 | Uses a small laptop window and a phone width | No horizontal scroll; main actions reachable | Pass (see limits) |
| U29 | The server stops while LoomWatch is open, then restarts | Plain message, **Try again**, recovers by itself | Fixed |
| U30 | Searches with the command palette | Commands found; teams reachable through **Open team…** | Pass (see limits) |
| U31 | A run waits for the user | The bell and tab title show it | Pass |

## Defects found and how they were fixed

1. **A YAML file that is not a team blanked the whole app.** Validation read `agents` from any
   YAML document. `TeamFileModel.parse` now refuses YAML without a team's keys, or whose
   `agents`/`edges` are not lists, as a `shape` problem. The modal says "This file isn't a
   LoomWatch team." Validation also tolerates a half-written team. An `ErrorBoundary` around the
   app replaces any future render crash with **Back to your teams** and **Reload**.
2. **Home called unreadable files "Needs setup".** `GET /api/teams` now reports
   `problem: unreadable | not_a_team`, and Home shows "Can't be opened: …".
3. **A team that failed to load still armed the "Leave site?" prompt.** That prompt now needs
   something to lose.
4. **The New team dialog's buttons, progress and errors were below the fold** at 900px tall and
   less. They now sit in a sticky footer.
5. **Two teams with the same name shared one id, and so one Notebook.** A new team's id now comes
   from its unique file name (`teamIdForPath`).
6. **Run team did not put the cursor in the request box.** It does now, and so does **New run**.
7. **The timeline said "You opened Your answer."** It now says "You answered."
8. **After a run finished, the one-line composer hid Retry, Redo from, the note explaining them and
   Run history,** although the README documents them. There was also no way to start an unrelated
   task without going through Build. Finished runs now get the full composer and a **New run**
   button in the run header.
9. **A stopped run's receipt was wrong.** It said "Took 63ms" for a nine-second run, because
   duration ended at the last event instead of the run's `finishedAt`. It also said "Researcher is
   still working" and "Waiting for your decision", and the cards said "running"/"waiting". Card
   states now settle when a run ends (`settleAfterRun`): a stage counts as handed over if a later
   stage started, otherwise it ended with the run. The receipt follows the cards.
10. **No way to rename a team.** The team switcher now has **Rename**. Teams that share a name show
    their file name in the switcher.
11. **Failed and stopped runs had a green status chip.** A prototype-parity rule painted every chip
    green. Green is now kept for success.
12. **A missing agent app produced a truncated technical error** ("failed to spawn ACP harness …
    os error 2"). `plainRunError` names the agent and the app and says what to do. Error strips
    wrap instead of truncating.
13. **Brief notes were invisible until the team was saved, and teams in one folder wrote notes to
    the same `brief/` file.** A second "Style guide" note silently overwrote another team's.
    Notes now go to `<team>.brief/` with word-boundary names. Unsaved entries are listed with a
    **Save team** button.
14. **A stopped server showed "Failed to execute 'json' on 'Response'…"** with no retry and no
    recovery. `daemonFetch` turns a dropped connection or a proxy 502 into one plain sentence. The
    Home team list has **Try again** and re-checks every 5 seconds until the server is back.
15. **Jargon in everyday copy:** "Delete this node", "Removing the last edge returns this team to
    self-organizing", "byte-equivalent". These now read in plain words.

## Automated results

| Check | Result |
| --- | --- |
| `npm --prefix ui test` | 613 tests in 66 files passed (41 new) |
| `npx tsc -b`, `npm --prefix ui run lint`, `npm --prefix ui run build` | Passed |
| `cargo test -p loomwatch-backend` with local PostgreSQL | 253 library + 8 schema tests passed |
| `cargo clippy -p loomwatch-backend --all-targets -- -D warnings`, `cargo fmt --check` | Passed |
| `git diff --check` | Passed |

Each main fix was reverted in turn to confirm its new test fails without it. Six tests were
checked this way: the shape check, validation guard, leave prompt, stopped-run receipt, full
composer after a run, and per-team note folder. Each failed, and the fix was then restored.

## Practical limits and follow-ups

- **A team cannot be deleted from the UI.** Closed after this pass by
  [ADR 0028](decisions/0028-delete-a-team-to-the-trash.md). **Delete team…** is now on each Home
  card's **…** menu and in the team switcher. The team moves to `.trash/` in the teams folder, and
  its run history is kept.
- ~~**A missing agent app is caught only when the run starts.**~~ Fixed after this pass: Build asks
  the daemon (`GET /api/commands`) whether each agent's app would start, names a missing one on the
  agent card, in the heading and in Review, and blocks Run with that reason (`docs/WATCH.md`,
  "Harness readiness").
- The command palette finds commands, not teams by name. Teams are reachable through **Open team…**,
  the switcher and Home.
- The review box shows the handover as raw Markdown (`## Summary`).
- On a run stopped at a review step, the checkpoint strip reads "Done: nothing was recorded. Next:
  not recorded." The wording is a deliberate, tested contract (`CheckpointStrip`) and was left alone.
- The Memory panel header leads with the full absolute path.
- At phone width the bell badge spills below the header. LoomWatch serves only `127.0.0.1`, so
  phones are not a supported client.
- In the browser automation used here, ⌘A does not select text in a textarea. This was confirmed
  on a plain page textarea, so it is a harness limit, not an app defect.
