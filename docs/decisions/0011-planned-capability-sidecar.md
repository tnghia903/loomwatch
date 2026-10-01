# 0011 — Planned capability wiring lives in a `<team>.layout.json` sidecar

- **Date:** 2026-09-12
- **Status:** Accepted — implemented in `crates/loomwatch-backend/src/composer.rs`,
  `crates/loomwatch-backend/src/api.rs` and `ui/src/lib/composer-layout/*`
- **Implements:** the placement and typed-connection halves of
  [`TNG122_FREEFORM_CAPABILITY_COMPOSER.md`](../TNG122_FREEFORM_CAPABILITY_COMPOSER.md)
  §3–§5, under the constraint its §8.2 sets
- **Does not amend:** `schemas/team.schema.yaml`

## Context

`docs/UX_REDESIGN.md` (TNG-122 revision) makes Agents, Skills, Tools/Connectors and Knowledge
Sources the Library's four first-class draggable types. Only the first was ever implemented. The
other three rendered a drag handle and nothing else: no `draggable` attribute, no drag handlers,
no click or keyboard path. The affordance was a lie, and an operator who tried to drag a skill
onto the canvas got nothing, with no explanation.

The obvious fix — make the drop create something — has nowhere to put it.
`team.schema.yaml` is `additionalProperties: false` at every level and describes agents, edges,
a budget, guards and a schedule. It has no place for a capability, and
`TNG122_FREEFORM_CAPABILITY_COMPOSER.md` §8.2 is explicit that adding one requires "backend
ownership, threat modeling, schema/ADR review, and fixtures", recommending "a versioned
`<team>.layout.json`/composer sidecar until an ADR deliberately changes `team.schema.yaml`".

## Decisions

1. **Planned capability wiring is a sidecar, not team configuration.** `<team>.layout.json`
   sits beside `<team>.yaml` and holds `{ version, nodes, edges }`: capability nodes
   (`id`, `kind` of `skill|tool|knowledge`, `name`, display-only `source`, `position`) and
   edges from an agent id to a capability id. The team file the daemon runs stays byte-identical
   when only the canvas changes — asserted by
   `api::tests::layout_round_trips_beside_the_team_file_without_touching_it`.

2. **The daemon stores it and never executes it.** `GET`/`PUT /api/team/layout` read and write
   the file; nothing else in the backend reads it. Naming a capability here grants no access
   (§8.4): execution still depends on the harness's own authorization. The endpoints validate
   structure only — version, unique ids, finite positions, and that no edge names a capability
   the layout does not contain.

3. **The client never names the file it writes.** `PUT` takes the *team* path and derives
   `layout_path()` server-side, so the existing teams-root boundary covers the sidecar for free;
   `..` in the team path is refused before anything is written
   (`api::tests::layout_cannot_be_written_outside_the_teams_root`).

4. **Only an agent may reach a capability.** §4's matrix collapses to one relationship word per
   target kind — `uses skill`, `invokes`, `reads` — enforced in `refuseCapabilityEdge` and made
   mostly unreachable by construction: a capability card renders a target handle and no source
   handle, so a pointer cannot start a connection from one. Every refusal is non-destructive.

5. **The sidecar autosaves; the team file does not.** This deliberately differs from the team
   YAML's explicit save. The layout carries no executable contract and has no validation gate
   that could block a write, while §9 calls the loss of unsaved planned work release-blocking.
   A 600 ms debounce settles a drag into one write. A sidecar that could not be *read* is never
   overwritten by the empty layout shown in its place — otherwise a transient daemon error would
   silently destroy an operator's wiring.

6. **An agent that leaves the team file takes its edges with it.** Renaming or deleting an agent
   would otherwise leave an edge drawn from nothing. Orphaned edges are pruned both at load
   (covering edits made while the canvas was closed) and when the agent list changes.

## Consequences

- Capability wiring is not visible to the daemon, so it does not influence execution today. It
  records what the operator *intends*; the run still does whatever the harness does. This is the
  honest position until permissions are modeled (§8.4), and the canvas says so by drawing planned
  cards with a dashed perimeter and no runtime status.
- `PUT /api/team/layout` has no `If-Match` precondition, unlike `PUT /api/team`. Two sessions
  arranging the same team's canvas at once would have a last-writer-wins outcome. Accepted for
  layout metadata; revisit if the sidecar ever holds something a user cannot re-drag in seconds.
- Nothing migrates. A team without a sidecar reads as an empty layout, which is exactly right.
