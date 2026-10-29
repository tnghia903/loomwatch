import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SavedJob } from '../../lib/library/jobs'
import { forgetYou } from '../../lib/you/client'
import { cascaded, goldFilled, heightOf, isGoldFill, PHONE } from '../../test/cascade'
import type { AgentFigureProps } from './AgentFigure'
import { AgentsPage } from './AgentsPage'

// The bench is drawn with WebGL, which jsdom has none of: here it is only its labels.
vi.mock('./AgentFigure', () => ({
  default: ({ labels }: AgentFigureProps) => <div>{labels.map((tag) => <button key={tag.anchor} type="button" aria-label={tag.label}>{tag.text}</button>)}</div>,
}))

const writer: SavedJob = { id: 'writer', file: '.jobs/writer.yaml', name: 'Writer', does: 'Turns notes into a draft', instructions: 'Write a short draft.', model: 'fake/offline' }
const editor: SavedJob = { id: 'editor', file: '.jobs/editor.yaml', name: 'Editor', instructions: 'Tighten the draft.', model: 'fake/offline' }
const calls: string[] = []

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method && init.method !== 'GET') calls.push(`${init.method} ${url}`)
    if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', jobs: [editor, writer], problems: [] }), { status: 200 })
    if (url === '/api/jobs/writer' && init?.method === 'PUT') return new Response(JSON.stringify({ ...writer, ...JSON.parse(String(init.body)) }), { status: 200 })
    if (url === '/api/jobs/writer' && init?.method === 'DELETE') return new Response(null, { status: 204 })
    if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: [], teams: [] }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); forgetYou() })

const page = () => render(<AgentsPage skills={[]} skillsLoading={false} tray={<button type="button">All clear</button>} />)

// An agent's page in a team page's frame: the same header, made of the same parts, and the rail.
describe('An agent’s page in the team page’s frame', () => {
  it('has a team page’s header: the brand home, the name chip, the tabs, the bell and the menu', async () => {
    window.history.replaceState({}, '', '/agents/writer?view=chat')
    page()
    const chip = await screen.findByRole('button', { name: /^Writer, Saved, open agent menu$/ }, { timeout: 5000 })
    const header = chip.closest('.workspace-chrome') as HTMLElement
    expect(header).not.toBeNull()
    // The brand is the way to your teams, and says so on hover.
    expect(within(header).getByRole('link', { name: 'LoomWatch, my team' })).toHaveAttribute('href', '/')
    expect(within(header).getByRole('link', { name: 'LoomWatch, my team' })).toHaveAttribute('title', 'My team')
    const tabs = within(header).getByRole('navigation', { name: 'Agent view' })
    expect(within(tabs).getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(header).getByRole('button', { name: 'All clear' })).toBeInTheDocument()
    fireEvent.click(within(header).getByRole('button', { name: 'Menu' }))
    const items = within(header).getAllByRole('menuitem').map((item) => item.textContent)
    expect(items).toEqual(expect.arrayContaining(['My agents…', 'Skills…', 'Quests…']))
    expect(items.some((item) => /^Switch to (light|dark) theme$/.test(item ?? ''))).toBe(true)
    expect(within(header).queryByRole('menuitem', { name: 'Team memory' })).not.toBeInTheDocument()
    // The page's own heading is the agent's name, for the reader that goes by headings.
    expect(screen.getByRole('heading', { level: 1, name: 'Writer' })).toBeInTheDocument()
    // Home's header is gone from it: no second brand, no My team button.
    expect(screen.queryByRole('link', { name: 'My team' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /LoomWatch/ })).toHaveLength(1)
  })

  it('switches tabs from the header', async () => {
    window.history.replaceState({}, '', '/agents/writer')
    page()
    fireEvent.click(within(await screen.findByRole('navigation', { name: 'Agent view' }, { timeout: 5000 })).getByRole('button', { name: 'Chat' }))
    expect(window.location.search).toBe('?view=chat')
  })

  it('puts Save beside the name while there is something to save, and says what it did', async () => {
    window.history.replaceState({}, '', '/agents/writer')
    page()
    await screen.findByRole('button', { name: /^Writer, Saved/ }, { timeout: 5000 })
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: /Instructions/ }), { target: { value: 'Write a short draft with a title.' } })
    const chip = screen.getByRole('button', { name: /^Writer, Unsaved changes/ }).closest('.lw-chip') as HTMLElement
    await act(async () => { fireEvent.click(within(chip).getByRole('button', { name: 'Save' })) })
    expect(calls).toEqual(['PUT /api/jobs/writer'])
    expect(await screen.findByText('Saved.', {}, { timeout: 5000 })).toHaveAttribute('role', 'status')
  })

  // ADR 0043: Remove is in the name chip's menu, as Delete team is in a team's, and nowhere else.
  it('removes the agent from its chip’s menu, after asking', async () => {
    window.history.replaceState({}, '', '/agents/writer')
    page()
    await screen.findByRole('textbox', { name: /Instructions/ }, { timeout: 5000 })
    expect(screen.queryByRole('button', { name: /Remove from My agents/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Writer, Saved, open agent menu$/ }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Agent menu' })).getByRole('button', { name: 'Remove from My agents…' }))
    expect(calls).toEqual([])
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Remove “Writer” from My agents?' })).getByRole('button', { name: 'Remove' })) })
    expect(calls).toEqual(['DELETE /api/jobs/writer'])
    expect(window.location.pathname).toBe('/agents')
  })

  // ADR 0100: its menu holds Remove, so its arrow shows where a team's chip drops its own for room.
  it('shows the arrow on its name at every width', async () => {
    window.history.replaceState({}, '', '/agents/writer')
    page()
    const open = await screen.findByRole('button', { name: /^Writer, Saved, open agent menu$/ }, { timeout: 5000 })
    const arrow = open.querySelector('.chev') as HTMLElement
    expect(arrow.closest('.workspace-chrome')).not.toBeNull()
    expect(cascaded(arrow, 'display', { width: 1024 })).toBe('grid')
  })

  it('keeps the rail as it is while the agent beside it changes', async () => {
    window.history.replaceState({}, '', '/agents/writer')
    page()
    const rail = screen.getByRole('navigation', { name: 'My agents' })
    fireEvent.click(await within(rail).findByRole('link', { name: 'Editor' }, { timeout: 5000 }))
    expect(await screen.findByRole('button', { name: /^Editor, Saved/ }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'My agents' })).toBe(rail)
  })

  // A team's header hides its name chip and menu in a narrow window; an agent's Save is in its chip,
  // so on an agent's page they move to a row under the header instead of going away.
  it('keeps the name chip, Save and the menu in a narrow window', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 767px)', media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    window.history.replaceState({}, '', '/agents/writer')
    page()
    fireEvent.change(await screen.findByRole('textbox', { name: /Instructions/ }, { timeout: 5000 }), { target: { value: 'Write a short draft with a title.' } })
    const chip = screen.getByRole('button', { name: /^Writer, Unsaved changes/ }).closest('.lw-chip') as HTMLElement
    expect(chip.closest('.workspace-chrome')).toBeNull()
    expect(chip.closest('.agent-bar-narrow')).not.toBeNull()
    expect(within(chip).getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(screen.getAllByRole('button', { name: 'Menu' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Menu' }).closest('.agent-bar-narrow')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'All clear' }).closest('.agent-bar-narrow')).not.toBeNull()
  })

  it('starts a new agent in the same frame, and the list keeps Home’s header', async () => {
    window.history.replaceState({}, '', '/agents/new')
    const view = page()
    expect(screen.getByText('New agent').closest('.workspace-chrome')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Build an agent' })).toBeInTheDocument()
    view.unmount()
    window.history.replaceState({}, '', '/agents')
    page()
    expect(screen.getByRole('link', { name: 'My team' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'My agents' })).not.toBeInTheDocument()
  })
})

// One gold fill per screen (DESIGN_LANGUAGE §8): on an agent's page it is Save, at least 32 px, and
// each switch is offered with a plain button. Three gold buttons once stood beside Save.
describe('the gold on an agent’s page', () => {
  it('fills only Save, at least 32 px, while its switches are offered with plain buttons', async () => {
    window.history.replaceState({}, '', '/agents/writer')
    page()
    fireEvent.change(await screen.findByRole('textbox', { name: /Instructions/ }, { timeout: 5000 }), { target: { value: 'Write a short draft with a title.' } })
    const offers = screen.getAllByRole('button', { name: /^Allow: / })
    expect(offers.length).toBeGreaterThan(1)
    for (const offer of offers) expect(isGoldFill(offer)).toBe(false)
    expect(goldFilled()).toEqual(['Save'])
    const save = screen.getByRole('button', { name: 'Save' })
    expect(heightOf(save)).toBe(32)
    expect(heightOf(save, PHONE)).toBe(44)
  })
})
