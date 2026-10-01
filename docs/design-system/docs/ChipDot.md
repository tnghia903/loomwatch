---
category: Status
---
The 12 px save-state glyph for the open team file (the document chip), from clean through saving to saved or failed.

```jsx
<span className="t-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><ChipDot state="dirty" /> Unsaved changes</span>
<span className="t-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><ChipDot state="saved" /> Saved</span>
```

`state`:
- `clean`: hollow ring, ink-3.
- `dirty`: filled gold diamond (unsaved).
- `new`: hollow gold diamond.
- `saving`: ring with a spinning gold arc.
- `saved`: green circle with a check.
- `failed`: red ×.
- `incomplete`: gold diamond (something required is missing).
- `invalid`: solid red dot.
- `readonly`: slate padlock.

Gold means "act here", red means wrong. Pair it with a word on the chip's second line.
