#!/usr/bin/env node
/* TNG-208 — the counterfactual pass for verify-response-states.mjs.
 *
 * The gate prints 6/6 and has never printed anything else. Every mutation below restores a
 * defect §3.4 / UX_REDESIGN §16 / CONTRACT §3 names — several of them the exact state
 * docs/mockups/TNG90_IMPLEMENTATION_CONFORMANCE.md §8 recorded before the fix — and requires
 * the contract that claims to catch it to go red, alone.
 *
 *   node docs/mockups/defeat-response-states.mjs
 *   node docs/mockups/defeat-response-states.mjs --only 3,4
 *   node docs/mockups/defeat-response-states.mjs --no-control
 *
 * `ui/` is never written; see defeat-source-gate.mjs for the staging and the verdicts.
 */

import { sweep } from './defeat-source-gate.mjs'

const WORKSPACE = 'ui/src/components/Workspace.tsx'
const NODES = 'ui/src/components/run/StoryNodes.tsx'
const EVENTS = 'ui/src/lib/watch/events.ts'
const CLIENT = 'ui/src/lib/runs/client.ts'

const WATERMARK = "          watermark: record?.errorCode ?? record?.stopReason ?? projection.errorCode ?? exitFact ?? 'no code reported',"

/* The §3.4 message expression, whole. Several mutations replace it outright rather than
   editing inside it, because the sentence and the code comparison are one decision. */
const MESSAGE = `          message: record?.error ?? crash?.message
            ?? (phase === 'failed' && (record?.errorCode ?? record?.stopReason ?? projection.errorCode) === 'missing_canonical_response'
              ? 'The run finished but no agent produced an answer.'
              : 'No error message was reported.'),`

/* Restoring the pre-fix OutputNodeCard takes four edits: the placeholder, the accessible name,
   the Reuse gate and the predicate itself. Breaking one of them alone leaves the others holding
   the contract, which is why these travel together. */
const UNCONDITIONAL_BODY = [
  { file: NODES, from: '      ) : terminalEmpty ? null : (', to: '      ) : (' },
  {
    file: NODES,
    from: '      aria-label={terminalEmpty ? `Output, ${data.phaseText}` : `Output response from ${data.producerLabel}, ${data.phaseText}`}',
    to: '      aria-label={`Output response from ${data.producerLabel}, ${data.phaseText}`}',
  },
  { file: NODES, from: '      {terminalEmpty && reusePrompt && (', to: '      {reusePrompt && (' },
]

const mutations = [
  {
    name: 'the daemon\'s code stops being modelled at all',
    why: '§8 recorded this exactly: `RunRecord` carried `error` and `exitCode` and no code field, so every watermark the operator read had been manufactured in the client. A type that cannot hold the daemon\'s code guarantees the UI invents one.',
    expect: 'D1',
    edits: [{
      file: CLIENT,
      from: `  /**
   * The daemon's stable machine-readable error code, verbatim (CONTRACT §3). Optional in
   * the type until the backend emits it — the UI carries what the daemon sends and says
   * \`no code reported\` when it sends none, never a token manufactured here.
   */
  errorCode?: string | null
  /** The daemon's terminal stop reason, verbatim (CONTRACT §3). Optional for the same reason. */
  stopReason?: string | null
`,
      to: '',
    }],
  },
  {
    name: 'the type keeps the code and the watermark stops reading it',
    why: 'The quiet half of the same defect, and the one a "we model it now" fix leaves behind: the field exists, nothing renders it, and the operator sees the exit status where the spec puts the code. Nothing is invented here, so only a check scoped to the watermark can see it.',
    expect: 'D1',
    edits: [{ file: WORKSPACE, from: WATERMARK, to: "          watermark: exitFact ?? 'no code reported'," }],
  },
  {
    name: 'the watermark goes back to `process_crashed` for every quiet run',
    why: '§8\'s headline defect. `record?.error ? \'run_failed\' : \'process_crashed\'` stamps a crash code on every partial run with no error string — including a run where every agent succeeded and none was canonical. It breaks both halves of the contract at once: nothing reads the daemon\'s code, and a code the daemon never emitted is shown at `--font-mono`, the typography of a machine fact.',
    expect: ['D1', 'D2'],
    edits: [{ file: WORKSPACE, from: WATERMARK, to: "          watermark: record?.error ? 'run_failed' : 'process_crashed'," }],
  },
  {
    name: 'the known paraphrase returns to the verbatim slot',
    why: 'UX_REDESIGN §16: LoomWatch never paraphrases a daemon error. "The run did not complete normally." is the sentence §8 found occupying the slot — same `.msg` element, same strip, same accessible reading as a real daemon message.',
    expect: 'D3',
    edits: [{ file: WORKSPACE, from: "              : 'No error message was reported.'),", to: "              : 'The run did not complete normally.')," }],
  },
  {
    name: 'a *different* invented sentence occupies the verbatim slot',
    why: 'The same §16 violation in a sentence nobody has written down yet. A gate that only knows the two paraphrases this repo happened to ship cannot stop the third, and the third is the one that has not been caught yet.',
    expect: 'D3',
    edits: [{ file: WORKSPACE, from: "              : 'No error message was reported.'),", to: "              : 'Something went wrong while running this team.')," }],
  },
  {
    name: 'the empty-body placeholder stops consulting the phase',
    why: '§8: "No response text yet." — `yet` is a promise a terminal run can no longer keep — was chosen by `!data.text` alone, and the accessible name still opened "Output response from <agent>" for an agent that produced none.',
    expect: 'D4',
    edits: [
      ...UNCONDITIONAL_BODY,
      {
        file: NODES,
        from: `  const isFailed = data.phase === 'failed'
  const terminalEmpty = isFailed && !data.text
`,
        to: '',
      },
    ],
  },
  {
    name: 'the phase is consulted for a CSS class and nowhere else',
    why: 'The realistic regression, not the clean revert: a refactor keeps `isFailed` — for a modifier class — and drops it from the body and the accessible name. The operator is told their answer is still coming on a run that has already failed, while the word the gate greps for is still in the file.',
    expect: 'D4',
    edits: [
      ...UNCONDITIONAL_BODY,
      { file: NODES, from: '  const terminalEmpty = isFailed && !data.text\n', to: '' },
      {
        file: NODES,
        from: "      className={cx('rt rt-response story-output', clickable && 'clickable', data.compact && 'compact')}",
        to: "      className={cx('rt rt-response story-output', clickable && 'clickable', isFailed && 'is-failed', data.compact && 'compact')}",
      },
    ],
  },
  {
    name: 'the [ Reuse ] affordance is deleted',
    why: '§3.4 names three things in the failed node and this is the only one the operator can act on. Without it the node a run dies on offers nothing to do, though §12.2 kept the prompt on the Prompt node the whole time.',
    expect: 'D5',
    edits: [{
      file: NODES,
      from: `      {terminalEmpty && reusePrompt && (
        <button
          type="button"
          className="rr-reuse nodrag"
          onClick={(event) => { event.stopPropagation(); reusePrompt() }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          [ Reuse ]
        </button>
      )}
`,
      to: '',
    }],
  },
  {
    name: 'the affordance is downgraded to a comment promising it',
    why: 'D5 was already blind once — `/Reuse/i` over the raw region matched `reusePrompt` from the context destructure and the prose comment above the check. This mutation is that false pass, kept as a regression test on the comment-stripping that fixed it.',
    expect: 'D5',
    edits: [{
      file: NODES,
      from: `        <button
          type="button"
          className="rr-reuse nodrag"
          onClick={(event) => { event.stopPropagation(); reusePrompt() }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          [ Reuse ]
        </button>`,
      to: '        {/* TODO: restore the [ Reuse ] button */}',
    }],
  },
  {
    name: 'the strip stops naming the no-canonical-response case',
    why: '§3.4 singles this case out for a plain-language second line. Fold it back into the generic branch and the one terminal state the spec asks to be named by name is the one the operator is given a bare code for.',
    expect: 'D6',
    edits: [{
      file: WORKSPACE,
      from: MESSAGE,
      to: "          message: record?.error ?? crash?.message ?? 'No error message was reported.',",
    }],
  },
  {
    name: 'the ladder folds the case back into `partial`',
    why: 'The classification half. With `missingCanonicalResponse` gone, a run where every agent finished cleanly and none was canonical lands in `partial` — and combined with mutation 3 the operator is told a clean run crashed. The phase ladder is where the case has to be distinguished; a sentence in the strip it can never reach is not a fix.',
    expect: 'D6',
    edits: [
      { file: EVENTS, from: '  const missingCanonicalResponse = atRest && !live && !outstanding && spawned.length > 0 && !anyFailed && !responseText\n', to: '' },
      {
        file: EVENTS,
        from: "  else if (registry === 'succeeded') phase = missingCanonicalResponse ? 'failed' : anyFailed ? 'partial' : 'succeeded'",
        to: "  else if (registry === 'succeeded') phase = anyFailed ? 'partial' : 'succeeded'",
      },
      {
        file: EVENTS,
        from: "  else phase = missingCanonicalResponse ? 'failed' : responseText ? 'succeeded' : 'partial'",
        to: "  else phase = responseText ? 'succeeded' : 'partial'",
      },
      {
        file: EVENTS,
        from: "    errorCode: missingCanonicalResponse && phase === 'failed' ? 'missing_canonical_response' : null,",
        to: '    errorCode: null,',
      },
    ],
  },
]

sweep({ gate: 'docs/mockups/verify-response-states.mjs', inputs: [WORKSPACE, NODES, EVENTS, CLIENT], mutations })
