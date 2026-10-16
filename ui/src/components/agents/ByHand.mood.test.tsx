import { act, cleanup, render, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DetectedHarness } from '../../lib/harnesses'
import { BLANK_DRAFT } from '../../lib/library/draft'
import type { RunRecord } from '../../lib/runs/client'
import type { AgentFigureProps } from './AgentFigure'
import { ByHand } from './ByHand'

// What the bench is told to show, in place of drawing it.
const shown: { view: AgentFigureProps['view'] | null } = { view: null }
vi.mock('./AgentFigure', () => ({ default: ({ view }: AgentFigureProps) => { shown.view = view; return null } }))

// The run's events as they arrive, and which session the bench asked to follow.
const stream = vi.hoisted(() => ({ asked: [] as string[], count: 0 }))
vi.mock('../../lib/watch/useSessionEvents', () => ({
  useSessionEvents: (sessionId: string) => {
    stream.asked.push(sessionId)
    return { sessionId, events: sessionId ? Array.from({ length: stream.count }, (_, seq) => ({ seq })) : [], error: null, connected: Boolean(sessionId), loading: false }
  },
}))

const harness: DetectedHarness = { id: 'claude', name: 'Claude', command: 'claude', executablePath: '/bin/claude', acpAvailable: true, spawn: { cmd: 'claude-agent-acp', args: [] } }
const run = (status: RunRecord['status'], eventCount: number | null = null): RunRecord => ({
  runId: 'run-1', sessionId: 'session-1', teamPath: '.jobs/.bench/reader.yaml', prompt: 'Check it', status, mode: 'team', entrypoint: 'reader', responder: 'reader',
  agentIds: ['reader'], createdAt: '2026-10-16T09:00:00.000Z', startedAt: '2026-10-16T09:00:00.000Z', finishedAt: null, error: null, exitCode: null, eventCount, reply: null,
})

function bench(record: RunRecord | null) {
  return <ByHand draft={{ ...BLANK_DRAFT, name: 'Reader', instructions: 'Check it.', appId: 'claude' }} set={vi.fn()} harness={harness} harnesses={[harness]} harnessesLoading={false} models={null} skills={[]} skillsLoading={false} tools={[]} toolsLoading={false} roleField={createRef()} markId="reader" figure={{ kind: 'yarn', color: 'sage' }} record={record} />
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); shown.view = null; stream.asked = []; stream.count = 0 })
afterEach(() => { cleanup(); vi.useRealTimers() })

// The daemon counts a run's events only once it is over (eventCount is null while it runs), so a
// figure moved by that count typed for its first few seconds and then sat still to the end.
describe('the figure at the bench, while its run works', () => {
  it('types while the run’s events arrive, and rests its hands when they stop', async () => {
    stream.count = 3
    const page = render(bench(run('running')))
    await waitFor(() => expect(shown.view?.mood).toBe('working'))
    expect(shown.view?.events).toBe(3)
    expect(stream.asked).toContain('session-1')

    act(() => { vi.advanceTimersByTime(4000) })
    expect(shown.view?.mood).toBe('quiet')

    stream.count = 4
    page.rerender(bench(run('running')))
    expect(shown.view?.mood).toBe('working')
    expect(shown.view?.events).toBe(4)
  })

  it('follows no events once the run is over, and counts them from its record', async () => {
    render(bench(run('succeeded', 12)))
    await waitFor(() => expect(shown.view?.mood).toBe('done'))
    expect(shown.view?.events).toBe(12)
    expect(stream.asked.every((sessionId) => sessionId === '')).toBe(true)
  })
})
