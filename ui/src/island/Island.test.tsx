import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NoteAnswering } from '../lib/chat/client'
import { figureFor, figureStill } from '../lib/library/figures'
import type { SavedJob } from '../lib/library/jobs'
import type { TeamRequest } from '../lib/runs/teamRequests'
import type { RunRecord } from '../lib/runs/client'
import { cascaded, DESKTOP, rulesOf } from '../test/cascade'
import { answering, at, failed, iso, maya, OUT_OF_CREDITS, permission, pinnedChat, run, said } from './fixtures'
import { Island } from './Island'
import { ISLAND_WAITS } from './waits'

// The workbench is drawn with WebGL, which jsdom has none of: here it is what it was given.
vi.mock('../components/agents/AgentFigure', () => ({
  default: ({ view, readOnly, tone, labels }: { view: { look: { name: string }; mood: string }; readOnly?: boolean; tone?: string; labels: { anchor: string }[] }) => (
    <div data-testid="bench" data-agent={view.look.name} data-mood={view.mood} data-read-only={String(Boolean(readOnly))} data-tone={tone ?? 'app'} data-labels={labels.map((label) => label.anchor).join(' ')} />
  ),
}))

const writer: SavedJob = { id: 'writer', file: '.jobs/writer.yaml', name: 'Writer', instructions: 'Write a short draft.', model: 'fake/offline' }

let runs: RunRecord[] = []
let notes: NoteAnswering[] = []
let noteReads = 0
let pinnedAgent: string | null = null
/** What the page pinned, through `PUT /api/pinned-agent`. */
const pins: (string | null)[] = []
let sendFails = false
let requests: TeamRequest[] = []
const answeredTeams: { id: string; decision: string }[] = []
const uploads: string[] = []
/** Uploads held back, by file name, until their promise settles. */
let holdUploads: Partial<Record<string, Promise<void>>> = {}
let jobs: SavedJob[] = []
const posted: { url: string; body: unknown }[] = []
/** Team files written, and messages sent to a chat. */
const wrote: { path: string; yaml: string; precondition: string | null }[] = []
const messages: Record<string, unknown>[] = []
const toApp: unknown[] = []
/** While set, reading one run whole waits for it. */
let holdRunReads: Promise<void> | null = null
/** What the archive has of each run's events; a run not here has none the page can read. */
let sessionEvents: Record<string, Record<string, unknown>[]> = {}
/** While set, reading a run's events waits for it. */
let holdEventReads: Promise<void> | null = null
/** What the daemon suggests asking the pinned agent next, and how many times it was asked. */
let suggested: { suggestions: unknown[]; writing: boolean } | null = null
let suggestionReads = 0

/** One of a run's events, as the archive returns it, just now. */
function runEvent(runId: string, seq: number, agentId: string, kind: string, payload: Record<string, unknown>) {
  return { id: `${runId}-${seq}`, sessionId: runId, agentId, seq, ts: new Date().toISOString(), kind, payload }
}

/** The live connection after the archive, which brings nothing more. */
class QuietSocket { onopen = null; onmessage = null; onclose = null; onerror = null; close() {} }

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
  pinnedAgent = null
  pins.length = 0
  sendFails = false
  requests = []
  answeredTeams.length = 0
  uploads.length = 0
  holdUploads = {}
  jobs = []
  posted.length = 0
  wrote.length = 0
  messages.length = 0
  toApp.length = 0
  holdRunReads = null
  sessionEvents = {}
  holdEventReads = null
  suggested = null
  suggestionReads = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/runs?')) return json(runs)
    if (url.startsWith('/api/session/events?')) {
      if (holdEventReads) await holdEventReads
      const query = new URLSearchParams(url.split('?')[1])
      const events = sessionEvents[query.get('session')!]
      return events ? json(events.filter((event) => Number(event.seq) > Number(query.get('afterSeq')))) : json({ error: 'not found' }, 404)
    }
    if (url.startsWith('/api/chat/answering?')) {
      noteReads += 1
      return json(notes)
    }
    if (url === '/api/jobs') return json({ folder: '.jobs', jobs, problems: [] })
    if (url === '/api/pinned-agent' && init?.method === 'PUT') {
      pinnedAgent = (JSON.parse(String(init.body)) as { agent: string | null }).agent
      pins.push(pinnedAgent)
      return json({ agent: pinnedAgent, notchShown: true })
    }
    if (url === '/api/pinned-agent') return json({ agent: pinnedAgent })
    if (url === '/api/pinned-agent/suggestions') {
      suggestionReads += 1
      return suggested ? json(suggested) : json({ error: 'not found' }, 404)
    }
    if (url.startsWith('/api/team-requests?')) return json(requests)
    if (url.startsWith('/api/team-requests/') && init?.method === 'POST') {
      const id = decodeURIComponent(url.split('/').at(-1)!)
      const { decision } = JSON.parse(String(init.body)) as { decision: 'start' | 'decline' }
      answeredTeams.push({ id, decision })
      requests = requests.map((request) => (request.id === id ? { ...request, status: decision === 'start' ? 'started' : 'declined', runId: decision === 'start' ? 'crew1' : null } : request))
      return json(requests.find((request) => request.id === id))
    }
    if (url.startsWith('/api/chat/files?')) {
      const name = new URLSearchParams(url.split('?')[1]).get('name')!
      if (holdUploads[name]) await holdUploads[name]
      uploads.push(name)
      return json({ name, path: `/teams/.jobs/.bench/files/${name}`, bytes: 10, picture: false })
    }
    if (url.startsWith('/api/runs/') && !init?.method) {
      if (holdRunReads) await holdRunReads
      const record = runs.find((each) => url === `/api/runs/${each.runId}`)
      return record ? json(record) : json({ error: 'gone' }, 404)
    }
    if (url === '/api/bench') return json({ folder: '.jobs/.bench' })
    // An agent's chat has no file until its first message.
    if (url.startsWith('/api/team?') && url.includes('.bench')) return json({ error: 'not found' }, 404)
    if (url === '/api/team' && init?.method === 'PUT') {
      const headers = new Headers(init.headers)
      const body = JSON.parse(String(init.body)) as { path: string; yaml: string }
      wrote.push({ ...body, precondition: headers.get('If-None-Match') ?? headers.get('If-Match') })
      return json({ ...body, revision: 'sha256:chat' })
    }
    if (url === '/api/chat/messages') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if (sendFails) return json({ error: 'no model' }, 500)
      messages.push(body)
      return json({ route: body.startKey ? 'agent' : 'note', message: { id: 'm1', teamPath: body.teamPath, text: body.text, createdAt: iso(1), route: 'agent' }, run: null })
    }
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
  // Each test's island goes with it: left mounted, it keeps reading the runs every two seconds,
  // and a render it queues can land after the file's page is gone.
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete window.webkit
  delete window.loomwatchIsland
})

function tellPage(message: unknown) {
  act(() => window.loomwatchIsland?.receive(message as never))
}

/** The box's agent's workbench where it can be seen: under the box, not folded out of sight. */
function benchInSight(container: HTMLElement): Element | null {
  return container.querySelector('.island-list .island-bench:not([hidden]) [data-testid="bench"]')
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
    // It says what it did before the card goes: a yes to the web is for the rest of the run (ADR
    // 0104), which the daemon makes of an Allow from anywhere.
    expect(await card.findByText('Allowed for the rest of the run.')).toBeTruthy()
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

  // The owner (2026-10-26): Researcher's work waited for a review, and the figure holding it at the
  // notch was the review step's own, not Researcher's, as the chat draws it.
  it('hangs a review from the figure of the agent whose work it is, not the review step’s', async () => {
    expect(figureStill(figureFor('review'))).not.toBe(figureStill(figureFor('researcher')))
    runs = [run('r1', { waitingOn: { node: 'review', name: 'You', kind: 'review_stop', handoverFrom: 'researcher', since: '2026-10-22T10:02:00Z', question: 'Researcher is done. Approve the findings, or say what to change.', park: 'reloadable', parkNote: '', sendBackAvailable: true } })]
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
    await waitFor(() => expect(container.querySelector('.island-card')).toBeTruthy())
    expect(container.querySelector('.island-hang-figure img')?.getAttribute('src')).toBe(figureStill(figureFor('researcher')))
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
    // Its ⋯ asks the app for its menu: Open LoomWatch, Start at login, Show at the notch, Show
    // log, Quit.
    fireEvent.click(container.querySelector('.island-list')!.querySelector<HTMLElement>('[aria-label="More"]')!)
    expect(toApp.at(-1)).toMatchObject({ kind: 'menu' })
  })

  // The owner (2026-10-26): Cole wore another figure than in My agents wherever its chat's runs
  // showed. An agent's own chat (`.jobs/.bench/<id>.yaml`) is that agent, pinned to the notch or not.
  it('shows a run of an agent’s own chat in the figure the agent wears in My agents', async () => {
    // Maya is first in My agents, so the box opens with her; Writer is the one at work.
    jobs = [maya, { ...writer, figure: { kind: 'cone', color: 'sky' } }]
    expect(figureStill(figureFor('writer'))).not.toContain('cone-sky')
    runs = [run('r1', { teamPath: '.jobs/.bench/writer.yaml', teamName: 'Writer · chat', entrypoint: 'writer', responder: 'writer', agentIds: ['writer'], agentNames: { writer: 'Writer' }, working: ['writer'] })]
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
    await waitFor(() => expect(container.querySelector('.island-head img')?.getAttribute('src')).toContain('cone-sky'))
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
    // An answer in the chat has no run to follow: the figure bobs rather than acting anything out.
    expect(container.querySelector('.island-slot.is-on')?.getAttribute('data-phase')).toBeNull()
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

  it('the figure that peeks out acts out what its agent is at, from its run, and so does the one in front in its row', async () => {
    vi.stubGlobal('WebSocket', QuietSocket)
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
    const island = container.querySelector('.island')!
    await waitFor(() => expect(noteReads).toBeGreaterThan(0))
    await act(async () => {})
    // The researcher is on a web search: a call still open.
    sessionEvents.r1 = [runEvent('r1', 0, 'researcher', 'tool_call', { callId: 'call1', status: 'in_progress', title: 'Web search' })]
    let letEvents = () => {}
    holdEventReads = new Promise((done) => { letEvents = done })
    runs = [run('r1', { working: ['researcher'] })]
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('work'), { timeout: 5000 })
    const out = container.querySelector('.island-slot.is-on')!
    expect(out.getAttribute('data-agent')).toBe('researcher')
    // Until its events arrive it acts nothing out: no events would read as its first moments.
    await act(async () => { await new Promise((done) => setTimeout(done, 300)) })
    expect(out.getAttribute('data-phase')).toBeNull()
    letEvents()
    await waitFor(() => expect(out.getAttribute('data-phase')).toBe('tools'))
    // Pointing at the notch: the researcher in front of its row acts it out; the writer behind waits.
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('list'))
    const figures = [...container.querySelectorAll('.island-row .island-row-figure')]
    await waitFor(() => expect(figures.map((figure) => figure.getAttribute('data-phase'))).toEqual(['tools', null]))
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

describe('beside the notch at rest, on every screen', () => {
  const place = () => tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
  const view = (container: HTMLElement) => container.querySelector('.island')?.getAttribute('data-view')
  const leftEar = (container: HTMLElement) => container.querySelector<HTMLElement>('.island-ear-left')!
  const islandRules = rulesOf(readFileSync(resolve(process.cwd(), 'src/island/island.css'), 'utf8'))
  /** The least the cascade lets the island be, in the sizes the page was given for where it is. */
  const least = (island: HTMLElement, property: string) => {
    const value = cascaded(island.querySelector('.island-shape')!, property, DESKTOP, islandRules)
    return value && island.style.getPropertyValue(/^var\((--[\w-]+)\)$/.exec(value)?.[1] ?? '')
  }

  it('pinned, unpinned or another pinned: the one beside the notch ducks and the new one pops up in its place', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(container.querySelector('.island-pinned-head')).toBeTruthy())
    // As the page first draws it, nothing is handed over.
    expect(container.querySelector('.island-head.is-coming, .island-head.is-leaving')).toBeNull()
    const mayaStill = container.querySelector('.island-pinned-head img')!.getAttribute('src')
    // Maya unpinned in LoomWatch: she ducks, and LoomWatch's mark pops up in her place.
    pinnedAgent = null
    await waitFor(() => expect(container.querySelector('.island-head.island-mark.is-coming')).toBeTruthy(), { timeout: ISLAND_WAITS.poll + 2_000 })
    expect(container.querySelector('.island-head.is-leaving')).toBeTruthy()
    const leaving = container.querySelector<HTMLElement>('.island-head.is-leaving')!
    expect(leaving.querySelector('img')?.getAttribute('src')).toBe(mayaStill)
    expect(cascaded(leaving, 'animation', DESKTOP, islandRules)).toMatch(/^island-ear-duck /)
    expect(cascaded(container.querySelector('.island-head.island-mark')!, 'animation', DESKTOP, islandRules)).toMatch(/^island-ear-pop /)
    expect(cascaded(leaving, 'display', { ...DESKTOP, reducedMotion: true }, islandRules)).toBe('none')
    // Handed over, the mark stands alone.
    await waitFor(() => expect(container.querySelector('.island-head.is-leaving, .island-head.is-coming')).toBeNull(), { timeout: ISLAND_WAITS.switch + 2_000 })
    expect(container.querySelectorAll('.island-ear-left .island-head')).toHaveLength(1)
  }, 15_000)

  it('a working agent unpinned ducks in its own light, its breath waiting; one pinned in the mark’s place has the mark duck', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    runs = [pinnedChat('c1', { working: ['maya'] })]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(container.querySelector('.island-pinned-head')?.getAttribute('data-moment')).toBe('work'), { timeout: 5_000 })
    pinnedAgent = null
    runs = []
    await waitFor(() => expect(container.querySelector('.island-head.is-leaving')).toBeTruthy(), { timeout: ISLAND_WAITS.poll + 2_000 })
    const leaving = container.querySelector<HTMLElement>('.island-head.is-leaving')!
    expect(leaving.getAttribute('data-moment')).toBe('work')
    expect(cascaded(leaving, 'animation', DESKTOP, islandRules)).toMatch(/^island-ear-duck /)
    await waitFor(() => expect(container.querySelector('.island-head.is-leaving, .island-head.is-coming')).toBeNull(), { timeout: ISLAND_WAITS.switch + 2_000 })
    // Pinned again: the mark ducks and she pops up in its place.
    pinnedAgent = 'maya'
    await waitFor(() => expect(container.querySelector('.island-head.island-mark.is-leaving')).toBeTruthy(), { timeout: ISLAND_WAITS.poll + 2_000 })
    expect(container.querySelector('.island-pinned-head')?.classList.contains('is-coming')).toBe(true)
  }, 20_000)

  it('with no agent pinned, LoomWatch’s mark sits beside the notch, even with nothing running', async () => {
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(view(container)).toBe('rest'))
    const first = leftEar(container).querySelector('.island-head')
    expect(first).not.toBeNull()
    expect(first!.classList.contains('island-mark')).toBe(true)
    expect(first!.querySelector('svg.lw-mark')).toBeTruthy()
    expect(leftEar(container).querySelectorAll('.island-head')).toHaveLength(1)
  })

  it('LoomWatch’s mark rests with its stitch smile on the island page too; its gold “o” is for something that needs you', async () => {
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(view(container)).toBe('rest'))
    expect(leftEar(container).querySelector('svg.lw-mark')?.getAttribute('data-mouth')).toBe('stitch')
    // The rule that keeps the "o" hidden at rest reaches the island's page, not only the app's.
    const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
    const mark = read('src/styles/mark.css')
    expect(mark).toMatch(/\.lw-mark \.lw-mark-o \{ opacity: 0;/)
    expect(read('src/island/index.css')).toContain(`@import '../styles/mark.css';`)
    expect(read('src/index.css')).toContain(`@import './styles/mark.css';`)
  })

  it('LoomWatch’s mark is never beside a figure: with none pinned, a team at work takes its place', async () => {
    runs = [run('r1', { working: ['writer'] })]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(view(container)).toBe('tucked'))
    const heads = [...leftEar(container).querySelectorAll<HTMLElement>('.island-head')]
    expect(heads.map((head) => head.classList.contains('island-mark'))).toEqual([false])
    expect(heads[0].getAttribute('data-moment')).toBe('work')
    expect(heads[0].style.left).toBe('0px')
  })

  it('is never smaller than the notch, so shrinking back on its spring never leaves the notch showing below it', async () => {
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(view(container)).toBe('rest'))
    const island = container.querySelector<HTMLElement>('.island')!
    // Whatever it moves between, it can't overshoot past the notch on the way.
    for (const each of ['rest', 'tucked', 'work', 'ask', 'done', 'fail', 'list', 'slot']) {
      island.setAttribute('data-view', each)
      expect([each, least(island, 'min-width'), least(island, 'min-height')]).toEqual([each, '188px', '32px'])
    }
  })

  it('the agent that peeked out last is not drawn as the island shrinks back from the list: only while out, and as it tucks in', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(noteReads).toBeGreaterThan(0))
    await act(async () => {})
    // A team starts: its researcher peeks out below the notch.
    runs = [run('r1', { working: ['researcher'] })]
    await waitFor(() => expect(view(container)).toBe('work'), { timeout: 5_000 })
    const balcony = container.querySelector<HTMLElement>('.island-balcony')!
    // Drawn unless a rule hides it, at once unless a rule says to wait.
    const drawn = () => cascaded(balcony, 'visibility', DESKTOP, islandRules) || 'visible'
    const waits = () => cascaded(balcony, 'transition', DESKTOP, islandRules) || 'none'
    // Out, it is drawn from when it starts up: not before, parked below, which an island coming
    // straight from the list (a team starting while it was open) is still deep enough to show. Its
    // island doesn't shrink on a spring with reduced motion: there it fades in from the start.
    const rise = cascaded(balcony.querySelector<HTMLElement>('.island-slot.is-on')!, 'transition', DESKTOP, islandRules)!
    expect([drawn(), waits()]).toEqual(['visible', `visibility 0s ${rise.split(' ').at(-1)}`])
    expect(cascaded(balcony, 'transition', { ...DESKTOP, reducedMotion: true }, islandRules)).toBe('none')
    // Pointed at, the list opens over it, and it is gone from the first frame.
    const shape = container.querySelector('.island-shape')!
    fireEvent.pointerEnter(shape, { pointerType: 'mouse' })
    await waitFor(() => expect(view(container)).toBe('list'))
    expect([drawn(), waits()]).toEqual(['hidden', 'none'])
    // Left, the list closes and the island shrinks back beside the notch on its spring. The
    // researcher, parked below where it peeked out, is inside the island while it is still nearly as
    // deep as the list: it stays out of sight, rather than showing there alone.
    fireEvent.pointerLeave(shape, { pointerType: 'mouse' })
    await waitFor(() => expect(view(container)).toBe('tucked'), { timeout: ISLAND_WAITS.closeList + 2_000 })
    expect(balcony.querySelector('.island-slot')?.getAttribute('data-agent')).toBe('researcher')
    expect(drawn()).toBe('hidden')
    // Tucking in from below the notch instead, it is drawn until it is down: as long as it slides.
    const slide = cascaded(balcony.querySelector<HTMLElement>('.island-slot')!, 'transition', DESKTOP, islandRules)!
    expect(waits()).toBe(`visibility 0s ${slide.split(' ')[1]}`)
  }, 15_000)

  it('without a notch, nothing is drawn at rest, nor for the teams: nothing to point at, the face has their news', async () => {
    runs = [run('r1', { permissionRequests: [permission('p1')] })]
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: null, menuBar: 24 })
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: null }))
    await act(async () => { await new Promise((done) => setTimeout(done, 50)) })
    expect(view(container)).toBe('hidden')
    const areas = toApp.filter((message) => (message as { kind: string }).kind === 'areas')
    expect(areas.at(-1)).toEqual({ kind: 'areas', rects: [] })
    expect(container.querySelector('.island-ear .island-head')).toBeNull()
  })

  it('with reduced motion, a figure at work holds a pose, so it is not told from a ready one by colour alone', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/island/island.css'), 'utf8')
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).not.toBe('')
    expect(reduced).toContain('.island:is([data-view="rest"], [data-view="tucked"]) .island-head[data-moment="work"] { translate: 0 -2px; }')
  })

  it('a figure acts out every phase with a move of its own, its glow is wide enough to read on black, and reduced motion stops it all', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/island/island.css'), 'utf8')
    const moving = css.slice(0, css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(moving).not.toBe('')
    const moves = (['reading', 'thinking', 'tools', 'typing'] as const).map((phase) => {
      const move = new RegExp(`\\.island \\[data-phase="${phase}"\\] \\{ --act: ([\\w-]+) `).exec(moving)?.[1]
      expect(move, phase).toBeTruthy()
      const frames = new RegExp(`@keyframes ${move} \\{ (.+) \\}\\n`).exec(moving)?.[1] ?? ''
      expect(frames, phase).toMatch(/rotate|translate/)
      // It starts from rest, so a figure that starts acting doesn't jump.
      const start = /(?:^|\} )0%(?:, 100%)? \{ ([^}]*) \}/.exec(frames)?.[1]
      if (start !== undefined) expect(['rotate: 0deg;', 'translate: 0 0;'], phase).toContain(start.trim())
      return move
    })
    // Four different moves: reading, thinking, a tool and writing each look like themselves.
    expect(new Set(moves).size).toBe(4)
    // The figure that peeks out, and the one in front in a row, take the move; until its run says, each bobs.
    expect(moving).toContain('.island[data-view="work"] .island-slot.is-on > * { animation: var(--act, island-bob ')
    expect(moving).toContain('.island .island-row-figure.glow[data-moment="work"] > * { transform-origin: 50% 90%; animation: var(--act, island-bob ')
    // In a row, its breath stays closer, off the teammates behind it.
    expect(moving).toContain('.island .island-row-figure.glow[data-moment="work"] { animation-name: island-breathe-near; }')
    // A figure at work in the menu bar bobs as well as breathing, down, as its head is at the screen's top.
    expect(moving).toContain('.island:is([data-view="rest"], [data-view="tucked"]) .island-head[data-moment="work"] > * { animation: island-dip ')
    expect(moving).toMatch(/@keyframes island-dip \{ 0%, 100% \{ translate: 0 0; \} 50% \{ translate: 0 \d+px; \} \}/)
    // The glow's wide shadow is at least 5 px, at rest and at work's breath; 2.5 px read as a thin edge.
    const widest = (rule: string) => Math.max(...[...rule.matchAll(/drop-shadow\(0 0 ([\d.]+)px/g)].map((match) => Number(match[1])))
    expect(widest(/\.island \.glow \{ filter: ([^}]+)\}/.exec(moving)![1])).toBeGreaterThanOrEqual(5)
    expect(widest(/@keyframes island-breathe \{([^\n]+)/.exec(moving)![1])).toBeGreaterThanOrEqual(10)
    expect(widest(/@keyframes island-breathe-near \{([^\n]+)/.exec(moving)![1])).toBeLessThanOrEqual(8)
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('.island *, .island *::before, .island *::after { animation: none !important; }')
  })

  it('a figure keeps its glow while it moves: one light to an element, a rim on the figure and a halo on its holder', async () => {
    // Safari's engine, which the Mac app draws the island with, drops two lights on one element
    // while the figure inside it moves: a head at work beside the notch showed no glow at all.
    runs = [run('r1', { working: ['writer'] })]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(view(container)).toBe('tucked'))
    const head = leftEar(container).querySelector<HTMLElement>('.island-head.glow')!
    const figure = head.firstElementChild!
    expect(head.getAttribute('data-moment')).toBe('work')
    // At work it dips inside its holder: the case that lost its light.
    expect(cascaded(figure, 'animation', DESKTOP, islandRules)).toMatch(/^island-dip /)
    const lights = (filter: string | null) => [...(filter ?? '').matchAll(/drop-shadow\(0 0 ([\d.]+)px var\(--glow\)\)/g)].map((match) => Number(match[1]))
    for (const moment of ['work', 'ask', 'done', 'fail', 'ready']) {
      head.setAttribute('data-moment', moment)
      expect([moment, lights(cascaded(figure, 'filter', DESKTOP, islandRules)), lights(cascaded(head, 'filter', DESKTOP, islandRules))]).toEqual([moment, [1], [5]])
    }
    // Only a stopped figure is greyed, under its red rim.
    expect(cascaded(figure, 'filter', DESKTOP, islandRules)).toBe('drop-shadow(0 0 1px var(--glow))')
    head.setAttribute('data-moment', 'fail')
    expect(cascaded(figure, 'filter', DESKTOP, islandRules)).toMatch(/^saturate\(\.35\) drop-shadow\(0 0 1px /)
    // No element on the island, at rest or in a breath, carries two lights, and its one light comes
    // last: a light before another filter, such as saturate(), is dropped as well.
    const css = readFileSync(resolve(process.cwd(), 'src/island/island.css'), 'utf8')
    const filters = [...css.matchAll(/filter: ([^;}]+)/g)].map((match) => match[1])
    expect(filters.length).toBeGreaterThanOrEqual(5)
    for (const filter of filters) {
      const oneLightLast = (filter.match(/drop-shadow\(/g) ?? []).length <= 1 && !/drop-shadow\(.*\)\s+[\w-]+\(/.test(filter)
      expect([filter, oneLightLast]).toEqual([filter, true])
    }
  })

  it('the pinned agent sits first beside the notch, ready, in its own figure', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(leftEar(container).querySelector('.island-pinned-head img')).toBeTruthy())
    expect(view(container)).toBe('rest')
    const first = leftEar(container).querySelector<HTMLElement>('.island-head')!
    expect(first.classList.contains('island-pinned-head')).toBe(true)
    expect(first.getAttribute('data-moment')).toBe('ready')
    expect(leftEar(container).querySelector('.island-mark')).toBeNull()
  })

  it('while the pinned agent works it glows as at work, first, with each other busy team after it', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    runs = [pinnedChat('c1', { working: ['maya'] }), run('r1', { working: ['writer'] })]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(leftEar(container).querySelector('.island-pinned-head')?.getAttribute('data-moment')).toBe('work'))
    const heads = [...leftEar(container).querySelectorAll<HTMLElement>('.island-head')]
    expect(heads.map((head) => head.classList.contains('island-pinned-head'))).toEqual([true, false])
    expect(heads[1].getAttribute('data-moment')).toBe('work')
  })

  it('keeps the teams’ news out at the notch while the pointer is on another screen; the list opens only where the pointer is', async () => {
    runs = [run('r1', { permissionRequests: [permission('p1')] })]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(view(container)).toBe('ask'))
    tellPage({ kind: 'live', on: false })
    expect(view(container)).toBe('ask')
    tellPage({ kind: 'live', on: true })
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    expect(view(container)).toBe('list')
    tellPage({ kind: 'live', on: false })
    expect(view(container)).toBe('tucked')
  })

  it('tells the other screens’ islands what was looked at here, and not what they told it', async () => {
    runs = [run('r1', { status: 'succeeded', finishedAt: new Date().toISOString(), reply: 'Five days in Kyoto' }), run('r2', { working: ['writer'] })]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(view(container)).not.toBe('hidden'))
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    const row = [...container.querySelectorAll<HTMLElement>('.island-row')].find((each) => each.textContent?.includes('Five days in Kyoto'))!
    fireEvent.click(within(row).getByRole('button', { name: 'See answer' }))
    expect(toApp).toContainEqual({ kind: 'seen', runs: ['r1'] })
    const told = toApp.length
    tellPage({ kind: 'seen', runs: ['r2'] })
    await act(async () => {})
    expect(toApp.slice(told).filter((message) => (message as { kind: string }).kind === 'seen')).toEqual([])
  })
})

describe('the agent pinned to the notch', () => {
  const place = () => tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })

  it('comes first in the list, and a message from there starts it in its own chat, as saved', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    runs = [run('r1', { working: ['writer'] })]
    const { container } = render(<Island />)
    const { findByRole } = within(container)
    place()
    // The app hears an agent is pinned, so ⌃⌥Space has a box to open.
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    await waitFor(() => expect(container.querySelector('.island')?.getAttribute('data-view')).toBe('tucked'))
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    const field = await findByRole('textbox', { name: 'Message Maya' })
    expect(container.querySelector('.island-row')?.classList.contains('island-pinned')).toBe(true)
    expect([...container.querySelectorAll('.island-row:not(.island-pinned)')].map((row) => row.textContent)).toEqual(['Trip plannerWriter just started'])

    // Writing takes the keyboard; a space typed is the message's, not the island's.
    fireEvent.focus(field)
    expect(toApp).toContainEqual({ kind: 'keyboard', on: true })
    expect(fireEvent.keyDown(field, { key: ' ' })).toBe(true)
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(true)
    expect(container.querySelector('.island')?.getAttribute('data-view')).toBe('list')
    fireEvent.change(field, { target: { value: 'What is on my calendar today?' } })
    fireEvent.submit(field.closest('form')!)

    await waitFor(() => expect(messages).toHaveLength(1))
    // Its chat is written first, as the agent is saved, then the message starts it there.
    expect(wrote).toHaveLength(1)
    expect(wrote[0].path).toBe('.jobs/.bench/maya.yaml')
    expect(wrote[0].precondition).toBe('*')
    expect(wrote[0].yaml).toContain('id: maya')
    expect(wrote[0].yaml).toContain('Help me with my day.')
    expect(messages[0]).toMatchObject({ teamPath: '.jobs/.bench/maya.yaml', text: 'What is on my calendar today?', to: { kind: 'agent', agent: 'maya' }, expectedRevision: 'sha256:chat' })
    expect(typeof messages[0].startKey).toBe('string')
    // Sent: the box gives way to Maya at her workbench, the words fold into her head, and the
    // keyboard goes back to whatever had it.
    await waitFor(() => expect(container.querySelector('.island')?.getAttribute('data-view')).toBe('bench'))
    expect(container.querySelector('.island-fold')?.textContent).toBe('What is on my calendar today?')
    expect(await within(container).findByTestId('bench')).toBeTruthy()
    expect(toApp.filter((message) => (message as { kind: string }).kind === 'keyboard').at(-1)).toEqual({ kind: 'keyboard', on: false })
  }, 15_000)

  it('while it works, a message joins its turn as a note, and its chat is not written again', async () => {
    vi.stubGlobal('WebSocket', QuietSocket)
    pinnedAgent = 'maya'
    jobs = [maya]
    // Maya is writing her answer: her figure in her row acts it out.
    sessionEvents.c1 = [runEvent('c1', 0, 'maya', 'message', { role: 'assistant', text: 'You have two' })]
    runs = [pinnedChat('c1', { working: ['maya'] })]
    const { container } = render(<Island />)
    const { findByRole } = within(container)
    place()
    await waitFor(() => expect(container.querySelector('.island')?.getAttribute('data-view')).not.toBe('hidden'))
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    const field = await findByRole('textbox', { name: 'Note for Maya · after its current step' })
    // Its work is its own row's, under its name, not a team's row of its own.
    expect(container.querySelector('.island-pinned .island-words')?.textContent).toBe('Maya just started')
    await waitFor(() => expect(container.querySelector('.island-pinned .island-row-figure')?.getAttribute('data-phase')).toBe('typing'))
    // A note's mark is the team chat's: a return arrow, where a message that starts work goes up.
    expect(within(container).getByRole('button', { name: 'Send note' }).querySelector('svg.lw-icon-enter')).toBeTruthy()
    expect(container.querySelectorAll('.island-row:not(.island-pinned)')).toHaveLength(0)
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: 'Also check the weather' } })
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => expect(messages).toHaveLength(1))
    expect(wrote).toEqual([])
    expect(messages[0]).toMatchObject({ teamPath: '.jobs/.bench/maya.yaml', text: 'Also check the weather', to: { kind: 'agent', agent: 'maya' } })
    expect(messages[0]).not.toHaveProperty('startKey')
    expect(messages[0]).not.toHaveProperty('expectedRevision')
  })

  it('keeps a message that didn’t go through, and offers its chat in LoomWatch', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    sendFails = true
    const { container } = render(<Island />)
    const { findByRole, findByText } = within(container)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    const field = await findByRole('textbox', { name: 'Message Maya' })
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: 'Book the dentist' } })
    fireEvent.submit(field.closest('form')!)
    expect(await findByText('That didn’t go through. Try again, or open Maya’s chat.')).toBeTruthy()
    expect((field as HTMLInputElement).value).toBe('Book the dentist')
    fireEvent.click(await findByRole('button', { name: 'Open chat' }))
    expect(toApp).toContainEqual({ kind: 'open', link: '/agents/maya?view=chat' })
  }, 15_000)

  it('peeks out below the notch with its whole face and a little of its body, none of it behind the camera', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    const island = container.querySelector<HTMLElement>('.island')!
    await waitFor(() => expect(noteReads).toBeGreaterThan(0))
    await act(async () => {})
    runs = [pinnedChat('c1', { working: ['maya'] })]
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('work'), { timeout: 5000 })
    // Its sizes, in points, as the island's rules work them out from the notch's height.
    const rules = rulesOf(readFileSync(resolve(process.cwd(), 'src/island/island.css'), 'utf8'))
    const points = (element: HTMLElement, property: string): number => {
      let value = element.style.getPropertyValue(property) || cascaded(element, property, DESKTOP, rules) || ''
      for (let depth = 0; value.includes('var(') && depth < 8; depth += 1) {
        value = value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => `(${island.style.getPropertyValue(name) || cascaded(island, name, DESKTOP, rules)})`)
      }
      return Number(Function(`return ${value.replaceAll('calc', '').replaceAll('px', '')}`)())
    }
    const bar = points(island, '--bar')
    const figure = points(island, '--fig')
    const top = points(container.querySelector<HTMLElement>('.island-balcony')!, 'top')
    const deep = points(container.querySelector<HTMLElement>('.island-shape')!, '--h')
    // Of its picture: from the notch's edge, which the tallest figure's head (7% down) stays under,
    // to past the spool's head (63%), so its face is whole and a little of its body shows.
    const shown = [(bar - top) / figure, (deep - top) / figure]
    expect(shown[0]).toBeCloseTo(0.07, 2)
    expect(shown[1]).toBeGreaterThan(0.75)
  }, 15_000)

  it('shows its answer as any answer, which can be copied whole but not dragged out of the island', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    const island = container.querySelector('.island')!
    await waitFor(() => expect(noteReads).toBeGreaterThan(0))
    await act(async () => {})
    runs = [pinnedChat('c1', { working: ['maya'] })]
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('work'), { timeout: 5000 })
    // It peeks out wearing the figure it wears in My agents.
    expect(container.querySelector('.island-slot.is-on img')?.getAttribute('src')).toContain('spool-sage')
    const whole = 'You have two meetings today.\n\n- 10:00 [budget review](https://cal.example/b)\n- 12:30 lunch with **Sam**'
    let letRead = () => {}
    holdRunReads = new Promise((done) => { letRead = done })
    runs = [pinnedChat('c1', { status: 'succeeded', working: [], reply: whole, finishedAt: new Date().toISOString() })]
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('done'), { timeout: 5000 })
    const shown = 'You have two meetings today.\n• 10:00 budget review\n• 12:30 lunch with Sam'
    const plain = 'You have two meetings today.\n\n• 10:00 budget review (https://cal.example/b)\n• 12:30 lunch with Sam'
    const card = container.querySelector<HTMLElement>('.island-slip.is-answer .island-answer')!
    const slip = within(card)
    expect(slip.getByText('Maya answered')).toBeTruthy()
    // Until it is read whole, Copy is off: only its first line is known yet.
    expect(slip.getByRole('button', { name: 'Copy' })).toBeDisabled()
    letRead()
    // The whole answer, read whole, as plain text: not only its first line, and no Markdown marks.
    await waitFor(() => expect(card.querySelector('.island-words p')?.textContent).toBe(shown))
    await waitFor(() => expect(slip.getByRole('button', { name: 'Copy' })).toBeEnabled())
    // Copy: formatted for apps that take it, and plain, links keeping their addresses, for the rest.
    fireEvent.click(slip.getByRole('button', { name: 'Copy' }))
    const copied = toApp.find((message) => (message as { kind: string }).kind === 'copy') as { text: string; html: string }
    expect(copied.text).toBe(plain)
    expect(copied.html).toContain('<a href="https://cal.example/b">budget review</a>')
    expect(copied.html).toContain('<strong>Sam</strong>')
    // Not dragged out: a drag of the card carries nothing, and one let go of elsewhere leaves the
    // answer out.
    expect(card.getAttribute('draggable')).not.toBe('true')
    const carried: Record<string, string> = {}
    fireEvent.dragStart(card, { dataTransfer: { setData: (type: string, value: string) => { carried[type] = value }, setDragImage: () => {}, effectAllowed: 'all' } })
    expect(carried).toEqual({})
    fireEvent.dragEnd(card, { dataTransfer: { dropEffect: 'copy' } })
    await act(async () => {})
    expect(island.getAttribute('data-view')).toBe('done')
    expect(container.querySelector('.island-ear-right')?.getAttribute('data-right')).toBe('slip')
  }, 15_000)

  it('lets the keyboard reach Copy from the box, keeping it until Escape', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    const island = container.querySelector('.island')!
    await waitFor(() => expect(noteReads).toBeGreaterThan(0))
    await act(async () => {})
    runs = [pinnedChat('c1', { status: 'succeeded', working: [], reply: 'Take the **8:10** train.', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() })]
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('done'), { timeout: 5000 })
    // ⌃⌥Space: the box has the keyboard; Shift-Tab goes back to the answer's Copy.
    tellPage({ kind: 'compose' })
    const row = within(container.querySelector<HTMLElement>('.island-pinned')!)
    const field = await row.findByRole('textbox', { name: 'Message Maya' })
    await waitFor(() => expect(document.activeElement).toBe(field))
    const copy = row.getByRole('button', { name: 'Copy' })
    await waitFor(() => expect(copy).toBeEnabled())
    fireEvent.blur(field, { relatedTarget: copy })
    copy.focus()
    await act(async () => { await new Promise((done) => setTimeout(done, 900)) })
    expect(island.getAttribute('data-view')).toBe('list')
    expect(toApp).not.toContainEqual({ kind: 'keyboard', on: false })
    fireEvent.click(copy)
    expect(toApp).toContainEqual(expect.objectContaining({ kind: 'copy', text: 'Take the 8:10 train.' }))
    // Escape away from the box (Copy has made way for "Copied."), not only in it, gives the
    // keyboard back.
    expect(row.getByRole('status')).toHaveTextContent('Copied.')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(toApp.at(-1)).toEqual({ kind: 'keyboard', on: false })
    await waitFor(() => expect(island.getAttribute('data-view')).not.toBe('list'))
  }, 15_000)

  it('opens its answer in its chat', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    const island = container.querySelector('.island')!
    await waitFor(() => expect(noteReads).toBeGreaterThan(0))
    await act(async () => {})
    runs = [pinnedChat('c1', { status: 'succeeded', working: [], reply: 'Done.', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() })]
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('done'), { timeout: 5000 })
    fireEvent.click(within(container.querySelector<HTMLElement>('.island-slip')!).getByRole('button', { name: 'Open in LoomWatch' }))
    expect(toApp).toContainEqual({ kind: 'open', link: '/agents/maya?view=chat' })
  }, 15_000)

  it('in the list, its answer has Copy as a mark, opens from the foot’s Open in LoomWatch, and Send is a mark that comes once something is written', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    const island = container.querySelector('.island')!
    await waitFor(() => expect(noteReads).toBeGreaterThan(0))
    await act(async () => {})
    runs = [pinnedChat('c1', { status: 'succeeded', working: [], reply: 'Take the 8:10 train.', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() })]
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('done'), { timeout: 5000 })
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    const row = within(container.querySelector<HTMLElement>('.island-pinned')!)
    // Her row: her answer and Copy, as a mark; no worded button but those of her figure and the box.
    expect(row.getByText('Take the 8:10 train.')).toBeTruthy()
    const copy = row.getByRole('button', { name: 'Copy' })
    expect([copy.textContent, copy.querySelector('svg')]).toEqual(['', expect.anything()])
    expect(row.queryByRole('button', { name: 'See answer' })).toBeNull()
    expect(row.queryByRole('button', { name: 'Open in LoomWatch' })).toBeNull()
    // Send: a mark at the field's end, out of sight until something is written.
    const rules = rulesOf(readFileSync(resolve(process.cwd(), 'src/island/island.css'), 'utf8'))
    const send = row.getByRole('button', { name: 'Send' })
    expect([send.textContent, Boolean(send.querySelector('svg.lw-icon-send')), cascaded(send, 'opacity', DESKTOP, rules)]).toEqual(['', true, '0'])
    fireEvent.change(row.getByRole('textbox', { name: 'Message Maya' }), { target: { value: 'And the way back?' } })
    expect(cascaded(send, 'opacity', DESKTOP, rules)).toBe('1')
    // It comes by fading in and growing; with reduced motion it only fades, never growing.
    expect([cascaded(send, 'scale', DESKTOP, rules), cascaded(send, 'transition', DESKTOP, rules)]).toEqual(['1', expect.stringContaining('scale')])
    const still = { ...DESKTOP, reducedMotion: true }
    fireEvent.change(row.getByRole('textbox', { name: 'Message Maya' }), { target: { value: '' } })
    expect([cascaded(send, 'scale', still, rules), cascaded(send, 'transition', still, rules)]).toEqual(['1', expect.not.stringContaining('scale')])
    // The foot opens her answer, where her chat has it whole.
    fireEvent.click(within(container.querySelector<HTMLElement>('.island-list-foot')!).getByRole('button', { name: 'Open in LoomWatch' }))
    expect(toApp).toContainEqual({ kind: 'open', link: '/agents/maya?view=chat' })
  }, 15_000)

  it('opens LoomWatch from the foot when its agent has no answer to open', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    runs = [run('r1', { working: ['writer'] })]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(container.querySelector('.island')?.getAttribute('data-view')).toBe('tucked'))
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    await waitFor(() => expect(container.querySelector('.island-pinned')).toBeTruthy())
    fireEvent.click(within(container.querySelector<HTMLElement>('.island-list-foot')!).getByRole('button', { name: 'Open in LoomWatch' }))
    expect(toApp).toContainEqual({ kind: 'open', link: '/' })
  }, 15_000)

  it('opens its box with the keyboard when the app’s menu asks, and Escape gives the keyboard back', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    const { findByRole } = within(container)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    tellPage({ kind: 'compose' })
    expect(container.querySelector('.island')?.getAttribute('data-view')).toBe('list')
    const field = await findByRole('textbox', { name: 'Message Maya' })
    await waitFor(() => expect(document.activeElement).toBe(field))
    expect(toApp).toContainEqual({ kind: 'keyboard', on: true })
    // The pointer is elsewhere, yet the list stays while a message is written.
    tellPage({ kind: 'pointer', over: false, area: null })
    await act(async () => { await new Promise((done) => setTimeout(done, 900)) })
    expect(container.querySelector('.island')?.getAttribute('data-view')).toBe('list')
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(toApp.at(-1)).toEqual({ kind: 'keyboard', on: false })
    await waitFor(() => expect(container.querySelector('.island')?.getAttribute('data-view')).not.toBe('list'))

    // Pointing at the notch again opens the list, and leaves the keyboard where it is.
    const asked = toApp.length
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    const again = await findByRole('textbox', { name: 'Message Maya' })
    await act(async () => {})
    expect(document.activeElement).not.toBe(again)
    expect(toApp.slice(asked)).not.toContainEqual({ kind: 'keyboard', on: true })
  }, 15_000)

  it('with none in My agents, the app hears there is no one to message, and the list has no box', async () => {
    runs = [run('r1', { working: ['writer'] })]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: null }))
    tellPage({ kind: 'compose' })
    expect(container.querySelector('.island')?.getAttribute('data-view')).not.toBe('list')
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    expect(container.querySelector('.island-pinned')).toBeNull()
    expect(container.querySelector('input')).toBeNull()
  }, 15_000)
})

describe('the box: any of My agents, and its workbench', () => {
  const place = () => tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
  const islandRules = rulesOf(readFileSync(resolve(process.cwd(), 'src/island/island.css'), 'utf8'))
  const view = (container: HTMLElement) => container.querySelector('.island')?.getAttribute('data-view')

  it('with none pinned, opens with the first of My agents, and the first message pins it', async () => {
    jobs = [maya, writer]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    tellPage({ kind: 'compose' })
    const field = await within(container).findByRole('textbox', { name: 'Message Maya' })
    fireEvent.change(field, { target: { value: 'What is on my calendar today?' } })
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => expect(messages).toHaveLength(1))
    expect(pins).toEqual(['maya'])
    expect(messages[0]).toMatchObject({ teamPath: '.jobs/.bench/maya.yaml' })
  }, 15_000)

  it('with none pinned, a file brought near opens the slot for the first of My agents', async () => {
    jobs = [maya, writer]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    const pdf = new File(['%PDF'], 'Lease 2027.pdf', { type: 'application/pdf' })
    fireEvent.dragEnter(container.querySelector<HTMLElement>('.island-shape')!, { dataTransfer: { files: [pdf], getData: () => '', dropEffect: 'none' } })
    expect(view(container)).toBe('slot')
    expect(within(container).getByRole('status', { name: 'Drop it here for Maya' })).toBeTruthy()
  })

  it('writes only to the agent pinned at the notch: no other agents beside its name, and Tab moves on as anywhere', async () => {
    pinnedAgent = 'maya'
    jobs = [maya, writer]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    tellPage({ kind: 'compose' })
    const field = await within(container).findByRole('textbox', { name: 'Message Maya' })
    expect(container.querySelector('.island-box-name')?.textContent).toBe('Maya')
    // Writer is in My agents but not at the notch: nothing here switches the box to it.
    expect(within(container).queryByRole('button', { name: /Writer/ })).toBeNull()
    expect(container.querySelector('.island-box-head img')).toBeNull()
    // Tab isn't the box's: it moves on, as it does anywhere, and the box still writes to Maya.
    expect(fireEvent.keyDown(field, { key: 'Tab' })).toBe(true)
    expect(within(container).getByRole('textbox', { name: 'Message Maya' })).toBe(field)
    fireEvent.change(field, { target: { value: 'What is on my calendar today?' } })
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]).toMatchObject({ teamPath: '.jobs/.bench/maya.yaml', to: { kind: 'agent', agent: 'maya' } })
  }, 15_000)

  it('holding ⌃⌥Space, it listens: it says so, what is heard writes itself in after what was typed, and let go, the words wait for Send', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    tellPage({ kind: 'compose' })
    const field = await within(container).findByRole('textbox', { name: 'Message Maya' }) as HTMLInputElement
    // Before anything is written, beside its name: how to talk to it instead.
    const hint = within(container).getByLabelText('Hold Control-Option-Space to talk to Maya')
    expect(hint.textContent).toBe('hold⌃⌥Space')
    fireEvent.change(field, { target: { value: 'Book the ' } })
    expect(within(container).queryByLabelText('Hold Control-Option-Space to talk to Maya')).toBeNull()

    tellPage({ kind: 'listen', on: true })
    const row = container.querySelector('.island-pinned')!
    expect(row.classList.contains('is-listening')).toBe(true)
    expect(within(container).getByRole('status', { name: '' }).textContent).toBe('listening')
    // How loud it hears stands in Send's place, and only the bars are told.
    expect(within(container).queryByRole('button', { name: 'Send' })).toBeNull()
    const bars = container.querySelector<HTMLElement>('.island-loudness')!
    tellPage({ kind: 'level', level: 0.6 })
    expect(bars.style.getPropertyValue('--level')).toBe('0.60')
    tellPage({ kind: 'level', level: 7 })
    expect(bars.style.getPropertyValue('--level')).toBe('1.00')
    // Each time, every word heard so far, after what was typed.
    tellPage({ kind: 'heard', text: 'train to', done: false })
    expect(field.value).toBe('Book the train to')
    tellPage({ kind: 'heard', text: 'train to Kyoto on Friday', done: false })
    expect(field.value).toBe('Book the train to Kyoto on Friday')
    // The newest words are the ones in view: the box shows its end.
    expect(field.selectionStart).toBe(field.value.length)

    tellPage({ kind: 'listen', on: false })
    tellPage({ kind: 'heard', text: 'train to Kyoto on Friday.', done: true })
    expect(field.value).toBe('Book the train to Kyoto on Friday.')
    expect(row.classList.contains('is-listening')).toBe(false)
    expect(container.querySelector('.island-loudness')).toBeNull()
    // Let go, nothing went: the words wait in the box to be read and put right, and Send is back.
    expect(messages).toHaveLength(0)
    expect(within(container).getByRole('button', { name: 'Send' })).toBeTruthy()
    // Words heard after the last are in change nothing.
    tellPage({ kind: 'heard', text: 'stray', done: false })
    expect(field.value).toBe('Book the train to Kyoto on Friday.')
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]).toMatchObject({ text: 'Book the train to Kyoto on Friday.' })
  }, 15_000)

  it('words still on their way after letting go never bring back a message sent, or undo a word put right', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    tellPage({ kind: 'compose' })
    const field = await within(container).findByRole('textbox', { name: 'Message Maya' }) as HTMLInputElement
    tellPage({ kind: 'listen', on: true })
    tellPage({ kind: 'heard', text: 'Book the train', done: false })
    tellPage({ kind: 'listen', on: false })
    // Put right before the last words are in: they don't undo it.
    fireEvent.change(field, { target: { value: 'Book the plane' } })
    tellPage({ kind: 'heard', text: 'Book the train.', done: true })
    expect(field.value).toBe('Book the plane')
    // Sent before the last words are in: they don't bring it back.
    tellPage({ kind: 'listen', on: true })
    tellPage({ kind: 'heard', text: 'to Kyoto', done: false })
    tellPage({ kind: 'listen', on: false })
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]).toMatchObject({ text: 'Book the plane to Kyoto' })
    tellPage({ kind: 'heard', text: 'to Kyoto.', done: true })
    // Opened again, the box is empty.
    tellPage({ kind: 'clickOutside' })
    tellPage({ kind: 'compose' })
    const again = await within(container).findByRole('textbox', { name: /Maya/ }) as HTMLInputElement
    expect(again.value).toBe('')
  }, 15_000)

  it('a hold that hears nothing says so', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    tellPage({ kind: 'compose' })
    await within(container).findByRole('textbox', { name: 'Message Maya' })
    tellPage({ kind: 'listen', on: true })
    tellPage({ kind: 'listen', on: false })
    tellPage({ kind: 'heard', text: '', done: true })
    expect(within(container).getByText('Nothing was heard. Hold ⌃⌥Space while you speak, or type instead.')).toBeTruthy()
    // Heard the next time, it goes.
    tellPage({ kind: 'listen', on: true })
    expect(within(container).queryByText('Nothing was heard. Hold ⌃⌥Space while you speak, or type instead.')).toBeNull()
  }, 15_000)

  it('held while the box is away, listening opens it for the words to go into', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    tellPage({ kind: 'listen', on: true })
    const field = await within(container).findByRole('textbox', { name: 'Message Maya' }) as HTMLInputElement
    tellPage({ kind: 'heard', text: 'What is on today?', done: true })
    expect(field.value).toBe('What is on today?')
  }, 15_000)

  it('says why it could not listen, with System Settings a press away where a switch there puts it right', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    tellPage({ kind: 'compose' })
    await within(container).findByRole('textbox', { name: 'Message Maya' })
    tellPage({ kind: 'cantListen', why: 'microphone' })
    expect(within(container).getByRole('alert').textContent).toBe('The microphone is off for LoomWatch. Turn it on, then hold ⌃⌥Space again.')
    fireEvent.click(within(container).getByRole('button', { name: 'Open System Settings' }))
    expect(toApp).toContainEqual({ kind: 'settings', pane: 'microphone' })
    tellPage({ kind: 'cantListen', why: 'speech' })
    fireEvent.click(within(container).getByRole('button', { name: 'Open System Settings' }))
    expect(toApp).toContainEqual({ kind: 'settings', pane: 'speech' })
    // macOS asking is no problem: there is nothing to put right, only to hold again.
    tellPage({ kind: 'cantListen', why: 'asked' })
    expect(within(container).queryByRole('alert')).toBeNull()
    expect(within(container).getByText('Allow LoomWatch when macOS asks, then hold ⌃⌥Space again.')).toBeTruthy()
    expect(within(container).queryByRole('button', { name: 'Open System Settings' })).toBeNull()
    // Holding again, it goes; so does what is said once the box is put away.
    tellPage({ kind: 'listen', on: true })
    expect(within(container).queryByText('Allow LoomWatch when macOS asks, then hold ⌃⌥Space again.')).toBeNull()
    tellPage({ kind: 'listen', on: false })
    tellPage({ kind: 'cantListen', why: 'unavailable' })
    expect(within(container).getByText('Your Mac can’t turn speech into words right now. Type instead, or try again later.')).toBeTruthy()
    tellPage({ kind: 'compose' })
    await waitFor(() => expect(within(container).queryByRole('textbox', { name: 'Message Maya' })).toBeNull())
    tellPage({ kind: 'compose' })
    await within(container).findByRole('textbox', { name: 'Message Maya' })
    expect(within(container).queryByText('Your Mac can’t turn speech into words right now. Type instead, or try again later.')).toBeNull()
  }, 15_000)

  it('suggests what to ask next under the box: pressing one puts it in the box to change or send, and nothing goes until it is sent', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    // Its next steps are still being written as the box opens: the page asks again in a moment.
    suggested = { suggestions: [], writing: true }
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    // Nothing is asked for, or written, until the box is opened.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(suggestionReads).toBe(0)
    tellPage({ kind: 'compose' })
    const field = await within(container).findByRole('textbox', { name: 'Message Maya' }) as HTMLInputElement
    await waitFor(() => expect(suggestionReads).toBeGreaterThan(0))
    expect(within(container).queryByRole('group', { name: 'Ask Maya' })).toBeNull()
    suggested = { suggestions: [{ text: 'Draft a reply to Ana', kind: 'next' }, { text: 'Check my availability', kind: 'again' }, { text: 'Not one', kind: 'other' }, { text: ' ', kind: 'next' }], writing: false }
    const group = await within(container).findByRole('group', { name: 'Ask Maya' }, { timeout: ISLAND_WAITS.suggestionReread + 2_000 })
    expect(within(group).getAllByRole('button').map((button) => button.textContent)).toEqual(['Draft a reply to Ana', 'Check my availability'])

    fireEvent.click(within(group).getByRole('button', { name: 'Draft a reply to Ana' }))
    expect(field.value).toBe('Draft a reply to Ana')
    expect(messages).toHaveLength(0)
    // With something in the box they step aside, and come back once it is empty.
    expect(within(container).queryByRole('group', { name: 'Ask Maya' })).toBeNull()
    fireEvent.change(field, { target: { value: '' } })
    expect(within(container).getByRole('group', { name: 'Ask Maya' })).toBeTruthy()
    // So they do while it listens, keeping their room, so the island doesn't shrink as it starts.
    tellPage({ kind: 'listen', on: true })
    expect(within(container).queryByRole('group', { name: 'Ask Maya' })).toBeNull()
    expect(container.querySelector('.island-next.is-away[aria-hidden="true"]')).toBeTruthy()
    tellPage({ kind: 'heard', text: 'Draft', done: false })
    expect(container.querySelector('.island-next.is-away')).toBeTruthy()
    tellPage({ kind: 'listen', on: false })
    tellPage({ kind: 'heard', text: '', done: true })
    tellPage({ kind: 'listen', on: false })
    fireEvent.click(within(container).getByRole('button', { name: 'Check my availability' }))
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]).toMatchObject({ text: 'Check my availability' })
  }, 15_000)

  it('outside the Mac app, where nothing listens, says nothing about holding a key to talk', async () => {
    delete window.webkit
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
    // Maya stands beside the notch once the page has read who is pinned.
    await waitFor(() => expect(container.querySelector('.island-head img')).toBeTruthy())
    tellPage({ kind: 'compose' })
    await within(container).findByRole('textbox', { name: 'Message Maya' })
    expect(within(container).queryByLabelText('Hold Control-Option-Space to talk to Maya')).toBeNull()
    expect(container.querySelector('.island-talk')).toBeNull()
  }, 15_000)

  it('⌃⌥Space gives the box the keyboard without scrolling the island, which would lift its agent’s row out of the top', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    try {
      const { container } = render(<Island />)
      place()
      await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
      tellPage({ kind: 'compose' })
      const field = await within(container).findByRole('textbox', { name: 'Message Maya' })
      await waitFor(() => expect(document.activeElement).toBe(field))
      expect(focus.mock.contexts).toContain(field)
      for (const [index, element] of focus.mock.contexts.entries()) if (element === field) expect(focus.mock.calls[index][0]).toEqual({ preventScroll: true })
      // And nothing can scroll it: the island's body clips what is outside it.
      expect(cascaded(container.querySelector<HTMLElement>('.island-body')!, 'overflow', DESKTOP, islandRules)).toBe('clip')
    } finally {
      focus.mockRestore()
    }
  }, 15_000)

  it('draws another agent pinned while the box is open: the one it was ducks and the new one pops up with its name, and the same workbench takes it', async () => {
    await import('./BenchCard')
    pinnedAgent = 'maya'
    jobs = [maya, writer]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    const bench = await within(container).findByTestId('bench', undefined, { timeout: ISLAND_WAITS.benchSetUp + 3_000 })
    tellPage({ kind: 'compose' })
    const field = await within(container).findByRole('textbox', { name: 'Message Maya' })
    // Opening the box draws no switch.
    expect(container.querySelector('.is-coming, .is-leaving')).toBeNull()
    const mayaStill = container.querySelector('.island-bench-toggle img')!.getAttribute('src')
    // Writer is pinned in My agents: the island reads it on its next look.
    expect(field).toBeTruthy()
    pinnedAgent = 'writer'
    await within(container).findByRole('textbox', { name: 'Message Writer' }, { timeout: ISLAND_WAITS.poll + 2_000 })
    const toggle = within(container).getByRole('button', { name: 'See Writer’s workbench' })
    // Maya ducks, and Writer pops up in her place with his name.
    expect(toggle.querySelector('.island-switch.is-leaving')).toBeTruthy()
    expect(toggle.querySelector('.island-switch.is-coming')).toBeTruthy()
    const leaving = toggle.querySelector<HTMLElement>('.island-switch.is-leaving')!
    const coming = toggle.querySelector<HTMLElement>('.island-switch.is-coming')!
    expect(leaving.querySelector('img')?.getAttribute('src')).toBe(mayaStill)
    expect(coming.querySelector('img')?.getAttribute('src')).not.toBe(mayaStill)
    // Its duck is a transition, so a figure skipped while still rising ducks from where it got to.
    expect([cascaded(leaving, 'translate', DESKTOP, islandRules), cascaded(leaving, 'transition', DESKTOP, islandRules)]).toEqual(['0 150%', 'translate var(--t-quick) var(--ease-in)'])
    expect(cascaded(coming, 'animation', DESKTOP, islandRules)).toMatch(/^island-pop-up /)
    expect(container.querySelector('.island-box-name')?.textContent).toBe('Writer')
    // With motion reduced, the swap is at once: the one it was is gone, not ducking.
    expect(cascaded(leaving, 'display', { ...DESKTOP, reducedMotion: true }, islandRules)).toBe('none')
    // The same workbench, set up once, now Writer's.
    expect(within(container).getByTestId('bench')).toBe(bench)
    await waitFor(() => expect(bench.dataset.agent).toBe('Writer'))
    // Drawn, the switch leaves Writer alone in the row.
    await waitFor(() => expect(container.querySelector('.is-coming, .is-leaving')).toBeNull(), { timeout: ISLAND_WAITS.switch + 2_000 })
    expect(toggle.querySelectorAll('.island-switch')).toHaveLength(1)
  }, 20_000)

  it('brings its agent down from beside the notch into its row as ⌃⌥Space opens the list, the rest rising in around it', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    // The flight takes hold when `taken` is called, as a browser's animation is ready a frame later.
    let taken = () => {}
    const animate = vi.fn(() => ({ ready: new Promise<void>((resolve) => { taken = resolve }) }))
    const had = HTMLElement.prototype.animate
    HTMLElement.prototype.animate = animate as never
    const box = (x: number, y: number, size: number) => ({ x, y, left: x, top: y, width: size, height: size, right: x + size, bottom: y + size, toJSON() {} }) as DOMRect
    // Where the page would lay them out: Maya beside the notch, and her place in the list's row.
    // The island's spring as WebKit reads it from the built stylesheet: in seconds.
    const style = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const real = style(element, pseudo)
      return new Proxy(real, { get: (target, key) => (key === 'getPropertyValue' ? (name: string) => (name === '--t-spring' ? '.56s' : target.getPropertyValue(name)) : Reflect.get(target, key)) })
    })
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      // Once the list opens she has begun to leave, a bar lower.
      if (this.classList.contains('island-pinned-head')) return this.closest('.island')?.getAttribute('data-view') === 'list' ? box(100, 28, 40) : box(100, -4, 40)
      // Her figure sits at the corner of its button, which is wider.
      if (this.classList.contains('island-row-figure')) return box(40, 49, 38)
      if (this.classList.contains('island-bench-toggle')) return box(40, 49, 56)
      return box(0, 0, 0)
    })
    try {
      const { container } = render(<Island />)
      place()
      await waitFor(() => expect(container.querySelector('.island-pinned-head')).toBeTruthy())
      expect(view(container)).toBe('rest')
      // ⌃⌥Space comes once the app knows whom the box opens with, as in the app: her head is drawn a
      // moment before the box knows her, and on a busy machine a ⌃⌥Space between the two opens nothing.
      await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
      tellPage({ kind: 'compose' })
      await within(container).findByRole('textbox', { name: 'Message Maya' })
      // Her figure in the row starts where she stood beside the notch, and comes down on the spring.
      expect(animate).toHaveBeenCalledTimes(1)
      expect(animate.mock.contexts[0]).toBe(within(container).getByRole('button', { name: 'See Maya’s workbench' }))
      const [frames, timing] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions]
      expect([frames[0].transform, frames.at(-1)?.transform]).toEqual([`translate(60px, -53px) scale(${40 / 38})`, 'none'])
      expect(frames[0].transformOrigin).toBe('0px 0px')
      // Until it has taken hold, she stands where it starts; then the flight alone moves her.
      const button = within(container).getByRole('button', { name: 'See Maya’s workbench' })
      expect(button.style.transform).toBe(frames[0].transform)
      await act(async () => taken())
      expect(button.style.transform).toBe('')
      expect(timing).toMatchObject({ duration: 560 })
      // The one beside the notch is gone at once, and the rest of the list rises in around her.
      expect(cascaded(container.querySelector('.island-pinned-head')!, 'visibility', DESKTOP, islandRules)).toBe('hidden')
      expect(container.querySelector('.island-list')?.classList.contains('is-flying')).toBe(true)
      // Put away and opened again by pointing at it while a team's start is out: nothing to bring down.
      tellPage({ kind: 'clickOutside' })
      await waitFor(() => expect(view(container)).toBe('rest'))
      runs = [run('r1', { working: ['researcher'] })]
      await waitFor(() => expect(view(container)).toBe('work'), { timeout: 5_000 })
      tellPage({ kind: 'pointer', over: true, area: 0 })
      await waitFor(() => expect(view(container)).toBe('list'))
      expect(animate).toHaveBeenCalledTimes(1)
      expect(container.querySelector('.island-list')?.classList.contains('is-flying')).toBe(false)
    } finally {
      HTMLElement.prototype.animate = had
      rects.mockRestore()
      vi.mocked(window.getComputedStyle).mockRestore()
    }
  }, 20_000)

  it('keeps the line between its agent’s row and the teams’ rows, past the workbench’s place between them', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    runs = [run('r1', { working: ['researcher'] })]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    tellPage({ kind: 'pointer', over: true, area: 0 })
    const team = await waitFor(() => {
      const row = container.querySelector<HTMLElement>('.island-row:not(.island-pinned)')
      expect(row).toBeTruthy()
      return row!
    })
    expect(team.previousElementSibling?.classList.contains('island-bench-slot')).toBe(true)
    expect(cascaded(team, 'border-top', DESKTOP, islandRules)).toBe('1px solid var(--color-hairline)')
  }, 15_000)

  it('opens its agent’s workbench from its figure, to look at, in the island’s own dark; Escape folds it first', async () => {
    try { localStorage.setItem('loomwatch:theme', 'light') } catch { /* no storage */ }
    document.documentElement.setAttribute('data-theme', 'dark')
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    tellPage({ kind: 'compose' })
    const field = await within(container).findByRole('textbox', { name: 'Message Maya' })
    const figure = within(container).getByRole('button', { name: 'See Maya’s workbench' })
    expect(figure.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(figure)
    const bench = await within(container).findByTestId('bench')
    const shown = () => {
      expect(bench.isConnected).toBe(true)
      return benchInSight(container) === bench
    }
    await waitFor(() => expect(shown()).toBe(true))
    expect([bench.dataset.agent, bench.dataset.readOnly, bench.dataset.tone]).toEqual(['Maya', 'true', 'dark'])
    expect(bench.dataset.labels).toContain('job')
    expect(within(container).getByRole('button', { name: 'Hide Maya’s workbench' }).getAttribute('aria-expanded')).toBe('true')
    // The bench never turns the island to the app's light theme.
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    // The workbench takes the place of the teams' rows.
    expect(container.querySelectorAll('.island-row:not(.island-pinned)')).toHaveLength(0)
    // Escape folds the bench out of sight, and the box stays to write in; again, and the box goes.
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(shown()).toBe(false))
    expect(field.isConnected).toBe(true)
    expect(view(container)).toBe('list')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(view(container)).not.toBe('list'))
    try { localStorage.removeItem('loomwatch:theme') } catch { /* no storage */ }
  }, 15_000)

  it('sets up its agent’s workbench out of sight once the page has settled, and the box opens with that one rather than setting up another', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    // Before ⌃⌥Space: her workbench is there, set up out of sight, and the box is not open.
    const bench = await within(container).findByTestId('bench', undefined, { timeout: ISLAND_WAITS.benchSetUp + 3_000 })
    expect(view(container)).toBe('rest')
    expect(bench.closest('.island-bench-park')).toBeTruthy()
    expect(benchInSight(container)).toBeNull()
    tellPage({ kind: 'compose' })
    await within(container).findByRole('textbox', { name: 'Message Maya' })
    // The box opens with the same one, moved under her row, still out of sight.
    expect(within(container).getByTestId('bench')).toBe(bench)
    expect(bench.closest('.island-list')).toBeTruthy()
    expect(benchInSight(container)).toBeNull()
    // Her figure shows it, the same one again.
    fireEvent.click(within(container).getByRole('button', { name: 'See Maya’s workbench' }))
    await waitFor(() => expect(benchInSight(container)).toBe(bench))
    // Put away, it goes back out of sight, kept for the next time.
    tellPage({ kind: 'clickOutside' })
    await waitFor(() => expect(view(container)).toBe('rest'))
    expect(bench.isConnected).toBe(true)
    expect(bench.closest('.island-bench-park')).toBeTruthy()
  }, 15_000)

  it('sets up no workbench on a screen the pointer isn’t on', async () => {
    // Its code is loaded first: run alone, its download could outlast the wait and pass for nothing.
    await import('./BenchCard')
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    tellPage({ kind: 'live', on: false })
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    await act(() => new Promise((resolve) => setTimeout(resolve, ISLAND_WAITS.benchSetUp + 500)))
    expect(within(container).queryByTestId('bench')).toBeNull()
    // The pointer comes: it is set up there.
    tellPage({ kind: 'live', on: true })
    expect(await within(container).findByTestId('bench', undefined, { timeout: ISLAND_WAITS.benchSetUp + 3_000 })).toBeTruthy()
  }, 15_000)

  it('without a notch, opens as a box from the menu bar, shows its agent at its workbench once sent, then tucks it into a pill at its desk, open again while pointed at', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: null, menuBar: 24 })
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    expect(view(container)).toBe('hidden')
    tellPage({ kind: 'compose' })
    expect(view(container)).toBe('box')
    // Only the box: no teams, no foot with the menu.
    expect(container.querySelector('.island-list-foot')).toBeNull()
    const field = await within(container).findByRole('textbox', { name: 'Message Maya' })
    fireEvent.change(field, { target: { value: 'What is on my calendar today?' } })
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => expect(view(container)).toBe('bench'))
    expect(await within(container).findByTestId('bench')).toBeTruthy()
    runs = [pinnedChat('c1', { working: ['maya'] })]
    // Its moment is up: it tucks into a pill, Maya at her little desk.
    vi.setSystemTime(Date.now() + ISLAND_WAITS.bench)
    tellPage({ kind: 'away', away: false })
    expect(view(container)).toBe('pill')
    expect(container.querySelector('.island-pill-desk .island-pill-figure')).toBeTruthy()
    expect(benchInSight(container)).toBeNull()
    // Pointed at, her workbench opens; left, it tucks away again.
    tellPage({ kind: 'pointer', over: true, area: 0 })
    expect(view(container)).toBe('pill')
    await waitFor(() => expect(view(container)).toBe('bench'))
    expect(await within(container).findByTestId('bench')).toBeTruthy()
    tellPage({ kind: 'pointer', over: false, area: null })
    await waitFor(() => expect(view(container)).toBe('pill'), { timeout: 3000 })
  }, 15_000)
})

describe('the notch as the pinned agent’s slot, and its crew', () => {
  const place = () => tellPage({ kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 })
  const pdf = new File(['%PDF'], 'Lease 2027.pdf', { type: 'application/pdf' })
  const carrying = (files: File[], data: Record<string, string> = {}) => ({ dataTransfer: { files, getData: (type: string) => data[type] ?? '', dropEffect: 'none' } })

  it('opens as a slot when a file comes near, takes it, and sends it with what you type', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    const { findByRole, getByRole } = within(container)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    const island = container.querySelector('.island')!
    const shape = container.querySelector<HTMLElement>('.island-shape')!
    fireEvent.dragEnter(shape, carrying([pdf]))
    expect(island.getAttribute('data-view')).toBe('slot')
    // A tray in a gold line, with Maya behind it.
    const slot = getByRole('status', { name: 'Drop it here for Maya' })
    expect(slot.querySelector('.island-tray rect')).toBeTruthy()
    expect(slot.querySelector('.island-tray-figure .figure-still, .island-tray-figure img')).toBeTruthy()
    fireEvent.drop(shape, carrying([pdf]))
    // The slot stays open while what was dropped is sorted, then the list opens to write.
    expect(island.getAttribute('data-view')).toBe('slot')
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('list'))
    // What went in, as a page marked PDF with its name under it, the jobs that fit it, and a box
    // for your own words, which has the keyboard.
    const row = within(container.querySelector<HTMLElement>('.island-pinned')!)
    const lease = row.getByRole('listitem', { name: 'Lease 2027.pdf' })
    expect([lease.querySelector('.island-file-face.is-page')?.textContent, lease.querySelector('.island-file-name')?.textContent]).toEqual(['PDF', 'Lease 2027'])
    expect(row.getAllByRole('button').map((button) => button.textContent)).toEqual(expect.arrayContaining(['What should I check?', 'Summarize it', 'Pull out the dates']))
    const field = await findByRole('textbox', { name: 'Or say what to do' })
    await waitFor(() => expect(document.activeElement).toBe(field))
    expect(toApp).toContainEqual({ kind: 'keyboard', on: true })
    fireEvent.change(field, { target: { value: 'Is the rent rise fair?' } })
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => expect(messages).toHaveLength(1))
    expect(uploads).toEqual(['Lease 2027.pdf'])
    expect(messages[0]).toMatchObject({ teamPath: '.jobs/.bench/maya.yaml', text: 'Is the rent rise fair?', files: [{ path: '/teams/.jobs/.bench/files/Lease 2027.pdf' }] })
    expect(container.querySelector('.island-intake')).toBeNull()
  }, 15_000)

  it('a job picked for what was dropped: the box gives way to its agent’s workbench, set up while it waited, and the pointer still on the island keeps it there', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    const island = container.querySelector('.island')!
    const shape = container.querySelector<HTMLElement>('.island-shape')!
    fireEvent.pointerEnter(shape, { pointerType: 'mouse' })
    fireEvent.drop(shape, carrying([pdf]))
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('list'))
    // Her workbench is there already, out of sight, while a job is picked.
    const bench = await within(container).findByTestId('bench')
    expect(bench.closest('.island-bench')?.hasAttribute('hidden')).toBe(true)
    fireEvent.click(within(container).getByRole('button', { name: 'Summarize it' }))
    // Sending disables the field, and a real browser takes the keyboard from it as it goes.
    fireEvent.blur(container.querySelector('.island-field')!)
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('bench'))
    // The same bench, shown: the words fold into her head, not into a bench still being set up.
    expect(within(container).getByTestId('bench')).toBe(bench)
    expect(benchInSight(container)).toBe(bench)
    expect(container.querySelector('.island-fold')?.textContent).toBe('Summarize it')
    // The panel gives the keyboard back, and the pointer, never off the island, comes on it again.
    fireEvent.pointerLeave(shape, { pointerType: 'mouse' })
    fireEvent.pointerEnter(shape, { pointerType: 'mouse' })
    tellPage({ kind: 'pointer', over: true, area: 0 })
    expect(island.getAttribute('data-view')).toBe('bench')
    // Its moment is up, and the pointer is still on it: it stays; once the pointer leaves, it goes.
    vi.setSystemTime(Date.now() + ISLAND_WAITS.bench)
    tellPage({ kind: 'away', away: false })
    expect(island.getAttribute('data-view')).toBe('bench')
    tellPage({ kind: 'pointer', over: false, area: null })
    fireEvent.pointerLeave(shape, { pointerType: 'mouse' })
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('rest'), { timeout: 3000 })
    expect(benchInSight(container)).toBeNull()
  }, 15_000)

  it('takes a Mail message the app took from the drop, through the picker the app answers', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    const island = container.querySelector('.island')!
    tellPage({ kind: 'drag', near: true })
    fireEvent.dragEnter(container.querySelector<HTMLElement>('.island-shape')!, carrying([]))
    tellPage({ kind: 'drag', near: false })
    // The app answers the page's picker with the message Mail wrote, as it does in the panel.
    const email = new File(['Subject: Rent\n\nHi'], 'Rent for March.eml', { type: 'message/rfc822' })
    const asked: HTMLInputElement[] = []
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      asked.push(this)
      Object.defineProperty(this, 'files', { value: [email] })
      this.dispatchEvent(new Event('change'))
    })
    tellPage({ kind: 'dropped' })
    click.mockRestore()
    expect(asked.map((picker) => [picker.type, picker.isConnected])).toEqual([['file', false]])
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('list'))
    // Called by its subject, with what one does with an email.
    const row = within(container.querySelector<HTMLElement>('.island-pinned')!)
    expect(row.getByText('Rent for March')).toBeTruthy()
    fireEvent.click(row.getByRole('button', { name: 'Draft a reply' }))
    await waitFor(() => expect(messages).toHaveLength(1))
    expect(uploads).toEqual(['Rent for March.eml'])
  }, 15_000)

  it('says at the notch why a file Maya can’t open stays out, and takes the rest', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    const island = container.querySelector('.island')!
    const shape = container.querySelector<HTMLElement>('.island-shape')!
    const recording = new File([new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00])], 'Call with landlord.m4a')
    // Only a recording: nothing goes in, and the box says why, with the keyboard to say more.
    fireEvent.dragEnter(shape, carrying([recording]))
    fireEvent.drop(shape, carrying([recording]))
    const said = await within(container).findByRole('alert')
    expect(said.textContent).toBe('Maya can’t listen to recordings.')
    expect(island.getAttribute('data-view')).toBe('list')
    expect(container.querySelector('.island-intake')).toBeNull()
    // The box takes the keyboard as it focuses its field, just after the line shows.
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'keyboard', on: true }))
    // A lease and the recording: the lease goes in, and the line says which stayed out.
    fireEvent.dragEnter(shape, carrying([pdf, recording]))
    fireEvent.drop(shape, carrying([pdf, recording]))
    await waitFor(() => expect(within(container).getByRole('alert').textContent).toBe('Left out Call with landlord.m4a. Maya can’t listen to recordings.'))
    const row = within(container.querySelector<HTMLElement>('.island-pinned')!)
    expect(row.getAllByRole('listitem').map((file) => file.getAttribute('aria-label'))).toEqual(['Lease 2027.pdf'])
    fireEvent.click(row.getByRole('button', { name: 'What should I check?' }))
    await waitFor(() => expect(messages).toHaveLength(1))
    expect(uploads).toEqual(['Lease 2027.pdf'])
    // Sent: the line goes with what went in.
    await waitFor(() => expect(within(container).queryByRole('alert')).toBeNull())
  }, 15_000)

  it('keeps what waits when the PDF made from a file Maya couldn’t open is dropped after it', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    const shape = container.querySelector<HTMLElement>('.island-shape')!
    const plan = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])], 'Budget plan.pages')
    fireEvent.dragEnter(shape, carrying([pdf, plan]))
    fireEvent.drop(shape, carrying([pdf, plan]))
    await waitFor(() => expect(within(container).getByRole('alert').textContent).toBe('Left out Budget plan.pages. Maya can’t open Pages files. In Pages, choose File › Export To › PDF, then add the PDF.'))
    // The list closes while the person exports it: the line stays with the lease that waits.
    tellPage({ kind: 'clickOutside' })
    await waitFor(() => expect(container.querySelector('.island')!.getAttribute('data-view')).not.toBe('list'))
    tellPage({ kind: 'pointer', over: true, area: 0 })
    expect(within(container).getByRole('alert').textContent).toContain('Budget plan.pages')
    // The PDF joins the lease, and the line goes: nothing was left out this time.
    const exported = new File(['%PDF-1.7 plan'], 'Budget plan.pdf', { type: 'application/pdf' })
    fireEvent.dragEnter(shape, carrying([exported]))
    fireEvent.drop(shape, carrying([exported]))
    await waitFor(() => expect(names(container)).toEqual(['Lease 2027.pdf', 'Budget plan.pdf']))
    const row = within(container.querySelector<HTMLElement>('.island-pinned')!)
    expect(within(container).queryByRole('alert')).toBeNull()
    fireEvent.click(row.getByRole('button', { name: 'Summarize each' }))
    await waitFor(() => expect(messages).toHaveLength(1))
    expect(uploads).toEqual(['Lease 2027.pdf', 'Budget plan.pdf'])
  }, 15_000)

  const budget = new File(['Month,Rent\nMarch,1200\n'], 'Budget.csv', { type: 'text/csv' })
  const names = (container: HTMLElement) => [...container.querySelectorAll('.island-pinned .island-file')].map((file) => file.getAttribute('aria-label'))

  it('takes one dropped file out with its ×, and sends only what is left', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    const shape = container.querySelector<HTMLElement>('.island-shape')!
    fireEvent.drop(shape, carrying([pdf, budget]))
    await waitFor(() => expect(names(container)).toEqual(['Lease 2027.pdf', 'Budget.csv']))
    // Each file is a page with its kind on it and its name under it; both together, the jobs for files.
    expect([...container.querySelectorAll('.island-file-face.is-page')].map((page) => page.textContent)).toEqual(['PDF', 'CSV'])
    expect([...container.querySelectorAll('.island-file-name')].map((name) => name.textContent)).toEqual(['Lease 2027', 'Budget'])
    const row = within(container.querySelector<HTMLElement>('.island-pinned')!)
    expect(row.getByRole('button', { name: 'Compare them' })).toBeTruthy()
    // The lease out, as the team chat says it, the keyboard staying in the box: the budget stays,
    // and the jobs are a table's.
    expect(within(container).getByRole('list', { name: 'Going with your message' })).toBeTruthy()
    const notLease = row.getByRole('button', { name: 'Don’t send Lease 2027.pdf' })
    expect(fireEvent.pointerDown(notLease)).toBe(false)
    fireEvent.click(notLease)
    expect(names(container)).toEqual(['Budget.csv'])
    expect(row.getByRole('button', { name: 'What stands out?' })).toBeTruthy()
    // The last one out: nothing waits.
    fireEvent.click(row.getByRole('button', { name: 'Don’t send Budget.csv' }))
    expect(container.querySelector('.island-intake')).toBeNull()
    // Dropped again, only what is there goes.
    fireEvent.drop(shape, carrying([pdf]))
    await waitFor(() => expect(names(container)).toEqual(['Lease 2027.pdf']))
    fireEvent.click(within(container.querySelector<HTMLElement>('.island-pinned')!).getByRole('button', { name: 'Summarize it' }))
    await waitFor(() => expect(messages).toHaveLength(1))
    expect(uploads).toEqual(['Lease 2027.pdf'])
  }, 15_000)

  it('+ in the box chooses files through the picker the app answers, and they join what waits', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    tellPage({ kind: 'compose' })
    const add = await within(container).findByRole('button', { name: 'Add pictures or files' })
    // Pressing it keeps the keyboard in the box.
    expect(fireEvent.pointerDown(add)).toBe(false)
    let chosen: File[] = []
    const asked: HTMLInputElement[] = []
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      asked.push(this)
      Object.defineProperty(this, 'files', { value: chosen })
      this.dispatchEvent(new Event('change'))
    })
    chosen = [pdf]
    fireEvent.click(add)
    await waitFor(() => expect(names(container)).toEqual(['Lease 2027.pdf']))
    chosen = [budget]
    fireEvent.click(within(container).getByRole('button', { name: 'Add pictures or files' }))
    await waitFor(() => expect(names(container)).toEqual(['Lease 2027.pdf', 'Budget.csv']))
    click.mockRestore()
    // One picker each time, for several files, gone once it has answered.
    expect(asked.map((picker) => [picker.type, picker.multiple, picker.isConnected])).toEqual([['file', true, false], ['file', true, false]])
    const field = within(container).getByRole('textbox', { name: 'Or say what to do' })
    fireEvent.change(field, { target: { value: 'Can I afford it?' } })
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => expect(messages).toHaveLength(1))
    expect(uploads).toEqual(['Lease 2027.pdf', 'Budget.csv'])
  }, 15_000)

  it('after + the box asks for the keyboard again, whether files were chosen or the Open panel was cancelled', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    tellPage({ kind: 'compose' })
    const field = await within(container).findByRole('textbox', { name: 'Message Maya' })
    await waitFor(() => expect(document.activeElement).toBe(field))
    // The Open panel takes the keyboard: the field loses it but stays the page's focused element.
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    let answer: (picker: HTMLInputElement) => void = () => {}
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) { answer(this) })
    const asks = () => toApp.filter((message) => JSON.stringify(message) === JSON.stringify({ kind: 'keyboard', on: true })).length
    // Cancelled: the box asks for it back.
    answer = (picker) => {
      fireEvent.blur(field)
      picker.dispatchEvent(new Event('cancel'))
    }
    let before = asks()
    fireEvent.click(within(container).getByRole('button', { name: 'Add pictures or files' }))
    expect(asks()).toBe(before + 1)
    expect(container.querySelector('.island')!.getAttribute('data-view')).toBe('list')
    // Chosen: the files arrive in the box, and it asks for the keyboard again.
    answer = (picker) => {
      fireEvent.blur(field)
      Object.defineProperty(picker, 'files', { value: [pdf] })
      picker.dispatchEvent(new Event('change'))
    }
    before = asks()
    fireEvent.click(within(container).getByRole('button', { name: 'Add pictures or files' }))
    await waitFor(() => expect(names(container)).toEqual(['Lease 2027.pdf']))
    await waitFor(() => expect(asks()).toBe(before + 1))
    expect(document.activeElement).toBe(within(container).getByRole('textbox', { name: 'Or say what to do' }))
    click.mockRestore()
    focused.mockRestore()
  }, 15_000)

  it('as a message goes, each file shows a line until it is with Maya, then a tick; if it fails, they wait as before', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    const shape = container.querySelector<HTMLElement>('.island-shape')!
    fireEvent.drop(shape, carrying([pdf, budget]))
    await waitFor(() => expect(names(container)).toEqual(['Lease 2027.pdf', 'Budget.csv']))
    const file = (name: string) => container.querySelector<HTMLElement>(`.island-file[aria-label^="${name}"]`)!
    // It fails: the files wait as they were, each with its ×.
    sendFails = true
    fireEvent.click(within(container).getByRole('button', { name: 'Compare them' }))
    await within(container).findByText('That didn’t go through. Try again, or open Maya’s chat.')
    expect(container.querySelectorAll('.island-file-in, .island-file-line')).toHaveLength(0)
    expect(within(container).getAllByRole('button', { name: /^Don’t send / })).toHaveLength(2)
    // Again, with the lease slow to arrive: the budget is in, the lease on its way, and none can be
    // taken out while they go.
    sendFails = false
    let arrive = () => {}
    holdUploads = { 'Lease 2027.pdf': new Promise<void>((done) => { arrive = done }) }
    uploads.length = 0
    fireEvent.click(within(container).getByRole('button', { name: 'Compare them' }))
    await waitFor(() => expect(file('Budget.csv').querySelector('.island-file-in')).toBeTruthy())
    expect([file('Budget.csv').getAttribute('aria-label'), file('Budget.csv').getAttribute('aria-busy')]).toEqual(['Budget.csv, with Maya', 'false'])
    expect(file('Lease 2027.pdf').getAttribute('aria-busy')).toBe('true')
    expect(file('Lease 2027.pdf').querySelector('.island-file-line')).toBeTruthy()
    expect(file('Lease 2027.pdf').querySelector('.island-file-in')).toBeNull()
    expect(within(container).queryAllByRole('button', { name: /^Don’t send / })).toHaveLength(0)
    expect(messages).toHaveLength(0)
    arrive()
    await waitFor(() => expect(messages).toHaveLength(1))
    expect(uploads).toEqual(['Budget.csv', 'Lease 2027.pdf'])
    expect(container.querySelector('.island-files')).toBeNull()
  }, 15_000)

  it('while files wait in the box, two teams show and the rest are counted, so the box keeps its room', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    runs = ['r1', 'r2', 'r3', 'r4'].map((id, index) => run(id, { teamPath: `team${index}.yaml`, teamName: `Team ${index + 1}`, working: ['writer'] }))
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    await waitFor(() => expect(container.querySelector('.island')?.getAttribute('data-view')).toBe('tucked'))
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    const teamRows = () => container.querySelectorAll('.island-row:not(.island-pinned)').length
    await waitFor(() => expect(teamRows()).toBe(4))
    fireEvent.drop(container.querySelector<HTMLElement>('.island-shape')!, carrying([pdf, budget]))
    await waitFor(() => expect(names(container)).toEqual(['Lease 2027.pdf', 'Budget.csv']))
    expect(teamRows()).toBe(2)
    expect(container.querySelector('.island-list-foot')?.textContent).toContain('2 more teams in LoomWatch')
    // Taken out, the teams come back.
    fireEvent.click(within(container).getByRole('button', { name: 'Don’t send Lease 2027.pdf' }))
    fireEvent.click(within(container).getByRole('button', { name: 'Don’t send Budget.csv' }))
    expect(teamRows()).toBe(4)
  }, 15_000)

  it('shows a dropped picture as itself, and lets it go once it is taken out', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:kyoto')
    const letGo = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    const photo = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'Kyoto trip.png', { type: 'image/png' })
    fireEvent.drop(container.querySelector<HTMLElement>('.island-shape')!, carrying([photo, pdf]))
    await waitFor(() => expect(container.querySelector('.island-file[aria-label="Kyoto trip.png"] img')?.getAttribute('src')).toBe('blob:kyoto'))
    // Only the picture is drawn from its file; the lease is a page.
    expect(made.mock.calls.map(([file]) => (file as File).name)).toEqual(['Kyoto trip.png'])
    expect(container.querySelector('.island-file[aria-label="Lease 2027.pdf"] img')).toBeNull()
    fireEvent.click(within(container).getByRole('button', { name: 'Don’t send Kyoto trip.png' }))
    expect(letGo).toHaveBeenCalledWith('blob:kyoto')
    expect(names(container)).toEqual(['Lease 2027.pdf'])
    made.mockRestore()
    letGo.mockRestore()
  }, 15_000)

  it('opens as a tray in a gold line with Maya behind it, which reduced motion holds still', () => {
    const rules = rulesOf(readFileSync(resolve(process.cwd(), 'src/island/island.css'), 'utf8'))
    const css = readFileSync(resolve(process.cwd(), 'src/island/island.css'), 'utf8')
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    // Gold is a line here, never a fill: the tray is the notch's black, tinted.
    const tray = document.createElement('span')
    tray.className = 'island-tray'
    tray.innerHTML = '<svg><rect></rect></svg>'
    document.body.append(tray)
    expect(cascaded(tray, 'background', DESKTOP, rules)).toBe('var(--color-accent-tint)')
    // Its edge is a dashed gold line, which runs; a file on its way has a running line. Reduced
    // motion stops both, and the line stands part way along instead.
    const edge = tray.querySelector('rect')!
    expect([cascaded(edge, 'fill', DESKTOP, rules), cascaded(edge, 'stroke', DESKTOP, rules), cascaded(edge, 'stroke-dasharray', DESKTOP, rules)]).toEqual(['none', 'var(--color-accent)', '7 6'])
    expect(cascaded(edge, 'animation', DESKTOP, rules)).toMatch(/^island-tray-edge /)
    tray.remove()
    expect(reduced).toContain('.island *, .island *::before, .island *::after { animation: none !important; }')
    expect(reduced).toContain('.island-file-line::after { translate: 50% 0; }')
  })

  it('sends a dropped link with the job picked, and opens when the app says something is dragged near', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    const island = container.querySelector('.island')!
    tellPage({ kind: 'drag', near: true })
    expect(island.getAttribute('data-view')).toBe('slot')
    fireEvent.drop(container.querySelector<HTMLElement>('.island-shape')!, carrying([], { 'text/uri-list': 'https://example.com/rent', 'text/plain': 'https://example.com/rent' }))
    const row = within(container.querySelector<HTMLElement>('.island-pinned')!)
    expect(row.getByText('a link to example.com')).toBeTruthy()
    fireEvent.click(row.getByRole('button', { name: 'Summarize the page' }))
    await waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]).toMatchObject({ text: 'Summarize the page\n\nhttps://example.com/rent' })
    expect(uploads).toEqual([])
  }, 15_000)

  it('closes the slot a moment after a drag that came over it is let go of somewhere else', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'agent', name: 'Maya' }))
    const island = container.querySelector('.island')!
    tellPage({ kind: 'drag', near: true })
    fireEvent.dragEnter(container.querySelector<HTMLElement>('.island-shape')!, carrying([pdf]))
    tellPage({ kind: 'drag', near: false })
    expect(island.getAttribute('data-view')).toBe('slot')
    await waitFor(() => expect(island.getAttribute('data-view')).not.toBe('slot'), { timeout: 4000 })
    expect(container.querySelector('.island-intake')).toBeNull()
  }, 15_000)

  it('asks to start one of your teams on the gold line; Start runs it, and its agents work on Maya’s stage', async () => {
    vi.stubGlobal('WebSocket', QuietSocket)
    pinnedAgent = 'maya'
    jobs = [maya]
    requests = [{ id: 'tr1', askedBy: { runId: 'c1', agent: 'maya', chatPath: '.jobs/.bench/maya.yaml' }, team: { path: 'trip.yaml', name: 'Trip planner' }, request: 'Plan three gentle days in Đà Lạt', status: 'waiting', runId: null, problem: null, createdAt: iso(1), finishedAt: null }]
    const { container } = render(<Island />)
    place()
    const island = container.querySelector('.island')!
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('ask'))
    const card = within(container.querySelector<HTMLElement>('.island-card')!)
    // Maya's words, the team they are to and that a run of it has no spending limit, from its file,
    // and Start. No ×: putting the card away doesn't answer it.
    expect(card.getByText('Plan three gentle days in Đà Lạt')).toBeTruthy()
    const toTeam = (within: ParentNode) => within.querySelector('.island-for')?.textContent?.replace(/\s+/g, ' ').trim()
    await waitFor(() => expect(toTeam(container.querySelector('.island-card')!)).toBe('to Trip planner · no spending limit'))
    expect(card.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Start Trip planner'])
    fireEvent.click(card.getByRole('button', { name: 'Start Trip planner' }))
    await waitFor(() => expect(answeredTeams).toEqual([{ id: 'tr1', decision: 'start' }]))
    expect(await card.findByText('Trip planner is starting.')).toBeTruthy()
    runs = [run('crew1', { working: ['researcher'] })]
    await waitFor(() => expect(island.getAttribute('data-view')).not.toBe('ask'), { timeout: 5000 })
    await act(async () => { await new Promise((done) => setTimeout(done, 2100)) })
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    const stage = container.querySelector<HTMLElement>('.island-stage')!
    expect(stage.getAttribute('aria-label')).toBe('Trip planner is working for Maya')
    expect([...stage.querySelectorAll('.island-stage-member b')].map((name) => name.textContent)).toEqual(['Researcher', 'Writer'])
    expect(stage.querySelector('.island-stage-figure.glow')?.closest('.island-stage-member')?.querySelector('b')?.textContent).toBe('Researcher')
    // Its work is on Maya's stage, not a row of its own.
    expect(container.querySelectorAll('.island-row:not(.island-pinned)')).toHaveLength(0)
  }, 20_000)

  it('shows a request for a team in Maya’s row as her words, with Start in the box’s place until you write something else', async () => {
    vi.stubGlobal('WebSocket', QuietSocket)
    pinnedAgent = 'maya'
    jobs = [maya]
    requests = [{ id: 'tr1', askedBy: { runId: 'c1', agent: 'maya', chatPath: '.jobs/.bench/maya.yaml' }, team: { path: 'school.yaml', name: 'First-principles school' }, request: 'Retry and complete this exact assignment, then send the lesson back', status: 'waiting', runId: null, problem: null, createdAt: iso(1), finishedAt: null }]
    const { container } = render(<Island />)
    place()
    const island = container.querySelector('.island')!
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('ask'))
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('list'))
    const row = container.querySelector<HTMLElement>('.island-pinned')!
    const inRow = within(row)
    // Her words, the team they are to with its agents' figures, and × to say don't: no other line.
    expect(inRow.getByText('Retry and complete this exact assignment, then send the lesson back')).toBeTruthy()
    await waitFor(() => expect(row.querySelector('.island-for')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('to First-principles school · no spending limit'))
    await waitFor(() => expect(row.querySelectorAll('.island-crew-figure')).toHaveLength(2))
    expect(row.querySelector('.island-request')?.querySelectorAll('small')).toHaveLength(1)
    // Start sits where Send would, and is the only other button but her figure, her workbench's,
    // and + to add files to the message.
    const field = inRow.getByRole('textbox', { name: 'Or message Maya' })
    expect(inRow.getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['See Maya’s workbench', 'Don’t start First-principles school', 'Add pictures or files', 'Start First-principles school'])
    expect(field.closest('form')?.contains(inRow.getByRole('button', { name: 'Start First-principles school' }))).toBe(true)
    // Writing something else brings Send back; an empty box, Start.
    fireEvent.change(field, { target: { value: 'Make it shorter first' } })
    expect(inRow.queryByRole('button', { name: 'Start First-principles school' })).toBeNull()
    expect(inRow.getByRole('button', { name: 'Send' })).toBeTruthy()
    fireEvent.change(field, { target: { value: '' } })
    expect(inRow.getByRole('button', { name: 'Start First-principles school' })).toBeTruthy()
    // The words take the row's width, four lines of them (no tooltip shows at the notch), with her
    // figure at the bubble's corner.
    const rules = rulesOf(readFileSync(resolve(process.cwd(), 'src/island/island.css'), 'utf8'))
    expect(cascaded(row.querySelector(':scope > .island-request')!, 'grid-column', DESKTOP, rules)).toBe('2 / -1')
    expect(cascaded(row.querySelector('.island-said-by .island-ask')!, 'line-clamp', DESKTOP, rules)).toBe('4')
    expect(cascaded(row.querySelector(':scope > .island-row-figures')!, 'align-self', DESKTOP, rules)).toBe('start')
    // While something dropped has the box, Start sits under her words.
    tellPage({ kind: 'drag', near: true })
    fireEvent.drop(container.querySelector<HTMLElement>('.island-shape')!, carrying([pdf]))
    await waitFor(() => expect(container.querySelector('.island-pinned .island-intake')).toBeTruthy())
    const dropped = container.querySelector<HTMLElement>('.island-pinned')!
    expect(within(dropped).getByRole('textbox', { name: 'Or say what to do' })).toBeTruthy()
    expect(dropped.querySelector('.island-request + .island-acts')?.contains(within(dropped).getByRole('button', { name: 'Start First-principles school' }))).toBe(true)
    fireEvent.click(within(dropped).getByRole('button', { name: 'Don’t start First-principles school' }))
    await waitFor(() => expect(answeredTeams).toEqual([{ id: 'tr1', decision: 'decline' }]))
  }, 15_000)
})

