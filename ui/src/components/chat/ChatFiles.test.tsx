import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useState } from 'react'

import { pastedName, withFolderSource, type ChatAttachments } from '../../lib/chat/attachments'
import type { ChatFile, ChatItem, ChatMessage } from '../../lib/chat/client'
import { FileReaderContext } from '../../lib/files/reader'
import type { RunRecord } from '../../lib/runs/client'
import { typeInto, wordsIn } from '../../test/chipField'
import { FolderPicker } from '../canvas/FolderPicker'
import { ChatComposer } from './ChatComposer'
import { TeamChat } from './TeamChat'
import type { TeamView } from './WorkPiece'

vi.mock('../../lib/runs/useRunSession', () => ({
  useRunSession: () => ({
    record: null, applyRecord: vi.fn(), missing: false, events: [], error: null, connected: false,
    projection: { agents: [], evidence: [], messages: [], delegations: [], attention: [], coverage: {}, prompt: null, promptAgentId: null, phase: 'succeeded' },
    latest: null, cursor: null, setCursor: vi.fn(), lastSeq: -1, mode: 'replay', terminal: true, evidenceComplete: true,
  }),
}))
vi.mock('../../lib/notion/useNotionSend', () => ({ useNotionSend: () => ({ hidden: true }) }))
vi.mock('../run/NotionSend', () => ({ NotionOutcome: () => null, NotionOffer: () => null }))

const agents = [{ id: 'researcher', name: 'Researcher' }, { id: 'writer', name: 'Writer' }]
const team: TeamView = {
  names: new Map([['researcher', 'Researcher'], ['writer', 'Writer']]),
  hues: new Map([['researcher', 1], ['writer', 2]]),
  parties: agents.map((agent) => ({ ...agent, operator: false })),
  predecessors: new Map([['writer', ['researcher']]]),
  order: ['researcher', 'writer'],
  operators: new Set(),
}
const FOLDER = '/teams/news.files/chat'
const kept = (name: string): ChatFile => ({ name, path: `${FOLDER}/${name}`, bytes: 10, picture: /\.(png|jpe?g|gif|webp)$/.test(name) })
const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  runId: 'run-1', sessionId: 'run-1', teamPath: 'news.yaml', prompt: 'today’s digest', status: 'succeeded', mode: 'pipeline',
  entrypoint: 'researcher', responder: 'writer', agentIds: ['researcher', 'writer'], createdAt: '2026-10-21T02:00:00.000Z',
  startedAt: '2026-10-21T02:00:00.000Z', finishedAt: '2026-10-21T02:04:00.000Z', error: null, exitCode: 0, eventCount: 10,
  reply: 'Done.', trigger: 'manual', ...overrides,
})
const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm-1', teamKey: 'news', teamPath: 'news.yaml', text: '@team like this', createdAt: '2026-10-21T02:00:00.000Z', route: 'team',
  runId: 'run-1', agentId: null, deliveredAt: null, now: false, ...overrides,
})

let page: ChatItem[] = []
let uploads: { name: string; type: string | null }[] = []
let posted: Array<Record<string, unknown>> = []
let sendAnswers: Array<() => Response> = []
// Uploads wait here until a test lets them through, so "Send waits" can be seen.
let releaseUploads: (() => void) | null = null
let uploadsHeld = false

beforeEach(() => {
  page = []
  uploads = []
  posted = []
  sendAnswers = []
  uploadsHeld = false
  releaseUploads = null
  // A preview is the picture itself, read in the page; jsdom's own can't read its files.
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${Math.random()}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('/api/chat?')) return new Response(JSON.stringify({ teamKey: 'news', teamPath: 'news.yaml', items: page, more: false }), { status: 200 })
    if (url.startsWith('/api/chat/files?') && init?.method === 'PUT') {
      const name = new URL(url, 'http://x').searchParams.get('name') ?? ''
      uploads.push({ name, type: new Headers(init.headers).get('Content-Type') })
      if (uploadsHeld) await new Promise<void>((resolve) => { releaseUploads = resolve })
      return new Response(JSON.stringify(kept(name)), { status: 200 })
    }
    if (url === '/api/chat/messages' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posted.push(body)
      const next = sendAnswers.shift()
      if (next) return next()
      const sent = message({ text: String(body.text), files: (body.files as { path: string }[] | undefined)?.map((file) => kept(file.path.split('/').pop() ?? '')) })
      return new Response(JSON.stringify({ route: 'team', message: sent, run: run({ status: 'running', reply: null, finishedAt: null }) }), { status: 202 })
    }
    return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function renderChat(overrides: Partial<Parameters<typeof TeamChat>[0]> = {}) {
  const props = {
    teamPath: 'news.yaml', teamName: 'News desk', agents, team, steps: 2, suggestion: null, detailsRunId: null, blocked: null,
    prepare: vi.fn(async () => ({ ok: true as const, revision: 'sha256:1' })), onDetails: vi.fn(), onTeamReview: vi.fn(), onStale: vi.fn(), announce: vi.fn(), onOpenFinding: vi.fn(), onOpenAnswer: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<TeamChat {...props} />) }
}

const box = () => screen.getByRole('textbox', { name: 'Message the team' })
const type = (text: string) => typeInto(box(), text)
const sendButton = () => screen.getByRole('button', { name: 'Start' })
const picture = (name = 'image.png') => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })

/** A drag from Finder, as the browser hands it to the page: its types, each item, and its files. */
function fromFinder(files: File[], folders: string[] = []) {
  const items = [
    ...files.map((file) => ({ kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false, name: file.name }) })),
    ...folders.map((name) => ({ kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true, name }) })),
  ]
  return { types: ['Files'], items, files, dropEffect: 'none' }
}

describe('pictures and files go with a message (ADR 0082)', () => {
  it('a pasted screenshot is kept at once, named for when it was pasted, and sent with the words', async () => {
    renderChat()
    await screen.findByRole('textbox', { name: 'Message the team' })
    fireEvent.paste(box(), { clipboardData: { files: [picture()] } })
    await waitFor(() => expect(uploads).toHaveLength(1))
    expect(uploads[0].type).toBe('application/octet-stream')
    // Every screenshot from the clipboard is "image.png"; it is kept under when it was pasted.
    expect(uploads[0].name).toMatch(/^Pasted \d\d\.\d\d\.\d\d\.png$/)
    const going = screen.getByRole('list', { name: 'Going with your message' })
    expect(within(going).getAllByRole('listitem')).toHaveLength(1)

    type('@team why is this cut off?')
    await waitFor(() => expect(sendButton()).toBeEnabled())
    fireEvent.click(sendButton())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ text: '@team why is this cut off?', files: [{ path: `${FOLDER}/${uploads[0].name}` }] })
    // The box lets the file go with the words, and its preview, and the message shows the picture.
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Going with your message' })).not.toBeInTheDocument())
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('button', { name: `Look at ${uploads[0].name}` })).toBeInTheDocument()
  })

  it('text pastes as text', async () => {
    renderChat()
    await screen.findByRole('textbox', { name: 'Message the team' })
    type('see ')
    fireEvent.paste(box(), { clipboardData: { files: [], getData: (kind: string) => (kind === 'text/plain' ? 'the\r\nreport' : '') } })
    expect(wordsIn(box())).toBe('see the\nreport')
    expect(uploads).toHaveLength(0)
  })

  it('Send waits for a file still being kept, and files need words to go with', async () => {
    uploadsHeld = true
    renderChat()
    await screen.findByRole('textbox', { name: 'Message the team' })
    fireEvent.paste(box(), { clipboardData: { files: [picture('layout.png')] } })
    await waitFor(() => expect(uploads).toHaveLength(1))
    // Files without an @ would be a note that starts nothing: the box says how to start work.
    expect(box()).toHaveAttribute('aria-placeholder', '@team, then what to do with it')
    type('@team use this layout')
    expect(sendButton()).toBeDisabled()
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(posted).toHaveLength(0)
    await act(async () => { releaseUploads?.() })
    await waitFor(() => expect(sendButton()).toBeEnabled())
    type('')
    expect(screen.getByRole('button', { name: /Send|Start/ })).toBeDisabled()
  })

  it('files dropped on the chat are met by the drop ring, kept, and the browser never opens them', async () => {
    const { container } = renderChat()
    await screen.findByRole('textbox', { name: 'Message the team' })
    const chat = container.querySelector('section.tc') as HTMLElement
    const drag = fromFinder([picture('shot.png'), new File(['# notes'], 'brief.md', { type: 'text/markdown' })])
    expect(fireEvent.dragEnter(chat, { dataTransfer: drag })).toBe(false)
    expect(chat).toHaveClass('dropping')
    expect(fireEvent.dragOver(chat, { dataTransfer: drag })).toBe(false)
    expect(fireEvent.drop(chat, { dataTransfer: drag })).toBe(false)
    expect(chat).not.toHaveClass('dropping')
    await waitFor(() => expect(uploads.map((upload) => upload.name)).toEqual(['shot.png', 'brief.md']))
    expect(within(screen.getByRole('list', { name: 'Going with your message' })).getAllByRole('listitem')).toHaveLength(2)
    // Dropped anywhere else on the page while the chat is open, a file is ignored, not opened.
    expect(fireEvent.drop(document.body, { dataTransfer: drag })).toBe(false)
    // A drag of something inside the page is left alone.
    expect(fireEvent.dragOver(chat, { dataTransfer: { types: ['text/plain'], items: [], files: [] } })).toBe(true)
  })

  it('a dropped folder is added for the team, not sent, and the chat says so', async () => {
    const onConnectFolder = vi.fn(async () => 'Designs added. Your agents can read it from their next piece of work.')
    const { container } = renderChat({ onConnectFolder })
    await screen.findByRole('textbox', { name: 'Message the team' })
    const chat = container.querySelector('section.tc') as HTMLElement
    fireEvent.drop(chat, { dataTransfer: fromFinder([], ['Designs']) })
    expect(onConnectFolder).toHaveBeenCalledWith('Designs')
    expect(uploads).toHaveLength(0)
    expect(await screen.findByRole('status', { name: '' })).toHaveTextContent('Designs added. Your agents can read it from their next piece of work.')
  })

  it('in an agent’s own chat a dropped folder points to Build, on screen', async () => {
    const { container } = renderChat({ team: { ...team, solo: 'writer' }, agents: [{ id: 'writer', name: 'Writer' }] })
    await screen.findByRole('textbox', { name: 'Message Writer' })
    fireEvent.drop(container.querySelector('section.tc') as HTMLElement, { dataTransfer: fromFinder([], ['Designs']) })
    expect(await screen.findByText('A folder can’t go in a chat. Give it to Writer in Build, under Folder.')).toBeInTheDocument()
  })

  it('an answer takes words only: with files in the box it says so and waits', () => {
    const shot = kept('shot.png')
    const files = {
      items: [{ id: 'a1', name: shot.name, picture: true, preview: null, state: 'ready', kept: shot, problem: null }],
      add: vi.fn(), remove: vi.fn(), restore: vi.fn(), clear: vi.fn(), kept: [shot], busy: false,
    } as unknown as ChatAttachments
    const onAnswer = vi.fn(async () => true)
    function Harness() {
      const [value, setValue] = useState('the second one')
      return <ChatComposer agents={agents} names={team.names} steps={2} live={[]} decision={{ runId: 'run-1', node: 'writer', kind: 'question', from: 'writer', fromName: 'Writer', backTo: null }}
        value={value} onChange={setValue} onSend={vi.fn(async () => true)} onAnswer={onAnswer} attachments={files} />
    }
    render(<Harness />)
    expect(screen.getByText('Your answer to Writer\'s question')).toBeInTheDocument()
    expect(screen.getByText('Pictures and files can’t go with an answer yet. Take them out to answer.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reply' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('the folder picker adds only the dropped folder, once it is open', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const at = new URL(String(input), 'http://x').searchParams.get('path')
      const listing = at === '/Users/mai/Designs'
        ? { path: '/Users/mai/Designs', name: 'Designs', parent: '/Users/mai', places: [], folders: [], files: ['a.png'], moreFiles: 0 }
        : { path: '/Users/mai', name: 'mai', parent: '/Users', places: [], folders: [{ name: 'Designs', path: '/Users/mai/Designs' }], files: [], moreFiles: 0 }
      return new Response(JSON.stringify(listing), { status: 200 })
    }))
    const onChoose = vi.fn()
    render(<FolderPicker want="Designs" onChoose={onChoose} onClose={vi.fn()} />)
    const waiting = await screen.findByRole('button', { name: 'Open “Designs” first' })
    expect(waiting).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Designs' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add “Designs”' }))
    expect(onChoose).toHaveBeenCalledWith({ name: 'Designs', path: '/Users/mai/Designs' })
  })

  it('a file too big to keep says so on its chip, and comes out with its ✕', async () => {
    renderChat()
    await screen.findByRole('textbox', { name: 'Message the team' })
    const big = picture('huge.png')
    Object.defineProperty(big, 'size', { value: 30 * 1024 * 1024 })
    fireEvent.paste(box(), { clipboardData: { files: [big] } })
    expect(await screen.findByText('Too big (over 25 MB). Remove it to send.')).toBeInTheDocument()
    expect(uploads).toHaveLength(0)
    type('@team look')
    expect(sendButton()).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Don’t send huge.png' }))
    expect(screen.queryByText('Too big (over 25 MB). Remove it to send.')).not.toBeInTheDocument()
    expect(sendButton()).toBeEnabled()
  })

  it('a message that could not go keeps its files for Try again', async () => {
    sendAnswers = [() => new Response(JSON.stringify({ error: 'The daemon is busy.' }), { status: 500 })]
    renderChat()
    await screen.findByRole('textbox', { name: 'Message the team' })
    fireEvent.paste(box(), { clipboardData: { files: [picture('shot.png')] } })
    type('@team fix this')
    await waitFor(() => expect(sendButton()).toBeEnabled())
    fireEvent.click(sendButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(posted).toHaveLength(2))
    expect(posted[1]).toMatchObject({ files: [{ path: `${FOLDER}/shot.png` }] })
  })

  it('a sent picture opens full size in the reader beside the chat, and other files are cards', async () => {
    page = [{ kind: 'work', run: run(), request: message({ files: [kept('shot.png'), kept('brief.pdf')] }), notes: [] }]
    const read = vi.fn()
    render(
      <FileReaderContext.Provider value={read}>
        <TeamChat teamPath="news.yaml" teamName="News desk" agents={agents} team={team} steps={2} suggestion={null} detailsRunId={null} blocked={null}
          prepare={vi.fn(async () => ({ ok: true as const, revision: 'sha256:1' }))} onDetails={vi.fn()} onTeamReview={vi.fn()} onStale={vi.fn()} announce={vi.fn()} onOpenFinding={vi.fn()} onOpenAnswer={vi.fn()} />
      </FileReaderContext.Provider>,
    )
    const shot = await screen.findByRole('button', { name: 'Look at shot.png' })
    const image = shot.querySelector('img') as HTMLImageElement
    expect(image.getAttribute('src')).toBe(`/api/files/raw?path=${encodeURIComponent(`${FOLDER}/shot.png`)}`)
    expect(image).toHaveAttribute('loading', 'lazy')
    fireEvent.click(shot)
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ path: `${FOLDER}/shot.png` }))
    expect(screen.getByText('brief.pdf')).toBeInTheDocument()
  })
})

describe('naming and connecting', () => {
  it('a pasted screenshot is named for when it was pasted; a copied file keeps its name', () => {
    const at = new Date(2026, 9, 21, 9, 38, 5)
    expect(pastedName(picture('image.png'), at)).toBe('Pasted 09.38.05.png')
    expect(pastedName(new File(['x'], 'image.jpeg', { type: 'image/jpeg' }), at)).toBe('Pasted 09.38.05.jpeg')
    expect(pastedName(picture('Screen Shot 2026-10-21.png'), at)).toBe('Screen Shot 2026-10-21.png')
  })

  it('a folder found in the picker becomes a source for every agent that lacks it, and never a review step', () => {
    const folder = { name: 'Designs', path: '/Users/mai/Designs' }
    expect(withFolderSource([
      { id: 'researcher', capabilities: [] },
      { id: 'writer', capabilities: [{ kind: 'knowledge', name: 'Designs', path: '/Users/mai/Old/Designs' }] },
      { id: 'editor', capabilities: [{ kind: 'knowledge', name: 'Designs', path: '/Users/mai/Designs' }] },
      { id: 'review', kind: 'operator' },
    ], folder)).toEqual([
      { id: 'researcher', capabilities: [{ kind: 'knowledge', name: 'Designs', path: '/Users/mai/Designs' }] },
      { id: 'writer', capabilities: [{ kind: 'knowledge', name: 'Designs', path: '/Users/mai/Old/Designs' }, { kind: 'knowledge', name: 'Designs (2)', path: '/Users/mai/Designs' }] },
    ])
  })
})
