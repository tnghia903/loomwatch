#!/usr/bin/env node
/* TNG-208 — the counterfactual pass for verify-a11y-conformance.mjs.
 *
 * The gate prints 5/5 and has never printed anything else. Every mutation below restores a
 * defect §6 of docs/TNG89_INTERACTION.md names — an accessible name that stops saying what it
 * promises, a disclosure that stops being focusable, a blocker that moves to the wrong channel,
 * a polite region that drops everything after the first message — and requires the contract that
 * claims to catch it to go red, alone.
 *
 *   node docs/mockups/defeat-a11y-conformance.mjs
 *   node docs/mockups/defeat-a11y-conformance.mjs --only 2,3
 *   node docs/mockups/defeat-a11y-conformance.mjs --no-control
 *
 * `ui/` is never written; see defeat-source-gate.mjs for the staging and the verdicts.
 */

import { sweep } from './defeat-source-gate.mjs'

const PANEL = 'ui/src/components/run/ProvenancePanel.tsx'
const WORKSPACE = 'ui/src/components/Workspace.tsx'
const STORY = 'ui/src/components/run/StoryNodes.tsx'
const COLUMN = 'ui/src/components/run/RunColumn.tsx'
const QUEUE = 'ui/src/lib/useAnnouncementQueue.ts'

/* The zone-head disclosure, opening tag through close. §6.1's tab-order contract is about the
   element, so a mutation that changes it has to carry the closing tag with it. */
const ZONE_HEAD = `            <button type="button" className="zone-head toggle t-micro" aria-expanded={open} aria-controls={\`prov-zone-\${category.key}\`} aria-label={\`\${category.label}, \${count} \${count === 1 ? 'entity' : 'entities'}, \${coverageWord(level)}\`} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(category.key)) next.delete(category.key); else next.add(category.key); return next })}>`

const PREFLIGHT = "    doc.documentChipState === 'invalid' ? `Team has ${validationProblemCount} validation problem${validationProblemCount === 1 ? '' : 's'}.` : null,\n"

const mutations = [
  {
    name: 'the panel row stops naming capture quality',
    why: '§6.4 fixes the entity name as "<kind>: <name>, <capture word>". Drop the capture word and a screen-reader user is read a list of entities with no way to tell a captured one from a redacted one — the §5 honesty layer exists only in the visual rendering.',
    expect: 'A1',
    edits: [{
      file: PANEL,
      from: 'aria-label={`${item.kind}: ${item.name}, ${item.capture}`}',
      to: 'aria-label={`${item.kind}: ${item.name}`}',
    }],
  },
  {
    name: 'the canvas evidence card stops naming capture quality',
    why: 'The same §6.4 name on the second of the three surfaces that render the entity control. TNG-170 moved the capture word onto the projection precisely so no surface could regress alone; that is only true if the gate checks each surface.',
    expect: 'A1',
    edits: [{
      file: STORY,
      from: 'aria-label={`Inspect ${evidence.kind}: ${evidence.name}, ${evidence.capture}, ',
      to: 'aria-label={`Inspect ${evidence.kind}: ${evidence.name}, ',
    }],
  },
  {
    name: 'the narrow evidence card stops naming capture quality',
    why: 'The third surface, and the one that matters most: below 768 px the RunColumn card is the only place an entity is rendered at all, so its accessible name is the entire §6.4 contract at that width.',
    expect: 'A1',
    edits: [{
      file: COLUMN,
      from: 'aria-label={`Inspect ${item.kind}: ${item.name}, ${item.capture}, ',
      to: 'aria-label={`Inspect ${item.kind}: ${item.name}, ',
    }],
  },
  {
    name: 'the summary chip announces a bare number',
    why: '§6.4: "<category>, <n> entities, <coverage word>". "Tools, 7, partial" is a number with no unit — the listener cannot tell seven entities from seven per cent, and the coverage word is the only honesty signal on the chip.',
    expect: 'A2',
    edits: [{
      file: PANEL,
      from: "${count} ${count === 1 ? 'entity' : 'entities'}, ${coverageWord(level)}",
      to: '${count}, ${coverageWord(level)}',
    }],
  },
  {
    name: 'the disclosure stops reporting whether it is open',
    why: '§6.1 requires `aria-expanded` to track every provenance disclosure. Without it the six summaries announce as plain buttons and a listener pressing one cannot tell whether anything happened.',
    expect: 'A3',
    edits: [{
      file: PANEL,
      from: 'aria-expanded={open} aria-controls={`prov-zone-${category.key}`} ',
      to: 'aria-controls={`prov-zone-${category.key}`} ',
    }],
  },
  {
    name: 'the summaries go back to being plain <div>s',
    why: 'The state TNG-158 fixed: a non-focusable element cannot occupy a tab position, so §6.1\'s "filters → the six summaries in fixed order → expanded entities" silently loses its middle. The chip keeps its class, its label and its click handler, so nothing visual changes and only the keyboard path breaks.',
    expect: 'A3',
    edits: [
      { file: PANEL, from: ZONE_HEAD, to: ZONE_HEAD.replace('<button type="button" ', '<div ') },
      { file: PANEL, from: '            </button>\n            {open && (', to: '            </div>\n            {open && (' },
    ],
  },
  {
    name: 'the preflight blocker moves to the polite queue',
    why: '§6.3 puts preflight blockers on the assertive channel. On the polite queue "N things to fix before this team can run" waits behind save state and status churn — the operator presses Run, hears nothing, and presses it again.',
    expect: 'A4',
    edits: [
      { file: WORKSPACE, from: PREFLIGHT, to: '' },
      { file: WORKSPACE, from: '  const politeCandidates = [\n', to: `  const politeCandidates = [\n${PREFLIGHT}` },
    ],
  },
  {
    name: 'the preflight blocker is published on both channels',
    why: 'The well-meaning version of the same defect. Belt-and-braces on two live regions announces the blocker twice, and §6.3 reserves the polite channel for what can wait — a blocker that interrupts and then repeats itself politely trains the operator to ignore both.',
    expect: 'A4',
    edits: [{ file: WORKSPACE, from: '  const politeCandidates = [\n', to: `  const politeCandidates = [\n${PREFLIGHT}` }],
  },
  {
    name: 'the polite region goes back to `.find(Boolean)`',
    why: 'The defect §6.3 was written against: a first-match region announces at most one message per render and silently drops everything below it — save state, disk notices and start errors all sit under `statusAnnouncement`, which refreshes every 3 s during a run.',
    expect: 'A5',
    edits: [
      {
        file: WORKSPACE,
        from: '  const [politeAnnouncement, enqueuePolite] = useAnnouncementQueue()\n',
        to: '  const politeAnnouncement = politeCandidates.find(Boolean) ?? \'\'\n',
      },
      {
        file: WORKSPACE,
        from: `  useEffect(() => {
    const previous = priorPolite.current
    priorPolite.current = politeCandidates
    for (let index = 0; index < politeCandidates.length; index += 1) {
      const message = politeCandidates[index]
      if (message && message !== previous[index]) enqueuePolite(message)
    }
  })
`,
        to: '',
      },
    ],
  },
  {
    name: 'the loop stops after the first changed candidate',
    why: 'A real FIFO queue, correctly drained, fed by a loop that breaks. Two candidates changing in one render — a save completing while a start error arrives — and one of them is never enqueued. The queue is not where messages are dropped; this is.',
    expect: 'A5',
    edits: [{
      file: WORKSPACE,
      from: '      if (message && message !== previous[index]) enqueuePolite(message)\n    }\n  })\n  useEffect(() => {\n    const previous = priorAssertive.current',
      to: '      if (message && message !== previous[index]) { enqueuePolite(message); break }\n    }\n  })\n  useEffect(() => {\n    const previous = priorAssertive.current',
    }],
  },
  {
    name: 'a start error stops being a polite candidate',
    why: 'The queue drains perfectly and the message never reaches it. §6.3 names start errors among what the polite channel carries; a run that refused to start, announced to nobody, is the same silence `.find(Boolean)` produced.',
    expect: 'A5',
    edits: [{ file: WORKSPACE, from: '    doc.diskNotice,\n    startError,\n  ]', to: '    doc.diskNotice,\n  ]' }],
  },
  {
    name: 'the queue keeps its shape and announces only the first message',
    why: 'push and shift both survive, the hook still looks like a queue, and a guard on `spoken` means every message after the first is dropped on the floor. This is `.find(Boolean)` rewritten to pass a check that greps for the mechanics of a queue rather than its behaviour.',
    expect: 'A5',
    edits: [{
      file: QUEUE,
      from: '    if (!message) return\n    pending.current.push(message)',
      to: '    if (!message) return\n    if (spoken.current) return\n    pending.current.push(message)',
    }],
  },
]

sweep({
  gate: 'docs/mockups/verify-a11y-conformance.mjs',
  inputs: [PANEL, WORKSPACE, STORY, COLUMN, QUEUE],
  mutations,
})
