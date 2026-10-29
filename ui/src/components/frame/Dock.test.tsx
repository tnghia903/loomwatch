import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Dock } from './Dock'
import { LABEL_USES, placeOf, registerAskToggle } from './frameStore'

const waiting = {
  runId: 'run-1', sessionId: 'run-1', teamPath: 'demo.yaml', prompt: 'Find suppliers', status: 'running', mode: 'pipeline',
  entrypoint: 'researcher', responder: 'writer', agentIds: ['researcher', 'writer'], createdAt: '2026-10-29T10:00:00Z', startedAt: '2026-10-29T10:00:00Z',
  finishedAt: null, error: null, exitCode: null, eventCount: null, reply: null,
  waitingOn: { node: 'review', name: 'You', question: 'Approve the findings?', since: '2026-10-29T10:01:00Z', kind: 'review' },
}

function daemon(runs: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/runs')) return new Response(JSON.stringify(runs), { status: 200 })
    if (url === '/api/teams') return new Response(JSON.stringify({ root: '/teams', files: ['demo.yaml'], teams: [{ path: 'demo.yaml', name: 'Demo', agentCount: 2 }] }), { status: 200 })
    return new Response('{}', { status: 200 })
  }))
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState({}, '', '/') })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })

describe('the dock', () => {
  it('shows the same seven places, with the one you are in marked', () => {
    daemon([])
    window.history.replaceState({}, '', '/agents/researcher')
    render(<Dock />)
    const dock = screen.getByRole('navigation', { name: 'LoomWatch' })
    expect(within(dock).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Home', 'Projects', 'Agents', 'Skills', 'Quests', 'Ask', 'You'])
    expect(within(dock).getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page')
    expect(within(dock).getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current')
    expect(within(dock).getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/projects')
  })

  it('carries what needs you on Home, as a count and in its name', async () => {
    daemon([waiting])
    render(<Dock />)
    const home = await screen.findByRole('link', { name: 'Home, 1 needs you' })
    expect(home.querySelector('.lw-dock-count')).toHaveTextContent('1')
  })

  it('stops showing a place’s name once it has been used a few times', () => {
    daemon([])
    localStorage.setItem('loomwatch:dock:uses', JSON.stringify({ home: LABEL_USES, agents: LABEL_USES - 1 }))
    render(<Dock />)
    const label = (name: string) => screen.getByRole('link', { name }).querySelector('.lw-dock-label')
    expect(label('Home')).not.toBeVisible()
    expect(label('Agents')).toBeVisible()
    fireEvent.click(screen.getByRole('link', { name: 'Agents' }))
    expect(JSON.parse(localStorage.getItem('loomwatch:dock:uses') ?? '{}')).toMatchObject({ agents: LABEL_USES })
  })

  it('opens the screen’s own Ask, or Home’s when the screen has none', () => {
    daemon([])
    const toggle = vi.fn()
    const unregister = registerAskToggle(toggle)
    render(<Dock />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(toggle).toHaveBeenCalledTimes(1)
    unregister()
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign, pathname: '/skills', search: '' })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('loomwatch:ask:open')).toBe('true')
    expect(assign).toHaveBeenCalledWith('/')
  })
})

describe('which place a page is in', () => {
  it('puts a team’s page in Projects, and Usage and Connections in You', () => {
    expect(placeOf('/', '')).toBe('home')
    expect(placeOf('/', '?path=demo.yaml')).toBe('projects')
    expect(placeOf('/projects/market')).toBe('projects')
    expect(placeOf('/agents')).toBe('agents')
    expect(placeOf('/usage')).toBe('you')
    expect(placeOf('/connections')).toBe('you')
  })
})
