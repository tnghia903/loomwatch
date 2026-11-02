import { describe, expect, it } from 'vitest'

import type { RunRecord } from '../runs/client'
import { projectRun, type Evidence, type RunEvent, type RunProjection } from '../watch/events'
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

  // Run 03f7b0dd: LoomWatch's own check ran on a ChatGPT plan at its usage limit, and the answer's
  // finding read "loomwatch:check stopped". It is not on the team, so it was named by its id.
  it('names LoomWatch’s own check, and says the answer wasn’t checked and why', () => {
    const limit = 'LoomWatch has reached a usage limit on your ChatGPT plan: the plan\'s own limit, or the share you allowed LoomWatch. See it under Manage usage in ChatGPT\'s settings.'
    const at = (seq: number) => new Date(Date.UTC(2026, 10, 2, 16, 51, seq)).toISOString()
    const on = (agentId: string, seq: number, kind: RunEvent['kind'], payload: RunEvent['payload'], raw?: unknown): RunEvent =>
      ({ id: `${agentId}-${seq}`, sessionId: 'run-1', agentId, seq, ts: at(seq), kind, payload, ...(raw ? { raw } : {}) })
    const events = [
      ...['researcher', 'writer'].flatMap((id, index) => [
        on(id, index * 4, 'process', { phase: 'spawned', pid: index }),
        on(id, index * 4 + 1, 'message', { role: 'agent', content: { type: 'text', text: '# Digest' } }),
        on(id, index * 4 + 2, 'turn_end', { stopReason: 'end_turn' }),
        on(id, index * 4 + 3, 'process', { phase: 'exited', exitCode: 0 }),
      ]),
      on('loomwatch:check', 8, 'process', { phase: 'spawned', pid: 9 }),
      on('loomwatch:check', 9, 'session_meta', { phase: 'turn_failed', reason: 'app_error', message: limit, problem: { kind: 'plan_limit', source: 'chatgpt', url: 'https://chatgpt.com/settings/usage' } }, { source: 'loomwatch', phase: 'turn_failed' }),
    ]
    // The run as the daemon ended it: a check that couldn't run leaves the answer whole, not partial.
    const projection = projectRun(events, Infinity, { status: 'succeeded', evidenceComplete: true })
    expect(projection.phase).toBe('succeeded')
    const { verdict } = check({ record: record({ mode: 'team' }), projection })
    expect(verdict.label).toBe('1 thing to check')
    expect(verdict.findings.map((line) => line.text)).toEqual([`The answer wasn’t checked. ${limit}`])
    // Its sentence already ends: the badge's hover doesn't add a second full stop.
    expect(verdict.detail).toContain(`The answer wasn’t checked. ${limit}`)
    expect(verdict.detail).not.toContain('..')
  })

  // ADR 0079: a helper is on no team file either, and is named after the agent it helps.
  it('names a helper that stopped after the agent it helps', () => {
    const at = (seq: number) => new Date(Date.UTC(2026, 10, 2, 16, 51, seq)).toISOString()
    const on = (agentId: string, seq: number, kind: RunEvent['kind'], payload: RunEvent['payload']): RunEvent =>
      ({ id: `${agentId}-${seq}`, sessionId: 'run-1', agentId, seq, ts: at(seq), kind, payload })
    const events = [
      on('writer', 0, 'process', { phase: 'spawned', pid: 1 }),
      on('writer~2', 1, 'process', { phase: 'spawned', pid: 2 }),
      on('writer~2', 2, 'process', { phase: 'exited', exitCode: 1 }),
      on('writer', 3, 'message', { role: 'agent', content: { type: 'text', text: '# Digest' } }),
      on('writer', 4, 'turn_end', { stopReason: 'end_turn' }),
      on('writer', 5, 'process', { phase: 'exited', exitCode: 0 }),
    ]
    const { verdict } = check({ record: record({ mode: 'team', onlyAgent: undefined }), projection: projectRun(events, Infinity, { status: 'succeeded', evidenceComplete: true }), parties: [parties[1]] })
    expect(verdict.findings.map((line) => line.text)).toContain('Writer’s helper 2 stopped (exit code 1)')
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
