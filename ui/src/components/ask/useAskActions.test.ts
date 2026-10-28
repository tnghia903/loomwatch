import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Proposal } from '../../lib/ask/client'
import type { ProposalCard } from '../../lib/ask/thread'
import { proposalSource, sameTeamFile, teamFileForAsk, useAskActions } from './useAskActions'

const client = vi.hoisted(() => ({
  fetchProposal: vi.fn(),
  reportProposalOutcome: vi.fn(async () => {}),
  decideRunRequest: vi.fn(async () => {}),
}))
vi.mock('../../lib/ask/client', () => client)
const runs = vi.hoisted(() => ({ startRun: vi.fn(), newStartKey: () => 'start-key-1' }))
vi.mock('../../lib/runs/client', () => runs)
const memory = vi.hoisted(() => ({ fetchMemory: vi.fn(), writeMemoryFile: vi.fn(async () => ({})) }))
vi.mock('../../lib/memory/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/memory/client')>()), ...memory }))

const SAVED = 'schemaVersion: 1\nid: brief\nname: Brief\nentrypoint: a\nagents:\n  - { id: a, name: Collector, role: Collect, model: m, spawn: { cmd: c, args: [], env: {}, cwd: "." } }\nedges: []\n'
const CHANGED = SAVED.replace('role: Collect,', 'role: Collect with links,') + ''
const proposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  id: 'p1', source: 'ask-1', file: 'brief.yaml', name: 'Brief', isNew: false, yaml: CHANGED, baseRevision: 'rev', summary: 'Links.', createdAt: '2026-10-02T09:00:00Z', ...overrides,
})

interface DocState { path: string | null; saveState: string; loadedYaml: string | null; yamlPreview: string }
const OPEN_TEAM: DocState = { path: '/Users/me/teams/brief.yaml', saveState: 'clean', loadedYaml: SAVED, yamlPreview: SAVED }
const HOME: DocState = { path: null, saveState: 'no-file', loadedYaml: null, yamlPreview: '' }

/** The editor as far as these actions use it: edits change its YAML, undo puts the last one back. */
function setup(initial: DocState = OPEN_TEAM, extra: Partial<{ activeRunId: string | null; waiting: boolean; saves: boolean }> = {}) {
  const spies = { applyYaml: vi.fn(), save: vi.fn(async () => extra.saves ?? true), undo: vi.fn(), closeDocument: vi.fn(), loadMyAgents: vi.fn(async () => {}), addBriefEntry: vi.fn() }
  const options = {
    conversationId: 'ask-1', activeRunId: extra.activeRunId ?? null, waiting: extra.waiting ?? false,
    toBuild: vi.fn(), showRun: vi.fn(), applyRecord: vi.fn(), onDocumentOpen: vi.fn(), frame: vi.fn(),
  }
  const person = { undo: () => {}, save: async () => false as boolean }
  const hook = renderHook(() => {
    const [state, setState] = useState(initial)
    const [history, setHistory] = useState<string[]>([])
    const doc = {
      ...state,
      loadMyAgents: () => spies.loadMyAgents(),
      applyYaml: (yaml: string, file?: string) => {
        spies.applyYaml(...(file ? [yaml, file] : [yaml]))
        if (!file) setHistory((past) => [...past, state.yamlPreview])
        setState((current) => ({ ...current, yamlPreview: yaml, path: file ?? current.path, saveState: file ? 'new' : 'dirty' }))
        return true
      },
      save: async () => {
        const ok = await spies.save()
        if (ok) setState((current) => ({ ...current, saveState: 'saved', loadedYaml: current.yamlPreview }))
        return ok
      },
      undo: () => {
        spies.undo()
        const previous = history.at(-1)
        if (previous === undefined) return
        setHistory((past) => past.slice(0, -1))
        setState((current) => ({ ...current, yamlPreview: previous, saveState: previous === current.loadedYaml ? 'clean' : 'dirty' }))
      },
      closeDocument: () => { spies.closeDocument(); setState(HOME) },
      addBriefEntry: (entry: { path: string }) => {
        spies.addBriefEntry(entry)
        setState((current) => ({ ...current, saveState: 'dirty' }))
      },
    }
    person.undo = doc.undo
    person.save = doc.save
    return { actions: useAskActions({ ...options, doc: doc as never }), state }
  })
  return { ...hook, options, spies, person }
}

beforeEach(() => {
  memory.fetchMemory.mockReset()
  memory.fetchMemory.mockResolvedValue({ enabled: true, entries: [] })
  memory.writeMemoryFile.mockClear()
  client.fetchProposal.mockReset()
  client.reportProposalOutcome.mockClear()
  client.decideRunRequest.mockClear()
  runs.startRun.mockReset()
})
// Unmounting each hook clears the timers it started, so none fires after this file's window is gone.
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useAskActions', () => {
  it('shows a proposal for the open team in place, and Apply saves it and records that', async () => {
    client.fetchProposal.mockResolvedValue(proposal())
    const { result, options, spies } = setup()
    await act(async () => { await result.current.actions.showProposal('p1') })
    expect(options.toBuild).toHaveBeenCalled()
    expect(spies.applyYaml).toHaveBeenCalledWith(CHANGED)
    expect(result.current.actions.preview?.changes.lines).toEqual(['Changes Collector’s job'])
    expect(result.current.actions.marks.get('a')).toBe('changed')

    await act(async () => { await result.current.actions.applyProposal() })
    expect(spies.save).toHaveBeenCalled()
    expect(client.reportProposalOutcome).toHaveBeenCalledWith('p1', 'applied')
    expect(result.current.actions.preview).toBeNull()
    expect(result.current.actions.notice?.text).toBe('Applied the changes to “Brief”.')
    expect(result.current.actions.marks.get('a')).toBe('settled')
  })

  it('keeps a proposal’s Brief beside the team once the team is saved, and not one the team already has (ADR 0097)', async () => {
    const brief = 'Colin’s SUTD final project: a gate for the campus library.'
    client.fetchProposal.mockResolvedValue(proposal({ brief }))
    const { result, spies } = setup()
    await act(async () => { await result.current.actions.showProposal('p1') })
    await act(async () => { await result.current.actions.applyProposal() })
    expect(memory.writeMemoryFile).toHaveBeenCalledWith('/Users/me/teams/brief.yaml', expect.stringMatching(/^brief\.brief\/.+\.md$/), `${brief}\n`)
    const file = (memory.writeMemoryFile.mock.calls[0] as unknown as [string, string, string])[1]
    expect(spies.addBriefEntry).toHaveBeenCalledWith({ path: file })
    expect(spies.save).toHaveBeenCalledTimes(2)
    // The team on disk first, then its Brief file, then the entry that names it.
    const order = (spy: { mock: { invocationCallOrder: number[] } }, at = 0) => spy.mock.invocationCallOrder[at]
    expect(order(spies.save)).toBeLessThan(order(memory.writeMemoryFile))
    expect(order(memory.writeMemoryFile)).toBeLessThan(order(spies.addBriefEntry))
    expect(order(spies.addBriefEntry)).toBeLessThan(order(spies.save, 1))
    expect(result.current.actions.notice?.text).toBe('Applied the changes to “Brief”.')

    memory.writeMemoryFile.mockClear()
    memory.fetchMemory.mockResolvedValue({ enabled: true, entries: [{ path: file, title: 'Colin', body: `${brief}\n`, chars: brief.length, sha256: 'x' }] })
    client.fetchProposal.mockResolvedValue(proposal({ id: 'p2', brief, yaml: CHANGED.replace('with links', 'with sources') }))
    const again = setup()
    await act(async () => { await again.result.current.actions.showProposal('p2') })
    await act(async () => { await again.result.current.actions.applyProposal() })
    expect(memory.writeMemoryFile).not.toHaveBeenCalled()
    expect(again.spies.addBriefEntry).not.toHaveBeenCalled()
    expect(again.spies.save).toHaveBeenCalledTimes(1)
  })

  // A step timed after showing a proposal once fired after the hook was gone (CI: "window is not
  // defined" from the palette fold), so leaving clears every step it timed.
  it('folds the library and frames the change while open, and does neither once it has gone', async () => {
    vi.useFakeTimers()
    const collapse = vi.fn()
    window.addEventListener('loomwatch:collapse-palette', collapse)
    try {
      client.fetchProposal.mockResolvedValue(proposal())
      const open = setup()
      await act(async () => { await open.result.current.actions.showProposal('p1') })
      act(() => { vi.advanceTimersByTime(1000) })
      expect(collapse).toHaveBeenCalledTimes(1)
      expect(open.options.frame).toHaveBeenCalledWith(['a'])
      open.unmount()

      collapse.mockClear()
      const gone = setup()
      await act(async () => { await gone.result.current.actions.showProposal('p1') })
      gone.unmount()
      vi.advanceTimersByTime(1000)
      expect(collapse).not.toHaveBeenCalled()
      expect(gone.options.frame).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('loomwatch:collapse-palette', collapse)
    }
  })

  it('undoes an applied change on the canvas and in the file', async () => {
    client.fetchProposal.mockResolvedValue(proposal())
    const { result, spies } = setup()
    await act(async () => { await result.current.actions.showProposal('p1') })
    await act(async () => { await result.current.actions.applyProposal() })
    spies.save.mockClear()
    act(() => result.current.actions.notice?.undo?.())
    expect(spies.undo).toHaveBeenCalled()
    await waitFor(() => expect(spies.save).toHaveBeenCalled())
    await waitFor(() => expect(client.reportProposalOutcome).toHaveBeenCalledWith('p1', 'undone'))
    expect(result.current.state.loadedYaml).toBe(SAVED)
  })

  it('keeps the proposal on the canvas and says so when the save is refused', async () => {
    client.fetchProposal.mockResolvedValue(proposal())
    const { result } = setup(OPEN_TEAM, { saves: false })
    await act(async () => { await result.current.actions.showProposal('p1') })
    await act(async () => { await result.current.actions.applyProposal() })
    expect(result.current.actions.preview?.error).toMatch(/Couldn’t save the team/)
    expect(client.reportProposalOutcome).not.toHaveBeenCalledWith('p1', 'applied')
  })

  it('counts saving another way — ⌘S, the Save beside the name — as applying it', async () => {
    client.fetchProposal.mockResolvedValue(proposal())
    const { result, person } = setup()
    await act(async () => { await result.current.actions.showProposal('p1') })
    expect(result.current.actions.preview).not.toBeNull()
    await act(async () => { await person.save() })
    expect(result.current.actions.preview).toBeNull()
    expect(result.current.actions.marks.get('a')).toBe('settled')
    await waitFor(() => expect(client.reportProposalOutcome).toHaveBeenCalledWith('p1', 'applied'))
  })

  it('opens a new team from Home unsaved, and Discard goes back to no team', async () => {
    client.fetchProposal.mockResolvedValue(proposal({ isNew: true, baseRevision: null, file: 'new-brief.yaml' }))
    const { result, options, spies } = setup(HOME)
    await act(async () => { await result.current.actions.showProposal('p1') })
    expect(spies.applyYaml).toHaveBeenCalledWith(CHANGED, 'new-brief.yaml')
    expect(options.onDocumentOpen).toHaveBeenCalled()
    expect(result.current.state.path).toBe('new-brief.yaml')
    expect(result.current.actions.preview?.beforeYaml).toBeNull()

    act(() => result.current.actions.discardProposal())
    expect(spies.closeDocument).toHaveBeenCalled()
    expect(spies.undo).not.toHaveBeenCalled()
    expect(client.reportProposalOutcome).toHaveBeenCalledWith('p1', 'discarded')
    expect(result.current.state.path).toBeNull()
  })

  it('ends the preview when the person undoes it with ⌘Z, and records it discarded', async () => {
    client.fetchProposal.mockResolvedValue(proposal())
    const { result, person } = setup()
    await act(async () => { await result.current.actions.showProposal('p1') })
    expect(result.current.actions.preview).not.toBeNull()
    act(() => person.undo())
    expect(result.current.state.yamlPreview).toBe(SAVED)
    expect(result.current.actions.preview).toBeNull()
    await waitFor(() => expect(client.reportProposalOutcome).toHaveBeenCalledWith('p1', 'discarded'))
  })

  it('replaces the proposal on the canvas with a revised one, measured from the person’s own version', async () => {
    const revised = SAVED.replace('role: Collect,', 'role: Collect twice,')
    client.fetchProposal.mockResolvedValueOnce(proposal()).mockResolvedValueOnce(proposal({ id: 'p2', yaml: revised }))
    const { result, spies } = setup()
    await act(async () => { await result.current.actions.showProposal('p1') })
    await act(async () => { await result.current.actions.showProposal('p2') })
    expect(spies.undo).toHaveBeenCalled()
    expect(client.reportProposalOutcome).toHaveBeenCalledWith('p1', 'discarded')
    await waitFor(() => expect(result.current.actions.preview?.proposal.id).toBe('p2'))
    expect(result.current.actions.preview?.beforeYaml).toBe(SAVED)
    expect(result.current.state.yamlPreview).toBe(revised)
  })

  it('says a proposal matching the saved team has nothing to change', async () => {
    client.fetchProposal.mockResolvedValue(proposal({ yaml: SAVED }))
    const { result, spies } = setup()
    await act(async () => { await result.current.actions.showProposal('p1') })
    expect(spies.applyYaml).not.toHaveBeenCalled()
    expect(result.current.actions.notice?.text).toMatch(/already exactly that/)
  })

  it('falls back to the file the conversation recorded when the daemon no longer has the proposal', async () => {
    client.fetchProposal.mockRejectedValue(new Error('This proposal is no longer available.'))
    const recorded: ProposalCard = { kind: 'proposal', id: 'p1', at: '2026-10-02T09:00:00Z', file: 'brief.yaml', name: 'Brief', isNew: false, summary: '', yaml: CHANGED, agentNames: {}, outcome: null, superseded: false }
    const { result, spies } = setup()
    await act(async () => { await result.current.actions.showProposal('p1', recorded) })
    expect(spies.applyYaml).toHaveBeenCalledWith(CHANGED)
    act(() => result.current.actions.discardProposal())
    await act(async () => { await result.current.actions.showProposal('p2') })
    expect(result.current.actions.notice?.text).toBe('This proposal is no longer available.')
  })

  it('starts a requested run only when asked, records it, and shows it', async () => {
    const record = { runId: 'run-5', teamPath: 'brief.yaml' }
    runs.startRun.mockResolvedValue(record)
    const { result, options } = setup()
    const card = { kind: 'run-request' as const, id: 'r1', file: 'brief.yaml', name: 'Brief', request: 'Today', apps: [], steps: 1, decision: null, runId: null }
    await act(async () => { await result.current.actions.startRequestedRun(card) })
    expect(runs.startRun).toHaveBeenCalledWith('brief.yaml', 'Today', { startKey: 'start-key-1', expectedRevision: null })
    expect(client.decideRunRequest).toHaveBeenCalledWith('ask-1', 'r1', 'started', 'run-5')
    expect(options.applyRecord).toHaveBeenCalledWith(record)
    expect(options.showRun).toHaveBeenCalledWith('run-5')

    await act(async () => { await result.current.actions.declineRequestedRun({ ...card, id: 'r2' }) })
    expect(client.decideRunRequest).toHaveBeenCalledWith('ask-1', 'r2', 'declined')
  })

  it('shows why a requested run could not start, on its card', async () => {
    runs.startRun.mockRejectedValue(new Error('Collector’s app is not installed.'))
    const { result } = setup()
    const card = { kind: 'run-request' as const, id: 'r1', file: 'brief.yaml', name: 'Brief', request: 'Today', apps: [], steps: 1, decision: null, runId: null }
    await act(async () => { await result.current.actions.startRequestedRun(card) })
    expect(result.current.actions.cardError).toEqual({ id: 'r1', message: 'Collector’s app is not installed.' })
    expect(client.decideRunRequest).not.toHaveBeenCalled()
  })

  it('puts a review note in the open run’s answer box without sending anything', () => {
    const { result } = setup(OPEN_TEAM, { activeRunId: 'run-1', waiting: true })
    const composed: string[] = []
    const listen = (event: Event) => composed.push(String((event as CustomEvent).detail))
    window.addEventListener('loomwatch:compose', listen)
    act(() => result.current.actions.takeNote({ kind: 'review-note', id: 'n1', runId: 'run-1', file: 'brief.yaml', name: 'You', question: 'Approve?', text: 'Approved.' }))
    window.removeEventListener('loomwatch:compose', listen)
    expect(composed).toEqual(['Approved.'])
  })
})

describe('team file names', () => {
  it('matches the daemon’s relative names against an open team’s absolute path', () => {
    expect(sameTeamFile('/Users/me/teams/brief.yaml', 'brief.yaml')).toBe(true)
    expect(sameTeamFile('/Users/me/teams/nested/brief.yaml', 'nested/brief.yaml')).toBe(true)
    expect(sameTeamFile('/Users/me/teams/other-brief.yaml', 'brief.yaml')).toBe(false)
    expect(sameTeamFile(null, 'brief.yaml')).toBe(false)
    expect(teamFileForAsk('/Users/me/teams/nested/brief.yaml', '/Users/me/teams')).toBe('nested/brief.yaml')
    expect(teamFileForAsk('brief.yaml', null)).toBe('brief.yaml')
  })

  it('reads My agents before it puts a proposal on the canvas, so an agent from there shows as itself', async () => {
    let read: () => void = () => {}
    const { result, spies } = setup(HOME)
    spies.loadMyAgents.mockImplementation(() => new Promise<void>((resolve) => { read = resolve }))
    client.fetchProposal.mockResolvedValue(proposal({ isNew: true, file: 'client-review.yaml', yaml: SAVED }))
    await act(async () => { await result.current.actions.showProposal('p1') })
    expect(spies.loadMyAgents).toHaveBeenCalledTimes(1)
    expect(spies.applyYaml).not.toHaveBeenCalled()
    await act(async () => { read() })
    await waitFor(() => expect(spies.applyYaml).toHaveBeenCalledWith(SAVED, 'client-review.yaml'))
    expect(result.current.actions.preview?.proposal.file).toBe('client-review.yaml')
  })

  it('credits Ask LoomWatch with a proposal, and names what an AI app connected earlier proposed', () => {
    expect(proposalSource('ask-123')).toBe('Ask LoomWatch')
    expect(proposalSource('connection:opencode')).toBe('opencode')
  })
})
