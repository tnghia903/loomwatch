import { act, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NoteAnswering } from '../lib/chat/client'
import type { RunRecord } from '../lib/runs/client'
import { answering, at, failed, iso, OUT_OF_CREDITS, permission, run, said } from './fixtures'
import { Island } from './Island'

let runs: RunRecord[] = []
let notes: NoteAnswering[] = []
let noteReads = 0
const posted: { url: string; body: unknown }[] = []
const toApp: unknown[] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  // The page reads the clock: hold it a few seconds after the sample runs started, on any day.
  // Only the date is held, so the page's own timers and waitFor keep running.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(at(0) + 5_000)
  runs = []
  notes = []
  noteReads = 0
  posted.length = 0
  toApp.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/runs?')) return json(runs)
    if (url.startsWith('/api/chat/answering?')) {
      noteReads += 1
      return json(notes)
    }
    if (url === '/api/jobs') return json({ jobs: [] })
    if (url.startsWith('/api/team?')) return json({ path: 'trip.yaml', yaml: 'name: Trip planner\nagents:\n  - id: researcher\n  - id: writer\n', revision: 'sha256:x' })
    if (init?.method === 'POST') {
      posted.push({ url, body: JSON.parse(String(init.body)) })
      runs = runs.map((record) => ({ ...record, permissionRequests: [] }))
      return json(runs[0])
    }
    return json({}, 404)
  }))
  // The Mac app's side of the bridge.
  window.webkit = { messageHandlers: { island: { postMessage: (body: string) => toApp.push(JSON.parse(body)) } } }
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete window.webkit
  delete window.loomwatchIsland
})

function tellPage(message: unknown) {
  act(() => window.loomwatchIsland?.receive(message as never))
}

describe('the island page', () => {
  it('tells the app it listens, waits to be placed, and then shows a permission it can answer', async () => {
    runs = [run('r1', { permissionRequests: [permission('p1')] })]
    const { container } = render(<Island />)
    expect(toApp).toContainEqual({ kind: 'ready' })
    const island = container.querySelector('.island')!
    expect(island.getAttribute('data-view')).toBe('hidden')

    tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('ask'))
    const card = within(container.querySelector<HTMLElement>('.island-card')!)
    expect(card.getByText('Writer wants to use the web')).toBeTruthy()
    expect(card.getByText('Web search · kyoto hotels under 150')).toBeTruthy()

    fireEvent.click(card.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(posted).toEqual([{ url: '/api/runs/r1/permissions', body: { requestId: 'p1', decision: 'allow_once' } }]))
    // It says what it did before the card goes.
    expect(await card.findByText('Allowed once.')).toBeTruthy()
    expect(card.queryByRole('button', { name: 'Allow' })).toBeNull()
  })

  it('opens a command in LoomWatch instead of allowing it from one line', async () => {
    runs = [run('r1', { permissionRequests: [permission('p1', 'writer', { title: 'Run command', kind: 'execute', switch: 'commands', detail: 'rm -rf build && git push --force' })] })]
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
    await waitFor(() => expect(container.querySelector('.island-card')).toBeTruthy())
    const card = within(container.querySelector<HTMLElement>('.island-card')!)
    expect(card.getByText('Writer wants to run a command')).toBeTruthy()
    expect(card.getAllByRole('button').map((button) => button.textContent)).toEqual(['Open'])
    fireEvent.click(card.getByRole('button', { name: 'Open' }))
    expect(toApp).toContainEqual({ kind: 'open', link: '/?path=trip.yaml&run=r1' })
    expect(posted).toEqual([])
  })

  it('denies with Deny, and offers no other answer than these two', async () => {
    runs = [run('r1', { permissionRequests: [permission('p1')] })]
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
    await waitFor(() => expect(container.querySelector('.island-card')).toBeTruthy())
    const card = within(container.querySelector<HTMLElement>('.island-card')!)
    expect(card.getAllByRole('button').map((button) => button.textContent)).toEqual(['Deny', 'Allow'])
    fireEvent.click(card.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(posted[0]?.body).toEqual({ requestId: 'p1', decision: 'deny' }))
  })

  it('tells the app where the island is, so clicks beside it go through, and asks for the menu on a right-click', async () => {
    runs = [run('r1', { working: ['writer'] })]
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
    await waitFor(() => expect(toApp.some((message) => (message as { kind: string }).kind === 'areas')).toBe(true))
    fireEvent.contextMenu(container.querySelector('.island-shape')!, { clientX: 280, clientY: 10 })
    expect(toApp).toContainEqual({ kind: 'menu', x: 280, y: 10 })
  })

  it('reports the island first and a dropped question second, as the app numbers them', async () => {
    runs = [run('r1', { permissionRequests: [permission('p1')] })]
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
    await waitFor(() => expect(container.querySelector('.island')?.getAttribute('data-view')).toBe('ask'))
    const shape = container.querySelector<HTMLElement>('.island-shape')!
    const card = container.querySelector<HTMLElement>('.island-card')!
    shape.getBoundingClientRect = () => DOMRect.fromRect({ x: 186, y: 0, width: 188, height: 42 })
    card.getBoundingClientRect = () => DOMRect.fromRect({ x: 110, y: 150, width: 340, height: 110 })
    // A slip that has not slid out is not there to point at.
    container.querySelector<HTMLElement>('.island-slip')!.getBoundingClientRect = () => DOMRect.fromRect({ x: 105, y: 90, width: 350, height: 70 })
    fireEvent.transitionEnd(shape)
    expect(toApp.at(-1)).toEqual({ kind: 'areas', rects: [{ x: 186, y: 0, width: 188, height: 42 }, { x: 110, y: 150, width: 340, height: 110 }] })
  })

  it('reports nothing to point at while it is hidden', async () => {
    runs = [run('r1', { working: ['writer'] })]
    const { container } = render(<Island />)
    const shape = container.querySelector<HTMLElement>('.island-shape')!
    shape.getBoundingClientRect = () => DOMRect.fromRect({ x: 186, y: 0, width: 188, height: 32 })
    fireEvent.transitionEnd(shape)
    expect(toApp.filter((message) => (message as { kind: string }).kind === 'areas').at(-1)).toEqual({ kind: 'areas', rects: [] })
  })

  it('opens a question it cannot answer in LoomWatch, at its run', async () => {
    runs = [run('r1', { waitingOn: { node: 'writer', name: 'Writer', kind: 'question', since: '2026-10-22T10:02:00Z', question: 'Which city first?', park: 'none', parkNote: '', sendBackAvailable: false } })]
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
    await waitFor(() => expect(container.querySelector('.island-card')).toBeTruthy())
    const card = within(container.querySelector<HTMLElement>('.island-card')!)
    expect(card.getByText('Which city first?')).toBeTruthy()
    expect(card.getAllByRole('button').map((button) => button.textContent)).toEqual(['Answer'])
    fireEvent.click(card.getByRole('button', { name: 'Answer' }))
    expect(toApp).toContainEqual({ kind: 'open', link: '/?path=trip.yaml&run=r1' })
    expect(posted).toEqual([])
  })

  it('opens the list when the pointer reaches the island, one row per team', async () => {
    runs = [run('r1', { working: ['writer'] }), run('r2', { teamPath: 'digest.yaml', teamName: 'Weekly digest', agentIds: ['checker'], agentNames: { checker: 'Checker' }, working: ['checker'] })]
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
    await waitFor(() => expect(container.querySelector('.island')?.getAttribute('data-view')).toBe('tucked'))
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    expect(container.querySelector('.island')?.getAttribute('data-view')).toBe('list')
    const rows = [...container.querySelectorAll('.island-row')].map((row) => row.textContent)
    expect(rows).toEqual(['Trip plannerWriter just started', 'Weekly digestChecker just started'])
    // Its ⋯ asks the app for its menu: Open LoomWatch, Start at login, Show log, Quit.
    fireEvent.click(container.querySelector('.island-list')!.querySelector<HTMLElement>('[aria-label="More"]')!)
    expect(toApp.at(-1)).toMatchObject({ kind: 'menu' })
  })

  it('lists an agent answering in the chat, where no run is', async () => {
    notes = [
      answering('m1'),
      answering('m2', { teamPath: 'digest.yaml', teamName: 'Weekly digest', agentNames: { checker: 'Checker' }, answers: { waiting: ['checker'], said: [] }, createdAt: iso(-4) }),
    ]
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
    await waitFor(() => expect(container.querySelector('.island')?.getAttribute('data-view')).toBe('tucked'))
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    expect([...container.querySelectorAll('.island-row')].map((row) => row.textContent)).toEqual(['Weekly digestChecker is answering · 4 min', 'Trip plannerWriter is answering'])
  })

  it('peeks out with the agent that starts answering in the chat, then slides out its answer, which opens the chat', async () => {
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
    const island = container.querySelector('.island')!
    // The island has had its first look: what starts after it pops out.
    await waitFor(() => expect(noteReads).toBeGreaterThan(0))
    await act(async () => {})
    notes = [answering('m1')]
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('work'), { timeout: 5000 })
    expect(container.querySelector('.island-slot.is-on')?.getAttribute('data-agent')).toBe('writer')
    notes = [answering('m1', { answers: { waiting: [], said: [said('Every item keeps one number.')] }, finishedAt: new Date().toISOString() })]
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('done'), { timeout: 5000 })
    const slip = within(container.querySelector<HTMLElement>('.island-slip')!)
    // One agent answered a question: the team did no work, as the chat says under the answer.
    expect(slip.getByText('Writer answered in Trip planner')).toBeTruthy()
    expect(container.querySelector('.island-shape')?.getAttribute('aria-label')).toBe('LoomWatch: Writer answered in Trip planner')
    expect(slip.getByText('Every item keeps one number.')).toBeTruthy()
    fireEvent.click(slip.getByRole('button', { name: 'See answer' }))
    expect(toApp).toContainEqual({ kind: 'open', link: '/?path=trip.yaml&view=chat' })
  }, 15_000)

  it('slides out a stop when the agent answering in the chat could not answer, saying why, which opens the chat', async () => {
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
    const island = container.querySelector('.island')!
    await waitFor(() => expect(noteReads).toBeGreaterThan(0))
    await act(async () => {})
    notes = [answering('m1')]
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('work'), { timeout: 5000 })
    notes = [answering('m1', { answers: { waiting: [], said: [], failed: [failed(OUT_OF_CREDITS)] }, finishedAt: new Date().toISOString() })]
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('fail'), { timeout: 5000 })
    const slip = within(container.querySelector<HTMLElement>('.island-slip')!)
    expect(slip.getByText('Writer didn’t answer')).toBeTruthy()
    expect(slip.getByText(OUT_OF_CREDITS)).toBeTruthy()
    expect(container.querySelector('.island-shape')?.getAttribute('aria-label')).toBe('LoomWatch: Writer didn’t answer')
    expect(slip.queryByRole('button', { name: 'See why' })).toBeNull()
    fireEvent.click(slip.getByRole('button', { name: 'Open chat' }))
    expect(toApp).toContainEqual({ kind: 'open', link: '/?path=trip.yaml&view=chat' })
  }, 15_000)

  it('lists agents that could not answer by name, and the team when three or more didn’t', async () => {
    const finishedAt = new Date(at(0) + 60_000).toISOString()
    notes = [
      answering('m1', {
        agentNames: { researcher: 'Researcher', writer: 'Writer' },
        answers: { waiting: [], said: [], failed: [failed(OUT_OF_CREDITS, 'researcher', 1), failed(OUT_OF_CREDITS, 'writer', 1)] },
        finishedAt,
      }),
      answering('m2', {
        teamPath: 'digest.yaml',
        teamName: 'Weekly digest',
        agentNames: { reader: 'Reader', checker: 'Checker', editor: 'Editor' },
        answers: { waiting: [], said: [], failed: ['reader', 'checker', 'editor'].map((id) => failed(OUT_OF_CREDITS, id, 1)) },
        createdAt: iso(-1),
        finishedAt,
      }),
    ]
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
    await waitFor(() => expect(container.querySelector('.island')?.getAttribute('data-view')).not.toBe('rest'))
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    const [team, two] = [...container.querySelectorAll<HTMLElement>('.island-row')].map((row) => within(row))
    expect(team.getByText('Weekly digest didn’t answer')).toBeTruthy()
    expect(two.getByText('Researcher and Writer didn’t answer')).toBeTruthy()
    expect(two.getByRole('button', { name: 'Open chat' })).toBeTruthy()
  })
})
