import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SavedJob } from '../../lib/library/jobs'
import type { RunRecord } from '../../lib/runs/client'
import { forgetYou } from '../../lib/you/client'
import type { AgentFigureProps } from './AgentFigure'
import { AgentsPage } from './AgentsPage'

// The bench is drawn with WebGL, which jsdom has none of: here it is only its labels.
vi.mock('./AgentFigure', () => ({
  default: ({ labels }: AgentFigureProps) => <div>{labels.map((tag) => <button key={tag.anchor} type="button" aria-label={tag.label}>{tag.text}</button>)}</div>,
}))

const writer: SavedJob = { id: 'writer', file: '.jobs/writer.yaml', name: 'Writer', does: 'Turns notes into a draft', instructions: 'Write a short draft.', model: 'fake/offline', figure: { kind: 'spool', color: 'rose' } }
const editor: SavedJob = { id: 'editor', file: '.jobs/editor.yaml', name: 'Editor', does: 'Tightens a draft', instructions: 'Tighten the draft.', model: 'fake/offline', figure: { kind: 'thimble', color: 'sky' } }
const saves: unknown[] = []

beforeEach(() => {
  saves.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', jobs: [editor, writer], problems: [] }), { status: 200 })
    if (url === '/api/jobs/writer' && init?.method === 'PUT') {
      saves.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ ...writer, ...JSON.parse(String(init.body)), version: 2 }), { status: 200 })
    }
    if (/^\/api\/jobs\/\w+\/versions$/.test(url)) return new Response(JSON.stringify({ versions: [] }), { status: 200 })
    if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: [], teams: [] }), { status: 200 })
    // A new agent waits for what is connected before it starts (ADR 0073).
    if (url === '/api/ai') return new Response(JSON.stringify({ openrouter: { connected: true, label: 'sk-or-v1-abc...xyz' } }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); forgetYou() })

const page = (records: RunRecord[] = []) => render(<AgentsPage skills={[]} skillsLoading={false} records={records} />)
const here = () => window.location.pathname + window.location.search

describe('Moving between agents from the rail', () => {
  it('has no rail on the list, which shows every agent already', async () => {
    window.history.replaceState({}, '', '/agents')
    page()
    await screen.findByRole('button', { name: /Writer/ }, { timeout: 5000 })
    expect(screen.queryByRole('navigation', { name: 'My agents' })).not.toBeInTheDocument()
  })

  it('opens another agent in one click, on the tab you are on', async () => {
    window.history.replaceState({}, '', '/agents/writer')
    page()
    const rail = screen.getByRole('navigation', { name: 'My agents' })
    expect(await within(rail).findByRole('link', { name: 'Writer' }, { timeout: 5000 })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByRole('heading', { level: 1, name: 'Writer' }, { timeout: 5000 })).toBeInTheDocument()
    fireEvent.click(within(rail).getByRole('link', { name: 'Editor' }))
    expect(here()).toBe('/agents/editor')
    expect(await screen.findByRole('heading', { level: 1, name: 'Editor' }, { timeout: 5000 })).toBeInTheDocument()
    expect(within(rail).getByRole('link', { name: 'Editor' })).toHaveAttribute('aria-current', 'page')
  })

  it('keeps Chat when the page is on Chat', async () => {
    window.history.replaceState({}, '', '/agents/writer?view=chat')
    page()
    const rail = screen.getByRole('navigation', { name: 'My agents' })
    expect(await within(rail).findByRole('link', { name: 'Editor' }, { timeout: 5000 })).toHaveAttribute('href', '/agents/editor?view=chat')
  })

  it('shows what each agent is doing in its own chat', async () => {
    window.history.replaceState({}, '', '/agents/writer')
    const working: RunRecord = { runId: 'r1', sessionId: 'r1', teamPath: '/teams/.jobs/.bench/editor.yaml', prompt: 'Tighten this', status: 'running', mode: 'pipeline', entrypoint: 'editor', responder: 'editor', agentIds: ['editor'], createdAt: '2026-10-20T03:00:00Z', startedAt: null, finishedAt: null, error: null, exitCode: null, eventCount: 0, reply: null }
    page([working])
    expect(await within(screen.getByRole('navigation', { name: 'My agents' })).findByRole('link', { name: 'Editor, working' }, { timeout: 5000 })).toHaveClass('working')
  })

  it('marks + while a new agent is being made', async () => {
    window.history.replaceState({}, '', '/agents/new')
    page()
    expect(within(screen.getByRole('navigation', { name: 'My agents' })).getByRole('link', { name: 'New agent' })).toHaveAttribute('aria-current', 'page')
  })

  describe('with changes not saved', () => {
    async function changeWriter() {
      window.history.replaceState({}, '', '/agents/writer')
      page()
      const instructions = await screen.findByRole('textbox', { name: /Instructions/ }, { timeout: 5000 })
      fireEvent.change(instructions, { target: { value: 'Write a short draft, then a title.' } })
      return screen.getByRole('navigation', { name: 'My agents' })
    }

    it('asks before leaving them, and Cancel keeps them on screen', async () => {
      const rail = await changeWriter()
      fireEvent.click(within(rail).getByRole('link', { name: 'Editor' }))
      expect(here()).toBe('/agents/writer')
      fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).getByRole('button', { name: 'Cancel' }))
      expect(here()).toBe('/agents/writer')
      expect(screen.getByRole('textbox', { name: /Instructions/ })).toHaveValue('Write a short draft, then a title.')
    })

    it('saves them first, then opens the other agent', async () => {
      const rail = await changeWriter()
      fireEvent.click(within(rail).getByRole('link', { name: 'Editor' }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save first' })) })
      expect(saves).toEqual([expect.objectContaining({ instructions: 'Write a short draft, then a title.' })])
      expect(here()).toBe('/agents/editor')
    })

    // A new agent has nothing saved to compare with: it asks once it differs from how it started.
    it('lets a new agent you have not touched go without asking', async () => {
      window.history.replaceState({}, '', '/agents/new?from=researcher')
      page()
      await screen.findByRole('textbox', { name: /Instructions/ }, { timeout: 5000 })
      fireEvent.click(within(screen.getByRole('navigation', { name: 'My agents' })).getByRole('link', { name: 'Editor' }))
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(here()).toBe('/agents/editor')
    })

    it('asks before leaving a new agent you have changed', async () => {
      window.history.replaceState({}, '', '/agents/new?from=researcher')
      page()
      fireEvent.change(await screen.findByRole('textbox', { name: /Instructions/ }, { timeout: 5000 }), { target: { value: 'Find three sources.' } })
      fireEvent.click(within(screen.getByRole('navigation', { name: 'My agents' })).getByRole('link', { name: 'Editor' }))
      expect(screen.getByRole('alertdialog', { name: 'Unsaved changes' })).toBeInTheDocument()
      expect(here()).toBe('/agents/new?from=researcher')
    })

    it('drops them when asked, without saving', async () => {
      const rail = await changeWriter()
      fireEvent.click(within(rail).getByRole('link', { name: 'Editor' }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Discard' })) })
      expect(saves).toEqual([])
      expect(here()).toBe('/agents/editor')
    })
  })
})
