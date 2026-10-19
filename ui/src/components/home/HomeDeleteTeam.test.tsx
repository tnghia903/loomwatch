import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { markFirstRun } from '../../lib/firstrun/store'
import { Home } from './Home'

let fetchMock: ReturnType<typeof vi.fn>

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

beforeEach(() => {
  // Someone who has run nothing would open on the first run (ADR 0075); these tests are about Home.
  markFirstRun('skipped')
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign: vi.fn(), search: '', pathname: '/' } })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderHome() {
  render(<Home onPalette={vi.fn()} />)
}

/** Creates a team from the dialog's first template and says where it was filed. */
async function createTeam(name: string): Promise<string> {
  fireEvent.click(screen.getByRole('button', { name: 'New team' }))
  const dialog = screen.getByRole('dialog', { name: 'Create a team' })
  fireEvent.click(within(dialog).getByRole('radio', { name: /One assistant/ }))
  fireEvent.change(within(dialog).getByLabelText('Team name'), { target: { value: name } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create team' }))
  const put = await waitFor(() => {
    const call = fetchMock.mock.calls.find(([url, init]) => url === '/api/team' && (init as RequestInit | undefined)?.method === 'PUT')
    if (!call) throw new Error('no team saved yet')
    return call
  })
  return (JSON.parse(String((put[1] as RequestInit).body)) as { path: string }).path
}

describe('Deleting a team from Home', () => {
  it('deletes a team from its card menu and drops it from the list', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/teams') return respond({
        root: '/teams',
        files: ['old-desk.yaml', 'research.yaml'],
        teams: [
          { path: 'old-desk.yaml', name: 'Old desk', agentCount: 1, modifiedAt: '2026-01-01T00:00:00Z' },
          { path: 'research.yaml', name: 'Research desk', agentCount: 3, modifiedAt: '2026-09-30T00:00:00Z' },
        ],
        trashed: [],
      })
      if (url === '/api/runs?preview=true') return respond([])
      if (url === '/api/team?path=old-desk.yaml' && init?.method === 'DELETE') {
        return respond({ path: 'old-desk.yaml', name: 'Old desk', trash: '.trash/2026-10-01T090000Z-old-desk', moved: ['old-desk.yaml'], deletedAt: '2026-10-01T09:00:00Z' })
      }
      return respond({ error: 'unexpected' }, 404)
    })
    renderHome()
    await screen.findByRole('button', { name: /Old desk/ })

    // Every card's menu is "More actions"; the team it belongs to is its description.
    const more = screen.getByRole('button', { name: 'More actions', description: 'More actions for Old desk' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    const menu = screen.getByRole('menu', { name: 'Old desk actions' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete team…' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    // Opening a card is still the card's own click; the menu never opened the team.
    expect(window.location.assign).not.toHaveBeenCalled()

    const dialog = screen.getByRole('alertdialog', { name: 'Delete “Old desk”?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete team' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: /Old desk/ })).not.toBeInTheDocument())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Research desk/ })).toBeInTheDocument()
    // No visible notice or trash path; only a screen reader hears that it went.
    const said = screen.getByText('Deleted “Old desk”.')
    expect(said).toHaveAttribute('role', 'status')
    expect(said).toHaveClass('visually-hidden')
    expect(screen.queryByText(/\.trash/)).not.toBeInTheDocument()

    // Its name stays taken: a new "Old desk" would otherwise inherit the deleted one's history.
    expect(await createTeam('Old desk')).toBe('old-desk-2.yaml')
  })

  it('never files a new team where a deleted team used to live', async () => {
    fetchMock.mockImplementation(() => respond({ root: '/teams', files: [], teams: [], trashed: ['blog-writer.yaml'] }))
    renderHome()
    await screen.findByText(/No teams yet/)
    expect(await createTeam('Blog writer')).toBe('blog-writer-2.yaml')
  })

  it('closes a card menu on Escape and hands the focus back', async () => {
    fetchMock.mockImplementation(() => respond({ root: '/teams', files: ['a.yaml'], teams: [{ path: 'a.yaml', name: 'Research desk', agentCount: 1 }] }))
    renderHome()
    await screen.findByRole('button', { name: /Research desk/ })
    const more = screen.getByRole('button', { name: 'More actions' })
    fireEvent.click(more)
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Delete team…' }), { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(more).toHaveFocus()
  })
})
