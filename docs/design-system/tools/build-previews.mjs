// Writes docs/design-system/preview/*.html: one card per foundation or component family, each
// rendered once in the dark theme and once in the light theme from the same markup.
// Every card's first line is the `@dsCard` marker Claude Design's Design System pane indexes.
//   node docs/design-system/tools/build-previews.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../preview')
mkdirSync(out, { recursive: true })
const STYLESHEETS = ['../fonts/fonts.css', '../tokens.css', '../components.css', 'card.css']

// ---- icons (lucide geometry, 24 px grid) -------------------------------------------------------
const P = {
  plus: '<path d="M5 12h14M12 5v14"/>',
  play: '<path d="M6 3l14 9-14 9z"/>',
  arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M16 13H8M16 17H8M10 9H8"/>',
  pencil: '<path d="M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8L2 21.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  ext: '<path d="M7 7h10v10M7 17 17 7"/>',
  enter: '<path d="M9 10l-5 5 5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  telescope: '<path d="m10 11 11-5-2-4-11 5zM8 7l-4 2 2 4 4-2M12 13l3 9M12 13l-3 9"/>',
}
const icon = (name, size = 16) => `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${P[name]}</svg>`
const loomMark = (w = 46, h = 20) => `<svg width="${w}" height="${h}" viewBox="0 0 102 44" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--color-accent)" aria-hidden="true"><path d="M6 34 24 10 42 34 60 10 78 34 96 10"/><path d="M6 10 24 34 42 10 60 34 78 10 96 34" opacity=".34"/></svg>`

// ---- agent mark (ui/src/components/ui/AgentMark.tsx, static) ------------------------------------
const AT = [6, 12, 18]
const FLOAT = 2.3
const WEAVES = {
  collector: [1, 0, 1, 0, 1, 1, 1, 0, 0],
  editor: [0, 1, 0, 1, 1, 0, 0, 1, 1],
  writer: [1, 1, 0, 0, 1, 0, 1, 0, 1],
  researcher: [0, 1, 1, 1, 0, 1, 0, 1, 0],
}
function mark(weave, { state = 'still', size = 24, ground = '' } = {}) {
  const style = ground ? ` style="--mark-ground:${ground}"` : ''
  if (weave === 'you') {
    return `<svg class="agent-mark you st-${state}" width="${size}" height="${size}" viewBox="0 0 24 24"${style} aria-hidden="true">${state === 'waiting' ? '<circle class="mk-halo" cx="12" cy="12" r="10.5"/>' : ''}<circle class="mk-ring" cx="12" cy="12" r="7"/><circle class="mk-dot" cx="12" cy="12" r="2.4"/></svg>`
  }
  const cells = WEAVES[weave].map((weftOnTop, i) => {
    const x = AT[i % 3], y = AT[Math.floor(i / 3)]
    return weftOnTop
      ? `<line class="mk-row r${Math.floor(i / 3)}" x1="${x - FLOAT}" y1="${y}" x2="${x + FLOAT}" y2="${y}"/>`
      : `<line class="mk-float-warp" x1="${x}" y1="${y - FLOAT}" x2="${x}" y2="${y + FLOAT}"/>`
  }).join('')
  const extra = {
    failed: '<g class="mk-break"><rect class="mk-gap" x="8.6" y="8.6" width="6.8" height="6.8"/><line x1="9.4" y1="11" x2="11.2" y2="12.8"/><line x1="12.8" y1="11.2" x2="14.6" y2="13"/></g>',
    working: '<line class="mk-shuttle" x1="3" y1="12" x2="8" y2="12"/>',
    done: '<circle class="mk-knot" cx="20.2" cy="20.2" r="2.3"/>',
    waiting: '<rect class="mk-halo" x=".75" y=".75" width="22.5" height="22.5" rx="6"/>',
  }[state] || ''
  return `<svg class="agent-mark st-${state}" width="${size}" height="${size}" viewBox="0 0 24 24"${style} aria-hidden="true">${cells}${extra}</svg>`
}

// ---- status glyph (12 px; shape first) ---------------------------------------------------------
const STATUS = {
  idle: '<circle cx="6" cy="6" r="4.25" fill="none" stroke="var(--color-ink-3)" stroke-width="1.5"/>',
  starting: '<circle cx="6" cy="6" r="4.25" fill="none" stroke="var(--color-live)" stroke-opacity=".35" stroke-width="1.5"/><path d="M6 1.75A4.25 4.25 0 0 1 10.25 6" fill="none" stroke="var(--color-live)" stroke-width="1.5" stroke-linecap="round"/>',
  running: '<circle cx="6" cy="6" r="4" fill="var(--color-live)"/>',
  waiting: '<path d="M6 1.5 10.5 6 6 10.5 1.5 6z" fill="none" stroke="var(--color-halt)" stroke-width="1.5" stroke-linejoin="round"/>',
  succeeded: '<circle cx="6" cy="6" r="5.5" fill="var(--color-ok)"/><path d="M3.6 6.1 5.3 7.8 8.5 4.4" fill="none" stroke="var(--color-ground)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  failed: '<circle cx="6" cy="6" r="5.5" fill="var(--color-alert)"/><path d="M4 4l4 4M8 4 4 8" stroke="var(--color-ground)" stroke-width="1.5" stroke-linecap="round"/>',
  stopped: '<rect x="1.75" y="1.75" width="8.5" height="8.5" rx="1.5" fill="var(--color-halt)"/>',
  unavailable: '<circle cx="6" cy="6" r="4.25" fill="none" stroke="var(--color-ink-3)" stroke-opacity=".4" stroke-width="1.5" stroke-dasharray="2 2"/>',
}
const glyph = (s) => `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">${STATUS[s]}</svg>`

// ---- cards -------------------------------------------------------------------------------------
const HEX = {
  dark: { ground: '#08080A', 'ground-dot': '#1E1E23', panel: '#101013', 'panel-solid': '#131316', hairline: '#FFF 9%', ink: '#F5F3EE', 'ink-2': '#A9A59C', 'ink-3': '#85817A', warp: '#666259', accent: '#E9C46A', 'accent-fill': '#D8A93C', 'accent-on-fill': '#08080A', 'accent-dim': '#8C7130', 'accent-tint': '#1A1508', live: '#6AB8FF', 'live-dim': '#2F7DD3', 'live-tint': '#0A2038', alert: '#F2635C', ok: '#4FC98D', halt: '#8C8C98' },
  light: { ground: '#FAF8F3', 'ground-dot': '#DFD9CD', panel: '#FFFFFF', 'panel-solid': '#FFFFFF', hairline: '#17150F 10%', ink: '#17150F', 'ink-2': '#56524A', 'ink-3': '#6E6862', warp: '#8B857C', accent: '#8A6A16', 'accent-fill': '#AD8A20', 'accent-on-fill': '#17150F', 'accent-dim': '#9C8440', 'accent-tint': '#F5F0E4', live: '#175CD3', 'live-dim': '#2F7DD3', 'live-tint': '#EAF2FF', alert: '#C0342E', ok: '#17724A', halt: '#605F6B' },
}
const swatchGroups = [
  ['Stone', ['ground', 'ground-dot', 'panel', 'panel-solid', 'hairline']],
  ['Ink & warp', ['ink', 'ink-2', 'ink-3', 'warp']],
  ['Gold — you, selected, act here', ['accent', 'accent-fill', 'accent-on-fill', 'accent-dim', 'accent-tint']],
  ['Signals', ['live', 'live-dim', 'live-tint', 'alert', 'ok', 'halt']],
]

const cards = []
const card = (c) => cards.push(c)

card({
  file: 'colors.html', group: 'Colors', title: 'Semantic colour',
  subtitle: 'Tier-2 tokens (--color-*). Only this tier flips between themes. Gold is scarce and semantic; blue means only "executing now".',
  body: (t) => swatchGroups.map(([name, keys]) => `
    <div class="sect"><div class="label">${name}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px">
        ${keys.map((k) => `<div style="display:flex;flex-direction:column;gap:5px">
          <div style="height:44px;border-radius:var(--r-sm);background:var(--color-${k});border:1px solid var(--color-hairline)"></div>
          <span style="font:500 12px/1.2 var(--font-sans)">${k}</span>
          <span class="mono" style="font-size:10.5px;color:var(--color-ink-3)">${HEX[t][k]}</span></div>`).join('')}
      </div></div>`).join(''),
})

card({
  file: 'type.html', group: 'Type', title: 'Typography',
  subtitle: 'Inter for UI, JetBrains Mono for anything typed into the team file, Instrument Serif for the story voice. Nine steps; tabular numerals.',
  body: () => `
    <div class="col" style="gap:14px">
      <div class="t-display">Put AI agents to work as a team.</div>
      <div class="t-title">Team response</div>
      <div class="t-body">Give your team a task, watch each step as it happens, and review the result before you use it.</div>
      <div class="t-node">News Collector</div>
      <div class="t-ui">Run team · Review output · Copy as Markdown</div>
      <div class="t-meta" style="color:var(--color-ink-2)">3 steps · edited 2 hours ago</div>
      <div class="t-micro" style="color:var(--color-ink-3)">Your teams · Team output</div>
      <div class="t-mono" style="color:var(--color-ink-2)">claude-sonnet-5-5 · daily-news.yaml</div>
      <div class="t-mono-sm" style="color:var(--color-ink-3)">run a9b34249 · 5m 36s · 47 events</div>
      <p style="margin:6px 0 0;font:400 19px/1.45 var(--font-serif);color:var(--color-ink-2)">Story voice — <span style="color:var(--color-ink)">every day at 10:00 AM, News Collector collects what is needed, then Digest Writer writes the answer.</span></p>
      <div class="label">display 34/38 serif · title 19/26 600 · body 14/20 · node 15/20 550 · ui 13/18 500 · meta 12/16 · micro 11/14 600 caps · mono 12/17 · mono-sm 11/15</div>
    </div>`,
})

card({
  file: 'space-shape-elevation.html', group: 'Spacing', title: 'Space, radius, elevation, focus',
  subtitle: '4 px base with eight steps. Radius xs 4 · sm 8 · md 10 · lg 14 · full. Two elevations: e1 glass, e2 opaque. Gold 2 px focus ring, always.',
  body: () => `
    <div class="sect"><div class="label">Spacing — sp-1 … sp-8</div>
      <div class="row" style="align-items:flex-end;gap:10px">${[4, 8, 12, 16, 20, 24, 32, 48].map((n) => `<div style="display:flex;flex-direction:column;align-items:center;gap:4px"><div style="width:${n}px;height:${n}px;background:var(--color-accent-tint);border:1px solid var(--color-accent-dim);border-radius:2px"></div><span class="mono" style="font-size:10px;color:var(--color-ink-3)">${n}</span></div>`).join('')}</div></div>
    <div class="sect"><div class="label">Radius</div>
      <div class="row">${[['xs', 4], ['sm', 8], ['md', 10], ['lg', 14], ['full', 999]].map(([k, r]) => `<div style="display:flex;flex-direction:column;align-items:center;gap:4px"><div style="width:52px;height:36px;border:1px solid var(--color-ink-3);border-radius:${Math.min(r, 18)}px;background:var(--color-panel-solid)"></div><span class="mono" style="font-size:10px;color:var(--color-ink-3)">${k}</span></div>`).join('')}</div></div>
    <div class="sect"><div class="label">Elevation on the dotted canvas ground</div>
      <div class="dots" style="position:relative;height:150px;border-radius:var(--r-md);border:1px solid var(--color-hairline);overflow:hidden">
        <div style="position:absolute;inset:0;background:linear-gradient(120deg,transparent 30%,color-mix(in srgb,var(--color-accent) 18%,transparent) 45%,transparent 60%)"></div>
        <div class="e1" style="position:absolute;left:16px;top:20px;width:180px;padding:14px"><div class="t-micro" style="color:var(--color-ink-3)">e1 · glass</div><div class="t-meta" style="color:var(--color-ink-2);margin-top:6px">Panels, inspector, composer, view controls</div></div>
        <div class="e2" style="position:absolute;right:16px;top:44px;width:180px;padding:14px"><div class="t-micro" style="color:var(--color-ink-3)">e2 · opaque</div><div class="t-meta" style="color:var(--color-ink-2);margin-top:6px">Popovers, ⌘K, the one dialog</div></div>
      </div></div>
    <div class="sect"><div class="label">Focus — 2 px accent outline, 2 px offset</div>
      <div class="row"><button class="btn" style="outline:2px solid var(--color-accent);outline-offset:2px">Focused button</button><span class="label">never removed</span></div></div>`,
})

card({
  file: 'buttons.html', group: 'CSS kit', title: 'Buttons & links',
  subtitle: 'One gold fill per screen (Law 2). Everything else is a hairline button, a gold link or an icon button. Touch sizes lift to 44 px.',
  body: () => `
    <div class="sect"><div class="label">Primary — the one gold plane</div>
      <div class="row"><button class="btn btn-lg btn-primary">${icon('plus')} New team</button><button class="btn btn-head btn-primary">${icon('play', 14)} Run team</button><button class="btn btn-primary">Review output ${icon('arrow', 14)}</button></div></div>
    <div class="sect"><div class="label">Secondary, disabled, danger</div>
      <div class="row"><button class="btn btn-head">${icon('layers', 14)} Edit team</button><button class="btn">Save</button><button class="btn" style="background:var(--color-accent-tint);color:var(--color-ink)">Hover</button><button class="btn" disabled>Save</button><button class="btn btn-danger" style="background:color-mix(in srgb,var(--color-alert) 12%,transparent);color:var(--color-alert)">Delete (hover)</button></div></div>
    <div class="sect"><div class="label">Links, icon buttons, keys</div>
      <div class="row"><button class="link">Run history</button><button class="link alert">Discard changes</button><button class="link muted">Not now</button>
      <button class="iconbtn" aria-label="Search">${icon('search')}</button><button class="iconbtn" aria-label="Theme">${icon('sun')}</button><button class="iconbtn" aria-pressed="true" aria-label="Layers">${icon('layers')}</button><button class="iconbtn" disabled aria-label="Menu">${icon('menu')}</button>
      <kbd class="key">⌘K</kbd><kbd class="key">⌘↵</kbd></div></div>
    <div class="sect"><div class="label">Switches — view switch (shipped: solid accent), depth dial, tabs</div>
      <div class="row"><nav class="view-switch"><button aria-pressed="true">${icon('play', 14)} Run</button><button>${icon('pencil', 14)} Build</button></nav>
      <nav class="view-switch tinted"><button aria-pressed="true">${icon('play', 14)} Run</button><button>${icon('pencil', 14)} Build</button></nav></div>
      <div class="row"><div class="depth-dial" role="radiogroup"><button aria-checked="true">Story</button><button aria-checked="false">Team</button><button aria-checked="false">Trace</button></div>
      <div class="tabs"><button aria-pressed="true">All</button><button>Skills</button><button>Tools</button></div></div>
      <div class="label">Second switch: the Law-2 tint variant (delivery.css), for screens that already have a gold primary button.</div></div>`,
})

card({
  file: 'fields.html', group: 'CSS kit', title: 'Fields & selection',
  subtitle: 'Unfinished is gold, wrong is red — both block saving, and a fresh item is never greeted with red.',
  body: () => `
    <div class="grid2">
      <div class="field"><label class="t-meta">Name</label><input class="input" value="News Editor"></div>
      <div class="field"><label class="t-meta">Model</label><input class="input mono" value="claude-sonnet-5-5" readonly></div>
      <div class="field needs"><label class="t-meta">Instructions</label><input class="input" placeholder="What should this agent do?"><span class="hint t-meta">Required before the team can run</span></div>
      <div class="field error"><label class="t-meta">Starting agent</label><input class="input mono" value="news editor!"><span class="hint t-meta">The starting agent can only use letters, numbers, dots, dashes and underscores.</span></div>
    </div>
    <div class="sect" style="margin-top:18px">
      <label class="search">${icon('search', 14)}<input placeholder="Search jobs and apps"></label>
      <div class="row" style="gap:4px"><button class="lfilt on">All</button><button class="lfilt">Jobs</button><button class="lfilt">AI apps</button><button class="lfilt">Skills</button><button class="lfilt">Tools</button></div>
      <div class="row" style="gap:24px"><button class="check on"><span class="box"><svg width="10" height="10" viewBox="0 0 12 12"><path d="M2.5 6.2 5 8.6l4.5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="txt"><b class="t-body-m">Share the team brief</b><span class="t-meta">Every agent reads it before starting</span></span></button>
      <button class="check"><span class="box"></span><span class="txt"><b class="t-body-m">Write back to memory</b><span class="t-meta">Off by default</span></span></button></div>
    </div>`,
})

card({
  file: 'status-badges.html', group: 'CSS kit', title: 'Status, badges, monograms',
  subtitle: 'Shape first, colour second, word third — every state survives greyscale. AI apps are monochrome monograms, never vendor colour.',
  body: () => `
    <div class="sect"><div class="label">Agent status</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px 8px">
        ${[['idle', 'idle', 'Ready'], ['starting', 'live', 'Starting'], ['running', 'live', 'Running'], ['waiting', 'waiting', 'Queued'], ['succeeded', 'ok', 'Done'], ['failed', 'alert', 'Error'], ['stopped', 'stopped', 'Cancelled'], ['unavailable', 'unavailable', 'Offline']].map(([s, c, w]) => `<span class="status ${c}">${glyph(s)} ${w}</span>`).join('')}
      </div></div>
    <div class="sect"><div class="label">Run badges · library badges · counts</div>
      <div class="row"><span class="badge badge-live t-micro"><span class="pip"></span>Live</span><span class="badge badge-replay t-micro"><span class="pip"></span>Replay</span>
      <span class="lbadge">Ready</span><span class="lbadge st-permission">Needs permission</span><span class="lbadge st-disconnected">Disconnected</span><span class="lbadge st-unavailable">Not installed</span><span class="lbadge wired">Connected</span><span class="count">12</span></div></div>
    <div class="sect"><div class="label">AI app monograms · chips · ready dots</div>
      <div class="row"><span class="monogram">C</span><span class="monogram">Cx</span><span class="monogram">G</span><span class="monogram">Oc</span><span class="monogram">·</span>
      <span class="chip">${icon('file', 12)} What it was given</span><span class="chip on">47 events</span>
      <span class="row" style="gap:6px"><span class="ready-dot"></span><span class="t-meta" style="color:var(--color-ink-2)">Ready to use: Claude, Codex, Gemini</span></span></div></div>`,
})

const agentCard = ({ weave, kind = 'Agent', name, line, cls = '', start = false, step = '', task = '', meta = '', state }) => `
  <div class="build-node ${cls}${task ? ' has-run' : ''}">
    ${step ? `<span class="step">${step}</span>` : ''}${start ? '<span class="primary-chip">START</span>' : ''}
    <div class="build-node-body"><div class="build-node-row">
      <span class="build-node-icon mark-holder">${weave === 'you' ? mark('you', { state }) : weave ? mark(weave, { state }) : icon('file', 18)}</span>
      <div><span class="node-kind">${kind}</span><strong>${name}</strong><small>${line}</small></div></div>
      ${task ? `<div class="build-node-task">${task}</div>` : ''}${meta ? `<div class="build-node-meta"><span class="monogram">C</span><span class="model">${meta}</span></div>` : ''}
    </div></div>`

card({
  file: 'canvas-cards.html', group: 'Canvas', title: 'Canvas cards',
  subtitle: 'Shipped Build/Run card (220 × 76; 248 × 88 with a run). The perimeter carries run status; selection is a gold ring; capabilities are dashed intent.',
  body: () => `
    <div class="dots" style="margin:-8px;padding:20px 16px;display:grid;grid-template-columns:repeat(2,max-content);gap:26px 22px;justify-content:start">
      ${agentCard({ weave: 'collector', name: 'News Collector', line: 'Collects what is needed', start: true, step: 1 })}
      ${agentCard({ weave: 'editor', name: 'News Editor', line: 'Edits', cls: 'selected', step: 2 })}
      ${agentCard({ weave: 'collector', name: 'News Collector', line: 'Collects what is needed', cls: 'st-running', state: 'working', step: 1, task: '<b style="color:var(--color-live)">Running</b><span class="task-text">Reading techcrunch.com front page</span>', meta: 'Claude · claude-sonnet-5-5' })}
      ${agentCard({ weave: 'writer', name: 'Digest Writer', line: 'Writes the answer', cls: 'st-succeeded', state: 'done', step: 3, task: '<b style="color:var(--color-ok)">Done</b><span class="task-text">Wrote the Sunday digest</span>', meta: 'Codex · gpt-5.5' })}
      ${agentCard({ weave: 'editor', name: 'News Editor', line: 'Edits', cls: 'st-failed', state: 'failed', step: 2, task: '<b style="color:var(--color-alert)">Error</b><span class="task-text">Couldn\'t open usnews.com</span>', meta: 'Claude · claude-sonnet-5-5' })}
      ${agentCard({ weave: 'you', kind: 'Review step', name: 'You', line: 'Approve before writing', cls: 'kind-operator', state: 'waiting', step: 3, task: '<b style="color:var(--color-accent)">Needs you</b><span class="task-text">Looks good, or send back?</span>' })}
      <div class="capability-node"><span class="capability-glyph">${icon('book', 15)}</span><span style="display:flex;flex-direction:column;gap:2px;min-width:0"><span class="t-micro capability-kind">Skill · planned</span><strong class="t-ui">claude-design</strong><span class="t-meta" style="color:var(--color-ink-2)">Wired to Digest Writer</span></span></div>
      <div class="build-node kind-output"><div class="build-node-body"><div class="build-node-row"><span class="build-node-icon">${icon('file', 18)}</span><div><span class="node-kind">Output</span><strong>Team response</strong><small>Written by Digest Writer</small></div></div></div></div>
    </div>`,
})

const edgeDefs = (t) => `<defs>
  <marker id="fill-${t}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" style="fill:var(--color-warp)"/></marker>
  <marker id="open-${t}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1 9 5 1 9" fill="none" style="stroke:var(--color-accent)" stroke-width="1.5"/></marker>
  <marker id="openred-${t}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1 9 5 1 9" fill="none" style="stroke:var(--color-alert)" stroke-width="1.5"/></marker>
  <marker id="chev-${t}" viewBox="0 0 14 10" refX="13" refY="5" markerWidth="11" markerHeight="8" orient="auto"><path d="M1 1 6 5 1 9M7 1l5 4-5 4" fill="none" style="stroke:var(--color-accent)" stroke-width="1.5"/></marker></defs>`
card({
  file: 'edges.html', group: 'Canvas', title: 'Edges — warp and weft',
  subtitle: 'Structure is a quiet graphite solid line; activity is a travelling gold dashed line beside it. Kinds differ by dash, weight and marker, so they survive greyscale.',
  body: (t) => {
    const rows = [
      ['configured · sequence', `stroke:var(--color-warp);stroke-width:1.5`, `fill-${t}`, '', 'static'],
      ['observed · dispatch', `stroke:var(--color-accent);stroke-width:1.5;stroke-dasharray:6 4`, `open-${t}`, '', 'travels →'],
      ['observed · ask', `stroke:var(--color-accent);stroke-opacity:.8;stroke-width:1.5;stroke-dasharray:2 3`, `open-${t}`, `open-${t}`, 'travels ⇄'],
      ['observed · handoff', `stroke:var(--color-accent);stroke-width:2.5;stroke-dasharray:10 4`, `chev-${t}`, '', 'once, then static'],
      ['anomaly', `stroke:var(--color-alert);stroke-width:1.5;stroke-dasharray:1 4;stroke-linecap:round`, `openred-${t}`, '', 'travels → + ⚠'],
    ]
    return `<svg width="0" height="0" style="position:absolute">${edgeDefs(t)}</svg>
      <div class="col" style="gap:8px">${rows.map(([name, style, end, start, motion]) => `
        <div style="display:grid;grid-template-columns:150px 1fr 110px;align-items:center;gap:12px">
          <span class="t-meta" style="color:var(--color-ink-2)">${name}</span>
          <svg height="18" width="100%" viewBox="0 0 240 18" preserveAspectRatio="none"><line x1="6" y1="9" x2="230" y2="9" style="${style}" marker-end="url(#${end})" ${start ? `marker-start="url(#${start})"` : ''}/></svg>
          <span class="t-mono-sm" style="color:var(--color-ink-3)">${motion}</span></div>`).join('')}</div>
      <div class="sect" style="margin-top:18px"><div class="label">Both layers between two cards — the observed handoff runs 14 px beside the configured line. (When they coincide exactly, no second line: a gold shuttle runs along the warp and a ×N badge sits at its midpoint.)</div>
        <div class="dots" style="position:relative;height:150px;border-radius:var(--r-md);border:1px solid var(--color-hairline)">
          <div style="position:absolute;left:12px;top:30px;transform:scale(.82);transform-origin:left top">${agentCard({ weave: 'collector', name: 'News Collector', line: 'Collects what is needed' })}</div>
          <div style="position:absolute;right:12px;top:30px;transform:scale(.82);transform-origin:right top">${agentCard({ weave: 'editor', name: 'News Editor', line: 'Edits' })}</div>
          <svg style="position:absolute;left:0;top:0;width:100%;height:100%" viewBox="0 0 560 150" preserveAspectRatio="none"><line x1="196" y1="66" x2="364" y2="66" style="stroke:var(--color-warp);stroke-width:1.5" marker-end="url(#fill-${t})"/><line x1="196" y1="80" x2="364" y2="80" style="stroke:var(--color-accent);stroke-width:2.5;stroke-dasharray:10 4" marker-end="url(#chev-${t})"/></svg>
        </div></div>`
  },
})

const libRow = (weave, name, job, app) => `<button class="lib-row">${mark(weave, { size: 22 })}<span class="lib-row-text"><span class="lib-row-name t-ui">${name}</span><span class="lib-row-sub t-meta">${job}</span><span class="engine">on ${app}</span></span><span class="grip">⋮⋮</span></button>`
card({
  file: 'panels.html', group: 'Panels', title: 'Library rows & inspector',
  subtitle: 'Hire-by-job rows are 44 px draggable cards (plain job first, the app in gold mono). The inspector is a 320 px e1 panel in three zones.',
  body: () => `
    <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:16px;align-items:start">
      <div class="e1" style="padding:12px;display:flex;flex-direction:column;gap:6px">
        <div class="eyebrow" style="padding:4px 4px 6px">Hire by job</div>
        ${libRow('researcher', 'Researcher', 'Finds and reads sources', 'Claude')}
        <button class="lib-row armed">${mark('writer', { size: 22 })}<span class="lib-row-text"><span class="lib-row-name t-ui">Writer</span><span class="lib-row-sub t-meta">Drafts the finished piece</span><span class="engine">on Claude</span></span><span class="grip">⋮⋮</span></button>
        ${libRow('editor', 'Editor', 'Tightens and corrects', 'Codex')}
        <button class="lib-row">${mark('you', { size: 22 })}<span class="lib-row-text"><span class="lib-row-name t-ui">You (review step)</span><span class="lib-row-sub t-meta">Pause so you can approve</span></span><span class="grip">⋮⋮</span></button>
        <button class="lib-row unavailable"><span class="monogram">Oc</span><span class="lib-row-text"><span class="lib-row-name t-ui">OpenCode</span><span class="lib-row-sub t-meta">Not installed</span></span></button>
      </div>
      <div class="e1 panel-pad">
        <div style="display:flex;gap:12px;align-items:flex-start">${mark('editor', { size: 22 })}<div style="flex:1;min-width:0"><div class="t-title">News Editor</div><div class="t-mono" style="color:var(--color-ink-2)">news-editor</div><div class="t-meta" style="color:var(--color-ink-3);display:flex;gap:6px;align-items:center;margin-top:3px">${glyph('idle')} Ready</div></div></div>
        <div class="zone"><div class="zone-head t-micro">Identity</div><div class="field"><label class="t-meta">Job</label><input class="input" value="Edits"></div></div>
        <div class="zone"><div class="zone-head t-micro">Behaviour</div><div class="field"><label class="t-meta">AI app</label><input class="input" value="Claude" readonly></div></div>
        <div class="zone"><div class="zone-head t-micro">Process</div><dl class="proc-list t-meta"><dt>Model</dt><dd class="mono">claude-sonnet-5-5</dd><dt>Folder</dt><dd class="mono">teams/.loomwatch/daily-news/news-editor</dd><dt>Skills</dt><dd>2 connected</dd></dl></div>
      </div>
    </div>`,
})

card({
  file: 'composer-palette.html', group: 'Panels', title: 'Composer, ⌘K palette, bars',
  subtitle: 'The composer is a 720 × 56 e1 bar (↵ sends, ⇧↵ new line). ⌘K is e2 and opaque, speaking plain words and /commands. Bars mark status with a 3 px rule, never a fill.',
  layout: 'stack',
  body: () => `
    <div class="row" style="align-items:flex-start;gap:20px">
      <div class="col" style="flex:1;min-width:320px">
        <div class="e1 composer"><button class="mode-chip t-ui"><span class="glyph">${icon('layers', 14)}</span>Pipeline</button><div class="mid"><textarea rows="1" placeholder="What should the team do?"></textarea><span class="note t-meta">Writes to Notion when it finishes</span></div><div class="act"><button class="btn btn-primary">Run <kbd>↵</kbd></button></div></div>
        <div class="e1 composer focused"><div class="mid"><textarea rows="2">Prepare the Sunday edition of the AI, tech and business news digest. Cover the last 24 hours only.</textarea><span class="note block t-meta">Give Digest Writer instructions before running</span></div><div class="act"><button class="iconbtn" aria-label="Send">${icon('enter')}</button></div></div>
        <div class="bar halt" style="border-radius:var(--r-sm)"><span class="msg t-ui">Replaying run 21</span><span class="sub t-meta">Read-only — a replay never re-executes</span><span class="acts"><button class="link">Back to live</button></span></div>
        <div class="bar alert" style="border-radius:var(--r-sm)"><span class="msg t-ui">The team file changed on disk</span><span class="acts"><button class="btn">Keep mine</button><button class="link">Load theirs</button></span></div>
        <div class="row"><span class="notice t-meta">Saved daily-news.yaml</span><span class="notice alert t-meta">Couldn't reach the daemon</span></div>
      </div>
      <div class="e2" style="width:420px;overflow:hidden">
        <div class="pop-search">${icon('search')}<input value="add a reviewer after editor"></div>
        <div class="pop-list">
          <button class="pop-row understood"><span class="name">Add Reviewer after News Editor<span class="understood-detail">Places a Reviewer on Claude and wires it in</span></span><span class="dialect">PLAIN</span></button>
          <button class="pop-row active t-ui"><span class="name">/add reviewer</span><span class="aside t-mono-sm">↵</span></button>
          <button class="pop-row t-ui"><span class="name">Zoom to Story</span><span class="aside t-mono-sm">/depth story</span></button>
          <div class="pop-sep"></div>
          <button class="pop-row t-ui"><span class="name">Switch to light</span><span class="aside t-mono-sm">⌘⇧L</span></button>
        </div>
      </div>
    </div>`,
})

const fabric = (states) => {
  const w = states.length * 11 + 2
  return `<svg width="${w}" height="24" viewBox="0 0 ${w} 24" aria-hidden="true"><line class="fabric-weft" x1="0" y1="12" x2="${w}" y2="12"/>${states.map((s, i) => `<rect class="fabric-thread st-${s}" x="${i * 11 + 2}" y="2" width="7" height="20" rx="3"/>`).join('')}${states.map((s, i) => (i % 2 === 1 ? `<line class="fabric-weft" x1="${i * 11 + 1}" y1="12" x2="${i * 11 + 10}" y2="12"/>` : '')).join('')}</svg>`
}
const homeCard = (name, meta, states, caption, file, waiting = false) => `
  <button class="home-card${waiting ? ' waiting' : ''}"><span class="home-card-name">${name}${waiting ? '<em class="home-card-waiting">Needs you</em>' : ''}</span><span class="home-card-meta">${meta}</span>
  ${states ? `<span class="team-fabric">${fabric(states)}<span class="team-fabric-caption">${caption}</span></span>` : `<span class="team-fabric" style="font-size:11.5px;color:var(--color-ink-3);font-style:italic">No runs yet — the first one starts the cloth.</span>`}
  <span class="home-card-file t-mono-sm">${file}</span><span class="home-card-go">${icon('arrow')}</span></button>`
card({
  file: 'home.html', group: 'Screens', title: 'Home',
  subtitle: 'A serif headline, one gold button, three numbered steps, then the teams. Each card weaves its recent runs: gold finished, red failed, blue working, dashed gold waiting on you.',
  layout: 'stack',
  body: () => `
    <div class="dots" style="margin:-16px -24px -24px;padding:20px 28px 28px">
      <div class="row" style="justify-content:space-between"><span class="row" style="gap:12px;font:600 17px/1 var(--font-sans)">${loomMark()}LoomWatch</span><span class="row" style="gap:6px"><span class="chip">${icon('bell', 12)} All clear</span><button class="iconbtn">${icon('search')}</button><button class="iconbtn">${icon('sun')}</button></span></div>
      <div style="max-width:640px;margin:28px 0 0">
        <h1 style="margin:0;font:400 42px/1.08 var(--font-serif)">Put AI agents to work as a team.</h1>
        <p style="margin:14px 0 0;font-size:17px;line-height:1.55;color:var(--color-ink-2)">Give your team a task, watch each step as it happens, and review the result before you use it.</p>
        <div style="margin-top:20px"><button class="btn btn-lg btn-primary">${icon('plus')} New team</button></div>
        <ol style="list-style:none;margin:20px 0 0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:16px">${[['Build', 'a team from the AI apps on this computer.'], ['Ask', 'it to do something, in plain words.'], ['Review', 'each step and the final result.']].map(([b, s], i) => `<li class="home-steps" style="display:flex;gap:12px;font-size:14px;line-height:1.45;color:var(--color-ink-2)"><b>${i + 1}</b><span><strong style="color:var(--color-ink)">${b}</strong> ${s}</span></li>`).join('')}</ol>
      </div>
      <h2 style="margin:32px 0 14px;font:600 13px/1 var(--font-sans);letter-spacing:.08em;text-transform:uppercase;color:var(--color-ink-3)">Your teams</h2>
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px">
        ${homeCard('Daily AI, tech & business news', '3 steps · edited Sep 19', ['failed', 'done', 'done', 'done', 'done', 'working'], 'Running now · 2 of 3', 'daily-news.yaml')}
        ${homeCard('Research and review', '3 steps · edited Sep 12', ['done', 'done', 'waiting'], 'Waiting for your review', 'research-team.yaml', true)}
        ${homeCard('Market research', '2 steps · edited Sep 17', null, '', 'market-research.yaml')}
      </div>
    </div>`,
})

card({
  file: 'loom.html', group: 'Loom layer', title: 'Team sentence, agent marks, timeline, receipt',
  subtitle: 'The story layer (ADR 0023/0025): the team as one serif sentence, a woven mark per agent that moves only from the record, a weft timeline per agent, and a run receipt.',
  layout: 'stack',
  body: (t) => `
    <div class="team-story"><span class="eyebrow">Your team, in one sentence</span>
      <p><span class="story-schedule">${icon('clock', 12)} Every day at 10:00 AM</span> and whenever you ask, <span class="story-name">${mark('collector', { size: 16, ground: 'var(--color-accent-tint)' })}News Collector</span> collects what is needed, then <span class="story-name you">${mark('you', { size: 16 })}You</span> approve, and finally <span class="story-name">${mark('writer', { size: 16, ground: 'var(--color-accent-tint)' })}Digest Writer</span> writes the answer.<button class="story-fix">Put Writer after Editor</button></p></div>
    <div class="sect" style="margin-top:20px"><div class="label">Agent marks — one weave per agent; state from the record only</div>
      <div class="row" style="gap:22px">${[['collector', 'still', 'idle'], ['collector', 'starting', 'starting'], ['editor', 'thinking', 'thinking'], ['editor', 'working', 'using a tool'], ['writer', 'done', 'done'], ['writer', 'failed', 'failed'], ['researcher', 'waiting', 'waits on you'], ['researcher', 'turn', 'not reached'], ['you', 'still', 'you'], ['you', 'waiting', 'you, waiting']].map(([w, s, l]) => `<span style="display:flex;flex-direction:column;align-items:center;gap:6px">${mark(w, { state: s, size: 32, ground: 'var(--color-ground)' })}<span class="t-mono-sm" style="color:var(--color-ink-3)">${l}</span></span>`).join('')}</div></div>
    <div style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:20px;margin-top:20px;align-items:start">
      <section class="weft"><div class="weft-head"><h2>Timeline</h2><span>Drag across it to replay what happened, and when.</span></div>
        <div class="weft-cloth"><div class="weft-names">
          <span>${mark('collector', { size: 16, ground: 'var(--color-panel)' })}News Collector</span><span class="you">${mark('you', { size: 16 })}You</span><span>${mark('writer', { size: 16, ground: 'var(--color-panel)' })}Digest Writer</span></div>
          <div class="weft-tracks">
            <div class="weft-lane"><div class="weft-warp"></div><div class="weft-thread" style="left:2%;width:36%"></div><div class="weft-stitch" style="left:9%"></div><div class="weft-stitch" style="left:18%"></div><div class="weft-stitch" style="left:27%"></div></div>
            <div class="weft-lane"><div class="weft-warp"></div><div class="weft-thread you" style="left:39%;width:14%"></div></div>
            <div class="weft-lane"><div class="weft-warp"></div><div class="weft-thread" style="left:54%;width:22%"></div><div class="weft-thread live" style="left:76%;width:16%"></div><div class="weft-stitch" style="left:62%"></div></div>
            <div class="weft-playhead" style="left:70%;top:-8px;bottom:-6px"></div>
          </div></div>
        <div class="weft-cap"><time>10:03:12</time><span class="weft-sentence">Digest Writer starts writing, with your approval and 16 stories.</span></div></section>
      <div class="run-receipt" style="margin:0"><div class="receipt-slip">
        <div class="receipt-head">${loomMark(28, 12)} Run receipt</div><p class="receipt-title">Run 21 · Finished</p><hr>
        <dl class="receipt-facts"><dt>Asked</dt><dd>Prepare the Sunday edition of the news digest</dd><dt>Team</dt><dd>3 helpers</dd><dt>Took</dt><dd>5m 36s</dd><dt>Ran on</dt><dd>Claude</dd></dl><hr>
        <ul class="receipt-lines"><li class="tone-ok"><span class="receipt-mark">✓</span><span>News Collector gathered 16 stories</span><span></span></li><li class="tone-bad"><span class="receipt-mark">✗</span><span>Couldn't open usnews.com — used reuters.com</span><span></span></li><li class="tone-wait"><span class="receipt-mark">→</span><span>Digest Writer is still working</span><span></span></li></ul><hr>
        <div class="receipt-checks"><b>Worth a look</b><ul><li><span>One source was replaced</span><span></span></li></ul></div>
        <div class="receipt-foot"><button class="btn">${icon('copy', 13)} Copy as Markdown</button><button class="btn">${icon('ext', 13)} See every event</button></div>
      </div></div>
    </div>`,
})

// ---- write -------------------------------------------------------------------------------------
const page = (c) => `<!-- @dsCard group="${c.group}" -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${c.title}</title>
${STYLESHEETS.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n')}
</head>
<body>
<!-- GENERATED by docs/design-system/tools/build-previews.mjs — edit the generator, not this file. -->
<header class="card-head"><h1>${c.title}</h1><p>${c.subtitle}</p></header>
<div class="duo ${c.layout || ''}">
${['dark', 'light'].map((t) => `<section class="pane" data-theme="${t}"><div class="pane-label">${t === 'dark' ? 'Dark · obsidian (default)' : 'Light · quarry'}</div>
${c.body(t)}
</section>`).join('\n')}
</div>
</body>
</html>
`
for (const c of cards) writeFileSync(resolve(out, c.file), page(c))
console.log(`wrote ${cards.length} preview cards to ${out}`)
