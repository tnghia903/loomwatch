import { describe, expect, it } from 'vitest'
import { capabilityEvidence } from './capabilityEvidence'
import { projectRun, type RunEvent } from '../watch/events'
import type { AgentConfig } from '../team-file/types'

const agent: AgentConfig = {
  id: 'designer',
  name: 'Designer',
  role: 'Design',
  capabilities: [{ kind: 'skill', name: 'claude-design' }],
}
function read(
  options: {
    agentId?: string
    path?: string
    title?: string
    status?: string
    kind?: string
  } = {},
) {
  const events: RunEvent[] = [
    {
      id: 'e1',
      sessionId: 'run',
      agentId: options.agentId ?? 'designer',
      seq: 1,
      ts: '2026-09-14T10:00:00Z',
      kind: 'tool_call',
      payload: {
        callId: 'read1',
        title: options.title ?? 'Read SKILL.md',
        name: 'read_file',
        toolKind: options.kind ?? 'read',
        rawInput: {
          path: options.path ?? '/work/.agents/skills/claude-design/SKILL.md',
        },
        status: 'in_progress',
      },
    },
    {
      id: 'e2',
      sessionId: 'run',
      agentId: options.agentId ?? 'designer',
      seq: 2,
      ts: '2026-09-14T10:00:01Z',
      kind: 'tool_update',
      payload: { callId: 'read1', status: options.status ?? 'completed' },
    },
  ]
  return projectRun(events).evidence
}
describe('required skill evidence', () => {
  it('recognizes a successful skill read in the receiving harness workspace', () => {
    expect(capabilityEvidence(agent, read())[0]).toMatchObject({
      state: 'read',
      label: 'Read observed',
    })
  })
  it.each([
    { agentId: 'researcher' },
    { path: '/work/.agents/skills/claude-design-extended/SKILL.md' },
    { path: '/work/.agents/skills/claude-design/references/readme.md' },
    { title: 'Use claude-design', path: '/work/unrelated.md' },
    { title: 'List claude-design', kind: 'execute' },
  ])('does not infer loading from mismatched evidence: %j', (options) => {
    expect(capabilityEvidence(agent, read(options))[0].state).toBe('unverified')
  })
  it('retains failed reads as failures', () => {
    expect(capabilityEvidence(agent, read({ status: 'failed' }))[0].state).toBe(
      'failed',
    )
  })
  it('does not verify a redacted receipt', () => {
    expect(
      capabilityEvidence(
        agent,
        read().map((item) => ({ ...item, capture: 'redacted' })),
      )[0].state,
    ).toBe('unverified')
  })
  it('keeps missing required skills visible with no events', () => {
    expect(capabilityEvidence(agent, [])[0]).toMatchObject({
      name: 'claude-design',
      required: true,
      state: 'unverified',
      evidence: [],
    })
  })
})

it('uses the archived resolved path instead of matching another copy by skill name', () => {
  const snapshot = [{name: 'claude-design', source: 'Claude Code', sourcePath: '/source/SKILL.md', path: '/work/.agents/skills/claude-design--abc/SKILL.md', sha256: 'a'.repeat(64), chars: 12, state: 'prepared' as const, eventId: 'prepared'}]
  expect(capabilityEvidence(agent, read(), snapshot)[0].state).toBe('unverified')
  expect(capabilityEvidence(agent, read({path: snapshot[0].path}), snapshot)[0].state).toBe('read')
})
