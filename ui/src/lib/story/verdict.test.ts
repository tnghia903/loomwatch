import { describe, expect, it } from 'vitest'

import type { Evidence, RunProjection } from '../watch/events'
import { buildReceipt, type Receipt, type ReceiptLine } from './receipt'
import { answerVerdict, findingsOf, type VerdictInput } from './verdict'

const receipt = (lines: ReceiptLine[], checks: ReceiptLine[] = []): Receipt => ({ heading: 'Run 3 · Finished', asked: 'Brief', took: '2m', team: '2 helpers', ranOn: 'Claude Code', lines, checks })
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
