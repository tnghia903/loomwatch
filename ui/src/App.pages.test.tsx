import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import App from './App'

// Nothing answers: what matters is what each page shows on its very first draw.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })

// Each page comes with the app (App.tsx), so opening one draws the page itself at once, its way
// back included, not a "Loading…" line that React keeps up for 300 ms once the page's code is in.
it.each(['/usage', '/agents', '/skills', '/quests', '/connections', '/you'])('%s draws the page at once', (path) => {
  window.history.replaceState({}, '', path)
  render(<App />)
  expect(screen.getAllByRole('link').length).toBeGreaterThan(0)
})

// The guide's "put it in a team" step happens in a project's room (ADR 0097), so the room carries it.
it('carries the getting-started guide on in a project’s room, where its teams are started', async () => {
  const room = { projects: [{ id: 'trip', name: 'Weekend trip', teams: [] }], loose: [], missing: [] }
  vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/projects'
    ? Promise.resolve(new Response(JSON.stringify(room), { headers: { 'content-type': 'application/json' } }))
    : new Promise(() => {}))))
  localStorage.setItem('loomwatch:tour', JSON.stringify({ status: 'active', step: 'new-team', runAtStepStart: null }))
  try {
    window.history.replaceState({}, '', '/projects/trip')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Weekend trip' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Put it in a team' }, { timeout: 3000 })).toBeInTheDocument()
  } finally {
    localStorage.removeItem('loomwatch:tour')
  }
})
