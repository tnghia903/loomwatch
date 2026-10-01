## LoomWatch conventions (read before building)

**Setup.** No provider. `styles.css` carries everything: fonts (Inter, JetBrains Mono, Instrument Serif), tokens and the class kit (all in `_ds_bundle.css`). Theme lives in a `data-theme` attribute. LoomWatch is **dark by default**: put `data-theme="dark"` on your root wrapper (it gets `--color-ground` background and `--color-ink` text). Light is the `:root` default, so for light just omit the attribute. Don't nest a light island inside a dark root.

**Styling idiom: kit classes plus `var(--*)` tokens. Never hex values, never new colours.** React components here are only glyphs (`AgentMark`, `StatusGlyph`, `ChipDot`, `CoverageGlyph`, `EntityGlyph`, `LoomMark`). Everything else is built with `className`:

| Family | Real names |
|---|---|
| Colour | `--color-ground` `ground-dot` `panel` `panel-solid` `hairline` `ink` `ink-2` `ink-3` `warp` `accent` `accent-fill` `accent-on-fill` `accent-dim` `accent-tint` `live` `live-tint` `alert` `ok` `halt` |
| Space / radius | `--sp-1`…`--sp-8` (4 8 12 16 20 24 32 48); `--r-xs` `--r-sm` `--r-md` `--r-lg` `--r-full` |
| Type | `t-display` (serif) `t-title` `t-body` `t-body-m` `t-node` `t-ui` `t-meta` `t-micro` `t-mono` `t-mono-sm` `eyebrow` |
| Surfaces | `e1` (glass panel) `e2` (opaque popover) `ground-dots` |
| Actions | `btn` `btn-primary` `btn-lg` `btn-head` `btn-danger` `link` `iconbtn` `key` `view-switch` `depth-dial` `tabs` |
| Fields | `field` (+`needs` gold, `error` red) `input` `hint` `search` `check` (+`on`) `lfilt` |
| Status | `status` + `idle\|live\|waiting\|stopped\|ok\|alert`; `badge badge-live\|badge-replay` with `pip`; `lbadge` `count` `monogram` `chip` `ready-dot` |
| Canvas | `build-node` (+`has-run` `selected` `st-running\|st-succeeded\|st-failed` `kind-operator`) with `build-node-body` `build-node-row` `build-node-icon` `build-node-task` `build-node-meta` `node-kind` `primary-chip` `step`; `capability-node` `ghost` |
| Panels | `lib-row` (+`armed`) `lib-row-text` `lib-row-name` `lib-row-sub` `engine`; `zone` `zone-head` `proc-list` `panel-pad`; `pop-search` `pop-list` `pop-row`; `bar` (+`halt\|alert\|ok`) `notice` `inline-error`; `composer` with `mode-chip` `mid` `note` `act` |
| Loom layer | `team-story` `story-name` (+`you`) `story-schedule` `story-fix`; `home-card` `home-card-name` `home-card-meta`; `weft` `weft-lane` `weft-thread`; `receipt-slip` |

**Rules the agent must keep.**
- One `btn-primary` (gold fill) per screen. All other gold is a line, ring, tint or text.
- Blue (`live`) means executing now and nothing else. Red (`alert`) means wrong, never a count.
- Status = glyph shape + an uppercase word, never colour alone.
- Serif (`t-display`, team sentence) is for what the product *says*. Mono is for ids, models, paths and file names.
- Plain words: "AI app", not "harness"; agent names, not ids. No avatars, no vendor colours.

**Where the truth lives.** `guidelines/DESIGN.md` is the full brief: colour meanings, the edge grammar, layout widths, motion and voice. Each component's `.prompt.md` covers its states. `_ds_bundle.css` holds every class above.

```jsx
<div data-theme="dark" className="ground-dots" style={{ padding: 'var(--sp-6)' }}>
  <div className="build-node has-run st-running">
    <span className="step">1</span>
    <div className="build-node-body">
      <div className="build-node-row">
        <span className="build-node-icon"><AgentMark id="news-collector" name="News Collector" state="working" /></span>
        <div><span className="node-kind">Agent</span><strong>News Collector</strong><small>Collects what is needed</small></div>
      </div>
      <div className="build-node-task"><StatusGlyph status="running" /><b style={{ color: 'var(--color-live)' }}>Running</b><span className="task-text">Reading techcrunch.com</span></div>
    </div>
  </div>
  <button className="btn btn-primary">Run team</button>
</div>
```
