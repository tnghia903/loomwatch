# 0012 — A wired capability is delivered into the agent's workspace

- **Date:** 2026-09-12
- **Status:** Accepted; Claude-only delivery superseded by
  [`0019-cross-harness-skill-delivery.md`](0019-cross-harness-skill-delivery.md) — implemented in `crates/loomwatch-backend/src/workspace.rs`,
  `crates/loomwatch-backend/src/config.rs`, `crates/loomwatch-backend/src/lib.rs`,
  `schemas/team.schema.yaml` and `ui/src/components/Workspace.tsx`
- **Amends:** [`0011-planned-capability-sidecar.md`](0011-planned-capability-sidecar.md) decision 1
  and 2, for skills only
- **Does amend:** `schemas/team.schema.yaml` — the deliberate change
  [`TNG122_FREEFORM_CAPABILITY_COMPOSER.md`](../TNG122_FREEFORM_CAPABILITY_COMPOSER.md) §8 item 2
  reserves for an ADR

## Context

ADR 0011 put capability wiring in a `<team>.layout.json` sidecar the daemon stores and never
executes, and said so plainly: "it records what the operator *intends*; the run still does whatever
the harness does." That was the honest position while nothing could deliver a capability.

It did not survive contact with an operator. Someone composed a two-stage pipeline, dragged
`claude-design` onto the canvas, drew `uses skill` to the agent meant to build a dashboard, and ran
it. The agent never used the skill, because nothing had told it the skill existed. The dashed
perimeter ADR 0011 relied on to communicate "planned, not running" did not carry that meaning: an
edge drawn between two things on a canvas reads as a wire, and a wire that does nothing is a bug
report waiting to be filed. It was filed.

Three separate facts had to line up for that run to work, and none did:

1. Nothing in the backend reads the sidecar — `grep` for `ComposerLayout` outside `api.rs` is empty.
2. `team.schema.yaml` had nowhere to express a capability, so there was no path even if it did.
3. The skill was wired to a Codex agent. Codex reads `~/.codex/skills`, never a workspace, so that
   particular wiring could not have worked under any delivery mechanism — and the canvas accepted
   it without a word, because `refuseCapabilityEdge` checks direction and duplicates only.

## Decisions

1. **A skill wired to an agent is executable configuration, so it lives in the team file.**
   `agents[].capabilities` is a list of `{ kind, name }`. `kind` is an enum whose only member today
   is `skill`. Tools and knowledge sources stay on the canvas as planned intent in the sidecar,
   because each needs a delivery contract this ADR does not write — an MCP grant and a mounted
   source respectively — and naming them here would repeat exactly the mistake above.

2. **The sidecar keeps positions; the team file keeps the contract.** ADR 0011's split was
   layout-and-wiring in the sidecar. The split is now presentation in the sidecar, meaning in the
   team file. A capability card's coordinates still autosave; connecting one to an agent is a team
   file edit that waits for an explicit save behind the same revision precondition as every other
   executable change. The canvas draws the union of both sources, so this is invisible until you
   notice that wiring a skill now makes the document dirty — which is correct, because it changed
   what the daemon will run.

3. **Delivery is materialisation, not a grant.** Before an agent starts, `workspace::materialise`
   copies each wired skill's whole directory into `<team dir>/.loomwatch/<team>/<agent>/.claude/skills/`
   and runs the agent there. This is the arrangement `teams/daily-news/` already proved by hand,
   automated and made per-agent. TNG122 §8 item 4 holds: placing a skill where a harness will find
   it confers no permission, every use still passes the harness's own authorisation, and LoomWatch
   still answers `session/request_permission` with a refusal for anything the workspace's
   `.claude/settings.json` does not allow. That file is carried over from the cwd the agent
   declared, so an operator's existing policy travels with them rather than being replaced by one
   invented here.

4. **An agent that wires nothing is untouched.** Empty `capabilities` means no workspace and the
   declared `cwd`, so every existing team file behaves exactly as before. Only opting in moves an
   agent's working directory.

5. **A capability that cannot be delivered fails the run.** Not silently, not "best effort". A skill
   that is not installed, or is installed only for a harness that will not find it in a workspace,
   aborts before the harness starts, naming the skill and what to do. The canvas enforces the same
   harness rule at the moment the edge is drawn, so the common case is caught while composing
   rather than after a paid run.

6. **The prompt names what was delivered.** Skills are model-invoked: the harness offers them and
   the model chooses. Delivery is necessary but not sufficient, so `agent_prompt` lists the wired
   capabilities under their own heading. It says the operator connected them and they are
   available; it does not command their use, because whether any particular use is allowed is still
   the harness's call.

7. **The managed tree is rebuilt every run.** `.claude/skills` under the workspace is deleted and
   re-materialised each time, so a capability removed from the canvas stops being delivered.
   Removing a card also strips the skill from every agent in the team file, so the two never drift.

## Consequences

- An agent with capabilities writes its output into its workspace rather than the teams directory.
  That is a behaviour change for anyone who opts in, and it is the better default: a run's files are
  now per-agent and in a known place instead of loose beside the team files.
- `.loomwatch/` appears beside the team files. It is managed state, safe to delete, and rebuilt on
  the next run.
- Symlinks inside a skill directory are skipped rather than followed. Following one would copy
  whatever it points at into the workspace, which is the escape the teams-root boundary exists to
  prevent.
- Skill delivery was initially Claude Code only. ADR 0019 replaces this limitation with
  cross-harness delivery through the interoperable project `.agents/skills` directory supported
  by Codex and the other Agent Skills harnesses.
- ADR 0011's decisions 3 through 6 — the client never naming the sidecar file, the typed relation
  matrix, autosave for layout, and pruning edges when an agent leaves — are unchanged.
