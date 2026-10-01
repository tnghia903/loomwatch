---
category: Identity
---
An agent's identity: a 3 × 3 woven swatch derived from its id, gold weft over graphite warp. Same id, same swatch, on every surface.

Use it wherever an agent is named: canvas cards, the team sentence, timeline lanes, stage cards, tickets. Never give an agent a face, avatar, logo or vendor colour instead.

```jsx
<AgentMark id="news-collector" name="News Collector" />
<AgentMark id="digest-writer" name="Digest Writer" state="writing" events={12} />
<AgentMark id="review" operator state="waiting" />   {/* the review step: a dashed gold ring */}
```

Props
- `id` (required): the agent's id. The weave is derived from it.
- `name`: used for the accessible label ("Digest Writer, writing its reply").
- `size`: px, default 24. Story-depth cards use 34.
- `state`: what the run record says. `still` (no run shown), `turn` (not started yet, faint), `starting`, `thinking` (rows pulse blue), `working` (a blue shuttle: using a tool), `writing` (rows weave in), `waiting` (gold halo: waiting for you), `done` (a knot ties off), `failed` (centre breaks red), `stopped`.
- `events`: recorded events so far. Each new one lays one stitch while live.
- `operator`: the review step (the person). Draws a ring, not a weave.
- `animate`: default true. Pass false for a replay or a finished run, so it shows state without motion.

Rules: blue only while executing, gold halo only when it waits on the operator, red only on failure. Under `prefers-reduced-motion` it shows state without motion. Set `--mark-ground` to the surface colour behind it (default `var(--color-panel-solid)`) so the weave's gaps cut cleanly.
