import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunRecord } from '../../lib/runs/client'
import { projectRun, type RunEvent } from '../../lib/watch/events'
import { AgentAnswer } from './AgentChat'

// Maya's run: she wrote the page, then named it in plain words in her long answer.
const PAGE = '/Users/me/sutd-final-project/design/architecture.html'
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 26, 4, 0, seconds)).toISOString()
const event = (seq: number, kind: RunEvent['kind'], payload: RunEvent['payload']): RunEvent => ({ id: `event-${seq}`, sessionId: 'run-1', agentId: 'maya', seq, ts: at(seq), kind, payload })
const events: RunEvent[] = [
  event(0, 'process', { phase: 'spawned', pid: 7 }),
  event(1, 'tool_call', { callId: 'w1', title: 'Write design/architecture.html', toolKind: 'edit', status: 'in_progress', rawInput: { path: 'design/architecture.html' }, locations: [{ path: PAGE }] }),
  event(2, 'tool_update', { callId: 'w1', status: 'completed' }),
  event(3, 'turn_end', { stopReason: 'end_turn' }),
  event(4, 'process', { phase: 'exited', exitCode: 0 }),
]
const reply = `# The architecture\n\n${'The live path sits in the top half. '.repeat(30)}\n\nFiles are in /Users/me/sutd-final-project/design:\n- architecture.html`
const record: RunRecord = {
  runId: 'run-1', sessionId: 'run-1', teamPath: '.jobs/.bench/maya.yaml', prompt: 'design it', status: 'succeeded', mode: 'team',
  entrypoint: 'maya', responder: 'maya', agentIds: ['maya'], createdAt: at(0), startedAt: at(0), finishedAt: at(4), error: null, exitCode: 0, eventCount: events.length,
  reply, trigger: 'manual',
}
vi.mock('../../lib/runs/useRunSession', () => ({
  useRunSession: () => {
    const projection = projectRun(events)
    return { record, applyRecord: vi.fn(), missing: false, events, error: null, connected: true, loading: false, projection, latest: projection, cursor: null, setCursor: vi.fn(), lastSeq: 4, mode: 'replay', terminal: true, evidenceComplete: true }
  },
}))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('an agent’s long answer, read over its bench', () => {
  it('opens a file the run wrote where the answer names it in plain words', async () => {
    render(<AgentAnswer runId="run-1" name="Maya" onClose={vi.fn()} />)
    const chip = await screen.findByRole('button', { name: /architecture\.html/ })
    expect(chip.getAttribute('title')?.split('\n')[0]).toBe(PAGE)
  })
})
