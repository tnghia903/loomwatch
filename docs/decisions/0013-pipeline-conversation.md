# 0013 — A pipeline stage stays answerable to the stage after it

- **Date:** 2026-09-12
- **Status:** Accepted — implemented in `crates/loomwatch-backend/src/acp.rs`,
  `crates/loomwatch-backend/src/team_bus.rs`, `crates/loomwatch-backend/src/lib.rs`,
  `crates/loomwatch-backend/src/config.rs` and `schemas/team.schema.yaml`
- **Changes:** pipeline handover is a brief the producing stage writes, not its transcript

## Context

Pipeline mode was a baton pass wearing the word "team". The archive of a two-stage run says it
plainly:

```
seq 0    claude  spawned
seq 826  claude  exited      ← the first stage is gone
seq 827  codex   spawned     ← before the second one starts
```

Nothing overlapped, so nothing could be asked. The `ask` tool existed and was even advertised in
pipeline mode, but calling it spawned a **brand-new process** for the target (`run_agent_inner`),
which meant the "answer" came from an agent holding nothing but its `role` and the question. An
operator watching this correctly reported that it did not feel like a conversation. It wasn't one.

The handover made it worse. The whole of the first stage's reply was pasted into the second's
prompt: measured on that run, 7,711 of 8,073 characters — 95% of the opening prompt — most of it
narration ("I'll start by pulling up the existing positioning…"). That is the expensive half of a
bad trade: the receiving stage pays for a transcript it mostly cannot use, and still cannot obtain
anything the transcript happens to omit.

The two problems share one cause and one fix. You cannot shrink the handover while the producer is
dead, because whatever you cut is gone for good. Keep the producer alive and the handover can be
small, because what it leaves out is still reachable.

## Decisions

1. **An ACP session can take more than one turn.** `run_session_inner` was one-shot by
   construction: a `has_run` latch, one `session/prompt`, then an unconditional `session/close` and
   teardown. It is now split into `open_live` → `prompt_turn` × N → `finish_live`, with the
   original one-shot call kept as a wrapper over the same primitives so every existing caller and
   its tests are unchanged.

2. **A stage is kept alive only while the stage that may ask it runs.** The pipeline hands the
   finished session to `TeamBus::keep_alive`, which owns the process in a task reading questions off
   a channel; `release` drops the sender, which ends the loop, closes the session and reaps the
   child. At most two harnesses are alive at once in a linear chain. A stage is released as soon as
   its successor's own turn ends, so nothing lingers for a stage that cannot address it.

3. **`ask` prefers the live session.** When the target is live the question goes to the session that
   did the work; otherwise the existing cold-spawn path is untouched, so team mode is unaffected.
   The reply carries `live: true` so the distinction is visible in the archive rather than implied.

4. **`allowRecruiting` does not gate a question to a predecessor.** That flag governs recruiting a
   *helper*. Asking the stage before you is conversation along an edge the operator drew, and the
   live registry only ever holds configured predecessors, so the gate would have blocked exactly the
   case this ADR exists to enable.

5. **The handover is a brief the producer writes, not its transcript.** Once its own work is done a
   stage is asked — in its still-warm session — for `## Summary` / `## Findings` / `## Open
   questions` / `## Artifacts`, bounded by `conversation.brief`. The successor reads that. Asking
   the producer costs one extra turn on a loaded context and is the only way to get a summary that
   keeps what mattered; truncation cannot substitute, because the conclusion is at the end and that
   is precisely what a cap would cut.

6. **The successor is told it can ask.** Without that, the brief has to be self-sufficient, which is
   the pressure that puts the whole transcript in the prompt. `conversation.ask.maxPerStage` bounds
   it, and the prompt says to ask only when the answer would change the output.

7. **Defaults are bounds, not policy.** 1,200 summary characters, 8 findings, 3 questions. They are
   `conversation` in the team file so a team whose output genuinely cannot be summarised can raise
   them, rather than the daemon pretending to know.

## Consequences

- A non-final stage now runs two turns instead of one. That is real added cost on the producing
  side, traded against every downstream stage no longer carrying its narration. The trade improves
  with chain length and is roughly break-even at two stages, where the quality gain (structure
  instead of a dump) is the reason to take it anyway.
- Two harnesses are alive at once. Memory and any per-process licence cost roughly double for the
  overlap; a kept-alive session is idle unless asked, so it consumes no tokens while waiting.
- Tokens spent answering a question land against the **answering** agent's budget, because that is
  whose session produces them. Budget enforcement remains admission-only and pre-spawn
  (`guard_delegation`), so a kept-alive agent's answers are not themselves admission-checked. A
  per-turn cap is the obvious next control and is deliberately not in this ADR.
- A run's canonical reply is unchanged: it is still the last stage's reply.
- `b asked a` now appears on the canvas as a delegation travelling back up a configured edge. It is
  no longer counted as an anomaly, which previously meant "a delegation outside the declared graph".
- Fixtures that scripted exactly one prompt per stage had to learn the second one. That is the
  contract changing, not a test being loosened: the two-node fixture now asserts the successor
  receives the *brief* and the ask offer, and the diamond asserts each join gets its own
  predecessors' briefs and no one else's.
