---
category: Status
---
A 10 px evidence-coverage glyph: how much of a run's record was captured. It always sits beside a word.

```jsx
<span className="t-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><CoverageGlyph level="complete" /> Complete record</span>
<span className="t-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><CoverageGlyph level="partial" /> Partly recorded</span>
```

`level`:
- `complete`: filled green circle.
- `partial`: half-filled gold circle.
- `unavailable`: dashed grey ring.
