import { act, cleanup, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import App from './App'
import { goToTeam } from './lib/team-file/teamPage'

let mounts = 0

// The team's part stands in for the real one: it reads its team from the address once, as the
// real one does.
vi.mock('./components/Workspace', () => ({
  Workspace: function TeamPart({ initialRunId }: { initialRunId: string | null }) {
    const [team] = useState(() => new URLSearchParams(window.location.search).get('path'))
    const [mount] = useState(() => ++mounts)
    return <main aria-label="Team">{`${team} · mount ${mount} · run ${initialRunId ?? 'none'}`}</main>
  },
}))

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  mounts = 0
  window.history.replaceState({}, '', '/?path=demo.yaml')
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/teams') return Promise.resolve(jsonResponse({ root: '/teams', files: ['demo.yaml', 'trip.yaml'], teams: [{ path: 'demo.yaml', name: 'Demo', agentCount: 1 }, { path: 'trip.yaml', name: 'Trip', agentCount: 1 }] }))
    if (url === '/api/jobs') return Promise.resolve(jsonResponse({ folder: '.jobs', jobs: [], problems: [] }))
    if (url.startsWith('/api/team?')) {
      const path = new URLSearchParams(url.split('?')[1]).get('path')
      return Promise.resolve(jsonResponse({ path, revision: 'r1', yaml: `name: ${path === 'trip.yaml' ? 'Trip' : 'Demo'}\nagents: []\n` }))
    }
    // Nothing else answers: the guide, updates and feedback wait.
    return new Promise<Response>(() => {})
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })

it('opens another team in place: the frame and its dock stay, and the team’s part starts again from the new address', async () => {
  render(<App />)
  expect(screen.getByRole('main', { name: 'Team' })).toHaveTextContent('demo.yaml · mount 1')
  const dock = screen.getByRole('navigation', { name: 'LoomWatch' })
  act(() => goToTeam('/?path=trip.yaml'))
  expect(await screen.findByText('trip.yaml · mount 2 · run none')).toBeInTheDocument()
  expect(window.location.search).toBe('?path=trip.yaml')
  expect(screen.getByRole('navigation', { name: 'LoomWatch' })).toBe(dock)
})

it('follows Back to the team before, with the run its address names', async () => {
  window.history.replaceState({}, '', '/?path=demo.yaml&run=run-3')
  render(<App />)
  expect(screen.getByRole('main', { name: 'Team' })).toHaveTextContent('demo.yaml · mount 1 · run run-3')
  act(() => goToTeam('/?path=trip.yaml'))
  await screen.findByText(/trip\.yaml · mount 2/)
  window.history.back()
  expect(await screen.findByText(/demo\.yaml · mount 3 · run run-3/)).toBeInTheDocument()
})
