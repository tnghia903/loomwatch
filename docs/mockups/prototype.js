/* ===========================================================================
   LoomWatch — TNG-87 prototype behaviour
   Renderers are shared between the live canvas and the system board, so the
   galleries cannot drift from the thing they document.
   =========================================================================== */

/* ---------------------------------------------------------------------------
   ROLE GLYPHS — DESIGN_LANGUAGE §12: lucide, 18 px, stroke 1.5, fixed map on
   a lowercase substring of Agent.role, Circle fallback. No other icon set.
   --------------------------------------------------------------------------- */
const GLYPH = {
  telescope: '<path d="M14 3.5 20.5 6l-2 5.5-6.5-2.5z"/><path d="M11.8 9.2 3.5 12l1.6 4.4 8-3z"/><path d="M7 17.2V21"/><path d="M12.2 15.6 15.4 21"/>',
  scanEye: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="1"/><path d="M18.9 12.3a1 1 0 0 0 0-.7 7.5 7.5 0 0 0-13.9 0 1 1 0 0 0 0 .7 7.5 7.5 0 0 0 13.9 0"/>',
  penLine: '<path d="M12 20h9"/><path d="M16.4 3.6a1 1 0 0 1 3 3L7.4 18.6a2 2 0 0 1-.9.5l-2.9.9a.5.5 0 0 1-.6-.6l.8-2.9a2 2 0 0 1 .5-.9z"/>',
  flask: '<path d="M10 2v7.5a2 2 0 0 1-.2.9L4.7 20.6a1 1 0 0 0 .9 1.4h12.8a1 1 0 0 0 .9-1.4l-5.1-10.2a2 2 0 0 1-.2-.9V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
  compass: '<circle cx="12" cy="12" r="10"/><path d="m16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3z"/>',
  circle: '<circle cx="12" cy="12" r="9"/>'
};
const glyphSVG = (k, s = 18) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
        aria-hidden="true">${GLYPH[k] || GLYPH.circle}</svg>`;

/* ---------------------------------------------------------------------------
   STATUS INDICATOR — DESIGN_LANGUAGE §12. The eight values of Agent.status.
   Shape is the primary channel; colour and motion are the second and third.
   --------------------------------------------------------------------------- */
const STATUS = {
  idle:        { colour: 'var(--color-ink-3)', motion: 'none',
                 body: '<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
  starting:    { colour: 'var(--color-live)', motion: 'arc rotates, 1200 ms linear',
                 body: '<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".35"/>' +
                       '<path class="status-arc" d="M6 1.6A4.4 4.4 0 0 1 10.4 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' },
  running:     { colour: 'var(--color-live)', motion: 'blue border + breathe halo, 2400 ms',
                 body: '<circle class="status-halo" cx="6" cy="6" r="5.4" fill="currentColor" opacity=".18"/>' +
                       '<circle cx="6" cy="6" r="3.4" fill="currentColor"/>' },
  waiting:     { colour: 'var(--color-halt)', motion: 'none — it waits on a handoff, and motion would imply progress',
                 body: '<path d="M6 1.4 10.6 6 6 10.6 1.4 6z" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
  succeeded:   { colour: 'var(--color-ok)', motion: 'none',
                 body: '<circle cx="6" cy="6" r="5.4" fill="currentColor"/>' +
                       '<path d="M3.6 6.2 5.3 7.9 8.5 4.3" fill="none" stroke="var(--color-ground)" stroke-width="1.6" stroke-linecap="round"/>' },
  failed:      { colour: 'var(--color-alert)', motion: 'none',
                 body: '<circle cx="6" cy="6" r="5.4" fill="currentColor"/>' +
                       '<path d="M4 4l4 4M8 4l-4 4" fill="none" stroke="var(--color-ground)" stroke-width="1.6" stroke-linecap="round"/>' },
  stopped:     { colour: 'var(--color-halt)', motion: 'none',
                 body: '<rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.2" fill="currentColor"/>' },
  unavailable: { colour: 'color-mix(in srgb, var(--color-ink-3) 40%, transparent)', motion: 'none',
                 body: '<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2"/>' }
};
const statusSVG = (s) =>
  `<svg width="12" height="12" viewBox="0 0 12 12" style="color:${STATUS[s].colour};flex:none"
        aria-hidden="true">${STATUS[s].body}</svg>`;

/* ---------------------------------------------------------------------------
   DOCUMENT-SWITCHER DOT — UX_REDESIGN §9.1. Nine states; the shape changes
   with the state, so the chip survives greyscale.
   --------------------------------------------------------------------------- */
const CHIP = {
  clean:      { l1: 'research-team.yaml', l2: '~/.loomwatch/teams', action: '',
                colour: 'var(--color-ink-3)',
                body: '<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
  dirty:      { l1: 'research-team.yaml', l2: '3 lines differ', action: 'primary:Save ⌘S',
                colour: 'var(--color-accent)',
                body: '<path d="M6 1.4 10.6 6 6 10.6 1.4 6z" fill="currentColor"/>' },
  saving:     { l1: 'Saving…', l2: 'writing to disk', action: '',
                colour: 'var(--color-accent)',
                body: '<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".35"/>' +
                      '<path d="M6 1.6A4.4 4.4 0 0 1 10.4 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
                      '<animateTransform attributeName="transform" type="rotate" from="0 6 6" to="360 6 6" dur="1.2s" repeatCount="indefinite"/></path>' },
  saved:      { l1: 'Saved', l2: 'research-team.yaml', action: '',
                colour: 'var(--color-ok)',
                body: '<circle cx="6" cy="6" r="5.4" fill="currentColor"/>' +
                      '<path d="M3.6 6.2 5.3 7.9 8.5 4.3" fill="none" stroke="var(--color-ground)" stroke-width="1.6" stroke-linecap="round"/>' },
  failed:     { l1: "Couldn't save", l2: '403: permission denied', action: 'plain:Retry',
                colour: 'var(--color-alert)',
                body: '<path d="M2.4 2.4l7.2 7.2M9.6 2.4 2.4 9.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' },
  incomplete: { l1: '1 thing to finish', l2: 'research-team.yaml', action: 'plain:Review',
                colour: 'var(--color-accent)',
                body: '<path d="M6 1.4 10.6 6 6 10.6 1.4 6z" fill="currentColor"/>' },
  invalid:    { l1: '2 problems', l2: 'research-team.yaml', action: 'plain:Review',
                colour: 'var(--color-alert)',
                body: '<circle cx="6" cy="6" r="5.2" fill="currentColor"/>' },
  readonly:   { l1: 'research-team.yaml', l2: 'Read-only', action: '',
                colour: 'var(--color-halt)',
                body: '<rect x="2.4" y="5.2" width="7.2" height="5" rx="1.2" fill="currentColor"/>' +
                      '<path d="M4.2 5.2V4a1.8 1.8 0 0 1 3.6 0v1.2" fill="none" stroke="currentColor" stroke-width="1.3"/>' },
  new:        { l1: 'spike.yaml', l2: 'Not saved yet', action: 'disabled:Save ⌘S',
                colour: 'var(--color-accent)',
                body: '<path d="M6 1.4 10.6 6 6 10.6 1.4 6z" fill="none" stroke="currentColor" stroke-width="1.5"/>' }
};
const chipDotSVG = (s) =>
  `<svg width="12" height="12" viewBox="0 0 12 12" style="color:${CHIP[s].colour}"
        aria-hidden="true">${CHIP[s].body}</svg>`;

/* ---------------------------------------------------------------------------
   AGENT NODE — UX_REDESIGN §5.1 / §5.2. One renderer, used by the canvas and
   by the state gallery on the system board.
   --------------------------------------------------------------------------- */
function nodeHTML(n) {
  const cls = ['node', 'st-' + n.status];
  if (n.task) cls.push('has-task');
  if (n.entry) cls.push('entry');
  if (n.valid === 'incomplete') cls.push('incomplete');
  if (n.valid === 'invalid') cls.push('invalid');
  if (n.selected) cls.push('selected');
  if (n.kbd) cls.push('kbd');
  if (n.drag) cls.push('dragging');

  const pct = n.pct == null ? 0 : n.pct;
  const laneCls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
  const role = n.role
    ? `<span class="node-role t-meta">${n.role}</span>`
    : `<span class="node-role t-meta empty">Add a role</span>`;
  const lock = n.lock
    ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`
    : '';

  const task = n.task
    ? `<div class="node-task t-meta">
        ${statusSVG(n.status)}
        <b>${n.taskState || n.status}</b>
        <span>${n.task}</span>
      </div>`
    : '';

  return `<div class="${cls.join(' ')}" style="--x:${n.x || 0}px;--y:${n.y || 0}px"
       data-node="${n.id}" tabindex="0" role="button"
       aria-label="${n.name}, ${n.role || 'no role'}, ${n.model || 'no model'}, ${n.taskState || n.status}${n.task ? ', current task ' + n.task : ''}${n.entry ? ', entry point' : ''}">
    <span class="rail"></span>
    ${n.step ? `<span class="step">${n.step}</span>` : ''}
    <span class="vdot"></span>
    <div class="node-top">
      <span class="node-glyph">${glyphSVG(n.glyph)}</span>
      <span class="node-id">
        <span class="node-name t-node">${n.name}</span>
        ${role}
      </span>
      ${statusSVG(n.status)}
    </div>
    ${task}
    <div class="node-rule"></div>
    <div class="node-meta t-mono-sm">
      ${lock}
      <span class="monogram" style="width:18px;height:18px;font-size:9px">${n.harness}</span>
      <span class="model">&lrm;${n.model || '—'}</span>
      <span class="cost">${n.cost || ''}</span>
    </div>
    <div class="budget-lane ${laneCls}"><i style="width:${pct}%"></i></div>
  </div>`;
}

/* ---------------------------------------------------------------------------
   THE TEAM — one document, rendered at three points in its life.
   --------------------------------------------------------------------------- */
const AGENTS = {
  n1: { id: 'n1', name: 'Protocol Researcher', role: 'Research ACP behaviour',
        model: 'kimi-for-coding/k3-256k', harness: 'Oc', cost: '$1.24', pct: 25,
        entry: true, status: 'running', glyph: 'telescope', idText: 'researcher',
        limit: '$ 5.00' },
  n2: { id: 'n2', name: 'Spec Reviewer', role: 'Review against TEAM_CONFIG',
        model: 'anthropic/claude-opus-4-6', harness: 'C', cost: '$0.86', pct: 29,
        status: 'waiting', glyph: 'scanEye', idText: 'reviewer', limit: '$ 3.00' },
  n3: { id: 'n3', name: 'Doc Author', role: 'Write the findings up',
        model: 'openai/gpt-5-codex-high', harness: 'Cx', cost: '$0.00', pct: 0,
        status: 'idle', glyph: 'penLine', idText: 'author', limit: '$ 2.00' },
  n4: { id: 'n4', name: 'Test Runner', role: '', model: '', harness: 'Oc',
        cost: '', pct: 0, status: 'idle', glyph: 'flask', idText: 'runner',
        valid: 'incomplete', limit: '$ 1.00' }
};

/* geometry — nodes are 276 × 96; handles sit at mid-height on the left/right
   edges, which is why the graph reads left-to-right (CANVAS_SPEC §8.2). */
const POS = {
  n1: { x: 348, y: 200 }, n2: { x: 640, y: 390 },
  n3: { x: 940, y: 580 }, n4: { x: 940, y: 220 }
};
/* handles sit at mid-height: n1 R(624,248) · n2 L(640,438) R(916,438)
   n3 L(940,628) · n4 L(940,268) */
const P_N1_N2 = 'M624 248 C 664 248 600 438 640 438';
const P_N2_N3 = 'M916 438 C 956 438 900 628 940 628';
const P_N1_N4 = 'M624 248 C 720 248 850 268 940 268';
const P_N2_N4 = 'M916 438 C 950 438 906 268 940 268';
/* the anomaly takes a deliberately wider arc, clearing n2 entirely, because
   "this run skipped a step" should not be mistaken for the step it skipped */
const P_SKIP  = 'M624 248 C 830 190 1070 380 940 628';

/* Three graphs, one document. Note what pipeline mode implies for the weft:
   a coincident observed edge becomes a shuttle on the configured path, and a
   non-coincident one is by definition an anomaly (§6.8). Gold dashed weft in
   full voice therefore lives in TEAM mode — which is why both are shown. */
const GRAPHS = {
  pipeline: {
    mode: 'pipeline',
    nodes: [
      { ...AGENTS.n1, ...POS.n1, step: 1 },
      { ...AGENTS.n2, ...POS.n2, step: 2 },
      { ...AGENTS.n3, ...POS.n3, step: 3 }
    ],
    edges: [
      { layer: 'warp', d: P_N1_N2 },
      { layer: 'warp', d: P_N2_N3 },
      { layer: 'shuttle', d: P_N1_N2 },
      { layer: 'shuttle', d: P_N2_N3 },
      { layer: 'weft', kind: 'anomaly', d: P_SKIP }
    ],
    labels: [
      { x: 632, y: 343, text: '×3', title: '3 dispatch events observed along this configured edge' },
      { x: 928, y: 533, text: '×1', title: '1 handoff observed along this configured edge' },
      { x: 908, y: 323, text: '⚠', alert: true,
        title: 'Anomaly — dispatch observed from researcher to author with no configured counterpart. The run skipped reviewer.' }
    ],
    counts: { warp: '2', weft: '×5' },
    legend: true, anomalies: 1, modeLabel: 'Pipeline · 3 steps'
  },
  team: {
    mode: 'team',
    nodes: [
      { ...AGENTS.n1, ...POS.n1 },
      { ...AGENTS.n2, ...POS.n2 },
      { ...AGENTS.n3, ...POS.n3 },
      { ...AGENTS.n4, ...POS.n4 }
    ],
    edges: [
      { layer: 'weft', kind: 'dispatch', d: P_N1_N2 },
      { layer: 'weft', kind: 'ask', d: P_N1_N4 },
      { layer: 'weft', kind: 'handoff', d: P_N2_N3 },
      { layer: 'weft', kind: 'dispatch aged', d: P_N2_N4 }
    ],
    labels: [],
    counts: { warp: '0', weft: '×7' },
    legend: true, anomalies: 0, modeLabel: 'Team · self-organizing'
  },
  problems: {
    mode: 'pipeline',
    nodes: [
      { ...AGENTS.n1, ...POS.n1, step: 1, status: 'idle' },
      { ...AGENTS.n2, ...POS.n2, step: 2, status: 'idle' },
      { ...AGENTS.n3, ...POS.n3, step: 3, status: 'idle', valid: 'invalid' },
      { ...AGENTS.n4, ...POS.n4, status: 'idle', valid: 'incomplete' }
    ],
    edges: [
      { layer: 'warp', d: P_N1_N2 },
      { layer: 'warp', d: P_N2_N3 }
    ],
    labels: [],
    counts: { warp: '2', weft: '×0' },
    legend: false, anomalies: 0, modeLabel: 'Pipeline · 3 steps'
  }
};

/* ===========================================================================
   RENDER
   =========================================================================== */
const $ = (s) => document.querySelector(s);
const stage = $('#stage');
let state = { screen: 'canvas', theme: 'dark', graph: 'pipeline',
              solo: 'both', selected: null, lib: false, motion: true };

function markerFor(e) {
  if (e.layer === 'warp') return ' marker-end="url(#mWarp)"';
  if (e.layer === 'shuttle') return '';
  if (e.kind === 'anomaly') return ' marker-end="url(#mAlert)"';
  if (e.kind === 'handoff') return ' marker-end="url(#mChevron)"';
  if (e.kind === 'ask') return ' marker-end="url(#mWeft)" marker-start="url(#mWeftBack)"';
  return ' marker-end="url(#mWeft)"';
}

function renderGraph(name) {
  const g = GRAPHS[name];
  state.graph = name;

  $('#edgeGroup').innerHTML = g.edges.map((e) => {
    const cls = e.layer === 'warp' ? 'warp'
      : e.layer === 'shuttle' ? 'shuttle'
      : 'weft ' + e.kind;
    return `<path class="${cls}" d="${e.d}"${markerFor(e)}/>`;
  }).join('');

  $('#edgeLabels').innerHTML = g.labels.map((l) =>
    `<span class="edge-label edge-badge t-micro ${l.alert ? 'alert' : ''}"
           style="left:${l.x}px;top:${l.y}px" title="${l.title || ''}">${l.text}</span>`).join('');

  $('#nodes').innerHTML = g.nodes
    .map((n) => nodeHTML({ ...n, selected: n.id === state.selected })).join('');
  $('#nodes').querySelectorAll('[data-node]').forEach((el) =>
    el.addEventListener('click', () => selectNode(el.dataset.node)));

  stage.classList.toggle('mode-pipeline', g.mode === 'pipeline');
  stage.classList.toggle('mode-team', g.mode === 'team');
  $('#modeGlyph').textContent = g.mode === 'pipeline' ? '⇉' : '⁂';
  $('#modeLabel').textContent = g.modeLabel;
  $('#modeAnomaly').hidden = !g.anomalies;
  $('#cntWarp').textContent = g.counts.warp;
  $('#cntWeft').textContent = g.counts.weft;
  $('#legend').hidden = !g.legend;
  truncateAll();
}

function renderChip(s) {
  const c = CHIP[s];
  const chip = $('#chip');
  chip.className = 'panel top cx e1 ' + s;
  $('#chipDot').innerHTML = chipDotSVG(s);
  $('#chipL1').textContent = c.l1;
  $('#chipL2').textContent = c.l2;

  let html = '';
  if (c.action) {
    const [kind, label] = c.action.split(':');
    html = `<button class="btn ${kind === 'primary' ? 'btn-primary' : ''}"
              ${kind === 'disabled' ? 'disabled title="A team needs at least one agent."' : ''}
              onclick="event.stopPropagation();${kind === 'primary' ? 'doSave()' : 'openProblems()'}">${label}</button>`;
  }
  $('#chipAction').innerHTML = html;
}

function paintDots() {
  document.querySelectorAll('[data-dot]').forEach((el) => {
    el.innerHTML = chipDotSVG(el.dataset.dot);
  });
}

/* the inspector is the detail surface; the node is the map (§5.4) */
function selectNode(id) {
  state.selected = id;
  const insp = $('#inspector');
  stage.classList.toggle('inspecting', !!id);
  if (!id) {
    insp.hidden = true;
    renderGraph(state.graph);
    if (stage.classList.contains('workspace')) renderAgentExecution();
    return;
  }
  const a = AGENTS[id];
  $('#ispGlyph').innerHTML = glyphSVG(a.glyph, 20);
  $('#ispName').textContent = a.name;
  $('#ispId').textContent = a.idText;
  $('#ispStatus').innerHTML = statusSVG(a.status) + ' ' + a.status;
  $('#iRole').value = a.role;
  $('#iModel').value = a.model;
  $('#cEntry').classList.toggle('on', !!a.entry);
  if (stage.classList.contains('workspace')) {
    const liveAgent = agentExecutionNodes().find((n) => n.id === id);
    if (liveAgent) $('#ispStatus').innerHTML = statusSVG(liveAgent.status) + ' ' + liveAgent.taskState.toLowerCase() + ' · ' + liveAgent.task;
  }

  /* the two validation weights, never both at once (§5.4) */
  $('#fRole').className = 'field';
  $('#fModel').className = 'field';
  $('#fRole').querySelector('.hint').textContent = '';
  $('#fModel').querySelector('.hint').textContent = '';
  if (a.valid === 'incomplete') {
    $('#fModel').className = 'field needs';
    $('#fModel').querySelector('.hint').textContent = 'Required';
    $('#iModel').placeholder = 'e.g. anthropic/claude-opus-4-6';
    $('#fRole').className = 'field needs';
    $('#fRole').querySelector('.hint').textContent = 'Required';
    $('#iRole').placeholder = 'What is this agent for?';
  }
  if (id === 'n3' && state.graph === 'problems') {
    $('#fModel').className = 'field error';
    $('#fModel').querySelector('.hint').textContent = 'warnAtPercent must be between 1 and 100.';
  }
  insp.hidden = false;
  renderGraph(state.graph);
}

/* ===========================================================================
   TNG-89 — prompt-to-run, live response, provenance
   Spec: ../TNG89_INTERACTION.md. Every entity kind, edge kind, capture value,
   coverage level and run state below is taken verbatim from
   ../RUN_PROVENANCE_CONTRACT.md. None of it is invented here.
   =========================================================================== */

/* the four `capture` values — CONTRACT §8.1. Border + glyph + WORD, so the
   set survives greyscale (DESIGN_LANGUAGE §8 Law 3). */
const CAPTURE = {
  recorded:    { word: 'Recorded',      glyph: '<svg width="9" height="9" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="currentColor"/></svg>' },
  derived:     { word: 'Derived',       glyph: '<svg width="9" height="9" viewBox="0 0 10 10"><circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>' },
  redacted:    { word: 'Redacted',      glyph: '<svg width="9" height="10" viewBox="0 0 10 12"><rect x="1.5" y="5" width="7" height="5.5" rx="1.2" fill="currentColor"/><path d="M3.2 5V3.6a1.8 1.8 0 0 1 3.6 0V5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>' },
  unavailable: { word: 'Not captured',  glyph: '<svg width="9" height="9" viewBox="0 0 10 10"><circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="1.8 1.8"/></svg>' }
};

/* coverage levels — CONTRACT §12. "complete" is only ever allowed when every
   requested category is complete; otherwise the header says partial capture. */
const COVERAGE = {
  complete:    { word: 'Complete',      colour: 'var(--color-ok)',
                 glyph: '<circle cx="5" cy="5" r="4" fill="currentColor"/>' },
  partial:     { word: 'Partial',       colour: 'var(--color-accent)',
                 glyph: '<path d="M5 1a4 4 0 0 0 0 8z" fill="currentColor"/><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="1.2"/>' },
  unavailable: { word: 'Not captured',  colour: 'var(--color-ink-3)',
                 glyph: '<circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="1.8 1.8"/>' }
};
const covSVG = (l) =>
  `<svg class="cov" viewBox="0 0 10 10" style="color:${COVERAGE[l].colour}" aria-hidden="true">${COVERAGE[l].glyph}</svg>`;

/* the eight TraceEntity kinds — CONTRACT §8.1 */
const ENT_GLYPH = {
  prompt:   '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  response: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h6"/>',
  agent:    '<circle cx="12" cy="12" r="9"/>',
  reasoning:'<path d="M12 4a4 4 0 0 0-4 4 3 3 0 0 0-1 5.8V17a3 3 0 0 0 5 2 3 3 0 0 0 5-2v-3.2A3 3 0 0 0 16 8a4 4 0 0 0-4-4z"/>',
  skill:    '<path d="M9 3h6v3a2 2 0 0 0 2 2h3v6h-3a2 2 0 0 0-2 2v3H9v-3a2 2 0 0 0-2-2H4V8h3a2 2 0 0 0 2-2z"/>',
  tool:     '<path d="M14.7 6.3a4 4 0 0 1 5 5L11 20a3 3 0 0 1-4-4z"/><path d="M15 7l2 2"/>',
  command:  '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  source:   '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'
};
const entGlyph = (k, s = 14) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        style="flex:none">${ENT_GLYPH[k] || ENT_GLYPH.agent}</svg>`;

/* run states — CONTRACT §3.2. Reuses DESIGN_LANGUAGE §12's status shapes, so
   an operator who learnt agent status already reads run status. */
const RUNSTATE = {
  queued:    { s: 'idle',      text: 'Queued — waiting for a supervisor.' },
  starting:  { s: 'starting',  text: 'Starting <code>researcher</code>…' },
  running:   { s: 'running',   text: 'Running — 2 agents.' },
  succeeded: { s: 'succeeded', text: 'Answered in 48s.' },
  partial:   { s: 'failed',    text: 'Partial answer.' },
  failed:    { s: 'failed',    text: 'Run failed.' }
};

/* ---------------------------------------------------------------------------
   The run-screen configuration graph. Deliberately two nodes: the runtime
   overlay is a column to the right of the configuration bounding box with a
   96 px gutter (§3.1), and both must be legible at once for review.
   The library is collapsed on these screens — which is what an operator
   actually does once they stop composing and start running.
   --------------------------------------------------------------------------- */
const RUN_NODES = [
  { ...AGENTS.n1, x: 90, y: 180, step: 1, status: 'idle', taskState: 'READY', task: 'Awaiting a task' },
  { ...AGENTS.n2, x: 90, y: 440, step: 2, status: 'idle', taskState: 'READY', task: 'Awaiting a task' }
];
const P_RUN = 'M228 304 C 228 350 228 394 228 440';

GRAPHS.run = {
  mode: 'pipeline',
  nodes: RUN_NODES,
  edges: [{ layer: 'warp', d: P_RUN }],
  labels: [], counts: { warp: '1', weft: '×0' },
  legend: false, anomalies: 0, modeLabel: 'Pipeline · 2 steps'
};
GRAPHS.runLive = {
  ...GRAPHS.run,
  nodes: [
    { ...AGENTS.n1, x: 90, y: 180, step: 1, status: 'running', taskState: 'RUNNING', task: 'Query Notion workspace' },
    { ...AGENTS.n2, x: 90, y: 440, step: 2, status: 'waiting', taskState: 'QUEUED', task: 'Review evidence bundle' }
  ],
  edges: [
    { layer: 'warp', d: P_RUN },
    { layer: 'shuttle', d: P_RUN }
  ],
  labels: [{ x: 424, y: 363, text: '×1', title: '1 dispatch observed' }],
  counts: { warp: '1', weft: '×2' }, legend: true
};
GRAPHS.runDone = {
  ...GRAPHS.run,
  nodes: [
    { ...AGENTS.n1, x: 90, y: 180, step: 1, status: 'succeeded', taskState: 'DONE', task: 'Evidence packet handed off' },
    { ...AGENTS.n2, x: 90, y: 440, step: 2, status: 'failed', taskState: 'ERROR', task: 'Validation stopped at test failure' }
  ],
  edges: [{ layer: 'warp', d: P_RUN }],
  counts: { warp: '1', weft: '×2' }, legend: false
};

GRAPHS.runOk = {
  ...GRAPHS.run,
  nodes: [
    { ...AGENTS.n1, x: 90, y: 180, step: 1, status: 'succeeded', taskState: 'DONE', task: 'Evidence packet handed off' },
    { ...AGENTS.n2, x: 90, y: 440, step: 2, status: 'succeeded', taskState: 'DONE', task: 'Validation report completed' }
  ],
  edges: [{ layer: 'warp', d: P_RUN }],
  counts: { warp: '1', weft: '×2' }, legend: false
};

/* the six coverage categories, in CONTRACT §12's order. Fixed order matters:
   the operator learns positions, and a graph that reorders itself by count is
   unlearnable. */
const CATS = [
  ['agents',    'agent',     '2',  'complete'],
  ['reasoning', 'reasoning', '7',  'partial'],
  ['skills',    'skill',     '—',  'unavailable'],
  ['tools',     'tool',      '11', 'partial'],
  ['commands',  'command',   '3',  'partial'],
  ['sources',   'source',    '5',  'partial']
];
const CAT_POS = [[812, 588], [1012, 588], [812, 662], [1012, 662], [812, 736], [1012, 736]];

const ANSWER = `<p>ACP negotiates capabilities during the <code>initialize</code> handshake:
the client advertises what it supports, the agent replies with the subset it will use, and
neither side may assume a capability that was not agreed.</p>
<p>Three consequences for LoomWatch: <code>reject_always</code> is never offered by a
targeted harness, permission replies must degrade to <code>cancelled</code>, and
<code>session/prompt</code> is the only place a goal enters the run.</p>`;

/* ---------------------------------------------------------------------------
   OVERLAY RENDERER — one function, driven by a per-screen spec, so the run
   screens cannot drift from each other.
   --------------------------------------------------------------------------- */
function renderOverlay(spec) {
  const ov = $('#overlay'), pe = $('#provGroup');
  if (!spec) { ov.innerHTML = ''; pe.innerHTML = ''; return; }
  let html = '', edges = '';

  /* Goal — animates from the composer's input to here on submit (§3.2) */
  if (spec.goal) {
    const gy = spec.goalY || 150;
    html += `<div class="rt" style="--x:812px;--y:${gy}px;width:400px">
      <div class="rt-head t-micro">${entGlyph('prompt')} Goal
        <span class="spacer"></span>
        <span class="t-meta" style="text-transform:none;letter-spacing:0">Reuse</span>
      </div>
      <div class="rt-body t-body">Find out how ACP negotiates capabilities, and what that
        means for our permission handling.</div>
    </div>`;
    const gb = gy + 100, rt = spec.responseY || 300;
    edges += `<path class="prov" d="M1012 ${gb} L1012 ${rt}" marker-end="url(#mProv)"/>`;
    html += `<span class="prov-label t-micro" style="left:1012px;top:${(gb + rt) / 2}px">initiated</span>`;
  }

  /* Response — the answer lives in the canvas (§3.3) */
  if (spec.response) {
    const rs = RUNSTATE[spec.response];
    const streaming = spec.response === 'running';
    const body = spec.response === 'queued' || spec.response === 'starting'
      ? `<div class="rr-body"><div class="skel-bars">
           <i class="skel-bar" style="width:88%"></i><i class="skel-bar" style="width:96%"></i>
           <i class="skel-bar" style="width:64%"></i></div></div>`
      : `<div class="rr-body t-body">${ANSWER}${streaming ? '<span class="caret"></span>' : ''}</div>`;
    html += `<div class="rt rt-response ${spec.compact ? 'compact' : ''}" style="--x:812px;--y:${spec.responseY || 300}px;width:400px">
      <div class="rr-head t-body-m">${statusSVG(rs.s)}
        <span>${rs.text}</span>
        <span style="flex:1"></span>
        <span class="t-meta" title="Widen and centre the answer">⤢</span>
      </div>
      <div class="rr-sub t-micro">Response · researcher</div>
      ${body}
      ${streaming ? '<div class="rr-stream"></div>' : ''}
      ${spec.eventsGap ? `<div class="rt-strip halt t-meta">
          <span class="dot" style="width:9px;height:9px">${chipDotSVG('readonly')}</span>
          <span>Live events reconnecting — answer shown to</span><span class="wm">seq 1284</span>
        </div>` : ''}
      ${spec.response === 'partial' ? `<div class="rt-strip alert t-meta">
          <span>⚠ <code style="font:400 11px/15px var(--font-mono)">reviewer</code> crashed after 2 turns.</span>
          <span class="wm">process_crashed</span>
        </div>` : ''}
    </div>`;
  }

  /* provenance — six grouped summaries, fixed order, one-hop expansion (§4.1) */
  if (spec.prov) {
    const gaps = CATS.filter((c) => c[3] !== 'complete').map((c) => c[0]);
    html += `<div id="provHead" class="t-body-m" style="--x:812px;--y:${spec.provHeadY}px">
      ${covSVG('partial')} Partial capture
      <span class="gaps t-meta">— ${gaps.slice(0, 2).join(' and ')} incomplete</span>
    </div>`;

    const rowY = spec.catY || CAT_POS.map((p) => p[1]);
    CATS.forEach(([name, kind, n, cov], i) => {
      const x = CAT_POS[i][0], y = rowY[i];
      const open = spec.open === name;
      html += `<button class="rt-chip ${open ? 'open' : ''}" style="--x:${x}px;--y:${y}px"
                 aria-expanded="${open}"
                 aria-label="${name}, ${n} entities, ${COVERAGE[cov].word}">
        <span class="c-top t-micro">${entGlyph(kind, 13)} ${name}
          <span class="n t-mono-sm">${n}</span></span>
        <span class="c-cov t-meta">${covSVG(cov)} ${COVERAGE[cov].word}</span>
      </button>`;
      const cx = x + 95;
      edges += `<path class="prov" d="M1012 ${spec.provSpineY} C 1012 ${y - 24} ${cx} ${y - 24} ${cx} ${y}" marker-end="url(#mProv)"/>`;
    });
  }

  /* one hop: the expanded category's entities. All four capture states are
     contract-plausible for `tools` (§12: partial for missing pair / opaque
     harness tools), which is why this is the category the prototype opens. */
  if (spec.entities) {
    spec.entities.forEach((e, i) => {
      const x = 812 + (i % 2) * 200, y = spec.entY + Math.floor(i / 2) * 104;
      html += `<button class="ent cap-${e.cap}" style="--x:${x}px;--y:${y}px"
                 aria-label="${e.kind}: ${e.name}, ${CAPTURE[e.cap].word}${e.why ? ', ' + e.why : ''}">
        <span class="e-top t-body-m">${entGlyph(e.kind, 13)}
          <span class="e-name" style="min-width:0;overflow:hidden;white-space:nowrap">${e.name}</span></span>
        <span class="e-sub t-mono-sm">${e.sub}</span>
        <span class="e-cap t-micro">${CAPTURE[e.cap].glyph} ${CAPTURE[e.cap].word}</span>
        ${e.why ? `<span class="e-sub t-meta">${e.why}</span>` : ''}
      </button>`;
      const openIdx = CATS.findIndex((c) => c[0] === spec.open);
      const from = CAT_POS[openIdx][0] + 95, fy = (spec.catY || CAT_POS.map((p) => p[1]))[openIdx] + 64;
      edges += `<path class="prov" d="M${from} ${fy} C ${from} ${y - 20} ${x + 120} ${y - 20} ${x + 120} ${y}" marker-end="url(#mProv)"/>`;
    });
    html += `<button class="btn btn-back" style="--x:1230px;--y:${spec.entY}px;position:absolute">
               ← Back to response</button>`;
    /* filters exist only while a trace is expanded; view state, never
       document state, and never re-runs the projector (§4.4) */
    html += `<div id="filters" class="e1" style="--x:1230px;--y:${spec.entY + 44}px">
      <span class="t-micro" style="color:var(--color-ink-3)">Filter</span>
      ${CATS.map(([n], i) => `<button class="filt t-meta ${i === 3 ? 'on' : 'on'}"><span class="bx"></span>${n}</button>`).join('')}
      <span class="pop-sep" style="margin:4px 0"></span>
      <button class="filt t-meta"><span class="bx"></span>Only redacted</button>
      <button class="filt t-meta"><span class="bx"></span>Only not captured</button>
    </div>`;
  }

  ov.innerHTML = html;
  pe.innerHTML = edges;
  ov.querySelectorAll('.ent .e-name').forEach(middleTruncate);
}

/* All four capture values are contract-plausible here: CONTRACT §12 gives
   tools `partial` for a missing pair or an opaque harness tool, commands a
   derived `ran_command` edge, and sources redaction for unauthorized refs. */
const TOOL_ENTITIES = [
  { kind: 'tool',    name: 'Team Bus: ask',  sub: 'team_bus · success',  cap: 'recorded' },
  { kind: 'tool',    name: 'read_file',      sub: 'read · success',      cap: 'recorded' },
  { kind: 'command', name: 'cargo test -p loomwatchd', sub: 'exit 0',    cap: 'derived' },
  { kind: 'source',  name: 'internal reference', sub: 'web · reference withheld', cap: 'redacted' },
  { kind: 'tool',    name: 'harness tool',   sub: 'opaque',              cap: 'unavailable',
    why: 'Harness did not pair this call' }
];

/* ---------------------------------------------------------------------------
   COMPOSER — TNG89 §1.3/§1.4. Preflight blockers, and the dirty document
   becoming `Save & run` so the immutable revision is visible.
   --------------------------------------------------------------------------- */
const COMPOSER = {
  notion:  { text: 'Use Notion to find the launch brief, verify it against the repository, and cite the external source.',
             act: 'primary:Run example  ⌘↵', note: null },
  ready:   { text: 'Find out how ACP negotiates capabilities, and what that means for our permission handling.',
             act: 'primary:Run  ⌘↵', note: null },
  empty:   { text: '', act: 'disabled:Run  ⌘↵', note: null },
  dirty:   { text: 'Find out how ACP negotiates capabilities.',
             act: 'primary:Save & run  ⌘⇧↵',
             note: ['', 'Saves research-team.yaml first, then runs that exact revision.'] },
  blocked: { text: 'Review the ACP spine and report.',
             act: 'disabled:Run  ⌘↵',
             note: ['block', 'A pipeline run needs exactly one final agent. This one has two: author, qa.'] },
  invalid: { text: 'Ship it.', act: 'disabled:Run  ⌘↵',
             note: ['err', '2 problems block this run.'] }
};
function renderComposer(k) {
  const c = COMPOSER[k] || COMPOSER.ready;
  $('#compInput').value = c.text;
  const [kind, label] = c.act.split(':');
  $('#compAct').innerHTML =
    `<button class="btn ${kind === 'primary' ? 'btn-primary' : ''}" ${kind === 'disabled' ? 'disabled' : ''}
       ${kind === 'primary' ? 'onclick="submitRun()"' : ''}
       title="${kind === 'disabled' ? (c.note ? c.note[1] : 'Type what the team should do.') : ''}">${label}</button>`
    + (c.note && c.note[1].startsWith('A pipeline') ? '<button class="btn">Show on canvas</button>' : '')
    + (k === 'invalid' ? '<button class="btn">Review</button>' : '');
  const n = $('#compNote');
  if (c.note) { n.hidden = false; n.className = 'comp-note t-meta ' + c.note[0]; n.textContent = c.note[1]; }
  else n.hidden = true;
  const g = GRAPHS[state.graph] || GRAPHS.run;
  $('#compModeGlyph').textContent = g.mode === 'pipeline' ? '⇉' : '⁂';
  $('#compModeLabel').textContent = g.modeLabel;
}

/* ===========================================================================
   TNG-89 rev 3 — the interactive workspace
   The board addendum asks for a *clickable* prototype: submit a prompt, watch
   it stream, select the response, expand and collapse provenance, filter.
   So the run screens stop being static pictures and become one model.
   =========================================================================== */

const run = {
  phase: 'idle',            /* CONTRACT §3.2 + the addendum's `cancelled`     */
  mode: 'live',             /* live | replay — must be unmistakable (§5)      */
  goal: '',
  chars: 0,
  selected: false,          /* response selected → provenance appears        */
  open: null,               /* expanded category (one hop)                   */
  openEnt: null,            /* expanded entity (command detail)              */
  gap: false,               /* events-channel gap                            */
  eventCount: 0,            /* ordered live evidence projected so far         */
  timers: []
};
const FILTERS = { cats: new Set(CATS.map((c) => c[0])), agent: 'all', status: 'all', time: 'all' };

/* A multi-agent trace: researcher hands off to reviewer, so `delegated_to`
   and `participated` both appear (addendum: "at least one multi-agent trace"). */
const TRACE = {
  agents: [
    { id: 'a1', kind: 'agent', name: 'Protocol Researcher', sub: 'researcher · entry point',
      cap: 'recorded', agent: 'researcher', status: 'succeeded', t: '0s' },
    { id: 'a2', kind: 'agent', name: 'Spec Reviewer', sub: 'reviewer · via handoff',
      cap: 'recorded', agent: 'reviewer', status: 'succeeded', t: '11s' }
  ],
  reasoning: [
    { id: 'r1', kind: 'reasoning', name: 'plan · 4 steps', sub: 'researcher · turn 1',
      cap: 'recorded', agent: 'researcher', status: 'succeeded', t: '2s' },
    { id: 'r2', kind: 'reasoning', name: 'thought', sub: 'reviewer · turn 2',
      cap: 'recorded', agent: 'reviewer', status: 'succeeded', t: '14s' },
    { id: 'r3', kind: 'reasoning', name: 'rationale summary', sub: 'grouped from plan + thought',
      cap: 'derived', agent: 'researcher', status: 'succeeded', t: '2s' }
  ],
  skills: [],
  tools: [
    { id: 't1', kind: 'tool', name: 'Notion', sub: 'workspace.search · success', order: 1,
      cap: 'recorded', agent: 'researcher', status: 'succeeded', t: '2.1s',
      detail: { dur: '0.8s', out: '3 pages matched · titles only in graph; page content opens on demand' } },
    { id: 't2', kind: 'tool', name: 'Team Bus: handoff', sub: 'team_bus · accepted', order: 4,
      cap: 'recorded', agent: 'researcher', status: 'succeeded', t: '9.6s',
      rationale: 'Enough corroborating evidence; hand off a concise packet for review.' },
    { id: 't3', kind: 'tool', name: 'read_file', sub: 'read · success', order: 5,
      cap: 'recorded', agent: 'reviewer', status: 'succeeded', t: '12.2s' },
    { id: 't4', kind: 'tool', name: 'harness tool', sub: 'opaque',
      cap: 'unavailable', why: 'Harness did not pair this call',
      agent: 'reviewer', status: 'failed', t: '15s' }
  ],
  commands: [
    { id: 'c1', kind: 'command', name: 'cargo test -p loomwatchd', sub: 'exit 0 · 12.4s',
      cap: 'recorded', agent: 'reviewer', status: 'succeeded', order: 6, t: '16.0s',
      detail: { exit: '0', dur: '12.4s',
        out: 'running 48 tests\n............\ntest result: ok. 48 passed; 0 failed' } },
    { id: 'c2', kind: 'command', name: 'git rev-parse HEAD', sub: 'exit 0 · 0.1s',
      cap: 'derived', agent: 'reviewer', status: 'succeeded', order: 5, t: '12.3s',
      detail: { exit: '0', dur: '0.1s', out: 'cb54846d1f…' } }
  ],
  sources: [
    { id: 's1', kind: 'source', name: 'Launch brief', sub: 'knowledge search · Notion', order: 2,
      cap: 'recorded', agent: 'researcher', status: 'succeeded', t: '4.8s', cite: true },
    { id: 's2', kind: 'source', name: 'github.com/acme/loomwatch', sub: 'repository · main@cb54846', order: 3,
      cap: 'recorded', agent: 'researcher', status: 'succeeded', t: '7.4s', cite: true },
    { id: 's4', kind: 'source', name: 'docs/LAUNCH.md', sub: 'file · lines 42–68', order: 5,
      cap: 'recorded', agent: 'reviewer', status: 'succeeded', t: '12.2s' },
    { id: 's5', kind: 'source', name: 'docs.example.com/release', sub: 'external source · cited', order: 3,
      cap: 'recorded', agent: 'researcher', status: 'succeeded', t: '8.1s', cite: true },
    { id: 's3', kind: 'source', name: 'internal reference', sub: 'web · reference withheld',
      cap: 'redacted', agent: 'reviewer', status: 'succeeded', t: '15s' }
  ]
};

/* These are projected from ordered activity events. They do not exist in the
   saved team file: each one materializes beside, and is edged from, the agent
   that produced it. The first event is the board's concrete Agent A → Notion
   example; the rest prove parity for search, repository/file, command, source. */
const LIVE_ACTIVITY = [
  { id: 'la1', kind: 'tool', name: 'Notion', sub: 'workspace.search', agent: 'researcher', owner: 'Agent A', order: 1, t: '02.1s', x: 410, y: 118, live: 'running' },
  { id: 'la2', kind: 'source', name: 'Launch brief', sub: 'knowledge search', agent: 'researcher', owner: 'Agent A', order: 2, t: '04.8s', x: 610, y: 118, live: 'running' },
  { id: 'la3', kind: 'source', name: 'acme/loomwatch', sub: 'repository · main', agent: 'researcher', owner: 'Agent A', order: 3, t: '07.4s', x: 410, y: 202, live: 'running' },
  { id: 'la4', kind: 'source', name: 'docs.example.com', sub: 'external source · cited', agent: 'researcher', owner: 'Agent A', order: 4, t: '08.1s', x: 610, y: 202, live: 'running' },
  { id: 'la5', kind: 'source', name: 'docs/LAUNCH.md', sub: 'file · lines 42–68', agent: 'reviewer', owner: 'Agent B', order: 5, t: '12.2s', x: 410, y: 548, live: 'running' },
  { id: 'la6', kind: 'command', name: 'cargo test …', sub: 'sanitized command', agent: 'reviewer', owner: 'Agent B', order: 6, t: '16.0s', x: 610, y: 548, live: 'running' }
];
const EDGE_OF_CAT = {
  agents: 'participated', reasoning: 'reasoned_with', skills: 'used_skill',
  tools: 'invoked_tool', commands: 'ran_command', sources: 'consulted_source'
};
const COVER = {
  agents: 'complete', reasoning: 'partial', skills: 'unavailable',
  tools: 'partial', commands: 'partial', sources: 'partial'
};

/* prior runs, so a finished run can be reopened in replay (addendum §2) */
const HISTORY = [
  { goal: 'Use Notion to find the launch brief, verify it against the repository, and cite the external source.', phase: 'succeeded', when: '2m ago' },
  { goal: 'Review the ACP spine and report anything the schema cannot express.', phase: 'partial', when: '1h ago' },
  { goal: 'Draft the release notes for phase 03.', phase: 'cancelled', when: 'yesterday' }
];

const TERMINAL = ['succeeded', 'partial', 'failed', 'cancelled'];
const isTerminal = () => TERMINAL.includes(run.phase);
const clearTimers = () => { run.timers.forEach(clearTimeout); run.timers = []; };
const later = (ms, fn) => run.timers.push(setTimeout(fn, ms));

function filtered(cat) {
  return (TRACE[cat] || []).filter((e) =>
    (FILTERS.agent === 'all' || e.agent === FILTERS.agent) &&
    (FILTERS.status === 'all' || e.status === FILTERS.status) &&
    (FILTERS.time === 'all' || parseFloat(e.t) <= 10));
}

function agentExecutionNodes() {
  const baseA = { ...AGENTS.n1, x: 90, y: 180, step: 1 };
  const baseB = { ...AGENTS.n2, x: 90, y: 440, step: 2 };
  if (run.phase === 'idle') return [
    { ...baseA, status: 'idle', taskState: 'READY', task: 'Awaiting a task' },
    { ...baseB, status: 'idle', taskState: 'READY', task: 'Awaiting a task' }
  ];
  if (run.phase === 'queued') return [
    { ...baseA, status: 'idle', taskState: 'QUEUED', task: 'Collect workspace evidence' },
    { ...baseB, status: 'idle', taskState: 'QUEUED', task: 'Review evidence bundle' }
  ];
  if (run.phase === 'starting') return [
    { ...baseA, status: 'starting', taskState: 'STARTING', task: 'Connect to Notion' },
    { ...baseB, status: 'idle', taskState: 'QUEUED', task: 'Review evidence bundle' }
  ];
  if (run.phase === 'running') return [
    run.eventCount >= 5
      ? { ...baseA, status: 'succeeded', taskState: 'DONE', task: 'Evidence packet handed off' }
      : { ...baseA, status: 'running', taskState: run.eventCount >= 2 ? 'STREAMING' : 'RUNNING', task: run.eventCount ? 'Search launch evidence' : 'Call Notion workspace' },
    run.eventCount >= 5
      ? { ...baseB, status: 'running', taskState: 'RUNNING', task: 'Validate repository findings' }
      : { ...baseB, status: 'waiting', taskState: 'QUEUED', task: 'Waiting for Agent A handoff' }
  ];
  if (run.phase === 'partial' || run.phase === 'failed') return [
    { ...baseA, status: 'succeeded', taskState: 'DONE', task: 'Evidence packet handed off' },
    { ...baseB, status: 'failed', taskState: 'ERROR', task: 'Validation stopped at test failure' }
  ];
  if (run.phase === 'cancelled') return [
    { ...baseA, status: 'stopped', taskState: 'CANCELLED', task: 'Evidence collection stopped' },
    { ...baseB, status: 'stopped', taskState: 'CANCELLED', task: 'Review never completed' }
  ];
  return [
    { ...baseA, status: 'succeeded', taskState: 'DONE', task: 'Evidence packet handed off' },
    { ...baseB, status: 'succeeded', taskState: 'DONE', task: 'Validation report completed' }
  ];
}

function renderAgentExecution() {
  const host = $('#nodes');
  if (!host) return;
  host.innerHTML = agentExecutionNodes().map((n) => nodeHTML(n)).join('');
  host.querySelectorAll('[data-node]').forEach((el) =>
    el.addEventListener('click', () => selectNode(el.dataset.node)));
}

const agentOrigin = (agent) => agent === 'reviewer' ? { x: 366, y: 502 } : { x: 366, y: 242 };
const ownerLabel = (agent) => agent === 'reviewer' ? 'Agent B' : 'Agent A';

/* ---------------------------------------------------------------------------
   SUBMIT — one start key held for the life of the attempt; re-pressing while
   a start is in flight is a no-op, not a second run (ADR 0005 §8).
   --------------------------------------------------------------------------- */
function submitRun(goalText) {
  if (!isTerminal() && run.phase !== 'idle') return;
  clearTimers();
  run.goal = (goalText || $('#compInput').value || '').trim();
  if (!run.goal) return;
  Object.assign(run, { phase: 'queued', mode: 'live', chars: 0,
                       selected: false, open: null, openEnt: null, gap: false, eventCount: 0 });
  paintRun();
  later(700, () => { run.phase = 'starting'; paintRun(); });
  later(1500, () => { run.phase = 'running'; paintRun(); stream(); });
  [1950, 2450, 3050, 3550, 4200, 4850].forEach((ms, i) => later(ms, () => {
    if (run.phase !== 'running') return;
    run.eventCount = i + 1;
    paintRun();
  }));
}

function stream() {
  const total = ANSWER_TEXT.length;
  const tick = () => {
    if (run.phase !== 'running') return;
    run.chars = Math.min(total, run.chars + 12);
    paintRun();
    if (run.chars < total) later(state.motion ? 120 : 1, tick);
    else later(500, () => { if (run.phase === 'running') { run.phase = 'succeeded'; run.eventCount = LIVE_ACTIVITY.length; paintRun(); } });
  };
  tick();
}

function retryRun() { const g = run.goal; clearTimers(); run.phase = 'idle'; submitRun(g); }

/* GATED — see TNG89_INTERACTION.md §8.1 and the escalation on TNG-87.
   Cancellation is outside RUN_PROVENANCE_CONTRACT §3.2 and ARCHITECTURE §6
   defers writes to running execution. Rendered so the board can rule on
   something concrete; it is not approved by default. */
function stopRun() {
  if (isTerminal()) return;
  clearTimers();
  run.phase = 'cancelled';
  paintRun();
}

function focusResponse() { requestAnimationFrame(() => { const el = $('.rt-response'); if (el) el.focus(); }); }
function selectResponse() { if (isTerminal()) { run.selected = !run.selected; paintRun(); focusResponse(); } }
function toggleCat(c) { run.open = run.open === c ? null : c; run.openEnt = null; paintRun(); }
function toggleEnt(id) { run.openEnt = run.openEnt === id ? null : id; paintRun(); }
function backToResponse() { run.open = null; run.openEnt = null; run.selected = false; paintRun(); focusResponse(); }
function loadReplay(i) {
  clearTimers(); closePops();
  const h = HISTORY[i];
  Object.assign(run, { phase: h.phase, mode: 'replay', goal: h.goal,
    chars: ANSWER_TEXT.length, selected: true, open: null, openEnt: null, gap: false,
    eventCount: LIVE_ACTIVITY.length });
  paintRun();
}

const ANSWER_TEXT = 'The Notion launch brief and repository agree on the September release scope. Agent A found the brief, repository, and external release source; Agent B checked docs/LAUNCH.md and ran the sanitized validation command. The final result cites each source and preserves the handoff and execution evidence without exposing hidden reasoning.';

/* ---------------------------------------------------------------------------
   PAINT — one function derives the whole workspace from `run`, so no two
   screens can disagree about what a phase looks like.
   --------------------------------------------------------------------------- */
const RPHASE = {
  queued:    { s: 'idle',      text: 'Queued — waiting for a supervisor.' },
  starting:  { s: 'starting',  text: 'Starting researcher…' },
  running:   { s: 'running',   text: 'Running — 2 agents.' },
  succeeded: { s: 'succeeded', text: 'Answered in 48s.' },
  partial:   { s: 'failed',    text: 'Partial answer.' },
  failed:    { s: 'failed',    text: 'Run failed.' },
  cancelled: { s: 'stopped',   text: 'Cancelled — partial answer kept.' }
};

function lifecycleForRun() {
  const task = run.phase === 'idle' ? 'ready'
    : run.phase === 'queued' ? 'queued'
    : run.phase === 'starting' ? 'starting'
    : run.phase === 'running' ? (run.eventCount >= 2 ? 'streaming' : 'running')
    : run.phase === 'succeeded' ? 'done'
    : run.phase === 'partial' || run.phase === 'failed' ? 'error'
    : 'cancelled';
  const result = run.phase === 'queued' || run.phase === 'starting' ? 'not started'
    : run.phase === 'running' ? 'streaming'
    : run.phase === 'succeeded' ? 'done'
    : run.phase;
  return { task, result };
}

function activityCard(e, newest) {
  const status = newest && run.phase === 'running' ? e.live : 'succeeded';
  const text = status === 'running' ? 'RUNNING' : 'SUCCEEDED';
  return `<div class="activity-ent st-${status}" style="--x:${e.x}px;--y:${e.y}px"
      role="button" tabindex="0" aria-label="${e.owner} ${text.toLowerCase()} ${e.kind} ${e.name}, event ${e.order}, ${e.t}">
    <span class="ae-order t-micro">#${String(e.order).padStart(2, '0')} · ${e.t}</span>
    <span class="ae-main t-body-m">${entGlyph(e.kind, 13)} ${e.name}</span>
    <span class="ae-sub t-meta">${statusSVG(status)} ${text} · ${e.owner} · ${e.sub}</span>
  </div>`;
}

function entCard(e, x, y, open) {
  const c = CAPTURE[e.cap];
  const d = e.detail;
  return `<button class="ent cap-${e.cap} ${open ? 'open' : ''}" style="--x:${x}px;--y:${y}px"
      onclick="toggleEnt('${e.id}')" aria-expanded="${!!open}"
      aria-label="${e.kind}: ${e.name}, ${c.word}${e.why ? ', ' + e.why : ''}">
    <span class="e-top t-body-m">${entGlyph(e.kind, 13)}
      <span class="e-name" style="min-width:0;overflow:hidden;white-space:nowrap">${e.name}</span></span>
    <span class="e-sub t-mono-sm">${e.sub}</span>
    <span class="e-own t-micro">${ownerLabel(e.agent)} · #${String(e.order || 0).padStart(2, '0')} · ${e.t} · ${e.status}</span>
    <span class="e-cap t-micro"><span class="dotfill">${c.glyph}</span> ${c.word}</span>
    ${e.why ? `<span class="e-sub t-meta">${e.why}</span>` : ''}
    ${open && e.rationale ? `<span class="ent-detail t-meta"><span class="kv"><b>rationale</b> ${e.rationale}</span></span>` : ''}
    ${open && d ? `<span class="ent-detail t-mono-sm">
        <span class="kv">${d.exit == null ? '' : `<b>exit</b> ${d.exit}`}<b style="margin-left:8px">took</b> ${d.dur}</span>
        <span class="ent-out">${d.out}</span></span>` : ''}
    ${open && e.cite ? `<span class="ent-detail t-meta">
        <span class="kv"><b>citation</b> <span class="cite">§4.2 initialize</span></span></span>` : ''}
    ${open && e.cap === 'redacted' ? `<span class="ent-detail t-meta">
        <span class="kv">Reference withheld by policy. No reveal is offered.</span></span>` : ''}
  </button>`;
}

function paintRun() {
  const ov = $('#overlay'), pe = $('#provGroup');
  if (!ov || !stage.classList.contains('workspace')) return;
  let h = '', ed = '';
  const live = run.mode === 'live';
  renderAgentExecution();

  /* composer reflects the phase; Stop is gated, Retry is not */
  const busy = !isTerminal() && run.phase !== 'idle';
  $('#compInput').value = busy || isTerminal() ? '' : $('#compInput').value;
  $('#compInput').placeholder = busy ? 'A run is in flight…' : 'What should the team do?';
  $('#compAct').innerHTML =
    (busy
      ? `<button class="btn" disabled>${run.phase === 'queued' ? 'Queued…' : run.phase === 'starting' ? 'Starting…' : 'Running…'}</button>
         <button class="btn btn-danger gated" onclick="stopRun()" title="Cancellation is outside RUN_PROVENANCE_CONTRACT §3.2 — awaiting a board ruling">Stop</button>`
      : isTerminal()
        ? `<button class="btn" onclick="retryRun()">Retry ⌘↵</button>
           <button class="btn btn-primary" onclick="submitRun(prompt('New goal')||'')">New run</button>`
        : `<button class="btn btn-primary" onclick="submitRun()">Run &nbsp;⌘↵</button>`);
  $('#compNote').hidden = !busy && !isTerminal();
  if (busy || isTerminal()) {
    $('#compNote').className = 'comp-note t-meta';
    $('#compNote').innerHTML = isTerminal()
      ? 'Retry starts a new run from the same goal. The prompt and any partial answer are kept.'
      : 'Connection loss never starts, restarts or cancels a run.';
  }

  if (run.phase === 'idle') { ov.innerHTML = ''; pe.innerHTML = ''; return; }

  const life = lifecycleForRun();
  h += `<div class="life-strip e1" style="--x:812px;--y:56px" aria-label="Lifecycle summary">
    <span><b>Task · Agent A</b>${life.task}</span>
    <span><b>Run</b>${run.phase}</span>
    <span><b>Result</b>${life.result}</span>
    <span class="badge t-micro ${live ? 'badge-live' : 'badge-replay'}"><span class="pip"></span>${live ? 'Live' : 'Replay'}</span>
  </div>`;

  /* Goal — lands adjacent to its response (addendum §2) */
  h += `<div class="rt" style="--x:812px;--y:100px;width:400px">
    <div class="rt-head t-micro">${entGlyph('prompt')} Goal <span class="spacer"></span>
      <span class="t-meta" style="text-transform:none;letter-spacing:0">Reuse</span></div>
    <div class="rt-body t-body">${run.goal}</div></div>`;
  ed += `<path class="prov" d="M1012 200 L1012 232" marker-end="url(#mProv)"/>`;
  h += `<span class="prov-label t-micro" style="left:1012px;top:216px">initiated</span>`;

  /* Live activity is projected immediately from ordered events. Every card
     has a direct agent-owned edge; no response/category indirection is needed
     to answer who performed it. */
  if (!run.selected && run.eventCount) {
    LIVE_ACTIVITY.slice(0, run.eventCount).forEach((e, i) => {
      h += activityCard(e, i === run.eventCount - 1);
      const from = agentOrigin(e.agent);
      const ty = e.y + 34;
      ed += `<path class="prov prov-live" d="M${from.x} ${from.y} C ${from.x + 28} ${from.y} ${e.x - 28} ${ty} ${e.x} ${ty}" marker-end="url(#mLive)"/>`;
      const firstForAgent = i === 0 || LIVE_ACTIVITY[i - 1].agent !== e.agent;
      if (firstForAgent) h += `<span class="prov-label prov-live-label t-micro" style="left:${(from.x + e.x) / 2}px;top:${(from.y + ty) / 2}px">${e.owner} → ${e.name}</span>`;
    });
  }

  /* Response */
  const p = RPHASE[run.phase];
  const phaseText = run.phase === 'running'
    ? (run.eventCount >= 5 ? 'Running — Agent B active; Agent A done.' : 'Running — Agent A active; Agent B queued.')
    : p.text;
  const pre = run.phase === 'queued' || run.phase === 'starting';
  const shown = pre ? '' : ANSWER_TEXT.slice(0, run.chars);
  const compact = run.selected;
  h += `<div class="rt rt-response ${compact ? 'compact' : ''}" style="--x:812px;--y:232px;width:400px"
      ${isTerminal() ? 'onclick="selectResponse()" role="button" tabindex="0" style="cursor:pointer;--x:812px;--y:232px;width:400px"' : ''}>
    <div class="rr-head t-body-m">${statusSVG(p.s)} <span>${phaseText}</span>
      <span style="flex:1"></span>
      <span class="badge t-micro ${live ? 'badge-live' : 'badge-replay'}">
        <span class="pip"></span>${live ? 'Live' : 'Replay'}</span></div>
    <div class="rr-sub t-micro">Response · researcher
      ${isTerminal() ? `<span style="float:right;text-transform:none;letter-spacing:0"
        class="t-meta">${run.selected ? 'Hide provenance' : 'Show provenance'}</span>` : ''}</div>
    ${pre
      ? `<div class="rr-body"><div class="skel-bars">
           <i class="skel-bar" style="width:88%"></i><i class="skel-bar" style="width:96%"></i>
           <i class="skel-bar" style="width:64%"></i></div></div>`
      : `<div class="rr-body t-body">${shown}${run.phase === 'running' ? '<span class="caret"></span>' : ''}</div>`}
    ${run.phase === 'running' && live ? '<div class="rr-stream"></div>' : ''}
    ${run.gap ? `<div class="rt-strip halt t-meta">
        <span>Live events reconnecting — answer shown to</span><span class="wm">seq 1284</span></div>` : ''}
    ${run.phase === 'partial' ? `<div class="rt-strip alert t-meta">
        <span>⚠ reviewer crashed after 2 turns.</span><span class="wm">process_crashed</span></div>` : ''}
    ${run.phase === 'cancelled' ? `<div class="rt-strip halt t-meta gated">
        <span>Cancelled by the operator. Partial answer kept.</span><span class="wm">stopReason: cancelled</span></div>` : ''}
  </div>`;

  if (run.selected) {
    const respBottom = 232 + 210;
    const headY = respBottom + 30, rowY = [headY + 30, headY + 30, headY + 104, headY + 104, headY + 178, headY + 178];
    const gaps = CATS.filter((c) => COVER[c[0]] !== 'complete').map((c) => c[0]);
    h += `<div id="provHead" class="t-body-m" style="--x:812px;--y:${headY}px">
      ${covSVG('partial')} Partial capture
      <span class="gaps t-meta">— ${gaps.slice(0, 2).join(' and ')} incomplete</span></div>`;

    if (run.openEnt) {
      h += `<div class="t-body-m" style="position:absolute;left:812px;top:${headY + 34}px;
              display:flex;align-items:center;gap:8px;color:var(--color-ink-3)">
        <button class="link" onclick="backToResponse()">Response</button> ›
        <button class="link" onclick="toggleEnt(null)">${run.open}</button> ›
        <span style="color:var(--color-ink)">detail</span></div>`;
    }
    CATS.forEach(([name, kind], i) => {
      if (run.openEnt) return;
      if (!FILTERS.cats.has(name)) return;
      const list = filtered(name), cov = COVER[name];
      const x = CAT_POS[i][0], y = rowY[i], open = run.open === name;
      h += `<button class="rt-chip ${open ? 'open' : ''}" style="--x:${x}px;--y:${y}px"
          onclick="toggleCat('${name}')" aria-expanded="${open}"
          aria-label="${name}, ${list.length} entities, ${COVERAGE[cov].word}">
        <span class="c-top t-micro">${entGlyph(kind, 13)} ${name}
          <span class="n t-mono-sm">${list.length || '—'}</span></span>
        <span class="c-cov t-meta">${covSVG(cov)} ${COVERAGE[cov].word}</span></button>`;
      ed += `<path class="prov" d="M1012 ${respBottom} C 1012 ${y - 22} ${x + 95} ${y - 22} ${x + 95} ${y}" marker-end="url(#mProv)"/>`;
    });

    if (run.open) {
      const list = filtered(run.open);
      const entY = run.openEnt ? headY + 74 : rowY[5] + 100;
      /* the breadcrumb already states the relationship when an entity is open */
      if (!run.openEnt) h += `<span class="prov-label t-micro" style="left:1012px;top:${entY - 18}px">${EDGE_OF_CAT[run.open]}</span>`;
      if (!list.length) {
        h += `<div class="prov-empty t-meta" style="--x:812px;--y:${entY}px">
          <b class="t-body-m" style="color:var(--color-ink-2)">Nothing captured for ${run.open}.</b>
          <span>${run.open === 'skills'
            ? 'No skill-use adapter is installed. Presence of a skill in a prompt or on disk is not use, so LoomWatch will not claim it.'
            : 'No entity matched the current filter.'}</span></div>`;
      } else if (run.openEnt) {
        /* progressive disclosure: expanding one entity focuses it (addendum §5) */
        const e = list.find((x) => x.id === run.openEnt) || list[0];
        h += entCard(e, 812, entY, true);
        const from = agentOrigin(e.agent);
        ed += `<path class="prov" d="M${from.x} ${from.y} C 520 ${from.y} 700 ${entY + 30} 812 ${entY + 30}" marker-end="url(#mProv)"/>`;
        h += `<span class="prov-label t-micro" style="left:590px;top:${(from.y + entY + 30) / 2}px">${ownerLabel(e.agent)} · ${EDGE_OF_CAT[run.open]} · #${String(e.order || 0).padStart(2, '0')}</span>`;
        h += `<button class="btn" style="position:absolute;left:1012px;top:${entY}px"
                onclick="toggleEnt('${e.id}')">← all ${run.open}</button>`;
      } else {
        list.forEach((e, j) => {
          const ex = 812 + (j % 2) * 200, ey = entY + Math.floor(j / 2) * 112;
          h += entCard(e, ex, ey, false);
          const from = agentOrigin(e.agent);
          ed += `<path class="prov" d="M${from.x} ${from.y} C 540 ${from.y} 690 ${ey + 30} ${ex} ${ey + 30}" marker-end="url(#mProv)"/>`;
        });
      }
      h += `<button class="btn btn-back" style="--x:1230px;--y:${entY}px;position:absolute"
              onclick="backToResponse()">← Back to response</button>`;
    }

    /* filters — artifact type, agent, status, time (addendum §5) */
    h += `<div id="filters" class="e1" style="--x:1230px;--y:${headY - 6}px">
      <span class="t-micro" style="color:var(--color-ink-3)">Artifact type</span>
      ${CATS.map(([n]) => `<button class="filt t-meta ${FILTERS.cats.has(n) ? 'on' : ''}"
          onclick="toggleFilterCat('${n}')"><span class="bx"></span>${n}</button>`).join('')}
      <span class="fhead t-micro">Agent</span>
      <span class="seg">${['all', 'researcher', 'reviewer'].map((a) =>
        `<button class="${FILTERS.agent === a ? 'on' : ''}" onclick="setFilter('agent','${a}')">${a === 'all' ? 'All' : a.slice(0, 8)}</button>`).join('')}</span>
      <span class="fhead t-micro">Status</span>
      <span class="seg">${['all', 'succeeded', 'failed'].map((a) =>
        `<button class="${FILTERS.status === a ? 'on' : ''}" onclick="setFilter('status','${a}')">${a === 'all' ? 'All' : a === 'succeeded' ? 'OK' : 'Failed'}</button>`).join('')}</span>
      <span class="fhead t-micro">Time</span>
      <span class="seg">${['all', 'first10'].map((a) =>
        `<button class="${FILTERS.time === a ? 'on' : ''}" onclick="setFilter('time','${a}')">${a === 'all' ? 'Whole run' : 'First 10s'}</button>`).join('')}</span>
      <span class="pop-sep" style="margin:6px 0"></span>
      <span class="t-meta" style="color:var(--color-ink-3)">Filters are view state. They never re-run the projector.</span>
    </div>`;
  }

  ov.innerHTML = h;
  pe.innerHTML = ed;
  ov.querySelectorAll('.ent .e-name').forEach(middleTruncate);
}
function toggleFilterCat(n) {
  FILTERS.cats.has(n) ? FILTERS.cats.delete(n) : FILTERS.cats.add(n);
  if (run.open && !FILTERS.cats.has(run.open)) run.open = null;
  paintRun();
}
function setFilter(k, v) { FILTERS[k] = v; run.openEnt = null; paintRun(); }
function openHistory() { closePops(); $('#history').hidden = false; }

/* run history rows — selecting one loads a replay, never re-executes */
if ($('#historyList')) {
  $('#historyList').innerHTML = HISTORY.map((h, i) =>
    `<button class="pop-row" onclick="loadReplay(${i})">
       ${statusSVG(RPHASE[h.phase].s)}
       <span class="goal t-body">${h.goal}</span>
       <span class="when t-meta">${h.when}</span>
     </button>`).join('');
}

/* the workspace is one screen with seeded entry points, so the reviewer can
   jump straight to a state and still drive it from there */
const SEEDS = {
  compose:  () => Object.assign(run, { phase: 'idle', mode: 'live', goal: '', chars: 0,
                                       selected: false, open: null, openEnt: null, gap: false, eventCount: 0 }),
  running:  () => { Object.assign(run, { phase: 'running', mode: 'live', goal: HISTORY[0].goal,
                                         chars: 210, selected: false, open: null, openEnt: null, gap: true, eventCount: 2 }); },
  answered: () => Object.assign(run, { phase: 'partial', mode: 'live', goal: HISTORY[1].goal,
                                       chars: ANSWER_TEXT.length, selected: true, open: null,
                                       openEnt: null, gap: false, eventCount: LIVE_ACTIVITY.length }),
  trace:    () => Object.assign(run, { phase: 'succeeded', mode: 'live', goal: HISTORY[0].goal,
                                       chars: ANSWER_TEXT.length, selected: true, open: 'commands',
                                       openEnt: 'c1', gap: false, eventCount: LIVE_ACTIVITY.length })
};

/* ===========================================================================
   SCREENS
   =========================================================================== */
const CANVAS_PARTS = ['library', 'chip', 'modepill', 'viewctl', 'legend', 'edges', 'edgeLabels', 'nodes'];
const ALL = [...CANVAS_PARTS, 'inspector', 'firstrun', 'states', 'system',
             'switcherPop', 'palette', 'problemsPop',
             'composer', 'overlay', 'provEdges', 'history'];
/* On run screens the mode pill is absorbed into the composer (TNG89 §1), so
   `modepill` is deliberately absent from this list. */
const RUN_PARTS = ['library', 'chip', 'viewctl', 'legend', 'edges', 'edgeLabels',
                   'nodes', 'composer', 'overlay', 'provEdges'];

const SCREENS = {
  'first-run': {
    label: 'First run', show: ['firstrun'],
    notes: `<h3>First run — §10.1</h3>
      <p>One centred composition, one action. No wizard, no tour, no sample gallery, no checklist.</p>
      <h4>Decisions</h4><ul>
      <li><b>The serif appears here and nowhere else.</b> <code>display</code> at 34 px is the reason a third font file is worth shipping — and confining it to two strings is what keeps it from looking like a template.</li>
      <li><b>“or open an existing team” opens the §9.1 switcher</b> anchored to the link. In v1 it was a link with nowhere to go, which meant the operator's own files were unreachable on the very first screen.</li>
      <li><b>The theme toggle is present even here</b> (bottom-right, beside the ⌘K hint). A toggle you cannot find until you have opened a file is not discoverable.</li>
      <li><b>Bottom-left carries the one line that matters:</b> <code>3 harnesses ready</code> — or <code>No agent harnesses found</code>, clickable to the search-path disclosure. That is the most likely first-run failure and it must name its own cause.</li>
      <li>Entrance: mark fades and scales 0.96 → 1 over <code>entrance</code>; headline, subhead and button follow at 60 ms stagger. Nothing translates more than 8 px.</li></ul>`
  },
  'canvas': {
    label: 'Canvas', show: CANVAS_PARTS, graph: 'pipeline', chip: 'dirty',
    notes: `<h3>Canvas · pipeline mode — §3, §5, §6, §9</h3>
      <p>One full-bleed canvas, five floating <code>e1</code> elements, 20 px inset. No status bar, no breadcrumb, no toolbar, no menu bar, no tab bar. Everything else is ⌘K.</p>
      <h4>Try it</h4><ul>
      <li><kbd>⌘S</kbd> — the ledger sweep (§9.1a). Gold line lays left → right across the chip, then resolves to <code>ok</code>.</li>
      <li><kbd>L</kbd> — cycle edge-layer solo: both → configured → observed → both.</li>
      <li>Click a node — the inspector opens.</li>
      <li><kbd>⌘\\</kbd> collapse the library · <kbd>⌘K</kbd> palette · <kbd>⌘⇧L</kbd> theme</li></ul>
      <h4>The two edge layers — ARCHITECTURE §5</h4><ul>
      <li><b>Configured (warp)</b>: quiet grey solid 1.5 px, filled arrowhead, static. Structure.</li>
      <li><b>Observed (weft)</b>: gold, dashed, travelling. Activity.</li>
      <li><b>Where they coincide, no second line is drawn</b> — the configured edge gains a 24 px gold shuttle per event and holds a <code>×3</code> count badge. Two lines on one path is noise, not information.</li>
      <li><b>The consequence worth noticing:</b> in pipeline mode a coincident observed edge becomes a shuttle and a non-coincident one is by definition an anomaly (§6.8). So the full gold weft vocabulary lives in <i>team</i> mode — see the next screen. The <code>⚠ 1</code> on the mode pill is the anomaly count, because an anomaly is a statement about the <i>design</i>.</li></ul>
      <h4>File is the truth — §9.1</h4><ul>
      <li><code>3 lines differ</code>, not “Unsaved changes”. A state tells you nothing; a magnitude decides whether you save or look first — and a line in a diff is the honest unit for a version-controlled file.</li>
      <li>No autosave, no save-on-blur, no debounce-write. ⌘S from anywhere.</li></ul>`
  },
  'inspector': {
    label: 'Inspector', show: [...CANVAS_PARTS, 'inspector'], graph: 'pipeline',
    chip: 'dirty', select: 'n1',
    notes: `<h3>Inspector — §5.4</h3>
      <p>Inspector, not inline, with two deliberate exceptions: name and role by double-click or <kbd>Enter</kbd>. <kbd>Esc</kbd> reverts, blur commits.</p>
      <h4>Three zones, in the order the operator thinks</h4><ul>
      <li><b>IDENTITY</b> — <code>role</code> and <code>model</code>, above the fold, because these are the two fields a freshly dropped node is deliberately missing (§4.5) and they are what stands between a drop and a valid save.</li>
      <li><b>BEHAVIOUR</b> — entrypoint, recruiting, budget. What the agent is <i>allowed</i> to do.</li>
      <li><b>PROCESS</b> — <code>spawn.cmd/args/cwd/env</code>, collapsed. Renamed from SPAWN because “process” is what it means to someone who has not read the ACP spec; the field labels inside stay the schema's own names.</li></ul>
      <h4>Decisions</h4><ul>
      <li><b>A status line under the id</b>, so the inspector answers “what is this doing” without the operator going back to the node they just covered with the inspector. In phase 04 it always reads <code>idle</code>.</li>
      <li><b>Two validation weights, never both:</b> incomplete → <code>accent</code> border + <code>Required</code>; error → <code>alert</code> border + the rule. A field never turns red while being typed in — only on blur or ⌘S.</li>
      <li>No Apply button. Every edit is immediate in memory; the disk write is ⌘S and only ⌘S.</li></ul>`
  },
  'team': {
    label: 'Team + live', show: CANVAS_PARTS, graph: 'team', chip: 'clean',
    notes: `<h3>Canvas · team mode, live — CANVAS_SPEC §8.2, §13</h3>
      <p><code>edges: []</code> → team mode. Mode is a <b>consequence of the file</b>, never a toggle the operator flips; the pill reports, it does not control.</p>
      <h4>The weft in full voice</h4><ul>
      <li><code>dispatch</code> — 1.5 px dash <code>6 4</code>, open arrowhead, travelling.</li>
      <li><code>ask</code> — dash <code>2 3</code>, arrowheads <b>both ends</b>, alternating travel. Unmistakable at any zoom.</li>
      <li><code>handoff</code> — 2.5 px dash <code>10 4</code>, double chevron, one pass on arrival then static.</li>
      <li><code>aged</code> — the n2 → n4 edge has dropped to <code>accent-dim</code>: the weft fades over 4 s after its last event, so the live frontier of the graph is the brightest thing on screen without anything being highlighted.</li>
      <li>Separated by dash pattern, stroke weight and marker — not by three shades of gold. v1's three violets a step apart were never legible at canvas zoom.</li></ul>
      <h4>Decisions</h4><ul>
      <li><b>Handles are dormant</b> (25%) in team mode — visible enough to discover, quiet enough not to suggest the graph is unfinished. No step numbers, because no rank order is implied.</li>
      <li><b>The legend is conditional chrome</b> — it exists only while ≥1 observed edge does. On a phase-04 canvas with no run it is simply not there. Click a row to solo that layer; <kbd>L</kbd> cycles. Solo is view state: it never dirties the document and resets on load.</li>
      <li>Nothing is anomalous in team mode — there is no configured graph to deviate from, so every observed edge is gold.</li>
      <li>Observed edges are runtime data and are <b>never written to the team file</b>.</li></ul>`
  },
  'switcher': {
    label: 'Switcher', show: [...CANVAS_PARTS, 'switcherPop'], graph: 'pipeline',
    chip: 'dirty',
    notes: `<h3>Document switcher — §9.1</h3>
      <p>The canvas is a visual editor over version-controlled YAML on disk (ARCHITECTURE §5). v1 expressed that with a grey “Unsaved changes” label. v2 makes the file a first-class object you can <b>see, switch and write</b>.</p>
      <h4>Decisions</h4><ul>
      <li><b>Needs no new endpoint.</b> The list is <code>GET /api/teams</code> → <code>{root, files}</code>, already shipped in TNG-74. The UI forms <code>{root}/{file}</code> and navigates by <code>?path=</code>, which is exactly what <code>GET /api/team</code> already takes.</li>
      <li><b>Switching a dirty document asks inline on the row</b> — <i>Save first? / Discard / Cancel</i> — and never silently drops work. No modal.</li>
      <li><b>“Saves keep your comments and key order.”</b> <code>TeamFileModel</code> is CST-preserving and <code>PUT /api/team</code> writes verbatim bytes, so the reformat warning modal from v1 is withdrawn entirely. <code>Show YAML</code> is the checkable version of the claim.</li>
      <li><b>Copy path, not Reveal in Finder</b> — a browser cannot do the latter, and an affordance that lies is worse than one that is honest about its limits (§15.6).</li></ul>`
  },
  'palette': {
    label: 'Palette', show: [...CANVAS_PARTS, 'palette'], graph: 'pipeline',
    chip: 'dirty',
    notes: `<h3>Command palette — §11</h3>
      <p>⌘K is the menu. 560 px, <code>e2</code>, centred at 22% from the top, a filter field and a flat <b>ungrouped</b> ranked list.</p>
      <h4>Decisions</h4><ul>
      <li><b>Ungrouped on purpose.</b> Ranking beats taxonomy in a palette the operator types into; groups only pay off when you browse, and nobody browses ⌘K.</li>
      <li><b>The palette absorbs chrome rather than growing it.</b> <code>Toggle minimap</code> moved here out of permanent chrome so the view-control cluster could take the theme toggle without passing 168 px. A minimap that is off by default does not deserve resident pixels; a theme toggle does.</li>
      <li><b>Follow system appearance</b> is the third theme state and lives only here, because the toggle itself is binary. It shows as a hairline dot under the toggle glyph.</li>
      <li>Every primary flow — create, open, add, connect, fix, save, switch theme — is reachable without a pointer. That is the condition on adding any new flow.</li></ul>`
  },
  'problems': {
    label: 'Validation', show: [...CANVAS_PARTS, 'problemsPop'], graph: 'problems',
    chip: 'invalid',
    notes: `<h3>Validation — §9.2</h3>
      <p>Validate against the daemon's <code>GET /api/config/schema</code>, then the TEAM_CONFIG.md semantic rules. <code>PUT</code> re-validates server-side, so client validation is a courtesy that explains the problem next to the field instead of after a round-trip. The schema is <b>fetched, never bundled</b> — a bundled copy is a second source of truth that drifts from the daemon that will reject the save.</p>
      <h4>Decisions</h4><ul>
      <li><b>Two weights, separated.</b> <code>1 thing to finish</code> (<code>accent</code>) above <code>2 problems</code> (<code>alert</code>). Incomplete is “not done yet”; invalid is “wrong”. Collapsing them into one red list makes a fresh drop look like a bug.</li>
      <li><b>The blocked Save says which.</b> Hover gives the first problem verbatim plus <code>and n more</code>, never a generic “document is invalid”.</li>
      <li><b><kbd>F8</kbd> / <kbd>⇧F8</kbd> cycles problems</b> — selects, centres and focuses the offending field. The gap in v1 was that the save was blocked and the only route to the cause was to guess which node.</li>
      <li><b>On the node:</b> incomplete and invalid differ in hue <i>and</i> dot, and the border is reserved for validity — status never touches it.</li></ul>
      <h4>Prototype delta to §5.2</h4><ul>
      <li>The validity dot was specified at the node's top-left, which <b>collides with the pipeline step badge</b> in the same corner. Moved to the top-right outside corner. Flagged for the engineer — see the README.</li></ul>`
  },
  'compose': {
    seed: 'compose',
    label: 'Composer', show: RUN_PARTS, graph: 'run', chip: 'dirty',
    composer: 'notion', libCollapsed: true,
    notes: `<h3>Prompt composer \u2014 TNG89 \u00a71</h3>
      <p>720 \u00d7 56, bottom-centre. It <b>absorbs the mode pill</b>: the pill explains how the document will execute (<code>CANVAS_SPEC \u00a78.1</code>), and that fact is worth most at the moment you execute it. This spends the 36 px run slot <code>\u00a714</code> reserved.</p>
      <h4>Decisions</h4><ul>
      <li><b><kbd>\u2318\u21b5</kbd> submits; <kbd>\u21b5</kbd> inserts a newline.</b> Goals are prose and often multi-line \u2014 Enter-to-submit would truncate thoughts mid-sentence. The button prints its own shortcut, because <kbd>\u21b5</kbd> not submitting is a surprise and the label is where that surprise gets pre-empted.</li>
      <li><b>The dirty document is where the immutable revision becomes visible.</b> A run executes an exact snapshot of team-file bytes (<code>ADR 0005 \u00a71</code>), so the button becomes <b>Save & run</b> and says which file it will write. There is <b>no \u201crun without saving\u201d</b> \u2014 it would mean running either stale or unreviewed bytes, and both break the reviewability the snapshot exists for.</li>
      <li><b>Preflight catches the contract\u2019s 422 client-side</b>: a pipeline run needs exactly one final agent (<code>CONTRACT \u00a74</code>). The composer names the offenders and offers <i>Show on canvas</i> rather than letting the daemon reject it after a round-trip. The daemon stays the authority.</li>
      <li><b>A typed goal is never lost.</b> On a revision conflict no run is created, the <code>\u00a79.3</code> conflict bar takes over, and the prompt text is preserved. Losing a typed goal to a file race would be unforgivable.</li>
      <li><b>No model picker, no agent selector, no attachments.</b> The team file is the configuration; anything else here would be a second, invisible source of run config competing with the file.</li></ul>
      <h4>Not here, deliberately</h4><ul>
      <li><b>No Stop.</b> <code>CONTRACT \u00a73.2</code> puts pause, resume, steering and cancellation outside the contract, and <code>ARCHITECTURE \u00a76</code> defers writes to running execution. Start-only. A stop would be an \u00a76 amendment plus a contract change, not a button.</li></ul>`
  },
  'running': {
    seed: 'running',
    label: 'Live response', show: RUN_PARTS, graph: 'runLive', chip: 'clean',
    composer: 'empty', libCollapsed: true,
    overlay: { goal: true, response: 'running', eventsGap: true },
    notes: `<h3>Live response landing \u2014 TNG89 \u00a70, \u00a72, \u00a73</h3>
      <p><b>The one idea.</b> The canvas already split structure from activity in its edges. Now the same law extends to nodes: <b>if it is filled and bordered it is in the file; if it is tinted and ringed it came from a run.</b> That is how the operator can trust that a run never touched their YAML without reading the file \u2014 and TNG-89E/F both require exactly that.</p>
      <h4>Decisions</h4><ul>
      <li><b>Agent nodes now name their current task.</b> Running/streaming owns a breathing blue perimeter plus a visible word; reduced motion keeps a static 2 px blue border. Done/error/cancelled/offline use semantic colour, glyph, word, and task title.</li>
      <li><b>Agent A → Notion is projected, not pre-authored.</b> Submitting the example reveals Notion first, then search, repository, external source, Agent B file activity, and Agent B command activity in event order. Every node shows owner, ordinal, time, and status; every edge originates at the performing agent.</li>
      <li><b>The overlay is a column to the right of the configuration bounding box</b>, laid out as a pure function of (bbox, entity IDs). Entity IDs are deterministic within a run (<code>CONTRACT \u00a78.1</code>), so a replayed run renders the same picture as the live one. The configuration nodes do not move.</li>
      <li><b>The Goal animates from the composer into the canvas.</b> That single 240 ms transition is what makes a goal feel <i>placed</i> rather than sent into a void.</li>
      <li><b>The Response is the one runtime node that is opaque.</b> It is the thing being read, and <code>e2</code>\u2019s law forbids tinting text the operator reads carefully.</li>
      <li><b><code>Response \u00b7 researcher</code> names the canonical responder.</b> Other agents\u2019 messages are evidence only and are never concatenated into the answer (<code>CONTRACT \u00a74</code>). Naming the responder is how the operator tells the answer from the chatter.</li>
      <li><b>The travelling underline means \u201cstill being written\u201d</b> \u2014 same visual family as the chip\u2019s ledger sweep, one meaning apart.</li></ul>
      <h4>The subtlest requirement in the whole feature</h4><ul>
      <li><b>Reconnecting is a transport state, not a run state.</b> <code>CONTRACT \u00a73.2</code> is explicit, and pause/cancel must never be inferred from connection closure. So reconnection never touches the run indicator \u2014 the run keeps whatever it last reported. This is the difference between \u201cyour network blipped\u201d and \u201cyour run died\u201d, and it is the easiest thing here to get wrong.</li>
      <li><b>Two channels means two indicators.</b> <code>RunEvent.seq</code> carries exact evidence; the provenance <code>cursor</code> carries the redacted graph, and the UI must recover gaps on each independently. Both name the watermark they are complete to \u2014 \u201creconnecting\u201d without a watermark tells the operator nothing about what they are looking at.</li></ul>`
  },
  'answered': {
    seed: 'answered',
    label: 'Provenance', show: RUN_PARTS, graph: 'runDone', chip: 'clean',
    composer: 'empty', libCollapsed: true,
    overlay: { goal: true, goalY: 100, response: 'partial', responseY: 250, prov: true,
               provHeadY: 650, provSpineY: 630,
               catY: [680, 680, 754, 754, 828, 828] },
    notes: `<h3>Partial answer + provenance summary \u2014 TNG89 \u00a73.4, \u00a74.1, \u00a75.2</h3>
      <p><code>partial</code> is the state that matters most, because it is the one where the operator <i>has</i> something and needs to know not to trust all of it.</p>
      <h4>Decisions</h4><ul>
      <li><b>Partial content is kept in full, never hidden behind the error</b> (<code>CONTRACT \u00a74</code>). The strip carries the stable machine-readable code <i>and</i> the verbatim message \u2014 <code>\u00a716</code>\u2019s rule holds: LoomWatch never paraphrases a daemon error.</li>
      <li><b>Six grouped summaries in fixed order</b> \u2014 agents, reasoning, skills, tools, commands, sources (<code>CONTRACT \u00a712</code>\u2019s categories, in its order). Fixed order matters: the operator learns positions, and a graph that reorders itself by count is unlearnable.</li>
      <li><b>\u201cPartial capture\u201d, and it names the gaps.</b> A graph-level \u201cComplete capture\u201d label is permitted only when <i>every</i> requested category is complete. This is the sentence that keeps the whole view honest: the graph shows what was observed and says plainly where it could not see.</li>
      <li><b><code>skills</code> reads \u201cNot captured\u201d</b> because no skill adapter exists yet \u2014 by design, not as a defect. <code>CONTRACT \u00a712</code>: prompt or filesystem presence of a skill is <b>not</b> use, and no inference from prose may label one.</li>
      <li><b>Finished provenance edges share one neutral stroke</b>, while newly projected live evidence uses blue. The edge starts at the performing agent in both live and replay views; labels preserve owner, order, time, and relation.</li></ul>`
  },
  'trace': {
    seed: 'trace',
    label: 'Expanded trace', show: RUN_PARTS, graph: 'runOk', chip: 'clean',
    composer: 'empty', libCollapsed: true,
    overlay: { response: 'succeeded', responseY: 120, compact: true, prov: true,
               provHeadY: 336, provSpineY: 310,
               catY: [366, 366, 440, 440, 514, 514],
               open: 'tools', entities: TOOL_ENTITIES, entY: 620 },
    notes: `<h3>One-hop expansion + evidence quality \u2014 TNG89 \u00a74, \u00a75</h3>
      <h4>One hop at a time</h4><ul>
      <li>Click a category \u2192 its entities appear, connected by their real edge kind. Click an entity \u2192 <i>its</i> one hop. <b>Nothing ever explodes the whole graph.</b> At the contract\u2019s approved graph-size limit a full expansion is unreadable; the one-hop rule is what keeps the canvas <i>usable</i> rather than merely populated.</li>
      <li><b>Back to response</b> collapses everything and returns focus and viewport to the Response node. Focus is stable across expand/collapse, and evidence preserves its recorded ordinal/time while layout remains deterministic.</li>
      <li><b>Filters are view state, never document state</b> (the <code>\u00a76.7</code> rule) and never re-run the projector.</li></ul>
      <h4>The honesty layer \u2014 four capture states</h4>
      <p>TNG-89F requires recorded, derived, redacted and unavailable to be <b>visibly and textually distinct</b>. So each gets a border treatment, a glyph <b>and</b> a word \u2014 three channels, and the word is never dropped to save space. Greyscale proof: <code>solid+dot</code> / <code>dashed+ring</code> / <code>solid+hatch+lock</code> / <code>dotted+dashed-ring</code>.</p>
      <ul>
      <li><b><code>unavailable</code> always states its reason</b>, from the contract\u2019s stable reason codes. An empty category with no explanation reads as a bug in LoomWatch; the same category with a reason reads as an honest boundary. That difference is most of the trust this feature exists to create.</li>
      <li><b><code>redacted</code> never shows a keyhole.</b> No hover-to-reveal, no \u201crequest access\u201d. Default provenance surfaces are redacted before delivery and fail closed (<code>ADR 0005 \u00a77</code>); an affordance implying the bytes are one click away would be a lie about the privacy contract.</li>
      <li><b><code>reasoning</code> is <code>thought</code> and <code>plan</code> only.</b> Hidden chain-of-thought is never requested or represented.</li>
      <li>The details inspector reuses the <code>\u00a75.4</code> inspector shell \u2014 one detail surface in the product, not two.</li></ul>`
  },
  'states': {
    label: 'States', show: ['states'],
    notes: `<h3>State matrix — §16</h3>
      <p>CANVAS_SPEC had empty states and no loading or transport-failure states. That is the gap that shows up on day one of real use, because the daemon is a local process that can die.</p>
      <h4>Two rules across every row</h4><ul>
      <li><b>An error always carries the server's own message verbatim.</b> LoomWatch never paraphrases a daemon error into something friendlier and less diagnostic. A <code>422</code> the client did not predict is a client bug — surface it, never swallow it.</li>
      <li><b>No error state destroys the in-memory document.</b> The operator's unsaved graph survives every failure in this table. Daemon unreachable? Pan, zoom and inspect keep working; only <code>Save</code> disables, with the reason.</li></ul>
      <h4>Decisions</h4><ul>
      <li><b>No loader screen and no spinner in a list.</b> Boot shows the app with skeleton contents — ≤400 ms in the normal case, so it must look like the app, not like a loading state.</li>
      <li><b>One failure, one message.</b> If the daemon is unreachable the transport bar owns it and the library freezes its skeletons at 40% rather than showing a second error.</li>
      <li><b>LoomWatch never merges.</b> A disk conflict offers Compare / Keep mine / Use disk and nothing cleverer.</li>
      <li>Parse failure is the product's <b>only</b> modal, because it is the only state with no document to fall back to.</li></ul>`
  },
  'system': {
    label: 'System', show: ['system'],
    notes: `<h3>Design language — “Obsidian &amp; Gilt”</h3>
      <p>Rendered live from <code>tokens.css</code>, so what you see is the token layer itself rather than a picture of it. Flip the theme and every value below re-resolves.</p>
      <h4>Three tiers — §3</h4><ul>
      <li><b>Tier 1, primitives:</b> raw ramps, no semantics, identical in both themes, never referenced by a component.</li>
      <li><b>Tier 2, semantic:</b> the only tier that flips. <code>ground</code>, <code>panel</code>, <code>ink</code>, <code>accent</code>, <code>alert</code>…</li>
      <li><b>Tier 3, component aliases:</b> names a builder can grep — <code>--lw-edge-warp</code>, <code>--lw-node-fill</code>.</li>
      <li><b>THE ONE RULE:</b> a component references tier 2 or tier 3 only. A hex value or a <code>--lw-*</code> primitive inside a component is a bug — and it is a bug that only shows up in one theme.</li></ul>
      <h4>Four colour laws — §8</h4><ul>
      <li>Gold is the one brand accent and remains scarce. Blue is a semantic signal used only for live execution/streaming.</li>
      <li>The gold <i>fill</i> is rationed — roughly one per screen. On the canvas it is the Save button.</li>
      <li>Colour is never the only channel. Status carries shape and motion too; the edge layers differ in four channels.</li>
      <li>Signal colours (<code>alert</code>, <code>ok</code>, <code>halt</code>) are never decorative.</li></ul>
      <h4>Why the light mode was re-tuned</h4><ul>
      <li>Light is <b>“quarry”</b>: warm paper <code>#FAF8F3</code>, not white, and gold drops to a <b>bronze</b> (<code>gold-600</code>) at 4.76:1 so it can legally carry text. A dark-mode gold on paper is either illegible or garish; the same <i>decision</i> at a different lightness is what makes the two themes one system rather than two moods.</li>
      <li>Elevation is specified twice because dark and light do not share a model: light uses cast shadow, dark uses a top-inset rim light plus a deeper shadow. Inverting one theme's shadows into the other is the single most common reason a dark mode looks cheap.</li>
      <li><b>Bloom is dark-only.</b> Glow on paper reads as a rendering bug.</li></ul>`
  }
};

/* ---------------------------------------------------------------------------
   MIDDLE TRUNCATION — §4.1 ("middle-truncated for paths") and §5.1 ("model
   middle-truncates"). A path or a model id carries its meaning at BOTH ends:
   `/opt/homebrew/bin/opencode` tail-truncated loses the binary, head-truncated
   loses the root. CSS `text-overflow` can only do one end, so this is the one
   place the design needs ~12 lines of measurement code. Binary search on
   scrollWidth; the full string always stays in `title`.
   --------------------------------------------------------------------------- */
function middleTruncate(el) {
  const full = el.dataset.full || el.textContent.trim();
  el.dataset.full = full;
  el.title = full;
  el.textContent = full;
  if (el.scrollWidth <= el.clientWidth) return;
  const set = (n) => {
    const head = Math.ceil(n / 2), tail = n - head;
    el.textContent = full.slice(0, head) + '…' + (tail ? full.slice(-tail) : '');
  };
  let lo = 0, hi = full.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    set(mid);
    if (el.scrollWidth <= el.clientWidth) lo = mid; else hi = mid - 1;
  }
  set(lo);
}
const truncateAll = () =>
  document.querySelectorAll('.lib-row-sub, .node-meta .model, .ent .e-name').forEach(middleTruncate);

/* ===========================================================================
   NAVIGATION
   =========================================================================== */
const ORDER = ['first-run', 'canvas', 'inspector', 'team', 'switcher',
               'palette', 'problems', 'compose', 'running', 'answered',
               'trace', 'states', 'system'];

function go(key) {
  const s = SCREENS[key];
  if (!s) return;
  state.screen = key;

  ALL.forEach((id) => { const el = document.getElementById(id); if (el) el.hidden = true; });
  s.show.forEach((id) => { const el = document.getElementById(id); if (el) el.hidden = false; });

  if (s.graph) renderGraph(s.graph);
  if (s.chip) renderChip(s.chip);
  stage.classList.toggle('workspace', !!s.seed);
  if (s.seed) {
    clearTimers();
    SEEDS[s.seed]();
    renderComposer(s.composer || 'empty');
    paintRun();
  } else {
    renderOverlay(s.overlay || null);
    if (s.composer) renderComposer(s.composer);
  }
  state.lib = !!s.libCollapsed;
  stage.classList.toggle('lib-collapsed', state.lib);
  state.selected = null;
  $('#inspector').hidden = true;
  stage.classList.remove('inspecting');
  if (s.select) selectNode(s.select);
  if (s.show.includes('legend') && GRAPHS[s.graph] && !GRAPHS[s.graph].legend) {
    $('#legend').hidden = true;
  }

  document.querySelectorAll('#tabs button').forEach((b) =>
    b.setAttribute('aria-current', String(b.dataset.k === key)));
  $('#notesBody').innerHTML = s.notes;
}

const missing = ORDER.filter((k) => !SCREENS[k]);
if (missing.length) throw new Error('SCREENS missing: ' + missing.join(', '));

$('#tabs').innerHTML = ORDER.map((k) =>
  `<button data-k="${k}">${SCREENS[k].label}</button>`).join('');
$('#tabs').querySelectorAll('button').forEach((b) =>
  b.addEventListener('click', () => go(b.dataset.k)));

/* ===========================================================================
   INTERACTIONS
   =========================================================================== */

/* Theme — DESIGN_LANGUAGE §11. The glyph names the DESTINATION, not the
   current state: showing current state on a two-state control is the classic
   ambiguity, and it is avoided by naming where the click goes. */
const SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/></svg>';
const MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>';

function paintTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  stage.classList.toggle('theme-dark', state.theme === 'dark');
  const dark = state.theme === 'dark';
  const glyph = dark ? SUN : MOON;                    /* where the click goes */
  const tip = dark ? 'Switch to light  ⌘⇧L' : 'Switch to dark  ⌘⇧L';
  ['#themeBtn', '#themeBtn2'].forEach((sel) => {
    const b = $(sel); if (!b) return;
    b.innerHTML = glyph + (sel === '#themeBtn' ? '<span class="sysdot"></span>' : '');
    b.title = tip;
    b.setAttribute('aria-label', tip);
  });
  $('meta[name="theme-color"]').setAttribute('content', dark ? '#08080A' : '#FAF8F3');
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  paintTheme();
  /* the theme switch is an animation, because it is the feature the board
     asked to feel: one gold sweep, 320 ms, and nothing else in the product
     gets a full-surface transition (§9). */
  if (state.motion) {
    stage.classList.remove('sweeping');
    void stage.offsetWidth;
    stage.classList.add('sweeping');
    setTimeout(() => stage.classList.remove('sweeping'), 340);
  }
}

/* The ledger sweep — §9.1a. Saving is the moment the canvas stops being the
   truth and the file starts, so it gets 900 ms and nothing else does. */
let saveTimer = null;
function doSave() {
  if (saveTimer) return;
  renderChip('saving');
  $('#chip').classList.add('saving');
  saveTimer = setTimeout(() => {
    renderChip('saved');
    $('#chip').classList.add('saved');
    saveTimer = setTimeout(() => {
      renderChip('clean');
      saveTimer = null;
    }, 2000);
  }, state.motion ? 900 : 160);
}

/* Layer solo — §6.7. View state, never document state. */
function soloLayer(which) {
  state.solo = state.solo === which ? 'both' : which;
  paintSolo();
}
function cycleSolo() {
  state.solo = state.solo === 'both' ? 'configured'
    : state.solo === 'configured' ? 'observed' : 'both';
  paintSolo();
}
function paintSolo() {
  stage.classList.remove('solo-configured', 'solo-observed', 'solo-both');
  stage.classList.add('solo-' + state.solo);
  const w = $('#legWarp'), f = $('#legWeft');
  [w, f].forEach((el) => el.classList.remove('soloed', 'dimmed'));
  if (state.solo === 'configured') { w.classList.add('soloed'); f.classList.add('dimmed'); }
  if (state.solo === 'observed') { f.classList.add('soloed'); w.classList.add('dimmed'); }
}

function toggleLibrary() { state.lib = !state.lib; stage.classList.toggle('lib-collapsed', state.lib); }
function openSwitcher() { closePops(); $('#switcherPop').hidden = false; }
function openProblems() { closePops(); $('#problemsPop').hidden = false; }
function openPalette() { closePops(); $('#palette').hidden = false; $('#paletteInput').focus(); }
function closePops() { ['switcherPop', 'palette', 'problemsPop', 'history'].forEach((i) => { const el = $('#' + i); if (el) el.hidden = true; }); }

/* the palette's action list — §11 */
const CMDS = [
  ['Add agent…', '', 'plus'], ['Save', '⌘S', 'save'], ['Open team…', '⌘P', 'folder'],
  ['New team…', '⌘N', 'plus'], ['Reload from disk', '', 'refresh'],
  ['Discard changes', '', 'trash'], ['Fit view', 'F', 'frame'],
  ['Auto-layout', '⌥⌘L', 'grid'], ['Toggle library', '⌘\\', 'panel'],
  ['Toggle minimap', '', 'map'], ['Switch to light', '⌘⇧L', 'sun'],
  ['Follow system appearance', '', 'monitor'], ['Solo configured edges', 'L', 'line'],
  ['Solo observed edges', 'L', 'dash'], ['Next problem', 'F8', 'alert'],
  ['Copy file path', '', 'copy'], ['Show YAML', '', 'code']
];
$('#paletteList').innerHTML = CMDS.map(([label, key], i) =>
  `<button class="pop-row ${i === 0 ? 'active' : ''}">
     <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>
     <span class="name t-body">${label}</span>
     <span class="kbd t-mono-sm">${key}</span>
   </button>`).join('');

/* ===========================================================================
   BOARDS — generated from the same tables the canvas uses
   =========================================================================== */
const SWATCHES = [
  ['ground', 'canvas ground'], ['panel-solid', 'e2, inputs, node fill'],
  ['ink', 'primary text'], ['ink-2', 'secondary'], ['ink-3', 'tertiary, meta'],
  ['warp', 'configured edge'], ['accent', 'gilt — text-safe'],
  ['accent-fill', 'the rationed fill'], ['accent-dim', 'aged weft, budget'],
  ['accent-tint', 'hover, row fill'], ['alert', 'invalid, anomaly, failure'],
  ['ok', 'saved, succeeded'], ['halt', 'stopped, read-only'], ['ground-dot', 'grid texture']
];
$('#swatches').innerHTML = SWATCHES.map(([t, use]) =>
  `<div class="sw">
     <i style="background:var(--color-${t})"></i>
     <b class="t-mono-sm">${t}</b>
     <span class="t-meta">${use}</span>
   </div>`).join('');

$('#statusRows').innerHTML = Object.entries(STATUS).map(([k, v]) => {
  const shapeName = { idle: 'hollow ring', starting: 'ring + 90° arc', running: 'filled dot',
    waiting: 'hollow diamond', succeeded: 'circle + check', failed: 'circle + ×',
    stopped: 'filled square', unavailable: 'dashed ring' }[k];
  const colourName = { idle: 'ink-3', starting: 'live blue', running: 'live blue', waiting: 'halt',
    succeeded: 'ok', failed: 'alert', stopped: 'halt', unavailable: 'ink-3 @ 40%' }[k];
  return `<tr>
    <td>${statusSVG(k)}</td>
    <td><b class="t-mono-sm">${k}</b></td>
    <td class="t-meta">${shapeName}<br><span style="color:var(--color-ink-3)">${colourName}</span></td>
    <td class="t-meta">${v.motion}</td>
    <td class="grey">${statusSVG(k)}</td>
  </tr>`;
}).join('');

const LIFECYCLES = [
  ['Agent task', [['queued', 'idle'], ['running', 'running'], ['streaming', 'running'], ['done', 'succeeded'], ['error', 'failed'], ['cancelled', 'stopped'], ['offline', 'unavailable']]],
  ['Run', [['queued', 'idle'], ['running', 'running'], ['succeeded', 'succeeded'], ['partial', 'failed'], ['failed', 'failed'], ['cancelled', 'stopped']]],
  ['Result / view', [['streaming', 'running'], ['done', 'succeeded'], ['partial', 'failed'], ['error', 'failed'], ['replay', 'stopped']]]
];
if ($('#lifecycleMatrix')) {
  $('#lifecycleMatrix').innerHTML = LIFECYCLES.map(([name, cells]) =>
    `<div class="life-row"><b class="t-meta">${name}</b><div class="life-cells">${cells.map(([word, s]) =>
      `<span class="life-state t-meta">${statusSVG(s)} ${word}</span>`).join('')}</div></div>`).join('');
}

const EDGE_ROWS = [
  ['warp', '', 'configured · sequence', '1.5 px solid · filled arrowhead', 'warp', 'none — always static'],
  ['weft', 'dispatch', 'observed · dispatch', 'dash 6 4 · open arrowhead', 'accent', 'flow →'],
  ['weft', 'ask', 'observed · ask', 'dash 2 3 · arrowheads both ends', 'accent @ 80%', 'flow ⇄, 1400 ms each way'],
  ['weft', 'handoff', 'observed · handoff', 'dash 10 4 · 2.5 px · double chevron', 'accent', 'one pass on arrival, then static'],
  ['weft', 'anomaly', 'observed · anomaly', 'dot 1 4 · ⚠ midpoint badge', 'alert', 'flow →']
];
$('#edgeRows').innerHTML = EDGE_ROWS.map(([layer, kind, name, stroke, colour, motion]) => {
  const cls = layer === 'warp' ? 'warp' : 'weft ' + kind;
  const mk = layer === 'warp' ? 'url(#mWarp)'
    : kind === 'anomaly' ? 'url(#mAlert)'
    : kind === 'handoff' ? 'url(#mChevron)' : 'url(#mWeft)';
  const swatch = (grey) =>
    /* x1 = 9 so the `ask` row's marker-start has room and is not clipped */
    `<svg width="130" height="14" class="${grey ? 'grey' : ''}" aria-hidden="true">
       <line class="${cls}" x1="9" y1="7" x2="118" y2="7" marker-end="${mk}"/>
       ${kind === 'ask' ? '<line class="' + cls + '" x1="9" y1="7" x2="118" y2="7" marker-start="url(#mWeftBack)"/>' : ''}
     </svg>`;
  return `<tr>
    <td>${swatch(false)}</td>
    <td><b class="t-mono-sm">${name}</b></td>
    <td class="t-meta">${colour}</td>
    <td class="t-meta">${motion}<br><span style="color:var(--color-ink-3)">${stroke}</span></td>
    <td>${swatch(true)}</td>
  </tr>`;
}).join('');

const GALLERY = [
  [{ ...AGENTS.n1, status: 'idle', entry: true }, 'default · entrypoint'],
  [{ ...AGENTS.n2, selected: true }, 'selected — 2 px ring, 3 px offset'],
  [{ ...AGENTS.n2, kbd: true, status: 'idle' }, 'keyboard focus — + inner panel ring'],
  [{ ...AGENTS.n4, valid: 'incomplete' }, 'incomplete — required field never filled'],
  [{ ...AGENTS.n3, valid: 'invalid', status: 'idle' }, 'invalid — a rule is broken'],
  [{ ...AGENTS.n1, status: 'running' }, 'running — rail + breathing dot'],
  [{ ...AGENTS.n2, status: 'waiting' }, 'waiting — static diamond'],
  [{ ...AGENTS.n3, status: 'succeeded', pct: 62 }, 'succeeded · budget 62%'],
  [{ ...AGENTS.n3, status: 'failed', pct: 104, cost: '$2.08' }, 'failed · budget over'],
  [{ ...AGENTS.n2, status: 'stopped', pct: 84, cost: '$2.52' }, 'stopped · budget warn'],
  [{ ...AGENTS.n3, status: 'unavailable' }, 'unavailable — harness gone'],
  [{ ...AGENTS.n2, status: 'idle', lock: true, drag: true }, 'dragging · allowRecruiting false']
];
$('#nodeGallery').innerHTML = GALLERY.map(([n, cap]) =>
  `<figure class="cell">${nodeHTML({ ...n, x: 0, y: 0 })}<figcaption class="t-meta">${cap}</figcaption></figure>`
).join('');

$('#chipStates').innerHTML = Object.keys(CHIP).map((k) => {
  const c = CHIP[k];
  let act = '';
  if (c.action) {
    const [kind, label] = c.action.split(':');
    act = `<button class="btn ${kind === 'primary' ? 'btn-primary' : ''}" ${kind === 'disabled' ? 'disabled' : ''}>${label}</button>`;
  }
  return `<div>
    <div class="e1" style="height:44px;padding:0 12px 0 16px;display:flex;align-items:center;gap:12px;position:relative;overflow:hidden">
      ${chipDotSVG(k)}
      <span style="display:flex;flex-direction:column;gap:1px;flex:1;min-width:0">
        <span class="t-body-m">${c.l1}</span>
        <span class="t-meta" style="color:var(--color-ink-3)">${c.l2}</span>
      </span>
      ${act}
      ${k === 'saving' ? '<span style="position:absolute;left:0;bottom:0;height:2px;width:62%;background:var(--color-accent)"></span>' : ''}
      ${k === 'saved' ? '<span style="position:absolute;left:0;bottom:0;height:2px;width:100%;background:var(--color-ok)"></span>' : ''}
      ${k === 'failed' ? '<span style="position:absolute;left:0;bottom:0;height:2px;width:55%;background:var(--color-alert)"></span>' : ''}
    </div>
    <div class="t-mono-sm" style="color:var(--color-ink-3);margin-top:6px">${k}</div>
  </div>`;
}).join('');

$('#spaceRow').innerHTML = [4, 8, 12, 16, 20, 24, 32, 48].map((n, i) =>
  `<span style="display:flex;flex-direction:column;align-items:center;gap:6px">
     <i style="display:block;width:${n}px;height:${n}px;background:var(--color-accent-dim);border-radius:2px"></i>
     <span class="t-mono-sm" style="color:var(--color-ink-3)">${i + 1}</span>
   </span>`).join('');
$('#radiusRow').innerHTML = [['xs', 4], ['sm', 8], ['md', 10], ['lg', 14], ['full', 24]].map(([n, r]) =>
  `<span style="display:flex;flex-direction:column;align-items:center;gap:6px">
     <i style="display:block;width:48px;height:34px;border:1px solid var(--color-ink-3);border-radius:${r}px"></i>
     <span class="t-mono-sm" style="color:var(--color-ink-3)">${n}</span>
   </span>`).join('');

/* ===========================================================================
   KEYBOARD — §11. Every primary flow is reachable without a pointer.
   =========================================================================== */
document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

  if (meta && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); return toggleTheme(); }
  if (meta && e.key === 'Enter') {
    e.preventDefault();
    if (stage.classList.contains('workspace')) return isTerminal() ? retryRun() : submitRun();
    return;
  }
  if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); return doSave(); }
  if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); return openPalette(); }
  if (meta && e.key.toLowerCase() === 'p') { e.preventDefault(); return openSwitcher(); }
  if (meta && e.key === '\\') { e.preventDefault(); return toggleLibrary(); }
  if (e.key === 'Escape') {
    /* Esc order: dismiss popover → deselect → close inspector (§11) */
    const open = ['switcherPop', 'palette', 'problemsPop', 'history'].some((i) => { const el = $('#' + i); return el && !el.hidden; });
    if (open) return closePops();
    if (state.selected) return selectNode(null);
    return;
  }
  if (typing) return;
  if (e.key.toLowerCase() === 'l') return cycleSolo();
  if (e.key === '?') return $('#notesBtn').click();
  if (e.key === 'F8') { e.preventDefault(); return openProblems(); }
  if (/^[1-9]$/.test(e.key)) return go(ORDER[+e.key - 1]);
  if (e.key === '0') return go(ORDER[9]);
  const extra = { q: 10, w: 11, e: 12 };
  if (extra[e.key] !== undefined) return go(ORDER[extra[e.key]]);
});

$('#notesBtn').addEventListener('click', () => {
  const open = $('#notes').classList.toggle('open');
  $('#notesBtn').setAttribute('aria-pressed', String(open));
  fit();
});
$('#motionBtn').addEventListener('click', () => {
  state.motion = !state.motion;
  document.documentElement.setAttribute('data-motion', state.motion ? 'full' : 'reduce');
  stage.style.setProperty('--t-flow', state.motion ? '1400ms' : '0ms');
  document.querySelectorAll('.weft, .shuttle, .skel-row').forEach((el) => {
    el.style.animationPlayState = state.motion ? 'running' : 'paused';
  });
  document.querySelectorAll('.shuttle').forEach((el) => { el.style.display = state.motion ? '' : 'none'; });
  $('#motionBtn').textContent = 'Motion: ' + (state.motion ? 'on' : 'reduced');
});

/* fit the fixed 1600 × 1000 stage into whatever the reviewer's window is */
function fit() {
  const wrap = $('#stageWrap');
  const pad = 32;
  const notesW = $('#notes').classList.contains('open') ? 320 : 0;
  const s = Math.min((wrap.clientWidth - notesW - pad) / 1600, (wrap.clientHeight - pad) / 1000, 1);
  stage.style.transform = `scale(${s})`;
  stage.style.marginRight = notesW ? notesW + 'px' : '0';
}
window.addEventListener('resize', fit);

/* ===========================================================================
   INIT — deep-linkable, so a review comment can point at an exact screen:
   prototype.html#canvas · #team,light · #system,light
   =========================================================================== */
const hash = decodeURIComponent(location.hash.replace(/^#/, '')).split(',').map((s) => s.trim());
if (hash.includes('light')) state.theme = 'light';
if (hash.includes('dark')) state.theme = 'dark';
const wanted = hash.find((h) => ORDER.includes(h));

paintTheme();
paintDots();
paintSolo();
go(wanted || 'canvas');
truncateAll();
fit();
window.addEventListener('hashchange', () => location.reload());




/* the capture / coverage vocabulary, rendered from the same tables the
   provenance graph uses, with a greyscale proof row beside it (TNG89 §5.1) */
const CAP_DEMO = [
  ['recorded',    'tool',    'Team Bus: ask',      'team_bus · success',   null],
  ['derived',     'command', 'cargo test',         'exit 0',               null],
  ['redacted',    'source',  'internal reference', 'web · withheld',       null],
  ['unavailable', 'skill',   'skill use',          '—', 'No skill adapter installed']
];
const capCard = (cap, kind, name, sub, why) =>
  `<button class="ent cap-${cap}" style="position:relative;--x:0;--y:0">
     <span class="e-top t-body-m">${entGlyph(kind, 13)} ${name}</span>
     <span class="e-sub t-mono-sm">${sub}</span>
     <span class="e-cap t-micro">${CAPTURE[cap].glyph} ${CAPTURE[cap].word}</span>
     ${why ? `<span class="e-sub t-meta">${why}</span>` : ''}
   </button>`;
if ($('#capRow')) {
  $('#capRow').innerHTML = CAP_DEMO.map((a) => capCard(...a)).join('');
  $('#capGrey').innerHTML = CAP_DEMO.map((a) => capCard(...a)).join('');
  $('#covRow').innerHTML = Object.keys(COVERAGE).map((l) =>
    `<span style="display:flex;flex-direction:column;gap:6px">
       <span class="t-body-m" style="display:flex;align-items:center;gap:6px">
         ${covSVG(l)} ${COVERAGE[l].word}</span>
       <span class="t-mono-sm" style="color:var(--color-ink-3)">${l}</span>
     </span>`).join('');
}
