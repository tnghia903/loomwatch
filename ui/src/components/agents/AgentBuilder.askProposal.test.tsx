import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { announceAiStatus, forgetKeyStatus } from '../../lib/ai/useKeyStatus'
import type { AgentProposal } from '../../lib/ask/client'
import { JOBS_CHANGED_EVENT, type SavedJob } from '../../lib/library/jobs'
import { forgetYou } from '../../lib/you/client'
import { openBenchRows } from '../../test/benchRows'
import type { AgentFigureProps } from './AgentFigure'
import { AgentsPage } from './AgentsPage'

openBenchRows()

// The bench is drawn with WebGL, which jsdom has none of: here it is only its labels.
vi.mock('./AgentFigure', () => ({
  default: ({ labels }: AgentFigureProps) => <div>{labels.map((tag) => <button key={tag.anchor} type="button" aria-label={tag.label}>{tag.text}</button>)}</div>,
}))

const writer: SavedJob = { id: 'writer', file: '.jobs/writer.yaml', name: 'Writer', instructions: 'Write a short draft.\nReply with the draft.', model: 'fake/offline', doneWhen: ['Uses only what it was handed'], version: 2, savedAt: '2026-10-20T03:00:00Z' }
const BLOG = 'name: Blog\nagents:\n  - {id: writer, from: {agent: writer}}\n'

// What Ask proposed (ADR 0119): a line put in, a check added, against version 2.
const change: AgentProposal = {
  id: 'proposal-1', source: 'ask-1', kind: 'agent', agent: 'writer', name: 'Writer', isNew: false,
  spec: { name: 'Writer', instructions: 'Write a short draft.\nGive it a title.\nReply with the draft.', model: 'fake/offline', doneWhen: ['Uses only what it was handed', 'Has a title'], note: 'Gives each draft a title.', version: 2 } as AgentProposal['spec'],
  baseVersion: 2, summary: 'Gives each draft a title.', inTeams: ['Blog'], createdAt: '2026-11-08T05:00:00Z',
}
const fresh: AgentProposal = {
  id: 'proposal-2', source: 'ask-1', kind: 'agent', name: 'Email helper', isNew: true,
  spec: { name: 'Email helper', does: 'Drafts replies to customer emails', instructions: 'You draft replies to customer emails.', model: 'fake/offline', doneWhen: ['Answers every question asked'] },
  summary: 'An agent that drafts replies to customer emails.', inTeams: [], createdAt: '2026-11-08T05:00:00Z',
}

let saves: { url: string; init: RequestInit }[] = []
let outcomes: { url: string; outcome: string }[] = []
let saveStatus = 200
// The version My agents lists the Writer at now: Ask's change was made from version 2.
let listedVersion = 2
// The figure the saved Writer wears, when it wears one.
let listedFigure: SavedJob['figure'] | undefined
// Ask's proposal answers after the list of My agents, as it can over a slow start.
let proposalLate = false

beforeEach(() => {
  saves = []
  outcomes = []
  saveStatus = 200
  listedVersion = 2
  listedFigure = undefined
  proposalLate = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', jobs: [{ ...writer, version: listedVersion, ...(listedFigure ? { figure: listedFigure } : {}) }], problems: [] }), { status: 200 })
    if (url.startsWith('/api/ask/proposals/proposal-') && !url.endsWith('/outcome') && proposalLate) await new Promise((resolve) => setTimeout(resolve, 400))
    if (url.startsWith('/api/jobs/') && init?.method === 'PUT') {
      saves.push({ url, init })
      if (saveStatus !== 200) return new Response(JSON.stringify({ error: 'This agent was changed in another window since you opened it. Reload the page to see that change, then make yours again.' }), { status: saveStatus })
      return new Response(JSON.stringify({ ...writer, ...JSON.parse(String(init.body)), id: url.split('/').pop(), version: 3 }), { status: 200 })
    }
    if (url === '/api/ask/proposals/proposal-1') return new Response(JSON.stringify(change), { status: 200 })
    if (url === '/api/ask/proposals/proposal-2') return new Response(JSON.stringify(fresh), { status: 200 })
    if (url.endsWith('/outcome')) {
      outcomes.push({ url, outcome: JSON.parse(String(init?.body)).outcome })
      return new Response(null, { status: 204 })
    }
    if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: ['blog.yaml'], teams: [{ path: 'blog.yaml', name: 'Blog', agentCount: 1 }] }), { status: 200 })
    if (url.startsWith('/api/team?')) return new Response(JSON.stringify({ path: 'blog.yaml', revision: 'r1', yaml: BLOG }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); forgetYou(); forgetKeyStatus() })

const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name)

describe('an agent Ask proposed, on its own page (ADR 0119)', () => {
  it('opens Ask’s change as the draft, says what changed, and saves it against the version Ask changed', async () => {
    window.history.replaceState({}, '', '/agents/writer?proposal=proposal-1')
    render(<AgentsPage skills={[]} skillsLoading={false} />)
    const note = await screen.findByRole('region', { name: 'Ask’s changes, not saved yet' }, { timeout: 5000 })
    expect(note).toHaveTextContent('Ask’s changes, not saved yet. Check them, then press Save.')
    expect(within(note).getByText('Instructions: 1 line put in')).toBeInTheDocument()
    expect(within(note).getByText('Adds to Done when: “Has a title”')).toBeInTheDocument()
    expect(note.querySelector('.instructions-diff ins')?.textContent).toContain('Give it a title.')
    expect(note.querySelector('.instructions-diff del')).toBeNull()
    expect(screen.getByRole('textbox', { name: /Instructions/ })).toHaveValue('Write a short draft.\nGive it a title.\nReply with the draft.')
    // The name chip says whose change is waiting, beside Save, so it is seen before the note.
    expect(screen.getByText('Ask’s changes, not saved')).toBeInTheDocument()
    // The note keeps saying Ask's change while the person goes on editing.
    fireEvent.change(screen.getByRole('textbox', { name: /Instructions/ }), { target: { value: 'Write a short draft.\nGive it a title.\nReply with the draft, signed.' } })
    expect(within(note).getByText('Instructions: 1 line put in')).toBeInTheDocument()
    expect(note.querySelector('.instructions-diff')?.textContent).not.toContain('signed')
    fireEvent.change(screen.getByRole('textbox', { name: /Instructions/ }), { target: { value: 'Write a short draft.\nGive it a title.\nReply with the draft.' } })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(await screen.findByText('Saved.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(saves).toHaveLength(1)
    expect(saves[0].url).toBe('/api/jobs/writer')
    expect(header(saves[0].init, 'If-Match')).toBe('"2"')
    const body = JSON.parse(String(saves[0].init.body))
    expect(body.instructions).toBe('Write a short draft.\nGive it a title.\nReply with the draft.')
    expect(body.doneWhen).toEqual(['Uses only what it was handed', 'Has a title'])
    expect(body.note).toBe('Gives each draft a title.')
    await waitFor(() => expect(outcomes).toEqual([{ url: '/api/ask/proposals/proposal-1/outcome', outcome: 'applied' }]))
    expect(window.location.search).toBe('')
    expect(screen.queryByRole('region', { name: 'Ask’s changes, not saved yet' })).toBeNull()
  }, 15_000)

  it('puts back what was there, says so, and tells Ask it was discarded', async () => {
    window.history.replaceState({}, '', '/agents/writer?proposal=proposal-1')
    render(<AgentsPage skills={[]} skillsLoading={false} />)
    const note = await screen.findByRole('region', { name: 'Ask’s changes, not saved yet' }, { timeout: 5000 })
    fireEvent.click(within(note).getByRole('button', { name: 'Put back what you had' }))
    expect(screen.getByRole('textbox', { name: /Instructions/ })).toHaveValue(writer.instructions)
    expect(screen.queryByRole('region', { name: 'Ask’s changes, not saved yet' })).toBeNull()
    expect(screen.getByText('Put back. Writer is as you saved it.')).toBeInTheDocument()
    await waitFor(() => expect(outcomes).toEqual([{ url: '/api/ask/proposals/proposal-1/outcome', outcome: 'discarded' }]))
    expect(saves).toHaveLength(0)
    expect(window.location.search).toBe('')
  }, 15_000)

  it('saves against the version Ask read even once the page knows a newer one, and says what to press when that is refused', async () => {
    saveStatus = 412
    window.history.replaceState({}, '', '/agents/writer?proposal=proposal-1')
    render(<AgentsPage skills={[]} skillsLoading={false} />)
    await screen.findByRole('region', { name: 'Ask’s changes, not saved yet' }, { timeout: 5000 })
    // Saved again in another window while the page is open: the list now says version 3.
    listedVersion = 3
    await act(async () => { window.dispatchEvent(new Event(JOBS_CHANGED_EVENT)) })
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/jobs').length).toBeGreaterThan(1))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(saves).toHaveLength(1)
    expect(header(saves[0].init, 'If-Match')).toBe('"2"')
    expect(await screen.findByText('Writer was saved again after Ask read it, so this change can’t be saved. Press Put back what you had, then ask for it again in Ask.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(outcomes).toEqual([])
  }, 15_000)

  it('opens the agent as it is saved when it was saved again after Ask read it', async () => {
    listedVersion = 3
    window.history.replaceState({}, '', '/agents/writer?proposal=proposal-1')
    render(<AgentsPage skills={[]} skillsLoading={false} />)
    expect(await screen.findByText('Couldn’t open Ask’s change: Writer was saved again after Ask read it, so this change can’t be saved. Ask again for a new change.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /Instructions/ })).toHaveValue(writer.instructions)
    expect(screen.queryByRole('region', { name: 'Ask’s changes, not saved yet' })).toBeNull()
  }, 15_000)

  it('keeps the figure the agent wears, and waits for Ask’s change when it answers after My agents', async () => {
    listedFigure = { kind: 'spool', color: 'sage' }
    proposalLate = true
    window.history.replaceState({}, '', '/agents/writer?proposal=proposal-1')
    render(<AgentsPage skills={[]} skillsLoading={false} />)
    await screen.findByRole('region', { name: 'Ask’s changes, not saved yet' }, { timeout: 5000 })
    expect(screen.getByRole('textbox', { name: /Instructions/ })).toHaveValue('Write a short draft.\nGive it a title.\nReply with the draft.')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 5000 })
    expect(JSON.parse(String(saves[0].init.body)).figure).toEqual({ kind: 'spool', color: 'sage' })
  }, 15_000)

  it('says LoomWatch restarted when Ask’s change is gone', async () => {
    window.history.replaceState({}, '', '/agents/writer?proposal=proposal-9')
    render(<AgentsPage skills={[]} skillsLoading={false} />)
    expect(await screen.findByText('Couldn’t open Ask’s change: LoomWatch restarted since Ask made it. Ask again for a new one.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /Instructions/ })).toHaveValue(writer.instructions)
  }, 15_000)

  it('opens a new agent Ask drafted, and saves it to My agents under its name', async () => {
    announceAiStatus({ openrouter: { connected: true } })
    window.history.replaceState({}, '', '/agents/new?proposal=proposal-2')
    render(<AgentsPage skills={[]} skillsLoading={false} />)
    const note = await screen.findByRole('region', { name: 'Ask’s new agent, not saved yet' }, { timeout: 5000 })
    expect(note).toHaveTextContent('Ask’s new agent, not saved yet. Check it, then press Save to My agents.')
    expect(screen.getByRole('textbox', { name: /Instructions/ })).toHaveValue('You draft replies to customer emails.')
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Save to My agents' })[0]) })
    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 5000 })
    expect(saves[0].url).toBe('/api/jobs/email-helper')
    expect(header(saves[0].init, 'If-None-Match')).toBe('*')
    expect(JSON.parse(String(saves[0].init.body)).doneWhen).toEqual(['Answers every question asked'])
    await waitFor(() => expect(outcomes).toEqual([{ url: '/api/ask/proposals/proposal-2/outcome', outcome: 'applied' }]))
    expect(window.location.pathname).toBe('/agents/email-helper')
  }, 15_000)

  it('says when Ask’s change is for another agent, and opens this one as it is', async () => {
    window.history.replaceState({}, '', '/agents/writer?proposal=proposal-2')
    render(<AgentsPage skills={[]} skillsLoading={false} />)
    expect(await screen.findByText('Couldn’t open Ask’s change: it is for another agent. Ask again for a new one.', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /Instructions/ })).toHaveValue(writer.instructions)
  }, 15_000)
})
