import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { offerUpdate, openUpdates, resetUpdateStatus, rollbackCommand, type UpdateStatus } from '../../lib/updates/client'
import { UpdateBadge, Updates } from './Updates'

const upToDate: UpdateStatus = {
  current: '0.1.5',
  install: 'release',
  command: '~/LoomWatch/app/loomwatch update',
  automatic: true,
  turnedOffBy: null,
  checkedAt: new Date().toISOString(),
  error: null,
  latest: {
    version: '0.1.5',
    tag: 'v0.1.5',
    name: 'LoomWatch 0.1.5',
    publishedAt: '2026-10-05T07:30:00Z',
    url: 'https://github.com/tnghia903/loomwatch/releases/tag/v0.1.5',
    notes: '',
  },
  available: false,
  skipped: null,
  releasesUrl: 'https://github.com/tnghia903/loomwatch/releases',
}

const newer: UpdateStatus = {
  ...upToDate,
  latest: {
    version: '0.1.6',
    tag: 'v0.1.6',
    name: 'LoomWatch 0.1.6',
    publishedAt: '2026-10-07T07:30:00Z',
    url: 'https://github.com/tnghia903/loomwatch/releases/tag/v0.1.6',
    notes: '## What changed\n\n- **Faster** runs\n- <img src="https://tracker.test/x.png"> no pixels',
  },
  available: true,
}

type Route = (init?: RequestInit) => Promise<Response>
let routes: Record<string, Route>
let fetchMock: ReturnType<typeof vi.fn>
let writeText: ReturnType<typeof vi.fn>

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

function serve(status: UpdateStatus) {
  let shown = status
  routes = {
    'GET /api/updates': () => json(shown),
    'POST /api/updates/check': () => json(shown),
    'PUT /api/updates/settings': (init) => {
      const change = JSON.parse(String(init?.body)) as { automatic?: boolean; skipped?: string | null }
      shown = {
        ...shown,
        ...(change.automatic === undefined ? {} : { automatic: change.automatic }),
        ...(change.skipped === undefined ? {} : { skipped: change.skipped }),
      }
      return json(shown)
    },
  }
}

function calls(method: string, url: string) {
  return fetchMock.mock.calls.filter(([called, init]) => called === url && ((init as RequestInit | undefined)?.method ?? 'GET') === method)
}

beforeEach(() => {
  resetUpdateStatus()
  serve(upToDate)
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const route = routes[`${init?.method ?? 'GET'} ${url}`]
    return route ? route(init) : Promise.reject(new Error(`unexpected ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  writeText = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function app() {
  return render(<><Updates /><UpdateBadge /></>)
}

describe('offerUpdate', () => {
  it('points at a newer release only until the operator skips it', () => {
    expect(offerUpdate(null)).toBe(false)
    expect(offerUpdate(upToDate)).toBe(false)
    expect(offerUpdate(newer)).toBe(true)
    expect(offerUpdate({ ...newer, skipped: '0.1.6' })).toBe(false)
    // A skipped version does not hide the next one.
    expect(offerUpdate({ ...newer, skipped: '0.1.5' })).toBe(true)
  })

  it('names the rollback command beside the update command', () => {
    expect(rollbackCommand('~/LoomWatch/app/loomwatch update')).toBe('~/LoomWatch/app/loomwatch rollback')
    expect(rollbackCommand('loomwatch update')).toBe('loomwatch rollback')
    expect(rollbackCommand(null)).toBeNull()
  })
})

describe('Updates', () => {
  it('shows no pill while LoomWatch is up to date, and says so when asked', async () => {
    app()
    await waitFor(() => expect(calls('GET', '/api/updates')).toHaveLength(1))
    expect(screen.queryByRole('button', { name: /Update available/ })).toBeNull()
    act(() => openUpdates())
    const dialog = screen.getByRole('dialog', { name: 'LoomWatch is up to date' })
    expect(within(dialog).getByText(/You have 0\.1\.5\./)).toBeInTheDocument()
    expect(within(dialog).queryByText('How to update')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Skip this version' })).toBeNull()
  })

  it('points at a newer release, says what changed, and how to install it', async () => {
    serve(newer)
    app()
    const pill = await screen.findByRole('button', { name: /Update available/ })
    expect(pill).toHaveAccessibleName(/LoomWatch 0\.1\.6/)
    fireEvent.click(pill)
    const dialog = screen.getByRole('dialog', { name: 'LoomWatch 0.1.6 is available' })
    expect(within(dialog).getByText(/came out on/)).toBeInTheDocument()
    expect(await within(dialog).findByText('Faster')).toBeInTheDocument()
    // Release notes are Markdown from the network: no raw HTML, so no tracking pixel.
    expect(dialog.querySelector('img')).toBeNull()
    expect(within(dialog).getByRole('link', { name: /Read the release notes on GitHub/ })).toHaveAttribute('href', newer.latest?.url)
    expect(within(dialog).getByText('~/LoomWatch/app/loomwatch update')).toBeInTheDocument()
    expect(within(dialog).getByText('~/LoomWatch/app/loomwatch rollback')).toBeInTheDocument()
    expect(within(dialog).getByText(/press/)).toHaveTextContent('press Ctrl-C')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy the command' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('~/LoomWatch/app/loomwatch update'))
    // Nothing in the app installs it: no request beyond reading what the daemon found.
    expect(fetchMock.mock.calls.every(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET')).toBe(true)
  })

  it('stops pointing at a skipped version everywhere at once, and can point at it again', async () => {
    serve(newer)
    app()
    fireEvent.click(await screen.findByRole('button', { name: /Update available/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Skip this version' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Update available/ })).toBeNull())
    expect(JSON.parse(String(calls('PUT', '/api/updates/settings')[0][1].body))).toEqual({ skipped: '0.1.6' })
    expect(screen.getByText(/You chose to skip this version/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Point it out again' }))
    expect(await screen.findByRole('button', { name: /Update available/ })).toBeInTheDocument()
    expect(JSON.parse(String(calls('PUT', '/api/updates/settings')[1][1].body))).toEqual({ skipped: null })
  })

  it('checks now on request and shows what the daemon could not do', async () => {
    app()
    act(() => openUpdates())
    let finish: (response: Response) => void = () => {}
    routes['POST /api/updates/check'] = () => new Promise((resolve) => { finish = resolve })
    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }))
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled()
    await act(async () => finish(new Response(JSON.stringify({ ...upToDate, error: 'Couldn’t reach GitHub to check for a new version.' }), { status: 200 })))
    expect(await screen.findByText(/Couldn’t reach GitHub/)).toHaveAttribute('role', 'status')

    routes['POST /api/updates/check'] = () => json({ error: 'The server is busy.' }, 500)
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The server is busy.')
  })

  it('turns the daily check off and on, and says what it sends', async () => {
    app()
    act(() => openUpdates())
    const daily = await screen.findByRole('checkbox', { name: 'Check for new versions once a day' })
    await waitFor(() => expect(daily).toBeChecked())
    expect(screen.getByText(/Nothing about you, your teams or your runs is sent/)).toBeInTheDocument()
    fireEvent.click(daily)
    await waitFor(() => expect(daily).not.toBeChecked())
    expect(JSON.parse(String(calls('PUT', '/api/updates/settings')[0][1].body))).toEqual({ automatic: false })
  })

  it('cannot turn checks back on, or check, when this computer turned them off', async () => {
    serve({ ...upToDate, turnedOffBy: 'LOOMWATCH_UPDATE_CHECK', checkedAt: null, latest: null })
    app()
    act(() => openUpdates())
    const daily = await screen.findByRole('checkbox', { name: 'Check for new versions once a day' })
    await waitFor(() => expect(daily).toBeDisabled())
    expect(daily).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled()
    expect(screen.getByText(/Turned off on this computer by the LOOMWATCH_UPDATE_CHECK setting/)).toBeInTheDocument()
  })

  it('sends a copy started another way to the release page', async () => {
    serve({ ...newer, install: 'other', command: null })
    app()
    fireEvent.click(await screen.findByRole('button', { name: /Update available/ }))
    expect(screen.getByText(/Download it from the release page above/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy the command' })).toBeNull()
  })

  it('stays quiet with a daemon that knows nothing about updates', async () => {
    routes['GET /api/updates'] = () => json({ error: 'not found' }, 404)
    app()
    await waitFor(() => expect(calls('GET', '/api/updates').length).toBeGreaterThan(0))
    expect(screen.queryByRole('button', { name: /Update available/ })).toBeNull()
  })
})
