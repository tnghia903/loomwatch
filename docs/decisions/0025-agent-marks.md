# 0025 — Agent marks: identity without a face, motion only from the record

- **Date:** 2026-10-01
- **Status:** Accepted (prototype) — `ui/src/lib/story/mark.ts`, `ui/src/components/ui/AgentMark.tsx`,
  styles in `ui/src/styles/loom.css`
- **Considered and declined:** 3D (Blender) human avatars performing activities

## Context

The operator asked whether agents should be humanised — modelled avatars that act out their work.
Avatars were declined: anthropomorphic agents raise trust and lower scrutiny, which works against a
product whose value is reviewing agent work; an avatar "typing" claims activity the run record does
not show; and a 3D pipeline costs bundle size, GPU and an art budget per role. What the idea gets
right is that agents deserve a recognisable identity, and that a glance should tell you what each
one is doing.

## Decision

Every agent wears a **mark**: a 3 × 3 woven swatch derived from its id (FNV-1a), drawn as
cloth seen up close — at each crossing either a gold horizontal float (weft on top) or a grey
vertical one (warp on top). The same agent wears the same swatch on the canvas card (with its job as
a small badge), in the team sentence, on the timeline lane and on the run's stage card. The review
step wears a ring.

The mark **moves only from recorded state** (`markState`), and only while the run is watched live:

| Record says | Mark does |
| --- | --- |
| starting | the gold rows weave in once |
| thinking (thought chunks) | rows pulse, blue |
| using a tool | a blue shuttle runs along the middle row |
| writing its reply (streaming) | rows weave in, row by row, with a faster shuttle |
| a new event recorded | one stitch lands, walking across the swatch |
| waiting for you | a gold halo pulses (gold = your action) |
| done | settles, a knot ties off |
| failed | the centre breaks, red |
| not reached yet | faint |

A replay shows each mark's state without motion. Reduced motion shows state without motion.

## Consequences

- Agents are recognisable across every surface without names, vendor colour or faces.
- Blue still means only "executing now" and gold only "you / selection / identity".
- One source of truth: every surface takes an agent's status from the same runtime the cards use —
  the timeline now receives it too, so a stage that handed over and was parked no longer reads as
  "still working" in one place and "done" in another.
- Tested in `lib/story/mark.test.tsx` (stable and distinct swatches, state mapping, no motion
  outside a live run, accessible names).
