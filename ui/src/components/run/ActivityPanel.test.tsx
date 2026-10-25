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

/**
 * LoomWatch's own engine, as run aace60a2 recorded it: the title is "Run: " and the command's first
 * line cut short; the whole command is only in the input.
 */
function run(agentId: string, callId: string, command: string, output: string, failed: boolean, from: number): Omit<RunEvent, 'id' | 'seq' | 'sessionId'>[] {
  return [
    { agentId, ts: at(from), kind: 'tool_call', payload: { callId, title: `Run: ${command.split('\n')[0]}${command.includes('\n') ? '…' : ''}`, toolKind: 'execute', status: 'in_progress', rawInput: { command, timeout_seconds: 120 }, locations: [{ path: '/Users/you/LoomWatch/teams/.jobs/.bench/.loomwatch/bench-coby/coby' }] } },
    { agentId, ts: at(from + 1), kind: 'tool_update', payload: { callId, status: failed ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: output } }] } },
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
const row = (term: string) => screen.getByText(term, { selector: 'dt' }).nextElementSibling as HTMLElement

describe('ActivityPanel for a failed call', () => {
  it('says what it tried, that it was fixed, and why the first try failed; the fix opens', () => {
    const onInspectEvidence = vi.fn()
    render(<ActivityPanel evidence={call('build')} ownerLabel="Editor · final answer" calls={calls} finished={false} onInspectEvidence={onInspectEvidence} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Editor couldn’t run build.py' })).toBeInTheDocument()
    expect(screen.getByText('Fixed')).toBeInTheDocument()
    expect(row('Why')).toHaveTextContent('The program it wrote had a mistake in it.')
    expect(row('Effect')).toHaveTextContent('Nothing lost')
    fireEvent.click(screen.getByRole('button', { name: 'Ran again 14 seconds later and worked' }))
    expect(onInspectEvidence).toHaveBeenCalledWith('editor:rebuild')
  })

  it('says why in plain words and keeps the traceback under Technical details', () => {
    const { container } = render(<ActivityPanel evidence={call('montage')} ownerLabel="Editor" calls={calls} finished={false} onInspectEvidence={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Editor couldn’t run a short Python program' })).toBeInTheDocument()
    expect(screen.getByText('Didn’t work')).toBeInTheDocument()
    expect(row('Why')).toHaveTextContent('A Python add-on it needs, PIL, isn’t installed.')
    expect(screen.queryByRole('button', { name: /worked/ })).toBeNull()
    const details = container.querySelector('details.act-tech') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details).toHaveTextContent("ModuleNotFoundError: No module named 'PIL'")
  })

  it('reads a command LoomWatch’s own engine ran: the pages it fetched, the site’s refusal, and that it went on', () => {
    const script = "python3 - <<'PY'\nimport urllib.request,pathlib\nfor n,u in [('optimization','https://docs.vllm.ai/en/latest/configuration/optimization/'),('assisted','https://huggingface.co/docs/transformers/en/assisted_decoding')]:\n p=urllib.request.urlopen(u,timeout=40).read()\nPY"
    const refused = 'The command failed with exit code 1.\nTraceback (most recent call last):\n  File "<stdin>", line 3, in <module>\nurllib.error.HTTPError: HTTP Error 403: Forbidden\n'
    const coby = projectRun(record([
      ...run('coby', 'fetch', script, refused, true, 0),
      ...run('coby', 'look', 'ls research', 'notes.txt', false, 9),
    ])).evidence
    render(<ActivityPanel evidence={coby[0]} ownerLabel="Coby · lead" calls={coby} finished={false} onInspectEvidence={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Coby couldn’t fetch 2 web pages' })).toBeInTheDocument()
    expect(row('Sites')).toHaveTextContent('docs.vllm.aihuggingface.co')
    expect(row('Why')).toHaveTextContent('The website said no.403')
    expect(row('Then')).toHaveTextContent('Carried on without them')
    expect(screen.queryByText('Effect', { selector: 'dt' })).toBeNull()
    // The command itself, line by line, under Technical details.
    expect(screen.getByText('Command').nextElementSibling?.textContent).toBe(script)
  })

  it('opens Technical details when nothing in the output says why', () => {
    const odd = projectRun(record(run('coby', 'odd', 'python3 tally.py', "The command failed with exit code 1.\nKeyError: 'rows'", true, 0))).evidence
    const { container } = render(<ActivityPanel evidence={odd[0]} ownerLabel="Coby" calls={odd} finished={false} onInspectEvidence={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Coby couldn’t run tally.py' })).toBeInTheDocument()
    expect(row('Why')).toHaveTextContent('Its program stopped with an error.')
    expect((container.querySelector('details.act-tech') as HTMLDetailsElement).open).toBe(true)
  })

  it('tells a call you declined as your choice, not as a failure', () => {
    const declined = projectRun(record([
      ...run('coby', 'get', 'curl -sL https://arxiv.org/abs/1706.03762', 'The person declined this. Carry on without it, or say what you need and why.', true, 0),
      ...run('coby', 'next', 'ls', 'notes.txt', false, 4),
    ])).evidence
    render(<ActivityPanel evidence={declined[0]} ownerLabel="Coby" calls={declined} finished onInspectEvidence={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Coby didn’t fetch a web page' })).toBeInTheDocument()
    expect(screen.getByText('You said no')).toBeInTheDocument()
    expect(screen.queryByText('Why', { selector: 'dt' })).toBeNull()
    expect(row('Then')).toHaveTextContent('Carried on without it')
    expect(row('Effect')).toHaveTextContent('Its answer was made without it')
  })
})

/**
 * LoomWatch's own engine, as run 948bd594 recorded its tutor: a reply cut off at its length limit
 * while writing a 25 KB lesson reached LoomWatch as an empty `write_file`, and the next call wrote it.
 */
const lesson = '/Users/you/LoomWatch/teams/.loomwatch/first-principles-school/tutor/lessons/Enterprise KB Indexing.html'
function tool(agentId: string, callId: string, title: string, toolKind: string, rawInput: Record<string, unknown>, output: string, failed: boolean, from: number): Omit<RunEvent, 'id' | 'seq' | 'sessionId'>[] {
  const locations = typeof rawInput.path === 'string' ? [{ path: lesson.replace(/lessons\/.*$/, rawInput.path) }] : []
  return [
    { agentId, ts: at(from), kind: 'tool_call', payload: { callId, title, toolKind, status: 'in_progress', rawInput, locations } },
    { agentId, ts: at(from + 1), kind: 'tool_update', payload: { callId, status: failed ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: output } }] } },
  ]
}

describe('ActivityPanel, on what a call that didn’t work came to', () => {
  it('reads an empty call the agent made again as fixed, with no effect, and names no tool as a file', () => {
    const tutor = projectRun(record([
      ...tool('tutor', 'empty', 'write_file', 'other', {}, '`path` is required and must be text.', true, 0),
      ...tool('tutor', 'write', 'Write lessons/Enterprise KB Indexing.html', 'edit', { path: 'lessons/Enterprise KB Indexing.html', content: '<!doctype html>' }, 'Created lessons/Enterprise KB Indexing.html (25704 bytes).', false, 6),
    ])).evidence
    const onInspectEvidence = vi.fn()
    render(<ActivityPanel evidence={tutor[0]} ownerLabel="First-principles tutor" calls={tutor} finished onInspectEvidence={onInspectEvidence} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'First-principles tutor couldn’t edit a file' })).toBeInTheDocument()
    expect(screen.getByText('Fixed')).toBeInTheDocument()
    expect(row('Why')).toHaveTextContent('It didn’t say which file.')
    expect(row('Effect')).toHaveTextContent('Nothing lost')
    fireEvent.click(screen.getByRole('button', { name: 'Worked on another try 6 seconds later' }))
    expect(onInspectEvidence).toHaveBeenCalledWith('tutor:write')
  })

  it('says a change that wasn’t made, whether or not the agent has finished', () => {
    const edits = projectRun(record([
      ...tool('tutor', 'edit', 'Edit lessons/notes.md', 'edit', { path: 'lessons/notes.md', old_text: 'BM25', new_text: 'BM25F' }, "old_text doesn't appear in lessons/notes.md.", true, 0),
      ...tool('tutor', 'next', 'Read lessons/plan.md', 'read', { path: 'lessons/plan.md' }, 'plan', false, 4),
    ])).evidence
    render(<ActivityPanel evidence={edits[0]} ownerLabel="Tutor" calls={edits} finished={false} onInspectEvidence={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Didn’t work')).toBeInTheDocument()
    expect(row('Effect')).toHaveTextContent('The change to lessons/notes.md wasn’t made')
  })

  it('says the answer was made without what a read got it nothing of, once the agent has finished', () => {
    const reads = projectRun(record([
      ...tool('tutor', 'read', 'Read lessons/facts.md', 'read', { path: 'lessons/facts.md' }, "lessons/facts.md doesn't exist.", true, 0),
      ...tool('tutor', 'next', 'Read lessons/plan.md', 'read', { path: 'lessons/plan.md' }, 'plan', false, 4),
    ])).evidence
    const { rerender } = render(<ActivityPanel evidence={reads[0]} ownerLabel="Tutor" calls={reads} finished={false} onInspectEvidence={vi.fn()} onClose={vi.fn()} />)
    expect(row('Then')).toHaveTextContent('Carried on without it')
    expect(screen.queryByText('Effect', { selector: 'dt' })).toBeNull()
    rerender(<ActivityPanel evidence={reads[0]} ownerLabel="Tutor" calls={reads} finished onInspectEvidence={vi.fn()} onClose={vi.fn()} />)
    expect(row('Effect')).toHaveTextContent('Its answer was made without it')
  })

  it('says what a last call came to, when no Then row is shown', () => {
    const last = projectRun(record(tool('tutor', 'read', 'Read lessons/facts.md', 'read', { path: 'lessons/facts.md' }, 'The person declined this. Carry on without it, or say what you need and why.', true, 0))).evidence
    render(<ActivityPanel evidence={last[0]} ownerLabel="Tutor" calls={last} finished onInspectEvidence={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByText('Then', { selector: 'dt' })).toBeNull()
    expect(row('Effect')).toHaveTextContent('Its answer was made without it')
  })

  it('says nothing was changed by an empty call the agent never made again, and names no tool as a file', () => {
    const cut = projectRun(record(tool('tutor', 'empty', 'write_file', 'other', {}, '`path` is required and must be text.', true, 0))).evidence
    render(<ActivityPanel evidence={cut[0]} ownerLabel="Tutor" calls={cut} finished={false} onInspectEvidence={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Didn’t work')).toBeInTheDocument()
    expect(row('Effect')).toHaveTextContent('Nothing was changed')
  })

  it('says a teammate didn’t get work sent to it, while the sender is still working', () => {
    const sent = projectRun(record([
      { agentId: 'lead', ts: at(0), kind: 'tool_call', payload: { callId: 'd', title: 'Team Bus: dispatch', name: 'dispatch', toolKind: 'other', status: 'in_progress', rawInput: { agent: 'researcher', task: 'Find the Q3 numbers.' } } },
      { agentId: 'lead', ts: at(1), kind: 'tool_update', payload: { callId: 'd', status: 'failed', rawOutput: { error: 'researcher is not on this team.' } } },
    ])).evidence
    render(<ActivityPanel evidence={sent[0]} ownerLabel="Lead" calls={sent} finished={false} onInspectEvidence={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Lead couldn’t send work to researcher' })).toBeInTheDocument()
    expect(row('Effect')).toHaveTextContent('researcher didn’t get the work')
  })
})

describe('ActivityPanel for a question to another agent', () => {
  it('reads the question and the answer as words, not only as the call’s JSON', () => {
    const asked = projectRun(record([
      { agentId: 'writer', ts: at(0), kind: 'tool_call', payload: { callId: 'q', title: 'Team Bus: ask', name: 'ask', toolKind: 'other', status: 'in_progress', rawInput: { agent: 'researcher', question: 'Which spec version did you read?' } } },
      { agentId: 'writer', ts: at(9), kind: 'tool_update', payload: { callId: 'q', status: 'completed', rawOutput: { agent: 'researcher', reply: 'Version 0.4.', live: true } } },
    ])).evidence[0]
    render(<ActivityPanel evidence={asked} ownerLabel="Writer" calls={[asked]} finished onInspectEvidence={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Worked')).toBeInTheDocument()
    expect(screen.getByText('Question').nextElementSibling).toHaveTextContent('Which spec version did you read?')
    expect(screen.getByText('Answer from researcher').nextElementSibling).toHaveTextContent('Version 0.4.')
  })

  it('shows the words as the agent wrote them, its Markdown formatted', async () => {
    const asked = projectRun(record([
      { agentId: 'writer', ts: at(0), kind: 'tool_call', payload: { callId: 'q', title: 'Team Bus: ask', name: 'ask', toolKind: 'other', status: 'in_progress', rawInput: { agent: 'researcher', question: 'Is **0.4** the version `spec.md` names?\n\n- one\n- two' } } },
    ])).evidence[0]
    render(<ActivityPanel evidence={asked} ownerLabel="Writer" calls={[asked]} finished={false} onInspectEvidence={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByText('0.4', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText('spec.md', { selector: 'code' })).toBeInTheDocument()
    const said = screen.getByText('Question').nextElementSibling as HTMLElement
    expect(said).toHaveClass('selectable')
    expect(said.querySelectorAll('li')).toHaveLength(2)
    expect(said).not.toHaveTextContent('**')
  })

  it('says the teammate had already finished, and that it went on without an answer', () => {
    const late = projectRun(record([
      { agentId: 'writer', ts: at(0), kind: 'tool_call', payload: { callId: 'q', title: 'Team Bus: ask', name: 'ask', toolKind: 'other', status: 'in_progress', rawInput: { agent: 'researcher', question: 'Which spec?' } } },
      { agentId: 'writer', ts: at(1), kind: 'tool_update', payload: { callId: 'q', status: 'failed', rawOutput: { error: 'Researcher has finished its part of this run and is no longer open, so it can\'t be asked.', refused: 'finished' } } },
      ...run('writer', 'next', 'ls', 'draft.md', false, 3),
    ])).evidence
    render(<ActivityPanel evidence={late[0]} ownerLabel="Writer" calls={late} finished onInspectEvidence={vi.fn()} onClose={vi.fn()} />)
    expect(row('Why')).toHaveTextContent('Researcher had already finished its part.')
    expect(row('Then')).toHaveTextContent('Carried on without an answer')
    expect(row('Effect')).toHaveTextContent('Its answer was made without hearing from researcher')
  })
})
