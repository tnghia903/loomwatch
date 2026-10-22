import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SavedJob } from '../../lib/library/jobs'
import { forgetYou } from '../../lib/you/client'
import type { AgentFigureProps } from './AgentFigure'
import { AgentsPage } from './AgentsPage'

// The bench is drawn with WebGL, which jsdom has none of: here it is only its labels.
vi.mock('./AgentFigure', () => ({
  default: ({ labels }: AgentFigureProps) => <div>{labels.map((tag) => <button key={tag.anchor} type="button" aria-label={tag.label}>{tag.text}</button>)}</div>,
}))

const maya: SavedJob = { id: 'maya', file: '.jobs/maya.yaml', name: 'Maya', instructions: 'Help me with my day.', model: 'fake/offline', savedAt: '2026-10-20T03:00:00Z' }
const writer: SavedJob = { id: 'writer', file: '.jobs/writer.yaml', name: 'Writer', instructions: 'Write a short draft.', model: 'fake/offline' }

let pinned: string | null = null
const pins: { agent: unknown; fromLoomWatch: boolean }[] = []

function onA(platform: 'MacIntel' | 'Win32') {
  vi.stubGlobal('navigator', { platform, userAgent: platform === 'MacIntel' ? 'Mozilla/5.0 (Macintosh)' : 'Mozilla/5.0 (Windows NT 10.0)', language: 'en-US', languages: ['en-US'] })
}

beforeEach(() => {
  pinned = null
  pins.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', jobs: [maya, writer], problems: [] }), { status: 200 })
    if (url === '/api/pinned-agent' && init?.method === 'PUT') {
      const { agent } = JSON.parse(String(init.body)) as { agent: string | null }
      pins.push({ agent, fromLoomWatch: new Headers(init.headers).get('X-LoomWatch-Request') === '1' })
      pinned = agent
      return new Response(JSON.stringify({ agent: pinned }), { status: 200 })
    }
    if (url === '/api/pinned-agent') return new Response(JSON.stringify({ agent: pinned }), { status: 200 })
    if (url === '/api/jobs/maya' && init?.method === 'PUT') return new Response(JSON.stringify({ ...maya, ...JSON.parse(String(init.body)), version: 2 }), { status: 200 })
    if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: [], teams: [] }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); forgetYou() })

const page = () => render(<AgentsPage skills={[]} skillsLoading={false} />)

// ADR 0083, decision 9: one of My agents kept at the notch of a Mac, to message from the top of the screen.
describe('Pinning an agent to the notch', () => {
  it('pins it from its name’s menu, says so beside its name, and unpins it the same way', async () => {
    onA('MacIntel')
    window.history.replaceState({}, '', '/agents/maya')
    page()
    fireEvent.click(await screen.findByRole('button', { name: /^Maya, .*open agent menu$/ }, { timeout: 5000 }))
    const menu = screen.getByRole('dialog', { name: 'Agent menu' })
    await act(async () => { fireEvent.click(within(menu).getByRole('button', { name: 'Pin to the notch' })) })
    expect(pins).toEqual([{ agent: 'maya', fromLoomWatch: true }])
    // It says where to find it now.
    expect(await screen.findByText('Pinned. Press Control-Option-Space in any app, or point at the top middle of your screen, to message Maya.')).toBeInTheDocument()
    // The menu closed; the name says it is pinned.
    expect(screen.queryByRole('dialog', { name: 'Agent menu' })).not.toBeInTheDocument()
    const chip = await screen.findByRole('button', { name: /^Maya, pinned to the notch, .*open agent menu$/ })
    fireEvent.click(chip)
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog', { name: 'Agent menu' })).getByRole('button', { name: 'Unpin from the notch' })) })
    expect(pins.at(-1)).toEqual({ agent: null, fromLoomWatch: true })
    expect(await screen.findByText('Unpinned.')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /^Maya, Saved .*open agent menu$/ })).toBeInTheDocument()
  }, 15_000)

  it('says what pinning did right after a save, and which agent it took the place of', async () => {
    onA('MacIntel')
    pinned = 'writer'
    window.history.replaceState({}, '', '/agents/maya')
    page()
    fireEvent.change(await screen.findByRole('textbox', { name: /Instructions/ }, { timeout: 5000 }), { target: { value: 'Help me with my day, briefly.' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Maya, .*open agent menu$/ }))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog', { name: 'Agent menu' })).getByRole('button', { name: 'Pin to the notch' })) })
    expect(await screen.findByText('Pinned in place of Writer. Press Control-Option-Space in any app, or point at the top middle of your screen, to message Maya.')).toBeInTheDocument()
  }, 15_000)

  it('pins one at a time: the list marks the one pinned now', async () => {
    onA('MacIntel')
    pinned = 'writer'
    window.history.replaceState({}, '', '/agents')
    page()
    const marks = await screen.findAllByRole('img', { name: 'pinned to the notch' }, { timeout: 5000 })
    expect(marks).toHaveLength(1)
    expect(marks[0].closest('.agent-card')?.textContent).toContain('Writer')
  }, 15_000)

  it('offers no pin where there is no notch to keep it at', async () => {
    onA('Win32')
    window.history.replaceState({}, '', '/agents/maya')
    page()
    fireEvent.click(await screen.findByRole('button', { name: /^Maya, .*open agent menu$/ }, { timeout: 5000 }))
    const menu = screen.getByRole('dialog', { name: 'Agent menu' })
    expect(within(menu).getByRole('button', { name: 'Remove from My agents…' })).toBeInTheDocument()
    expect(within(menu).queryByRole('button', { name: /notch/ })).not.toBeInTheDocument()
  }, 15_000)
})
