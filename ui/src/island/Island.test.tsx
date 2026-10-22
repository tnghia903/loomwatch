import { act, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NoteAnswering } from '../lib/chat/client'
import type { SavedJob } from '../lib/library/jobs'
import type { TeamRequest } from '../lib/runs/teamRequests'
import type { RunRecord } from '../lib/runs/client'
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
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/runs?')) return json(runs)
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
    pinnedAgent = 'maya'
    jobs = [maya]
    runs = [pinnedChat('c1', { working: ['maya'] })]
    const { container } = render(<Island />)
    const { findByRole } = within(container)
    place()
    await waitFor(() => expect(container.querySelector('.island')?.getAttribute('data-view')).not.toBe('hidden'))
    fireEvent.pointerEnter(container.querySelector('.island-shape')!, { pointerType: 'mouse' })
    const field = await findByRole('textbox', { name: 'Note for Maya · after its current step' })
    // Its work is its own row's, under its name, not a team's row of its own.
    expect(container.querySelector('.island-pinned .island-words')?.textContent).toBe('Maya just started')
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

  it('shows its answer as any answer, which can be copied or torn off into another app whole', async () => {
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
    const whole = 'You have two meetings today.\n\n- 10:00 budget review\n- 12:30 lunch with Sam'
    runs = [pinnedChat('c1', { status: 'succeeded', working: [], reply: whole, finishedAt: new Date().toISOString() })]
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('done'), { timeout: 5000 })
    const plain = 'You have two meetings today.\n\n• 10:00 budget review\n• 12:30 lunch with Sam'
    const card = container.querySelector<HTMLElement>('.island-slip.is-answer .island-answer')!
    const slip = within(card)
    expect(slip.getAllByText('Maya answered')).toHaveLength(2)
    // The whole answer, read whole, as plain text: not only its first line, and no Markdown marks.
    await waitFor(() => expect(card.querySelector('.island-words p')?.textContent).toBe(plain.replace(/\n{2,}/g, '\n')))
    fireEvent.click(slip.getByRole('button', { name: 'Copy' }))
    expect(toApp).toContainEqual({ kind: 'copy', text: plain })
    // Torn off: its words go with the drag, and once dropped somewhere it has been seen.
    const carried: Record<string, string> = {}
    let image: Element | null = null
    fireEvent.dragStart(card, { dataTransfer: { setData: (type: string, value: string) => { carried[type] = value }, setDragImage: (element: Element) => { image = element }, effectAllowed: 'all' } })
    expect(carried['text/plain']).toBe(plain)
    expect(image).toBe(card.querySelector('.island-paper-copy'))
    fireEvent.dragEnd(card, { dataTransfer: { dropEffect: 'copy' } })
    await waitFor(() => expect(island.getAttribute('data-view')).not.toBe('done'))
    expect(container.querySelector('.island-ear-right')?.getAttribute('data-right')).not.toBe('slip')
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
    expect(island.getAttribute('data-view')).toBe('list')
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
    class QuietSocket { onopen = null; onmessage = null; onclose = null; onerror = null; close() {} }
    vi.stubGlobal('WebSocket', QuietSocket)
    pinnedAgent = 'maya'
    jobs = [maya]
    requests = [{ id: 'tr1', askedBy: { runId: 'c1', agent: 'maya', chatPath: '.jobs/.bench/maya.yaml' }, team: { path: 'trip.yaml', name: 'Trip planner' }, request: 'Plan three gentle days in Đà Lạt', status: 'waiting', runId: null, problem: null, createdAt: iso(1), finishedAt: null }]
    const { container } = render(<Island />)
    place()
    const island = container.querySelector('.island')!
    await waitFor(() => expect(island.getAttribute('data-view')).toBe('ask'))
    const card = within(container.querySelector<HTMLElement>('.island-card')!)
    expect(card.getByText('Maya wants Trip planner to do this')).toBeTruthy()
    expect(card.getByText('Plan three gentle days in Đà Lạt')).toBeTruthy()
    expect(card.getAllByRole('button').map((button) => button.textContent)).toEqual(['Not now', 'Start Trip planner'])
    // What one run may spend, from the team's file: this one sets no limit.
    expect(await card.findByText('No spending limit set')).toBeTruthy()
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
})

