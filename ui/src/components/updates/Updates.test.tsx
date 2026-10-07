import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { offerUpdate, openUpdates, resetUpdateStatus, rollbackCommand, waitForRestart, type UpdateStatus } from '../../lib/updates/client'
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

/** A ready-built copy whose launcher starts it again: `./loomwatch` from this version on. */
const supervised: UpdateStatus = { ...newer, canInstall: true, installError: null }
const OLD_START = '2026-10-07T08:00:00.000Z'
const NEW_START = '2026-10-07T08:02:00.000Z'

function about(version: string, startedAt: string) {
  return json({ version, commit: null, os: 'macos', osVersion: '26.0', arch: 'aarch64', startedAt })
}

function run(runId: string, teamPath: string, status: string) {
  return { runId, sessionId: runId, teamPath, prompt: 'plan', status, mode: 'team', entrypoint: 'a', responder: 'a', agentIds: ['a'], createdAt: OLD_START, startedAt: OLD_START, finishedAt: null, error: null, exitCode: null, eventCount: null, reply: null }
}

async function openOn(status: UpdateStatus) {
  serve(status)
  app()
  fireEvent.click(await screen.findByRole('button', { name: /Update available/ }))
  return screen.getByRole('dialog')
}

describe('Update and restart', () => {
  it('is offered only when the launcher can start LoomWatch again', async () => {
    let dialog = await openOn(supervised)
    expect(within(dialog).getByRole('button', { name: 'Update and restart' })).toBeInTheDocument()
    // The terminal's way stays beside it.
    expect(within(dialog).getByText('~/LoomWatch/app/loomwatch update')).toBeInTheDocument()
    cleanup()
    resetUpdateStatus()

    for (const status of [
      newer,
      { ...newer, canInstall: false },
      { ...newer, install: 'source' as const, command: './loomwatch update', canInstall: false },
      { ...newer, install: 'other' as const, command: null },
    ]) {
      dialog = await openOn(status)
      expect(within(dialog).queryByRole('button', { name: 'Update and restart' })).toBeNull()
      cleanup()
      resetUpdateStatus()
    }

    // Nothing to install: no button, however the copy was started.
    serve({ ...upToDate, canInstall: true })
    app()
    act(() => openUpdates())
    expect(await screen.findByRole('dialog', { name: 'LoomWatch is up to date' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update and restart' })).toBeNull()
  })

  it('asks first, naming the teams at work that updating stops', async () => {
    const dialog = await openOn(supervised)
    routes['GET /api/runs'] = () => json([run('r1', 'trips/japan.yaml', 'running'), run('r2', 'digest.yaml', 'succeeded')])
    routes['GET /api/teams'] = () => json({ root: '/teams', files: ['trips/japan.yaml', 'digest.yaml'], teams: [{ path: 'trips/japan.yaml', name: 'Japan trip', agentCount: 2 }] })
    routes['POST /api/updates/install'] = () => json({ from: '0.1.5', to: '0.1.6', startedAt: OLD_START, stoppedRuns: 1 }, 202)
    routes['GET /api/about'] = () => about('0.1.5', OLD_START)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update and restart' }))

    const question = await within(dialog).findByRole('group', { name: 'Update to 0.1.6?' })
    expect(await within(question).findByText('This team is working, and updating stops it:')).toBeInTheDocument()
    // By the name Home shows it under.
    expect(within(question).getByRole('listitem')).toHaveTextContent('Japan trip')
    expect(calls('POST', '/api/updates/install')).toHaveLength(0)

    // Cancel stops nothing.
    fireEvent.click(within(question).getByRole('button', { name: 'Cancel' }))
    expect(within(dialog).queryByRole('group')).toBeNull()
    expect(calls('POST', '/api/updates/install')).toHaveLength(0)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Update and restart' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Stop it and update' }))
    expect(await screen.findByRole('dialog', { name: 'Updating to 0.1.6…' })).toBeInTheDocument()
    expect(JSON.parse(String(calls('POST', '/api/updates/install')[0][1].body))).toEqual({ stopRuns: true })
  })

  it('names a team that started working after the question, and asks again', async () => {
    const dialog = await openOn(supervised)
    routes['GET /api/runs'] = () => json([])
    routes['POST /api/updates/install'] = () => json({ error: 'A team is working. Updating stops it.', code: 'runs_live', liveRuns: [{ runId: 'r3', teamPath: 'news.yaml', status: 'starting' }] }, 409)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update and restart' }))
    expect(await within(dialog).findByText(/No team is working/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update and restart' }))
    const question = within(dialog).getByRole('group', { name: 'Update to 0.1.6?' })
    expect(await within(question).findByText(/A team started working since you asked/)).toBeInTheDocument()
    expect(within(question).getByRole('listitem')).toHaveTextContent('news')
    expect(JSON.parse(String(calls('POST', '/api/updates/install')[0][1].body))).toEqual({ stopRuns: false })
    expect(within(dialog).getByRole('button', { name: 'Stop it and update' })).toBeEnabled()
  })

  it('waits for LoomWatch to start again and says which version it updated to', async () => {
    const dialog = await openOn(supervised)
    routes['GET /api/runs'] = () => json([])
    routes['POST /api/updates/install'] = () => json({ from: '0.1.5', to: '0.1.6', startedAt: OLD_START, stoppedRuns: 0 }, 202)
    routes['GET /api/about'] = () => about('0.1.6', NEW_START)
    routes['GET /api/updates'] = () => json({ ...upToDate, current: '0.1.6', latest: newer.latest, canInstall: true })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update and restart' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Update and restart' }))

    expect(await screen.findByRole('dialog', { name: 'Updated to 0.1.6' })).toBeInTheDocument()
    expect(screen.getByText('LoomWatch 0.1.6 is running. Reload this page to use it.')).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    // The new version's news replaces the old: no pill for the version now running.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Update available/ })).toBeNull())
  })

  it('says why when the launcher started the same version again', async () => {
    const dialog = await openOn(supervised)
    routes['GET /api/runs'] = () => json([])
    routes['POST /api/updates/install'] = () => json({ from: '0.1.5', to: '0.1.6', startedAt: OLD_START, stoppedRuns: 0 }, 202)
    routes['GET /api/about'] = () => about('0.1.5', NEW_START)
    routes['GET /api/updates'] = () => json({ ...supervised, installError: 'the download did not finish, and LoomWatch 0.1.5 was left as it was.' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update and restart' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Update and restart' }))

    expect(await screen.findByRole('dialog', { name: 'The update didn’t finish' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('LoomWatch 0.1.5 was started again instead of 0.1.6. The download did not finish')
    // Said once, not again as the last update's note.
    expect(screen.queryByText(/The last update didn’t finish/)).toBeNull()
    // The way to try again, here or in the terminal, is still there.
    expect(screen.getByRole('button', { name: 'Update and restart' })).toBeInTheDocument()
  })

  it('says why the last update did not finish when the page opens after it', async () => {
    const dialog = await openOn({ ...supervised, installError: 'the download did not finish.' })
    expect(within(dialog).getByText('The last update didn’t finish. The download did not finish.')).toHaveAttribute('role', 'status')
  })

  it('shows a refusal it cannot act on', async () => {
    const dialog = await openOn(supervised)
    routes['GET /api/runs'] = () => json([])
    routes['POST /api/updates/install'] = () => json({ error: 'LoomWatch 0.1.5 is the newest version.', code: 'nothing_newer' }, 409)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update and restart' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Update and restart' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('LoomWatch 0.1.5 is the newest version.')
    expect(within(dialog).getByRole('button', { name: 'Update and restart' })).toBeEnabled()
  })
})

describe('waitForRestart', () => {
  const started = { from: '0.1.5', to: '0.1.6', startedAt: OLD_START, stoppedRuns: 0 }
  let clock = 0
  const options = { everyMs: 1000, giveUpMs: 10_000, now: () => clock, sleep: (ms: number) => { clock += ms; return Promise.resolve() } }

  it('waits past the daemon that is stopping and the time nothing answers', async () => {
    clock = 0
    const answers = [() => about('0.1.5', OLD_START), () => Promise.reject(new TypeError('Failed to fetch')), () => about('0.1.6', NEW_START)]
    routes['GET /api/about'] = () => (answers.shift() ?? answers[0])()
    expect(await waitForRestart(started, options)).toEqual({ outcome: 'updated', version: '0.1.6' })
    expect(calls('GET', '/api/about')).toHaveLength(3)
  })

  it('gives up when nothing answers, so the page can say where to look', async () => {
    clock = 0
    routes['GET /api/about'] = () => Promise.reject(new TypeError('Failed to fetch'))
    expect(await waitForRestart(started, options)).toEqual({ outcome: 'lost' })
  })
})
