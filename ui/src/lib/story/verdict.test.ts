import { describe, expect, it } from 'vitest'

import type { Evidence, RunProjection } from '../watch/events'
import type { CheckItemResult } from './checks'
import { buildReceipt, type Receipt, type ReceiptLine } from './receipt'
import { answerVerdict, findingsOf, type VerdictInput } from './verdict'

const receipt = (lines: ReceiptLine[], checks: ReceiptLine[] = []): Receipt => ({ run: 'Run 3', outcome: { word: 'Finished', tone: 'ok' }, endedAt: null, asked: 'Brief', took: '2m', team: '2 agents', ranOn: 'Claude Code', tokens: null, lines, checks })
const finished: VerdictInput = { phase: 'succeeded', text: '# Brief', streaming: false, terminal: true, settled: true, reviewed: false, receipt: receipt([{ tone: 'ok', text: 'Writer finished' }]), read: { files: 0, pages: 0, notes: 0 } }

describe('answerVerdict', () => {
  // The badge used to read "Response available" over a response the reader could already see.
  it('says nothing was flagged for a clean run, and what the answer rests on', () => {
    expect(answerVerdict(finished)).toMatchObject({ tone: 'ok', label: 'Nothing flagged', reviewable: true, detail: 'Every step finished and nothing in the record was flagged.' })
    expect(answerVerdict({ ...finished, read: { files: 12, pages: 2, notes: 0 } }).detail).toBe('Every step finished, reading 12 files and 2 web pages, and nothing in the record was flagged.')
  })

  it('counts what is worth a look and leads with the worst of it', () => {
    const verdict = answerVerdict({ ...finished, receipt: receipt(
      [{ tone: 'ok', text: 'Researcher finished' }, { tone: 'bad', text: 'Researcher wasn’t allowed to search the web, and carried on without it', evidenceId: 'p1' }],
      [{ tone: 'warn', text: 'Writer was given the skill “style” but the record never shows it opened' }],
    ) })
    expect(verdict).toMatchObject({ tone: 'look', label: '2 things to check', detail: 'Researcher wasn’t allowed to search the web, and carried on without it.' })
    expect(verdict.findings.map((line) => line.tone)).toEqual(['bad', 'warn'])
  })

  it('shows what the answer’s author could not meet or kept against a check, beside the answer they were taken off', () => {
    const verdict = answerVerdict({ ...finished, notes: { agentId: 'writer', notMet: ['Story 2 has a link: the page is down'], missing: ['The March total: no sheet was attached'], notChanged: ['2.5 million: the report says so'], changes: [] } })
    expect(verdict).toMatchObject({ tone: 'look', label: '3 things to check', detail: 'Could not meet: Story 2 has a link: the page is down.' })
    expect(verdict.findings).toEqual([
      { tone: 'warn', text: 'Could not meet: Story 2 has a link: the page is down', agentId: 'writer', markdown: true },
      { tone: 'warn', text: 'Missing: The March total: no sheet was attached', agentId: 'writer', markdown: true },
      { tone: 'warn', text: 'Kept against the check: 2.5 million: the report says so', agentId: 'writer', markdown: true },
    ])
  })

  // Quality bench pilot 1: the Editor's change list was delivered as part of the answer.
  it('lists the edits taken off the answer beside it, without counting an edit as a problem', () => {
    const notes = { agentId: 'editor', notMet: [], missing: [], notChanged: [], changes: ['"overnight" became "at night"', 'Cut a repeated "the water"'] }
    const clean = answerVerdict({ ...finished, notes })
    expect(clean).toMatchObject({ tone: 'ok', label: 'Nothing flagged', detail: 'Every step finished and nothing in the record was flagged. The review lists 2 changes made to the draft.', findings: [] })
    expect(clean.changes).toEqual([
      { tone: 'ok', text: '"overnight" became "at night"', agentId: 'editor', markdown: true },
      { tone: 'ok', text: 'Cut a repeated "the water"', agentId: 'editor', markdown: true },
    ])
    // What the Editor flagged goes under Missing, which is worth a look; the edits still are not.
    const flagged = answerVerdict({ ...finished, notes: { ...notes, missing: ['The end date: the notice gives none'] } })
    expect(flagged).toMatchObject({ tone: 'look', label: '1 thing to check', detail: 'Missing: The end date: the notice gives none. The review lists 2 changes made to the draft.' })
    expect(flagged.changes).toHaveLength(2)
    expect(answerVerdict({ ...finished, notes: { ...notes, changes: [] } })).not.toHaveProperty('changes')
  })

  it('leads with a failure even when a check step also missed something', () => {
    const verdict = answerVerdict({
      ...finished,
      receipt: receipt([{ tone: 'bad', text: 'Researcher wasn’t allowed to search the web, and carried on without it' }]),
      checks: [{ checker: 'checker', checked: 'writer', round: 1, items: [{ verdict: 'not_met', item: 'Every claim has a link', evidence: '' }] }],
    })
    expect(verdict.findings.map((line) => line.tone)).toEqual(['bad', 'warn'])
    expect(verdict.detail).toBe('Researcher wasn’t allowed to search the web, and carried on without it.')
  })

  // ADR 0062: only the last round decides the badge, so what a send-back fixed is said beside it.
  it('says what the check found and how much of it was fixed before you saw the answer', () => {
    const met = (item: string): CheckItemResult => ({ verdict: 'met', item, evidence: 'seen' })
    const missed = (item: string): CheckItemResult => ({ verdict: 'not_met', item, evidence: 'not seen' })
    const round = (first: CheckItemResult[], items: CheckItemResult[]) => [{ checker: 'checker', checked: 'writer', round: 2, first, items }]
    expect(answerVerdict({ ...finished, checks: round([missed('Linked'), missed('Short')], [met('Linked'), met('Short')]) })).toMatchObject({
      tone: 'ok',
      detail: 'Every step finished and nothing in the record was flagged. Every check was met. The check found 2 problems, and both were fixed before you saw this answer.',
    })
    expect(answerVerdict({ ...finished, checks: round([missed('Linked'), missed('Short')], [met('Linked'), missed('Short')]) })).toMatchObject({
      tone: 'look',
      detail: 'Check not met: Short (not seen). The check found 2 problems, and 1 of them was fixed before you saw this answer.',
    })
    expect(answerVerdict({ ...finished, checks: round([missed('Linked')], [missed('Linked')]) }).detail).toBe('Check not met: Linked (not seen). The check found 1 problem, and none was fixed when the work was sent back.')
    // Nothing sent back, nothing said.
    expect(answerVerdict({ ...finished, checks: [{ checker: 'checker', checked: 'writer', round: 1, items: [met('Linked')] }] }).detail).toBe('Every step finished and nothing in the record was flagged. Every check was met.')
  })

  // ADR 0062: you saw what was not met at the check step's stop and kept the work as it was.
  it('says you approved the answer with checks not met', () => {
    const missed: CheckItemResult = { verdict: 'not_met', item: 'Linked', evidence: 'claim 2' }
    const unsure: CheckItemResult = { verdict: 'not_sure', item: 'Short', evidence: '' }
    const approved = (items: CheckItemResult[]) => answerVerdict({ ...finished, checks: [{ checker: 'checker', checked: 'writer', round: 3, items, approved: true }] })
    expect(approved([missed, unsure])).toMatchObject({ tone: 'look', label: 'Approved with 2 checks not met', detail: 'You approved it as it was. Check not met: Linked (claim 2).' })
    expect(approved([missed]).label).toBe('Approved with 1 check not met')
  })

  // The checker writes Markdown: the review shows it formatted, the badge's tooltip as its words.
  it('says a check’s Markdown as its words in the sentence beside the badge', () => {
    const missed: CheckItemResult = { verdict: 'not_met', item: 'Uses `idf()` as written', evidence: 'gives **1.897**, per [IR book](https://nlp.stanford.edu/IR-book/)' }
    const unsure: CheckItemResult = { verdict: 'not_sure', item: 'Under `200` words', evidence: '' }
    const verdict = answerVerdict({ ...finished, checks: [{ checker: 'checker', checked: 'writer', round: 1, items: [missed, unsure] }] })
    expect(verdict.detail).toBe('Check not met: Uses idf() as written (gives 1.897, per IR book).')
    expect(verdict.findings).toEqual([
      { tone: 'warn', text: 'Check not met: Uses `idf()` as written (gives **1.897**, per [IR book](https://nlp.stanford.edu/IR-book/))', agentId: 'checker', markdown: true },
      { tone: 'warn', text: 'Check not sure: Under `200` words', agentId: 'checker', markdown: true },
    ])
    // A line of the app's own keeps every character, an underscore in a file name too.
    const own = answerVerdict({ ...finished, receipt: receipt([{ tone: 'bad', text: 'Writer couldn’t read notes_2025.md, and carried on without it', evidenceId: 'f1' }]) })
    expect(own.detail).toBe('Writer couldn’t read notes_2025.md, and carried on without it.')
  })

  // A reply the daemon could not read checked nothing: one finding says so, not a Not sure per item.
  it('says a check that could not be read confirmed nothing', () => {
    const verdict = answerVerdict({ ...finished, checks: [{ checker: 'checker', checked: 'writer', round: 1, readable: false, items: [{ verdict: 'not_sure', item: 'Linked', evidence: 'no block' }, { verdict: 'not_sure', item: 'Short', evidence: 'no block' }] }] })
    expect(verdict).toMatchObject({ tone: 'look', label: '1 thing to check' })
    expect(verdict.findings).toEqual([{ tone: 'warn', text: 'The check could not be read, so nothing it checked is confirmed', agentId: 'checker' }])
  })

  it('calls an answer from a run that did not finish partial, whatever else it holds', () => {
    expect(answerVerdict({ ...finished, phase: 'partial', receipt: receipt([{ tone: 'bad', text: 'Researcher stopped (exit code 1)' }]) })).toMatchObject({ tone: 'bad', label: 'Partial answer', detail: 'Researcher stopped (exit code 1).' })
    expect(answerVerdict({ ...finished, phase: 'cancelled' })).toMatchObject({ label: 'Stopped early', detail: 'The team did not finish, so parts of this answer may be missing.' })
  })

  // A replay pages its record in: before the last page, stages that ran read "didn't run" and a
  // normal end of turn reads as a stop, so the count would start wrong and jump.
  it('waits for the whole record before counting anything', () => {
    expect(answerVerdict({ ...finished, settled: false, receipt: receipt([{ tone: 'bad', text: 'Planner stopped (end turn)' }]) })).toMatchObject({ tone: 'live', label: 'Reading the record', findings: [], reviewable: false })
  })

  it('lets your own review stand over the findings', () => {
    expect(answerVerdict({ ...finished, reviewed: true, receipt: receipt([{ tone: 'bad', text: 'A call failed' }]) })).toMatchObject({ tone: 'ok', label: 'Reviewed by you', reviewable: true })
  })

  it('offers no review while the answer is still being written, or when there is none', () => {
    expect(answerVerdict({ ...finished, streaming: true, terminal: false, receipt: null })).toMatchObject({ tone: 'live', label: 'Writing', reviewable: false })
    expect(answerVerdict({ ...finished, terminal: false, receipt: null })).toMatchObject({ tone: 'live', label: 'In progress', reviewable: false })
    expect(answerVerdict({ ...finished, text: '', terminal: true })).toMatchObject({ tone: 'bad', label: 'No answer', reviewable: false })
    expect(answerVerdict({ ...finished, text: '', terminal: false, receipt: null })).toMatchObject({ tone: 'live', label: 'In progress', detail: 'The team’s response will appear here.' })
  })
})

describe('findingsOf', () => {
  // The receipt explains refusals in a note of its own; that note is not a second finding.
  it('counts a refusal once, not again for the note that explains refusals', () => {
    const refused = { id: 'p1', agentId: 'researcher', seq: 1, offsetMs: 0, kind: 'permission', relation: 'asked permission for', name: 'Web search', status: 'rejected', target: null, rawInput: { toolCall: { kind: 'fetch' } } } as unknown as Evidence
    const projection = { agents: [{ id: 'researcher', status: 'succeeded', openCalls: 0, exitCode: null, stopReason: null, requiredSkills: [] }], attention: [], coverage: {} } as unknown as RunProjection
    const built = buildReceipt({ attempt: 3, prompt: 'Brief', phase: 'succeeded', elapsed: '2m', agents: [{ id: 'researcher', name: 'Researcher', operator: false }], projection, evidenceByAgent: new Map([['researcher', [refused]]]), harnessLabels: new Map(), answered: true })
    expect(built.checks).toHaveLength(1)
    expect(findingsOf(built).map((line) => line.text)).toEqual(['Researcher wasn’t allowed to search the web, and carried on without it'])
  })

  it('lists a line the receipt prints twice only once', () => {
    expect(findingsOf(receipt([{ tone: 'bad', text: 'Search failed' }], [{ tone: 'warn', text: 'Search failed' }]))).toHaveLength(1)
  })
})
