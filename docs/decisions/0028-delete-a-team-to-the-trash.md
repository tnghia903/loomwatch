# 0028 — Deleting a team moves it to the teams folder's trash

- **Date:** 2026-10-01
- **Status:** Accepted. Daemon: `crates/loomwatch-backend/src/api.rs` (`DELETE /api/team`, plus
  `trashed` on `GET /api/teams`), `runs.rs` (`RunRegistry::live_run_for`), `memory.rs`
  (`TeamIndex` skips the trash) and `main.rs`. UI: `ui/src/components/home/{DeleteTeamDialog,TeamCardMenu,Home}.tsx`,
  `ui/src/components/canvas/DocumentSwitcher.tsx`, `ui/src/components/Workspace.tsx` and
  `ui/src/lib/team-file/{client,useTeamList}.ts`.
- **Closes:** the "A team cannot be deleted from the UI" follow-up from the 2026-10-01 normal-user QA
  pass (`docs/USER_JOURNEYS_QA.md`, "Practical limits and follow-ups").
- **Amended 2026-10-02:** the trash also takes `<team>.files/`, the folder ADR 0035's **Add file…**
  copies files into (`chosen_knowledge::files_folder`). Before this, a deleted team left that folder
  in the teams folder, and a new team with the same file stem would have been handed its files.

## Context

Home and the team switcher could create a team but not remove one. The only way was to delete files
by hand, and a team is more than its YAML:

| Part | Where | Filed under |
| --- | --- | --- |
| Team file | `<team>.yaml` in the teams folder | its path |
| Canvas layout | `<team>.layout.json` beside it (`composer::layout_path`) | its path |
| Brief notes written in the panel | `<team>.brief/` beside it | its path |
| Files added with **Add file…** (ADR 0035) | `<team>.files/` beside it (`chosen_knowledge::files_folder`) | its path |
| Run records and their events | the `runs` table and the event archive | `team_path`, relative to the teams root |
| Notebook notes | Postgres | the team's `id`, or its file stem when it has none (`memory::scope_id`) |
| Managed workspaces | `.loomwatch/<team id>/<agent>/` beside the team | the team's id |

Three things besides the editor read a team's files: a run in progress, the scheduler (it rescans
the teams root every 30 s and skips hidden folders), and the `memory.inherits` index. The index
finds teams by id anywhere under the root, and until this change it looked inside hidden folders
too.

## Decisions

1. **Deleting moves the team; it erases nothing.** `DELETE /api/team?path=` moves up to four things
   into a new folder `.trash/<UTC time>-<file stem>/` under the teams root: the team's own
   `<team>.brief/` folder, its `<team>.layout.json`, its `<team>.files/` folder of added files, and
   the YAML. They move in that order, each sidecar only if it exists, so the YAML goes last. The
   folder also gets a `deleted.json` manifest (`path`, `name`, `trash`, `moved`, `deletedAt`), and
   the response body is the same object. A rename never copies. If one move fails, the moves already
   made are renamed back and the folder is removed, so the team is either still in the list or
   wholly in the trash. To restore a team, move the files back (README, "Where your
   work is saved"). LoomWatch does not offer "Empty trash" or a Restore button. Permanent deletion
   stays the operator's own act. A Restore button can wait until someone needs it more than once.

   The trash is a folder under the teams root rather than the OS Trash. A rename on the same
   filesystem is atomic, and Compose deployments have no desktop Trash. The folder is also already
   invisible to everything that lists teams, because `GET /api/teams` and the scheduler skip hidden
   folders. Deleting a team therefore also stops its routine.

2. **Delete is confined the same way as `PUT /api/team`.** The path goes through
   `resolve_existing_team_path`, which resolves symlinks and requires a file strictly below the
   canonical root (403 otherwise). It must also be a team the list shows: a `.yaml`/`.yml` file
   outside hidden folders and `node_modules` (404 otherwise). This rule means files under `.trash/`
   or `.loomwatch/` can never be deleted through the endpoint. The handler takes the same write lock
   as every team write. It also refuses or holds back in these cases:
   - **The path is itself a symlink (409).** A link's sidecars sit beside its target, which may be
     listed as a team in its own right. Moving either half would strand the other.
   - **`.trash` is not a real folder (500, nothing moves).** A `.trash` that is a link out of the
     root is never written through.
   - **A sibling shares the sidecars.** When `trip.yaml` and `trip.yml` both exist, they resolve to
     the same `trip.layout.json`, `trip.brief/` and `trip.files/`. Deleting one leaves those for the
     other.

3. **Delete is refused while a run of the team is unfinished (409).** The API router now holds the
   run-control router's registry, and `RunRegistry::live_run_for` counts `queued`, `starting` and
   `running`. A run waiting on the operator is `running`. A record that a previous daemon left
   unfinished never blocks, because `reload` marks it failed. The dialog asks `GET /api/runs` when
   it opens and asks again every 4 s while the team is running, so the operator hears about the run
   before choosing. The daemon's 409 is the authority. The switcher names the open team by its
   absolute path, so the dialog converts that path to the teams-relative one with the discovery
   root. It never matches on the end of a path, because that would mistake `archive/trip.yaml` for
   `trip.yaml`. The UI check can therefore under-report, but it never blocks a team that is not
   running.

   One race is accepted: a routine or a second tab can start a run between the check and the move.
   That run has already loaded its team file, and at worst it fails reading a Brief file.

4. **Delete is refused while another team inherits the team's memory (409).** The refusal names
   those teams. Inheritance resolves by id, so trashing the origin would make every run of the
   borrowing team fail with "names team …, which is not a team file under the teams root". Only an
   enabled `memory:` block counts, because a disabled one resolves nothing. The memory index now
   skips `.trash/`, so a deleted team cannot be inherited later either. It also means a new team
   that reuses a deleted team's id never reads as "declared by more than one file".

5. **Run history and Notebook notes are kept.** The rows stay filed under the old `team_path` and
   id. They are small, and they are the record of what the agents did. Keeping them also makes a
   restore lossless: moving the files back reconnects the history, the notes, the checkpoints and the
   managed workspace, which also stays in place. The cost is that a new team created under the same
   file name would inherit all of it: the run strip on its card, its run history and, worst, kept
   notes delivered into its agents' context. Decision 6 prevents that.

6. **A deleted team's name stays taken.** `GET /api/teams` gains `trashed: string[]`, the original
   paths read from the trash manifests. The New team dialog treats those paths like existing files.
   For example, a new "Trip planner" created after `trip-planner.yaml` was deleted becomes
   `trip-planner-2.yaml`, with id `trip-planner-2`. Deleting a folder from `.trash/` by hand frees
   the name. Reusing it after that is a deliberate act, and the new team inherits the old history.

7. **Both entry points use one confirmation.** Each Home team card gets a "…" menu. Its accessible
   name is "More actions" and its description is "More actions for <team>", so the team name does
   not repeat on every card. The menu has one item, **Delete team…**. The team switcher's footer
   also gets **Delete team…**. Both open `DeleteTeamDialog`:

   > **Delete "Trip planner"?** It leaves your teams list. Nothing is erased: its file, layout and
   > notes move to a hidden .trash folder inside your teams folder, and moving them back restores
   > the team. LoomWatch keeps its past runs, so they come back if you restore it.

   **Cancel** has the focus. When the team is running, the dialog says so and **Delete team** stays
   disabled until the run ends. When the daemon refuses, its message is shown as written. The
   switcher holds **Delete team…** while the open team has unsaved changes ("Save or discard your
   changes first"), because deleting goes to Home and the browser's unsaved-changes prompt would
   interrupt it. After a delete from Home the card leaves the list and a status line names the
   trash folder. After a delete from the switcher the workspace goes to Home.

## API

| Request | Answer |
| --- | --- |
| `DELETE /api/team?path=<relative or absolute>` | `200` with `{path, name?, trash, moved[], deletedAt}` |
| Outside the teams root, or the root itself | `403` |
| Missing, not `.yaml`/`.yml`, or inside a hidden folder or `node_modules` | `404` |
| A symlink, a team with an unfinished run, or one another team inherits | `409`, with a sentence the operator can act on |
| The move failed | `500`; nothing moved |
| `GET /api/teams` | gains `trashed: string[]`, sorted. Older clients ignore it, and the UI treats its absence as `[]` |

## Consequences

- The trash grows until the operator empties it. Nothing in LoomWatch prunes it, and each deletion
  is one small folder.
- A deleted team's run history stays in `GET /api/runs` and the archive, but the UI does not show
  it, because history is shown for the open team. A restore brings it back.
- `api::router_with_archive` takes the `RunRegistry`, and `main` builds the registry before the
  API router so both routers share one.
- Gated by `api::tests::delete_*` (`delete_moves_the_files_added_to_the_team_into_the_trash` for
  `<team>.files/`), `two_deletions_in_one_second_get_a_folder_each`,
  `memory::tests::a_team_in_the_trash_cannot_be_inherited`, `DeleteTeamDialog.test.tsx`,
  `HomeDeleteTeam.test.tsx` and `DocumentSwitcher.delete.test.tsx`. Each guard was removed in
  turn, and every removal turned its test red: liveness, inheritance (including the
  enabled-block rule), hidden folders, shared sidecars, the symlink refusal, the trash-link
  refusal, the same-second suffix, the index skip, the UI's live lock and re-check, the
  absolute-to-relative path conversion, name reservation and the unsaved-changes hold.
- Not covered by a test: rolling back after a move that fails part-way. A test would need a rename
  that succeeds once and then fails within one directory.
- Follow-ups: a "Recently deleted" list with Restore (the manifest already holds what it needs), and
  purging a deleted team's history and notes when the operator asks for it.
