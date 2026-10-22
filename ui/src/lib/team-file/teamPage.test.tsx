import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { holdPage, movedInPlace } from './inPlace'
import { goToTeam, useTeamPage } from './teamPage'
import { useTeamDocument } from './useTeamDocument'

const TEAM_YAML = (name: string) => `schemaVersion: 1
id: ${name.toLowerCase()}
name: ${name}
entrypoint: planner
agents:
  - id: planner
    name: Planner
    role: Plans the trip
    model: fake/offline
edges: []
`

const SCHEMA = { type: 'object', required: ['agents'] }

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

const teamReads = (fetchMock: Mock) => fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/team?')).length

let assign: Mock
let fetchMock: Mock
const real = window.location
let release: (() => void) | null = null

beforeEach(() => {
  window.history.replaceState(null, '', '/?path=demo.yaml')
  // jsdom makes location.assign non-configurable, so stand in a location that reads the real one.
  assign = vi.fn()
  const standIn = { assign, get href() { return real.href }, get search() { return real.search }, get pathname() { return real.pathname }, get origin() { return real.origin } }
  Object.defineProperty(window, 'location', { configurable: true, value: standIn })
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/teams') return jsonResponse({ root: '/teams', files: ['demo.yaml', 'trip.yaml'] })
    if (url === '/api/config/schema') return jsonResponse(SCHEMA)
    const path = new URLSearchParams(url.split('?')[1]).get('path') ?? ''
    return jsonResponse({ path, revision: `r-${path}`, yaml: TEAM_YAML(path === 'trip.yaml' ? 'Trip' : 'Demo') })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  release?.()
  release = null
  Object.defineProperty(window, 'location', { configurable: true, value: real })
  vi.unstubAllGlobals()
})

describe('moving between teams in place', () => {
  it('reads the next team first, then moves the address and starts its page from what was read', async () => {
    const page = renderHook(() => useTeamPage())
    act(() => goToTeam('/?path=trip.yaml'))
    await waitFor(() => expect(page.result.current.key).toBe(1))
    expect(assign).not.toHaveBeenCalled()
    expect(window.location.search).toBe('?path=trip.yaml')
    const reads = teamReads(fetchMock)
    expect(reads).toBe(1)

    // The team's page draws the team at once: no "Opening team…", and no second read of its file.
    const doc = renderHook(() => useTeamDocument())
    expect(doc.result.current.path).toBe('/teams/trip.yaml')
    expect(doc.result.current.teamName).toBe('Trip')
    expect(doc.result.current.nodes.map((node) => node.id)).toEqual(['planner'])
    expect(doc.result.current.saveState).toBe('clean')
    await waitFor(() => expect(doc.result.current.checking).toBe(false))
    expect(teamReads(fetchMock)).toBe(reads)
  })

  it('brings the schema’s checker along, so the next team is checked from the start', async () => {
    const first = renderHook(() => useTeamDocument())
    await waitFor(() => expect(first.result.current.checking).toBe(false))
    first.unmount()
    const page = renderHook(() => useTeamPage())
    act(() => goToTeam('/?path=trip.yaml'))
    await waitFor(() => expect(page.result.current.key).toBe(1))
    const schemaReads = fetchMock.mock.calls.filter(([input]) => String(input) === '/api/config/schema').length

    const doc = renderHook(() => useTeamDocument())
    expect(doc.result.current.checking).toBe(false)
    expect(doc.result.current.isValid).toBe(true)
    await act(async () => { await Promise.resolve() })
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/config/schema')).toHaveLength(schemaReads)
  })

  it('goes as a page load while changes aren’t saved, so the browser asks first', async () => {
    const page = renderHook(() => useTeamPage())
    release = holdPage()
    act(() => goToTeam('/?path=trip.yaml'))
    expect(assign).toHaveBeenCalledWith('/?path=trip.yaml')
    expect(window.location.search).toBe('?path=demo.yaml')
    expect(page.result.current.key).toBe(0)
    expect(teamReads(fetchMock)).toBe(0)
  })

  it('treats a team with changes not saved as work the move would lose', async () => {
    const page = renderHook(() => useTeamPage())
    const doc = renderHook(() => useTeamDocument())
    await waitFor(() => expect(doc.result.current.saveState).toBe('clean'))
    act(() => doc.result.current.renameTeam('Demo (draft)'))
    act(() => goToTeam('/?path=trip.yaml'))
    expect(assign).toHaveBeenCalledWith('/?path=trip.yaml')
    expect(page.result.current.key).toBe(0)
    // Gone with its page, the team holds nothing back.
    doc.unmount()
    assign.mockClear()
    act(() => goToTeam('/?path=trip.yaml'))
    expect(assign).not.toHaveBeenCalled()
    await waitFor(() => expect(page.result.current.key).toBe(1))
  })

  it('shows the team asked for last when two are asked for at once', async () => {
    let answerTrip: (() => void) | null = null
    const answered = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input: RequestInfo | URL) => (String(input).includes('path=trip.yaml')
      ? new Promise<Response>((resolve) => { answerTrip = () => resolve(answered(input)) })
      : answered(input)))
    const page = renderHook(() => useTeamPage())
    act(() => goToTeam('/?path=trip.yaml'))
    act(() => goToTeam('/?path=notes.yaml'))
    await waitFor(() => expect(page.result.current.key).toBe(1))
    expect(window.location.search).toBe('?path=notes.yaml')
    await act(async () => { answerTrip?.() })
    await act(async () => { await Promise.resolve() })
    expect(page.result.current.key).toBe(1)
    expect(window.location.search).toBe('?path=notes.yaml')
    // The page has moved in place, so the app's own data starts from what it last knew (inPlace.test).
    expect(movedInPlace()).toBe(true)
  })

  it('goes as a page load where no team page follows the address', () => {
    goToTeam('/?path=trip.yaml')
    expect(assign).toHaveBeenCalledWith('/?path=trip.yaml')
  })

  it('follows Back and Forward in place, with the run the address names', async () => {
    const page = renderHook(() => useTeamPage())
    // Where Back lands: the browser has moved the address before it says so.
    act(() => {
      window.history.pushState(null, '', '/?path=trip.yaml&run=run-7')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await waitFor(() => expect(page.result.current.key).toBe(1))
    expect(page.result.current.runId).toBe('run-7')
    expect(assign).not.toHaveBeenCalled()
  })

  it('keeps a team with changes not saved on screen when Back is pressed, and goes as a page load', () => {
    const page = renderHook(() => useTeamPage())
    release = holdPage()
    act(() => {
      window.history.pushState(null, '', '/?path=trip.yaml')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    // Its address comes back with it, and the browser asks before the page goes.
    expect(window.location.search).toBe('?path=demo.yaml')
    expect(assign).toHaveBeenCalledWith('http://localhost:3000/?path=trip.yaml')
    expect(page.result.current.key).toBe(0)
  })

  it('puts back the address of the team on screen after it was opened in place', async () => {
    const page = renderHook(() => useTeamPage())
    act(() => goToTeam('/?path=trip.yaml'))
    await waitFor(() => expect(page.result.current.key).toBe(1))
    release = holdPage()
    act(() => {
      window.history.pushState(null, '', '/?path=demo.yaml')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(window.location.search).toBe('?path=trip.yaml')
    expect(assign).toHaveBeenCalledWith('http://localhost:3000/?path=demo.yaml')
  })
})
