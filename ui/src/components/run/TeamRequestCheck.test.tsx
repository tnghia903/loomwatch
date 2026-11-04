import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { teamRequestCheckHref } from '../../lib/runs/teamRequests'
import { TeamRequestCheck } from './TeamRequestCheck'

/**
 * What the daemon answers each Start on the request, in turn: started, failed, gone (already
 * answered), forgotten (a restart), or the check of that revision.
 */
let starts: string[] = []
const pressed: string[] = []
const approved: unknown[] = []
/** Revisions the approval refuses as stale: the file changed after they were shown. */
let stale = new Set<string>()
/** Revisions the approval can't keep, for another reason. */
let unkept = new Set<string>()

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const request = {
  id: 'tr1',
  askedBy: { runId: 'c1', agent: 'coby', name: 'Coby', chatPath: '.jobs/.bench/coby.yaml' },
  team: { path: 'trip.yaml', name: 'Trip planner' },
  request: 'Plan one easy day trip from Đà Lạt',
  status: 'waiting',
  runId: null,
  problem: null,
  createdAt: '2026-11-04T00:00:00Z',
  finishedAt: null,
}
/** Another agent's request, listed first. */
const other = { ...request, id: 'tr0', askedBy: { ...request.askedBy, agent: 'maya', name: 'Maya' }, request: 'Book a table' }

beforeEach(() => {
  starts = []
  pressed.length = 0
  approved.length = 0
  stale = new Set()
  unkept = new Set()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/team-requests?')) return json([other, request])
    if (url === '/api/team-requests/tr1' && init?.method === 'POST') {
      pressed.push((JSON.parse(String(init.body)) as { decision: string }).decision)
      const next = starts.shift() ?? 'started'
      if (next === 'started') return json({ ...request, status: 'started', runId: 'run9' })
      if (next === 'failed') return json({ ...request, status: 'failed', problem: 'Trip planner can’t run as it is. Open Trip planner to see what to fix.' })
      if (next === 'gone') return json({ error: 'This request was already answered.' }, 409)
      if (next === 'forgotten') return json({ error: 'LoomWatch has no such request: it was answered or forgotten.' }, 404)
      return json({ error: 'Trip planner needs a check.', code: 'team_needs_review', teamPath: 'trip.yaml', teamName: 'Trip planner', teamRevision: next, review: [{ text: `Planner runs on LoomWatch (${next}).`, warn: false }] }, 428)
    }
    if (url === '/api/team/approve' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { teamRevision: string }
      approved.push(body)
      if (stale.has(body.teamRevision)) return json({ error: 'the team file changed after you reviewed it', code: 'stale_team_revision', currentTeamRevision: 'sha256:newer' }, 409)
      if (unkept.has(body.teamRevision)) return json({ error: 'LoomWatch could not keep your approval: the disk is full' }, 500)
      return json({ teamPath: 'trip.yaml', teamRevision: body.teamRevision })
    }
    return json({ error: 'not here' }, 404)
  }))
  window.history.replaceState(null, '', teamRequestCheckHref(request))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

const trust = () => fireEvent.click(screen.getByRole('button', { name: 'Trust and run' }))

describe('TeamRequestCheck', () => {
  it('shows the check of the team the notch’s Start opened it for, with what was asked, and Trust and run starts that request', async () => {
    starts = ['sha256:one', 'started']
    render(<TeamRequestCheck />)
    const dialog = await screen.findByRole('alertdialog', { name: 'Check “Trip planner” before it runs' })
    expect(dialog.textContent).toContain('Planner runs on LoomWatch (sha256:one).')
    expect(within(dialog).getByText('Coby asked: “Plan one easy day trip from Đà Lạt”')).toBeTruthy()
    // The address no longer asks: going back or loading the page again starts nothing.
    expect(window.location.search).toBe('?path=trip.yaml&view=chat')
    trust()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(approved).toEqual([{ teamPath: 'trip.yaml', teamRevision: 'sha256:one' }])
    expect(pressed).toEqual(['start', 'start'])
  })

  it('brings the newer check in place when the team changed again while it was open, and trusts that one', async () => {
    starts = ['sha256:one', 'sha256:two', 'started']
    // The file changed after the check opened: the version shown can't be approved any more.
    stale = new Set(['sha256:one'])
    render(<TeamRequestCheck />)
    const dialog = await screen.findByRole('alertdialog')
    trust()
    await screen.findByText('Planner runs on LoomWatch (sha256:two).')
    // The same dialog, saying it changed, ready to be trusted, with nothing gone wrong.
    expect(screen.getByRole('alertdialog')).toBe(dialog)
    expect(dialog.textContent).toContain('Trip planner changed again while this was open. Here is what it will do now:')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Trust and run' }).hasAttribute('disabled')).toBe(false)
    trust()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(approved).toEqual([{ teamPath: 'trip.yaml', teamRevision: 'sha256:one' }, { teamPath: 'trip.yaml', teamRevision: 'sha256:two' }])
    expect(pressed).toEqual(['start', 'start', 'start'])
  })

  it('says why on the team’s own page, with Close alone, when the request couldn’t start after all', async () => {
    starts = ['sha256:one', 'failed']
    render(<TeamRequestCheck />)
    const dialog = await screen.findByRole('alertdialog')
    trust()
    expect((await screen.findByRole('alert')).textContent).toBe('Trip planner can’t run as it is. Close this to see what to fix.')
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['Close'])
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('says so, with Close alone, when the request was answered while the check was open', async () => {
    starts = ['sha256:one', 'gone']
    render(<TeamRequestCheck />)
    const dialog = await screen.findByRole('alertdialog')
    trust()
    expect((await screen.findByRole('alert')).textContent).toBe('Coby’s request isn’t waiting any more.')
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['Close'])
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('says so when LoomWatch forgot the request while the check was open', async () => {
    starts = ['sha256:one', 'forgotten']
    render(<TeamRequestCheck />)
    const dialog = await screen.findByRole('alertdialog')
    trust()
    expect((await screen.findByRole('alert')).textContent).toBe('Coby’s request isn’t waiting any more.')
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['Close'])
  })

  it('starts nothing when the approval itself fails, and says why with Trust and run still there', async () => {
    starts = ['sha256:one']
    unkept = new Set(['sha256:one'])
    render(<TeamRequestCheck />)
    await screen.findByRole('alertdialog')
    trust()
    expect((await screen.findByRole('alert')).textContent).toBe('LoomWatch could not keep your approval: the disk is full')
    expect(pressed).toEqual(['start'])
    expect(screen.getByRole('button', { name: 'Trust and run' }).hasAttribute('disabled')).toBe(false)
  })

  it('Cancel puts the check away without trusting or starting anything', async () => {
    starts = ['sha256:one']
    render(<TeamRequestCheck />)
    await screen.findByRole('alertdialog')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(approved).toEqual([])
    expect(pressed).toEqual(['start'])
  })

  it('starts a request whose team was trusted since without asking again', async () => {
    starts = ['started']
    render(<TeamRequestCheck />)
    await waitFor(() => expect(pressed).toEqual(['start']))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(approved).toEqual([])
  })

  it('does nothing on a team page that wasn’t opened to check a request', async () => {
    window.history.replaceState(null, '', '/?path=trip.yaml&view=chat')
    render(<TeamRequestCheck />)
    await new Promise((done) => setTimeout(done, 50))
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
