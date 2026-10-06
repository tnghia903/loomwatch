import { describe, expect, it } from 'vitest'

import type { RunRecord } from '../runs/client'
import { projectRun, type Evidence, type RunProjection } from '../watch/events'
import { checkAnswer, type CheckParty } from './answerCheck'

const record = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  runId: 'run-1', sessionId: 'run-1', teamPath: 'news.yaml', prompt: 'today’s digest', status: 'succeeded', mode: 'pipeline',
  entrypoint: 'researcher', responder: 'writer', agentIds: ['researcher', 'writer'], createdAt: '2026-10-06T02:00:00.000Z',
  startedAt: '2026-10-06T02:00:00.000Z', finishedAt: '2026-10-06T02:04:00.000Z', error: null, exitCode: 0, eventCount: 10,
  reply: '# Digest', trigger: 'manual', ...overrides,
})
const finished = (id: string) => ({ id, status: 'succeeded', openCalls: 0, exitCode: null, stopReason: null, requiredSkills: [] })
const projection = (agents: string[], evidence: Evidence[] = []): RunProjection =>
  ({ ...projectRun([]), phase: 'succeeded', agents: agents.map(finished), evidence }) as unknown as RunProjection
const parties: CheckParty[] = [
  { id: 'researcher', name: 'Researcher', operator: false },
  { id: 'writer', name: 'Writer', operator: false },
]
const check = (input: Partial<Parameters<typeof checkAnswer>[0]> = {}) =>
  checkAnswer({ record: record(), projection: projection(['researcher', 'writer']), parties, answer: '# Digest', streaming: false, settled: true, reviewed: false, ...input })

// ADR 0051: the verdict Details printed beside its copy of the answer, now worked out for the
// answer in the chat from that piece's own record.
describe('what an answer’s record holds to check', () => {
  it('says nothing was flagged when every step finished and nothing in the record was', () => {
    const { verdict } = check()
    expect(verdict.label).toBe('Nothing flagged')
    expect(verdict.detail).toBe('Every step finished and nothing in the record was flagged.')
    expect(verdict.reviewable).toBe(true)
  })

  it('names what is worth a look, and points at its record', () => {
    const refused = { id: 'p1', agentId: 'writer', seq: 1, offsetMs: 0, kind: 'permission', relation: 'asked permission for', name: 'Web search', status: 'rejected', target: null, rawInput: { toolCall: { kind: 'fetch' } } } as unknown as Evidence
    const { verdict } = check({ projection: projection(['researcher', 'writer'], [refused]) })
    expect(verdict.label).toBe('1 thing to check')
    expect(verdict.findings[0]).toMatchObject({ text: 'Writer wasn’t allowed to search the web, and carried on without it', evidenceId: 'p1' })
  })

  // A linked folder read as a file (EISDIR), then the files in it, read as "1 thing to check"; and
  // a clean run "read 1 source", which was your own answer at the review stop.
  it('neither flags a folder whose files were read nor counts your answer as a source', () => {
    const folder = '/Users/Shared/harbor-pine/q3-reports'
    const read = (id: string, path: string, status = 'succeeded') => ({ id, agentId: 'researcher', seq: 1, offsetMs: 0, kind: 'file', relation: 'read file', name: `Read ${path}`, status, toolKind: 'read', rawInput: { file_path: path }, locations: [{ path, line: 1 }], target: null }) as unknown as Evidence
    const answer = { id: 'a1', agentId: 'review', seq: 9, offsetMs: 0, kind: 'source', relation: 'directed', name: 'Your answer', status: 'succeeded', toolKind: null, rawInput: null, locations: [], target: null } as unknown as Evidence
    const evidence = [read('r0', folder, 'failed'), ...['README.md', 'q3-sales.md', 'q3-churn.md'].map((file, index) => read(`r${index + 1}`, `${folder}/${file}`)), answer]
    const { verdict } = check({ projection: projection(['researcher', 'writer'], evidence) })
    expect(verdict.label).toBe('Nothing flagged')
    expect(verdict.detail).toBe('Every step finished, reading 3 files, and nothing in the record was flagged.')
  })

  // "@Writer make it punchier" ran Writer alone: Researcher was never asked, so it is not missing.
  it('checks a one-agent turn against that agent alone', () => {
    const { receipt, verdict } = check({ record: record({ onlyAgent: 'writer' }), projection: projection(['writer']) })
    expect(receipt?.lines.map((line) => line.text)).toEqual(['Writer finished'])
    expect(verdict.label).toBe('Nothing flagged')
  })

  it('says a stage that was still working when the run ended did not finish', () => {
    const stuck = { ...projectRun([]), phase: 'partial', agents: [finished('researcher'), { ...finished('writer'), status: 'running' }], evidence: [] } as unknown as RunProjection
    const { verdict } = check({ projection: stuck })
    expect(verdict.tone).toBe('bad')
    expect(verdict.label).toBe('Partial answer')
  })

  it('waits for the whole record before saying anything, and says so while the answer is written', () => {
    expect(check({ settled: false }).verdict.label).toBe('Reading the record')
    expect(check({ record: record({ status: 'running' }), streaming: true }).verdict.label).toBe('Writing')
  })

  it('counts the skills the team requires, and how many it opened', () => {
    const designer = { id: 'writer', name: 'Writer', role: 'Write', capabilities: [{ kind: 'skill', name: 'claude-design' }] }
    // A record from before the daemon listed required skills: the team file's wiring says which.
    const unlisted = { ...projection(['researcher', 'writer']), agents: [finished('researcher'), { ...finished('writer'), requiredSkills: undefined }] } as unknown as RunProjection
    const result = check({ projection: unlisted, parties: [parties[0], { ...parties[1], config: designer as unknown as CheckParty['config'] }] })
    expect(result).toMatchObject({ required: 1, opened: 0 })
    expect(check({ reviewed: true }).verdict.label).toBe('Reviewed by you')
  })
})
