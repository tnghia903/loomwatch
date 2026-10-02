import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunRecord } from '../../lib/runs/client'
import { teamPathUnderRoot, type DeletedTeam } from '../../lib/team-file/client'
import { DeleteTeamDialog } from './DeleteTeamDialog'

const trashed: DeletedTeam = { path: 'trip.yaml', name: 'Trip planner', trash: '.trash/2026-10-01T090000Z-trip', moved: ['trip.brief', 'trip.layout.json', 'trip.yaml'], deletedAt: '2026-10-01T09:00:00Z' }

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

function run(teamPath: string, status: RunRecord['status']): Partial<RunRecord> {
  return { runId: `${teamPath}-${status}`, teamPath, status, createdAt: '2026-10-01T08:00:00Z' }
}

let fetchMock: ReturnType<typeof vi.fn>
let runs: Partial<RunRecord>[]
let deleteAnswer: () => Promise<Response>

beforeEach(() => {
  runs = []
  deleteAnswer = () => respond(trashed)
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/runs') return respond(runs)
    if (url === '/api/teams') return respond({ root: '/teams/', files: [] })
    if (url.startsWith('/api/team?') && init?.method === 'DELETE') return deleteAnswer()
    return respond({ error: 'unexpected' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

function renderDialog(path = 'trip.yaml') {
  const onDeleted = vi.fn()
  const onClose = vi.fn()
  render(<DeleteTeamDialog path={path} name="Trip planner" onDeleted={onDeleted} onClose={onClose} />)
  return { onDeleted, onClose }
}

const deleteCalls = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')

describe('DeleteTeamDialog', () => {
  it('says what happens in plain words, then moves the team to the trash', async () => {
    const { onDeleted } = renderDialog()
    const dialog = screen.getByRole('alertdialog', { name: 'Delete “Trip planner”?' })
    expect(dialog).toHaveTextContent('It leaves your teams list. Nothing is erased')
    // Added files go to the trash with the team (ADR 0028, amended), so the copy names them.
    expect(dialog).toHaveTextContent('any files you added to its agents move to a hidden .trash folder')
    expect(dialog).toHaveTextContent('.trash folder inside your teams folder')
    expect(dialog).toHaveTextContent('LoomWatch keeps its past runs')
    // The safe choice has the focus, so Enter on open never deletes.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Delete team' }))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(trashed))
    expect(deleteCalls().map(([url]) => url)).toEqual(['/api/team?path=trip.yaml'])
  })

  it('will not delete a team while one of its runs is unfinished, and unlocks when it ends', async () => {
    vi.useFakeTimers()
    // Finished runs of this team and live runs of another one are not this team running.
    runs = [run('trip.yaml', 'succeeded'), run('other.yaml', 'running'), run('trip.yaml', 'running')]
    renderDialog()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByRole('alert')).toHaveTextContent('“Trip planner” is running right now. Stop the run or wait for it to finish')
    const remove = screen.getByRole('button', { name: 'Delete team' })
    expect(remove).toBeDisabled()
    fireEvent.click(remove)
    expect(deleteCalls()).toHaveLength(0)

    runs = [run('trip.yaml', 'succeeded'), run('other.yaml', 'running'), run('trip.yaml', 'cancelled')]
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete team' })).toBeEnabled()
  })

  // The switcher passes the open document's absolute path; runs are filed relative to the folder.
  it('knows the open team is running when the switcher names it absolutely', async () => {
    runs = [run('trip.yaml', 'running')]
    renderDialog('/teams/trip.yaml')
    expect(await screen.findByRole('alert')).toHaveTextContent('is running right now')
    expect(screen.getByRole('button', { name: 'Delete team' })).toBeDisabled()
  })

  it('never takes a running team for one in another folder with the same file name', async () => {
    runs = [run('trip.yaml', 'running')]
    renderDialog('/teams/archive/trip.yaml')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/teams'))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete team' })).toBeEnabled()
    expect(teamPathUnderRoot('/teams', '/teams/archive/trip.yaml')).toBe('archive/trip.yaml')
    expect(teamPathUnderRoot('/teams', '/elsewhere/trip.yaml')).toBeNull()
  })

  it('shows the daemon’s refusal in its own words and keeps the team', async () => {
    deleteAnswer = () => respond({ error: "Japan trip reads this team's memory. Remove it from that team's memory settings first, then delete this team." }, 409)
    const { onDeleted } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Delete team' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Japan trip reads this team's memory.")
    expect(onDeleted).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Delete team' })).toBeEnabled()
  })

  it('closes on Cancel or Escape without deleting anything', () => {
    const { onClose } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(deleteCalls()).toHaveLength(0)
  })
})
