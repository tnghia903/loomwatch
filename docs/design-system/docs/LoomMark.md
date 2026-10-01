---
category: Identity
---
The LoomWatch brand mark: two strands crossing, the warp solid and the weft dimmed. It is drawn in gold (`.fr-mark` sets `color: var(--color-accent)`).

```jsx
<span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, font: '600 17px/1 var(--font-sans)' }}>
  <LoomMark width={46} height={20} />LoomWatch
</span>
```

`width` and `height` default to 102 × 44 (the first-run size); the Home header uses 46 × 20. It plays a short entrance animation once (`.fr-mark`); the Home header switches that off with a scoped `animation: none`. Pair it with the wordmark "LoomWatch" in Inter 600. Don't recolour it, outline it, or put it on a gradient.
