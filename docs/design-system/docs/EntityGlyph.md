---
category: Provenance
---
A 14 px line icon for each kind of thing in a run's record (prompt, response, agent, tool call, source, file…). It inherits `currentColor` and is drawn at stroke 1.6.

```jsx
<span className="t-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-ink-2)' }}><EntityGlyph kind="tool" /> Read techcrunch.com</span>
<EntityGlyph kind="response" size={18} style={{ color: 'var(--color-ok)' }} />
```

`kind`: `prompt`, `response`, `agent`, `reasoning`, `skill`, `tool`, `command`, `source`, `file`, `search`, `delegation`, `permission`, `plan`, `run`.

Colour it with ink tokens by default. Use gold for a skill and green for the team's output, as the canvas does. Never use vendor colours.
