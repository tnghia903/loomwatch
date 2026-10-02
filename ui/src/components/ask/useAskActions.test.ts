import { act, renderHook, waitFor } from '@testing-library/react'
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
  const spies = { applyYaml: vi.fn(), save: vi.fn(async () => extra.saves ?? true), undo: vi.fn(), closeDocument: vi.fn() }
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
    }
    person.undo = doc.undo
    person.save = doc.save
    return { actions: useAskActions({ ...options, doc: doc as never }), state }
  })
  return { ...hook, options, spies, person }
}

beforeEach(() => {
  client.fetchProposal.mockReset()
  client.reportProposalOutcome.mockClear()
  client.decideRunRequest.mockClear()
  runs.startRun.mockReset()
})
afterEach(() => vi.useRealTimers())

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
    const recorded: ProposalCard = { kind: 'proposal', id: 'p1', at: '2026-10-02T09:00:00Z', file: 'brief.yaml', name: 'Brief', isNew: false, summary: '', yaml: CHANGED, outcome: null, superseded: false }
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

  it('credits the app that made a proposal', () => {
    expect(proposalSource('ask-123')).toBe('Ask LoomWatch')
    expect(proposalSource('connection:opencode')).toBe('OpenCode')
    expect(proposalSource('connection:claude')).toBe('Claude Code')
  })
})
