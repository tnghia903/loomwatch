#!/usr/bin/env node
/* TNG-208 — the counterfactual pass for verify-narrow-conformance.mjs.
 *
 * The gate prints 4/4 and has never printed anything else. Every mutation below restores a defect
 * §11.6 of docs/TNG89_INTERACTION.md names — a stage of the narrow composition that goes missing,
 * failure 22's unreachable provenance, failure 21's sub-44 px touch target, a card that stops
 * stating capture quality — and requires the contract that claims to catch it to go red, alone.
 *
 *   node docs/mockups/defeat-narrow-conformance.mjs
 *   node docs/mockups/defeat-narrow-conformance.mjs --only 5,6
 *   node docs/mockups/defeat-narrow-conformance.mjs --no-control
 *
 * `ui/` is never written; see defeat-source-gate.mjs for the staging and the verdicts.
 */

import { sweep } from './defeat-source-gate.mjs'

const WORKSPACE = 'ui/src/components/Workspace.tsx'
const COLUMN = 'ui/src/components/run/RunColumn.tsx'
const PANEL = 'ui/src/components/run/ProvenancePanel.tsx'
const ACTIVITY = 'ui/src/components/run/ActivityPanel.tsx'
const APP_CSS = 'ui/src/styles/app.css'
const RUNTIME_CSS = 'ui/src/styles/runtime.css'

const COVERAGE_STAGE = `        <p className="run-prov-cov t-micro" title="Complete for what the adapters can observe — never an agent's private internal state.">
          <CoverageGlyph level={coverage.complete ? 'complete' : 'partial'} /> {coverage.text}
        </p>
`

const FILTERS_STAGE = `        <div className="run-prov-filters" role="group" aria-label="Filter the evidence this run shows">
          {CATEGORIES.map((category) => (
            <button key={category.key} type="button" className="filter-chip t-micro" aria-pressed={!hidden.has(category.key)} onClick={() => toggleCategory(category.key)}>
              <EntityGlyph kind={category.kind} size={12} /> {category.label}
            </button>
          ))}
          <button type="button" className="filter-chip t-micro" aria-pressed={onlyRedacted} onClick={() => setOnlyRedacted((on) => !on)}>Only redacted</button>
          <button type="button" className="filter-chip t-micro" aria-pressed={onlyNotCaptured} onClick={() => setOnlyNotCaptured((on) => !on)}>Only not captured</button>
        </div>
`

const SUMMARIES_STAGE = `        <ul className="run-prov-sums" aria-label="Provenance summaries">
          {CATEGORIES.map((category) => {
            const level = coverageFor(category.key, projection)
            const count = projection.coverage[category.key].observed
            return (
              <li key={category.key}>
                {/* The count and level are the projector's, never the filter's: a filtered
                    view that also restated the counts would let view state look like capture. */}
                <button type="button" className="prov-sum" onClick={toggleProvenance} aria-label={\`\${category.label}, \${count} \${count === 1 ? 'entity' : 'entities'}, \${coverageWord(level)}. Open full provenance.\`}>
                  <EntityGlyph kind={category.kind} size={13} />
                  <span className="ps-label t-micro">{category.label}</span>
                  <span className="ps-count t-body-m">{count || '—'}</span>
                  <span className="ps-level t-meta"><CoverageGlyph level={level} /> {coverageWord(level)}</span>
                </button>
              </li>
            )
          })}
        </ul>
`

/* Both routes into the panel at this width. §11.6 failure 22 is unmet when neither survives, so a
   mutation aimed at N2 has to take both — which is also how the defect actually shipped. */
const PROVENANCE_ROUTES = [
  {
    file: COLUMN,
    from: '<button type="button" className="prov-sum" onClick={toggleProvenance} aria-label=',
    to: '<button type="button" className="prov-sum" aria-label=',
  },
  {
    file: COLUMN,
    from: '        <button type="button" className="btn" onClick={toggleProvenance}>Open full provenance</button>\n',
    to: '',
  },
]

const mutations = [
  {
    name: 'the narrow column loses the coverage stage',
    why: '§11.6 fixes the source order "… Output / response → coverage → filters → summaries → selected evidence". Coverage is the first thing the operator reads about how much of the run was actually observed; without it the column lists evidence with no statement of what is missing from it.',
    expect: 'N1',
    edits: [{ file: COLUMN, from: COVERAGE_STAGE, to: '' }],
  },
  {
    name: 'the narrow column loses the summaries stage',
    why: 'The six grouped summaries (§4.1) are the way into the panel at this width — they carry the per-category counts and coverage words, and each one opens the detail surface. Remove them and the column has filters that narrow a list the operator can no longer see grouped.',
    expect: 'N1',
    edits: [{ file: COLUMN, from: SUMMARIES_STAGE, to: '' }],
  },
  {
    name: 'the narrow column loses the filter controls',
    why: '§4.4 filtering is the second stage, and the one that makes a long single-column read usable at all. "Only redacted" and "Only not captured" are the §5 honesty layer\'s two questions; without them the honesty layer is a word on a card.',
    expect: 'N1',
    edits: [{ file: COLUMN, from: FILTERS_STAGE, to: '' }],
  },
  {
    name: 'both routes into provenance are removed below 768 px',
    why: '§11.6 failure 22 verbatim: the panel renders only while `provenanceOpen`, and its other writer is the Response node\'s toggle inside the ReactFlow canvas the narrow branch replaces. Take the column\'s two routes and the §4.1 summaries and §4.4 filters cannot be reached by pointer, palette or shortcut at this width.',
    expect: 'N2',
    edits: PROVENANCE_ROUTES,
  },
  {
    name: 'the routes are removed and the palette is left a TODO about provenance',
    why: 'The same failure 22 with a comment in the command actions promising the route that was deleted. A gate that greps the actions block for the bare word "provenance" counts the promise as the affordance — and a TODO is the single most likely thing to be sitting there at exactly the moment the route is missing.',
    expect: 'N2',
    edits: [
      ...PROVENANCE_ROUTES,
      {
        file: WORKSPACE,
        from: '  const actions = useMemo<CommandAction[]>(() => [\n',
        to: '  const actions = useMemo<CommandAction[]>(() => [\n    // TODO(§11.6): add a "Show provenance" action here so narrow has a route in.\n',
      },
    ],
  },
  {
    name: 'the composer buttons go back to the 28 px pointer size',
    why: '§11.6 failure 21: "makes a core action smaller than 44 px. Fail." Run / Save & run / Stop / Retry / New run are `.btn`, and 28 px is the desktop hit box shipped to a thumb. The narrow block still ends with a 44 px `.pop-inline .btn`, which governs buttons inside a popover and not one of these.',
    expect: 'N3',
    edits: [{ file: APP_CSS, from: '  .btn { height: 44px; padding: 0 var(--sp-4); }', to: '  .btn { height: 28px; padding: 0 var(--sp-4); }' }],
  },
  {
    name: 'the run-history and theme controls go back to 32 px',
    why: 'The same failure on the two `.iconbtn` controls §11.6 names. These have no second rule to hide behind, so this is the version of failure 21 the gate has always been able to see — kept as the control for the mutation above it.',
    expect: 'N3',
    edits: [{ file: APP_CSS, from: '  .iconbtn { width: 44px; height: 44px; }', to: '  .iconbtn { width: 32px; height: 32px; }' }],
  },
  {
    name: 'the mode chip is re-pinned under the touch floor',
    why: 'The chip is a core action and was pinned under 44 px here once already — the narrow rule carries a comment saying so. A `min-height` is what actually produces the 44, so lowering it is enough; nothing else in the cascade lifts it back.',
    expect: 'N3',
    edits: [{
      file: RUNTIME_CSS,
      from: '  .lw-composer .mode-chip { border-right: 0; padding: 0 var(--sp-2); min-height: 44px; }',
      to: '  .lw-composer .mode-chip { border-right: 0; padding: 0 var(--sp-2); min-height: 32px; }',
    }],
  },
  {
    name: 'the narrow card stops stating capture quality on its face',
    why: '§11.6: the geometry is omitted at this width, the information it carried is not — "cards continue to state owner, event order/time, status, capture quality, and relationship". Capture quality reached the accessible name already; this is about the face. With the panel unreachable, deleting this span leaves the §5 honesty layer with no visible expression anywhere below 768 px.',
    expect: 'N4',
    edits: [{
      file: COLUMN,
      from: '                  <span className={cx(\'ae-cap t-micro\', `cap-${item.capture}`)}>{CAPTURE_WORD[item.capture]}</span>\n',
      to: '',
    }],
  },
]

sweep({
  gate: 'docs/mockups/verify-narrow-conformance.mjs',
  inputs: [WORKSPACE, COLUMN, PANEL, ACTIVITY, APP_CSS, RUNTIME_CSS],
  mutations,
})
