import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { projectRun, type RunEvent } from '../../lib/watch/events'
import { ActivityPanel } from './ActivityPanel'

afterEach(cleanup)

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 4, 17, 12, seconds)).toISOString()

/** Claude Code's Bash as a recorded run (6ca4befe) has it: "Terminal", then the command, then the result. */
function bash(callId: string, command: string, output: string, failed: boolean, from: number): Omit<RunEvent, 'id' | 'seq' | 'sessionId'>[] {
  return [
    { agentId: 'editor', ts: at(from), kind: 'tool_call', payload: { name: 'Bash', title: 'Terminal', callId, status: 'pending', content: [], rawInput: {}, toolKind: 'execute' } },
    { agentId: 'editor', ts: at(from), kind: 'tool_update', payload: { title: command, callId, rawInput: { command } } },
    { agentId: 'editor', ts: at(from + 1), kind: 'tool_update', payload: { callId, status: failed ? 'failed' : 'completed', rawOutput: output, content: [{ type: 'content', content: { type: 'text', text: output } }] } },
  ]
}

const record = (steps: Omit<RunEvent, 'id' | 'seq' | 'sessionId'>[]): RunEvent[] => steps.map((step, seq) => ({ ...step, id: `event-${seq}`, seq, sessionId: 'run-1' }))

const events = record([
  ...bash('build', "mkdir -p /tmp/build && cat > /tmp/build/build.py <<'E'\nprint(1)\nE\ncd /tmp/build && python3 build.py && ls -la out.docx", 'Exit code 1\nSyntaxError: f-string expression part cannot include a backslash', true, 0),
  ...bash('rebuild', "cd /tmp/build && python3 - <<'E'\nfix()\nE\npython3 build.py && ls -la out.docx", '-rw-r--r-- out.docx', false, 14),
  ...bash('montage', 'cd /tmp/build && python3 -c "\nfrom PIL import Image"', "ModuleNotFoundError: No module named 'PIL'", true, 30),
])
const calls = projectRun(events).evidence
const call = (id: string) => calls.find((item) => item.id === `editor:${id}`) as (typeof calls)[number]

describe('ActivityPanel for a failed call', () => {
  it('says the agent ran it again and it worked, and opens that call', () => {
    const onInspectEvidence = vi.fn()
    render(<ActivityPanel evidence={call('build')} ownerLabel="Editor · final answer" calls={calls} onInspectEvidence={onInspectEvidence} onClose={vi.fn()} />)
    expect(screen.getByText('Editor’s command “python3 build.py” failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ran again 14 seconds later and worked' }))
    expect(onInspectEvidence).toHaveBeenCalledWith('editor:rebuild')
  })

  it('says nothing more when nothing put it right', () => {
    render(<ActivityPanel evidence={call('montage')} ownerLabel="Editor" calls={calls} onInspectEvidence={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Editor’s command “python3 -c …” failed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /worked/ })).toBeNull()
  })
})
