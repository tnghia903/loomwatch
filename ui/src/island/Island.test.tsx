import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NoteAnswering } from '../lib/chat/client'
import type { SavedJob } from '../lib/library/jobs'
import type { TeamRequest } from '../lib/runs/teamRequests'
import type { RunRecord } from '../lib/runs/client'
import { cascaded, DESKTOP, rulesOf } from '../test/cascade'
import { answering, at, failed, iso, maya, OUT_OF_CREDITS, permission, pinnedChat, run, said } from './fixtures'
import { Island } from './Island'

let runs: RunRecord[] = []
let notes: NoteAnswering[] = []
let noteReads = 0
let pinnedAgent: string | null = null
let sendFails = false
let requests: TeamRequest[] = []
const answeredTeams: { id: string; decision: string }[] = []
const uploads: string[] = []
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
  sendFails = false
  requests = []
  answeredTeams.length = 0
  uploads.length = 0
  jobs = []
  posted.length = 0
  wrote.length = 0
  messages.length = 0
  toApp.length = 0
  holdRunReads = null
  sessionEvents = {}
  holdEventReads = null
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
    if (url === '/api/pinned-agent') return json({ agent: pinnedAgent })
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
    // Its ⋯ asks the app for its menu: Open LoomWatch, Start at login, Show at the notch, Show
    // log, Quit.
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

  it('without a notch, the tab shrinks back to its figure and no further, nor shorter than the menu bar', async () => {
    const { container } = render(<Island />)
    tellPage({ kind: 'place', notch: null, menuBar: 24 })
    await waitFor(() => expect(view(container)).toBe('rest'))
    const island = container.querySelector<HTMLElement>('.island')!
    // As wide as LoomWatch's mark and its margin, which is all there is beside no notch.
    const ear = island.style.getPropertyValue('--ear')
    expect(Number.parseFloat(ear)).toBeLessThan(40)
    expect([least(island, 'min-width'), least(island, 'min-height')]).toEqual([ear, '24px'])
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

  it('drops nothing out while another screen’s island is live, and the list opens only on the live one', async () => {
    runs = [run('r1', { permissionRequests: [permission('p1')] })]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(view(container)).toBe('ask'))
    tellPage({ kind: 'live', on: false })
    expect(view(container)).toBe('tucked')
    tellPage({ kind: 'live', on: true })
    expect(view(container)).toBe('ask')
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
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'pinned', name: 'Maya' }))
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
    expect(await within(container.querySelector<HTMLElement>('.island-pinned')!).findByText('Sent to Maya.')).toBeTruthy()
    expect((field as HTMLInputElement).value).toBe('')
    // Sent: the keyboard goes back to whatever had it.
    expect(toApp.at(-1)).toEqual({ kind: 'keyboard', on: false })
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
    expect(within(container).getByRole('button', { name: 'Send note' })).toBeTruthy()
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
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'pinned', name: 'Maya' }))
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
    fireEvent.click(within(container.querySelector<HTMLElement>('.island-slip')!).getByRole('button', { name: 'See answer' }))
    expect(toApp).toContainEqual({ kind: 'open', link: '/agents/maya?view=chat' })
  }, 15_000)

  it('opens its box with the keyboard when the app’s menu asks, and Escape gives the keyboard back', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    const { findByRole } = within(container)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'pinned', name: 'Maya' }))
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

  it('with none pinned, the app hears so, and the list has no box', async () => {
    runs = [run('r1', { working: ['writer'] })]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'pinned', name: null }))
    tellPage({ kind: 'compose' })
    expect(container.querySelector('.island')?.getAttribute('data-view')).not.toBe('list')
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    expect(container.querySelector('.island-pinned')).toBeNull()
    expect(container.querySelector('input')).toBeNull()
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
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'pinned', name: 'Maya' }))
    const island = container.querySelector('.island')!
    const shape = container.querySelector<HTMLElement>('.island-shape')!
    fireEvent.dragEnter(shape, carrying([pdf]))
    expect(island.getAttribute('data-view')).toBe('slot')
    expect(getByRole('status', { name: 'Drop it here for Maya' })).toBeTruthy()
    fireEvent.drop(shape, carrying([pdf]))
    // The slot stays open while what was dropped is sorted, then the list opens to write.
    expect(island.getAttribute('data-view')).toBe('slot')
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('list'))
    // What went in, the jobs that fit it, and a box for your own words, which has the keyboard.
    const row = within(container.querySelector<HTMLElement>('.island-pinned')!)
    expect(row.getByText('Lease 2027.pdf')).toBeTruthy()
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

  it('takes a Mail message the app took from the drop, through the picker the app answers', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'pinned', name: 'Maya' }))
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
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'pinned', name: 'Maya' }))
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
    expect(toApp).toContainEqual({ kind: 'keyboard', on: true })
    // A lease and the recording: the lease goes in, and the line says which stayed out.
    fireEvent.dragEnter(shape, carrying([pdf, recording]))
    fireEvent.drop(shape, carrying([pdf, recording]))
    await waitFor(() => expect(within(container).getByRole('alert').textContent).toBe('Left out Call with landlord.m4a. Maya can’t listen to recordings.'))
    const row = within(container.querySelector<HTMLElement>('.island-pinned')!)
    expect(row.getByText('Lease 2027.pdf')).toBeTruthy()
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
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'pinned', name: 'Maya' }))
    const shape = container.querySelector<HTMLElement>('.island-shape')!
    const plan = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])], 'Budget plan.pages')
    fireEvent.dragEnter(shape, carrying([pdf, plan]))
    fireEvent.drop(shape, carrying([pdf, plan]))
    await waitFor(() => expect(within(container).getByRole('alert').textContent).toBe('Left out Budget plan.pages. Maya can’t open Pages files. In Pages, choose File › Export To › PDF, then drop the PDF.'))
    // The list closes while the person exports it: the line stays with the lease that waits.
    tellPage({ kind: 'clickOutside' })
    await waitFor(() => expect(container.querySelector('.island')!.getAttribute('data-view')).not.toBe('list'))
    tellPage({ kind: 'pointer', over: true, area: 0 })
    expect(within(container).getByRole('alert').textContent).toContain('Budget plan.pages')
    // The PDF joins the lease, and the line goes: nothing was left out this time.
    const exported = new File(['%PDF-1.7 plan'], 'Budget plan.pdf', { type: 'application/pdf' })
    fireEvent.dragEnter(shape, carrying([exported]))
    fireEvent.drop(shape, carrying([exported]))
    await waitFor(() => expect(container.querySelector('.island-intake-what')?.textContent).toBe('2 files×'))
    const row = within(container.querySelector<HTMLElement>('.island-pinned')!)
    expect(within(container).queryByRole('alert')).toBeNull()
    fireEvent.click(row.getByRole('button', { name: 'Summarize each' }))
    await waitFor(() => expect(messages).toHaveLength(1))
    expect(uploads).toEqual(['Lease 2027.pdf', 'Budget plan.pdf'])
  }, 15_000)

  it('sends a dropped link with the job picked, and opens when the app says something is dragged near', async () => {
    pinnedAgent = 'maya'
    jobs = [maya]
    const { container } = render(<Island />)
    place()
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'pinned', name: 'Maya' }))
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
    await waitFor(() => expect(toApp).toContainEqual({ kind: 'pinned', name: 'Maya' }))
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
    // Start sits where Send would, and is the only other button.
    const field = inRow.getByRole('textbox', { name: 'Or message Maya' })
    expect(inRow.getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Don’t start First-principles school', 'Start First-principles school'])
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

