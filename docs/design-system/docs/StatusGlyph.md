---
category: Status
---
A 12 px agent-status glyph where shape carries the meaning and colour comes second, so it survives greyscale.

Always pair it with the visible status word (micro type, uppercase). Colour alone is never the signal.

```jsx
<span className="status live"><StatusGlyph status="running" /> Running</span>
<span className="status ok"><StatusGlyph status="succeeded" /> Done</span>
<StatusGlyph status="failed" size={14} title="Error" />
```

`status`:
- `idle`: hollow ring, ink-3. Word: Ready.
- `starting`: ring with a rotating arc, blue. Word: Starting.
- `running`: filled dot, blue. Word: Running / Streaming.
- `waiting`: hollow diamond, halt. Word: Queued. No motion.
- `succeeded`: filled circle with a check, ok. Word: Done.
- `failed`: filled circle with ×, alert. Word: Error.
- `stopped`: filled square, halt. Word: Cancelled.
- `unavailable`: dashed ring, faded. Word: Offline.

`size` defaults to 12. `title` makes it a labelled image; omit it when a visible word sits beside it.
