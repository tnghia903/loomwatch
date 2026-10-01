import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { appProblemsFor, appProblemSummary, commandsToCheck, fetchCommandChecks, useAppChecks, type CommandCheck } from './appChecks'
import type { AgentConfig } from './types'

const agent = (id: string, name: string, cmd: string, env: Record<string, string> = {}): AgentConfig =>
  ({ id, name, role: 'Work', model: 'm', spawn: { cmd, args: [], env, cwd: '.' } })
const helper = agent('helper', 'Helper', 'acme-agent-cli')
const writer = agent('writer', 'Writer', 'npx')
const reviewStop: AgentConfig = { id: 'you', name: 'You', role: 'Decide', kind: 'operator' }
const names = new Map([['helper', 'Helper'], ['writer', 'Writer']])
const checks = (...entries: CommandCheck[]) => new Map(entries.map((entry) => [entry.cmd, entry]))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('commandsToCheck', () => {
  it('asks once per command, skipping review stops and agents with no app yet', () => {
    expect(commandsToCheck([writer, helper, agent('second', 'Second', 'npx'), reviewStop, agent('blank', 'Blank', '')])).toEqual(['acme-agent-cli', 'npx'])
  })

  // A run looks such a command up on the agent's own PATH, which the daemon's check never sees.
  it('leaves out an agent that sets its own PATH', () => {
    expect(commandsToCheck([agent('own', 'Own', 'tool', { PATH: '/opt/tools' })])).toEqual([])
  })
})

describe('appProblemsFor', () => {
  it('names the agent and the app that is not installed', () => {
    const [problem] = appProblemsFor([helper, writer], checks({ cmd: 'acme-agent-cli', status: 'not_found' }, { cmd: 'npx', status: 'found', path: '/usr/local/bin/npx' }), names)
    expect(problem).toEqual({
      agentId: 'helper', cmd: 'acme-agent-cli', status: 'not_found',
      sentence: 'Helper’s app “acme-agent-cli” isn’t installed on this computer.',
      remedy: 'Install it, or choose another AI app for Helper.',
    })
  })

  it('reports nothing for an app that will start, or one that cannot be judged', () => {
    expect(appProblemsFor([writer, agent('local', 'Local', './bin/agent')], checks({ cmd: 'npx', status: 'found' }, { cmd: './bin/agent', status: 'unchecked' }), names)).toEqual([])
  })

  // Not knowing is not a reason to stop a run: no answer yet, or an older daemon, says nothing.
  it('reports nothing for a command the daemon has not answered about', () => {
    expect(appProblemsFor([helper], new Map(), names)).toEqual([])
  })

  it('says where an app is when LoomWatch was started without that folder', () => {
    const [problem] = appProblemsFor([agent('helper', 'Helper', 'opencode')], checks({ cmd: 'opencode', status: 'outside_path', path: '/Users/me/.opencode/bin/opencode' }), names)
    expect(problem.sentence).toBe('Helper’s app “opencode” is installed in ~/.opencode/bin, but LoomWatch was started without that folder.')
    expect(problem.remedy).toBe('Restart LoomWatch from a terminal where “opencode” works, or choose another AI app for Helper.')
  })

  it('says when a file named as an app cannot be started', () => {
    const [problem] = appProblemsFor([agent('helper', 'Helper', '/opt/acme/notes.txt')], checks({ cmd: '/opt/acme/notes.txt', status: 'not_executable' }), names)
    expect(problem.sentence).toBe('Helper’s app “/opt/acme/notes.txt” isn’t a program this computer can start.')
  })

  it('does not apply a shared command’s answer to an agent that sets its own PATH', () => {
    const own = agent('own', 'Own', 'acme-agent-cli', { PATH: '/opt/acme/bin' })
    expect(appProblemsFor([helper, own], checks({ cmd: 'acme-agent-cli', status: 'not_found' }), names).map((problem) => problem.agentId)).toEqual(['helper'])
  })
})

describe('appProblemSummary', () => {
  it('is the problem itself for one agent, and a count with names for several', () => {
    const missing = checks({ cmd: 'acme-agent-cli', status: 'not_found' }, { cmd: 'npx', status: 'not_found' })
    const problems = appProblemsFor([helper, writer], missing, names)
    expect(appProblemSummary(problems.slice(0, 1), names)).toBe('Helper’s app “acme-agent-cli” isn’t installed on this computer.')
    expect(appProblemSummary(problems, names)).toBe('2 agents’ apps can’t start on this computer: Helper, Writer.')
    expect(appProblemSummary([], names)).toBeNull()
  })
})

describe('fetchCommandChecks', () => {
  it('asks about each command by name, encoded', async () => {
    const fetchMock = vi.fn(async () => json({ commands: [{ cmd: 'my app', status: 'not_found' }] }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchCommandChecks(['my app', '/opt/a&b'])).resolves.toEqual([{ cmd: 'my app', status: 'not_found' }])
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/commands?cmd=my%20app&cmd=%2Fopt%2Fa%26b')
  })
})

describe('useAppChecks', () => {
  it('asks the daemon about the team’s commands and asks again when the window regains focus', async () => {
    let status: CommandCheck['status'] = 'not_found'
    const fetchMock = vi.fn(async () => json({ commands: [{ cmd: 'acme-agent-cli', status }] }))
    vi.stubGlobal('fetch', fetchMock)
    const agents = [helper]
    const { result } = renderHook(() => useAppChecks(agents))
    await waitFor(() => expect(result.current.get('acme-agent-cli')?.status).toBe('not_found'))

    // Installing the app happens outside LoomWatch; coming back to the window is the cue.
    status = 'found'
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(result.current.get('acme-agent-cli')?.status).toBe('found'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('asks once for a burst of edits, not once per keystroke', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => json({ commands: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = renderHook(({ cmd }) => useAppChecks([agent('helper', 'Helper', cmd)]), { initialProps: { cmd: 'a' } })
    rerender({ cmd: 'ac' })
    rerender({ cmd: 'acm' })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/commands?cmd=acm')
  })

  it('reports nothing when the daemon cannot answer', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'not found' }, 404))
    vi.stubGlobal('fetch', fetchMock)
    const agents = [helper]
    const { result } = renderHook(() => useAppChecks(agents))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(result.current.size).toBe(0)
  })
})
