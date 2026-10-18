import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_MODEL } from '../../lib/ai/modelIds'
import { forgetKeyStatus } from '../../lib/ai/useKeyStatus'
import { readTourState, resetTourForTests } from '../../lib/tour/store'
import { Home } from './Home'

let assign: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

beforeEach(() => {
  assign = vi.fn()
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign, search: '', pathname: '/' } })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  forgetKeyStatus()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderHome(onCreateBlank = vi.fn()) {
  render(<Home onCreateBlank={onCreateBlank} onPalette={vi.fn()} />)
  return { onCreateBlank }
}

/** The daemon with no teams and the OpenRouter key as `key` says. */
const keyed = (key: Record<string, unknown>) => (url: string) => respond(url === '/api/ai' ? { openrouter: key } : { root: '/teams', files: [], teams: [] })

describe('Home', () => {
  it('lists teams by name, newest first, and opens one with a single click', async () => {
    fetchMock.mockImplementation(() => respond({
      root: '/teams',
      files: ['old.yaml', 'new.yaml'],
      teams: [
        { path: 'old.yaml', name: 'Old desk', agentCount: 1, modifiedAt: '2026-01-01T00:00:00Z' },
        { path: 'new.yaml', name: 'Research desk', agentCount: 3, modifiedAt: '2026-09-30T00:00:00Z' },
      ],
    }))
    renderHome()
    const cards = await screen.findAllByRole('button', { name: /desk/ })
    expect(cards.map((card) => within(card).getByText(/desk$/).textContent)).toEqual(['Research desk', 'Old desk'])
    expect(cards[0]).toHaveTextContent('3 steps')
    // A team that never ran says so in plain words, not in the loom's.
    expect(within(cards[0]).getByText('No runs yet.')).toBeInTheDocument()
    expect(screen.queryByText(/cloth/)).toBeNull()
    fireEvent.click(cards[0])
    expect(assign).toHaveBeenCalledWith('/?path=new.yaml')
  })

  // A newcomer coming back to use their agent landed on Build and had to look for Chat.
  it('opens a saved agent from Home on its chat', async () => {
    const helper = { id: 'reply-helper', file: 'reply-helper.yaml', name: 'Review reply helper', role: 'Reply to reviews.', version: 1 }
    fetchMock.mockImplementation((url: string) => respond(url === '/api/jobs'
      ? { folder: '/teams/.jobs', jobs: [helper], problems: [] }
      : { root: '/teams', files: [], teams: [] }))
    renderHome()
    const chip = await screen.findByRole('link', { name: /Review reply helper/ })
    expect(chip).toHaveAttribute('href', '/agents/reply-helper?view=chat')
  })

  // A newcomer whose teams were made first saw "Build your first agent" over teams full of agents.
  it('lists the agents written into a team with their team, and opens each one there', async () => {
    const yaml = [
      'schemaVersion: 1', 'id: rag', 'name: Enterprise RAG research', 'entrypoint: researcher', 'agents:',
      '  - id: researcher', '    name: RAG researcher', '    role: Research.',
      '  - id: review', '    kind: operator', '    name: You', '    role: Approve it.',
    ].join('\n')
    fetchMock.mockImplementation((url: string) => respond(
      url === '/api/jobs' ? { folder: '/teams/.jobs', jobs: [], problems: [] }
        : url.startsWith('/api/team?') ? { path: 'research/rag.yaml', yaml, revision: 'r1' }
          : { root: '/teams', files: ['research/rag.yaml'], teams: [{ path: 'research/rag.yaml', name: 'Enterprise RAG research', agentCount: 2 }] }))
    renderHome()
    const chip = await screen.findByRole('link', { name: /RAG researcher/ })
    expect(chip).toHaveTextContent('in Enterprise RAG research')
    expect(chip).toHaveAttribute('href', '/?path=research%2Frag.yaml&view=agents&agent=researcher')
    // The operator's stop is a step of the workflow, not an agent.
    expect(screen.queryByRole('link', { name: /^You/ })).toBeNull()
    expect(screen.queryByText(/Build your first agent/)).toBeNull()
    expect(screen.getByRole('link', { name: /All agents/ })).toHaveAttribute('href', '/agents')
  })

  // The work in the order it is done: build agents, put them in a team's workflow, then chat with it.
  it('starts with building an agent, lists your agents before your teams, and opens each team where it left off', async () => {
    fetchMock.mockImplementation((url: string) => respond(url === '/api/jobs'
      ? { folder: '/teams/.jobs', jobs: [], problems: [] }
      : { root: '/teams', files: ['empty.yaml', 'ready.yaml'], teams: [
        { path: 'empty.yaml', name: 'Empty desk', agentCount: 0, modifiedAt: '2026-09-30T00:00:00Z' },
        { path: 'ready.yaml', name: 'Ready desk', agentCount: 2, modifiedAt: '2026-09-29T00:00:00Z' },
      ] }))
    renderHome()
    const build = screen.getByRole('link', { name: 'Build an agent' })
    expect(build).toHaveAttribute('href', '/agents/new')
    expect(build).toHaveClass('btn-primary')
    expect(screen.getByRole('button', { name: 'New team' })).not.toHaveClass('btn-primary')
    const steps = within(screen.getByRole('list', { name: 'How it works' })).getAllByRole('listitem')
    expect(steps.map((step) => step.querySelector('strong')?.textContent)).toEqual(['Agents.', 'Workflow.', 'Chat.'])
    const agents = await screen.findByRole('heading', { name: /Your agents/ })
    const teams = screen.getByRole('heading', { name: /Your teams/ })
    expect(agents.compareDocumentPosition(teams) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // A team with no agents opens on its agents, the first thing to set up; one with agents, on its workflow.
    fireEvent.click(await screen.findByRole('button', { name: /Empty desk/ }))
    expect(assign).toHaveBeenLastCalledWith('/?path=empty.yaml&view=agents')
    fireEvent.click(screen.getByRole('button', { name: /Ready desk/ }))
    expect(assign).toHaveBeenLastCalledWith('/?path=ready.yaml')
  })

  // ADR 0051: teams are listed as chats — the newest work first, a line of it, and a mark for
  // what came in since you last looked; a team with history opens in its chat.
  it('lists teams as chats: newest work first, its last line, an unread mark, and opens the chat', async () => {
    fetchMock.mockImplementation(() => respond({
      root: '/teams',
      files: ['quiet.yaml', 'news.yaml'],
      teams: [
        { path: 'quiet.yaml', name: 'Quiet desk', agentCount: 1, modifiedAt: '2026-10-05T00:00:00Z' },
        { path: 'news.yaml', name: 'News desk', agentCount: 2, modifiedAt: '2026-01-01T00:00:00Z' },
      ],
    }))
    window.localStorage.setItem('lw-chat-seen', JSON.stringify({ 'news.yaml': '2026-10-06T01:00:00.000Z' }))
    const runs = [{
      runId: 'r1', sessionId: 'r1', teamPath: 'news.yaml', prompt: 'today’s digest', status: 'succeeded' as const, mode: 'pipeline' as const,
      entrypoint: 'a', responder: 'b', agentIds: ['a', 'b'], createdAt: '2026-10-06T02:00:00.000Z', startedAt: '2026-10-06T02:00:00.000Z',
      finishedAt: '2026-10-06T02:04:00.000Z', error: null, exitCode: 0, eventCount: 3, reply: '# Today’s AI digest\nChips lead.',
    }]
    render(<Home onCreateBlank={vi.fn()} onPalette={vi.fn()} runs={runs} />)
    const cards = await screen.findAllByRole('button', { name: /desk/ })
    expect(cards.map((card) => within(card).getByText(/desk$/).textContent)).toEqual(['News desk', 'Quiet desk'])
    expect(within(cards[0]).getByText('Today’s AI digest')).toBeInTheDocument()
    expect(within(cards[0]).getByLabelText('New since you looked')).toBeInTheDocument()
    expect(within(cards[1]).queryByLabelText('New since you looked')).not.toBeInTheDocument()
    fireEvent.click(cards[0])
    expect(assign).toHaveBeenCalledWith('/?path=news.yaml&view=chat')
    fireEvent.click(cards[1])
    expect(assign).toHaveBeenLastCalledWith('/?path=quiet.yaml')
    window.localStorage.removeItem('lw-chat-seen')
  })

  it('falls back to file names when an older daemon sends no summaries', async () => {
    fetchMock.mockImplementation(() => respond({ root: '/teams', files: ['nested/research-team.yaml'] }))
    renderHome()
    expect(await screen.findByRole('button', { name: /research-team/ })).toBeInTheDocument()
  })

  it('says how to start when there are no teams, and asks for an OpenRouter key until there is one', async () => {
    fetchMock.mockImplementation(keyed({ connected: false }))
    renderHome()
    expect(await screen.findByText(/No teams yet/)).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Add your OpenRouter key' })).toBeInTheDocument()
    expect(screen.getByText('Add your OpenRouter key so your agents can run.')).toBeInTheDocument()
    // The card asks for the key's state itself, so its field comes once that answer does.
    expect(await screen.findByLabelText('OpenRouter key')).toHaveAttribute('type', 'password')
  })

  it('keeps the key card away once a key is added, and says the agents run on OpenRouter', async () => {
    fetchMock.mockImplementation(keyed({ connected: true, label: 'sk-or-v1-abc...xyz' }))
    renderHome()
    expect(await screen.findByText('Agents run on OpenRouter with key sk-or-v1-abc...xyz')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Add your OpenRouter key' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Manage key' })).toHaveAttribute('href', '/connections')
  })

  it('says when the account has no credits yet, or OpenRouter refused the key', async () => {
    fetchMock.mockImplementation(keyed({ connected: true, freeTier: true }))
    renderHome()
    expect(await screen.findByText('Your OpenRouter account has no credits yet, so only free models work.')).toBeInTheDocument()
    cleanup()
    forgetKeyStatus()
    fetchMock.mockImplementation(keyed({ connected: true, problem: 'OpenRouter refused the key.' }))
    renderHome()
    expect(await screen.findByText('OpenRouter: OpenRouter refused the key.')).toBeInTheDocument()
  })

  it('creates a ready-to-run team from a template and opens it', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/teams') return respond({ root: '/teams', files: ['blog-writer.yaml'], teams: [{ path: 'blog-writer.yaml', name: 'Blog writer', agentCount: 1 }] })
      if (url === '/api/team' && init?.method === 'PUT') return respond({ path: 'blog-writer-2.yaml', yaml: '', revision: 'r1' })
      return respond({ error: 'unexpected' }, 404)
    })
    renderHome()
    await screen.findByRole('button', { name: /Blog writer/ })
    fireEvent.click(screen.getByRole('button', { name: 'New team' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a team' })
    expect(within(dialog).getByRole('radio', { name: /One assistant/ })).toBeChecked()
    fireEvent.change(within(dialog).getByLabelText('Team name'), { target: { value: 'Blog writer' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create team' }))

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/?path=blog-writer-2.yaml'))
    const put = fetchMock.mock.calls.find(([url, init]) => url === '/api/team' && init?.method === 'PUT')
    expect(put?.[1]?.headers).toMatchObject({ 'If-None-Match': '*' })
    const body = JSON.parse(String(put?.[1]?.body)) as { path: string; yaml: string }
    // The existing file is never overwritten, and the assistant runs on the default model.
    expect(body.path).toBe('blog-writer-2.yaml')
    expect(body.yaml).toContain(`model: ${DEFAULT_MODEL}`)
    expect(body.yaml).not.toContain('spawn')
    expect(body.yaml).toContain('name: Blog writer')
    // Same name, own id: the Notebook is filed by id, so sharing one shared the first team's notes.
    expect(body.yaml).toContain('id: blog-writer-2')
  })

  it('says a file cannot be opened instead of calling it a team that needs setup', async () => {
    fetchMock.mockImplementation(() => respond({
      root: '/teams',
      files: ['broken.yaml', 'notes.yaml', 'draft.yaml'],
      teams: [
        { path: 'broken.yaml', agentCount: 0, problem: 'unreadable' },
        { path: 'notes.yaml', agentCount: 0, problem: 'not_a_team' },
        { path: 'draft.yaml', name: 'Draft', agentCount: 0 },
      ],
    }))
    renderHome()
    expect(await screen.findByRole('button', { name: /broken/ })).toHaveTextContent('Can’t be opened: not valid YAML')
    expect(screen.getByRole('button', { name: /notes/ })).toHaveTextContent('Can’t be opened: not a team file')
    expect(screen.getByRole('button', { name: /Draft/ })).toHaveTextContent('Needs setup')
  })

  it('says plainly when the server is down, and brings the teams back when it returns', async () => {
    let up = false
    fetchMock.mockImplementation(() => up
      ? respond({ root: '/teams', files: ['a.yaml'], teams: [{ path: 'a.yaml', name: 'Research desk', agentCount: 1 }] })
      : Promise.reject(new TypeError('Failed to fetch')))
    renderHome()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Can’t reach the LoomWatch server')
    expect(alert).not.toHaveTextContent('Failed to fetch')
    up = true
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: /Research desk/ })).toBeInTheDocument()
  })

  it('opens an empty team without touching the disk', async () => {
    fetchMock.mockImplementation(() => respond({ root: '/teams', files: [], teams: [] }))
    const { onCreateBlank } = renderHome()
    await screen.findByText(/No teams yet/)
    fireEvent.click(screen.getByRole('button', { name: 'New team' }))
    fireEvent.click(screen.getByRole('radio', { name: /Empty team/ }))
    fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'Scratch' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }))
    expect(onCreateBlank).toHaveBeenCalledWith('Scratch', 'scratch.yaml')
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })

})

describe('Home and the getting-started guide', () => {
  beforeEach(() => resetTourForTests())

  const demoTeam = { root: '/teams', files: ['operator-stop.yaml'], teams: [{ path: 'operator-stop.yaml', name: 'Review stop demo', agentCount: 3, modifiedAt: null }] }

  it('offers the guide to someone who has never run a team, though the demo team is there', async () => {
    fetchMock.mockImplementation((url: string) => respond(url === '/api/runs?preview=true' ? [] : demoTeam))
    renderHome()
    await screen.findByText('Review stop demo')
    await waitFor(() => expect(readTourState()).toMatchObject({ status: 'active', step: 'welcome' }))
  })

  it('leaves someone who has run a team alone, but lets them start it', async () => {
    fetchMock.mockImplementation((url: string) => respond(url === '/api/runs?preview=true' ? [{ runId: 'run-1', teamPath: 'operator-stop.yaml', status: 'succeeded' }] : demoTeam))
    renderHome()
    await screen.findByText('Review stop demo')
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/runs?preview=true')).toBe(true))
    expect(readTourState()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Take the 3-minute guide/ }))
    expect(readTourState()).toMatchObject({ status: 'active', step: 'welcome' })
  })

  it('takes the job in plain words for Ask LoomWatch, and says why when it cannot', async () => {
    fetchMock.mockImplementation(() => respond({ root: '/teams', files: [], teams: [] }))
    const onAsk = vi.fn()
    const { unmount } = render(<Home onCreateBlank={vi.fn()} onPalette={vi.fn()} ask={{ unavailable: null, onAsk }} />)
    const box = screen.getByRole('textbox', { name: /Or describe the job/ })
    fireEvent.change(box, { target: { value: '  Brief me on chip news every weekday  ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onAsk).toHaveBeenCalledWith('Brief me on chip news every weekday')
    expect(box).toHaveValue('')
    // Build an agent stays the one gold button.
    expect(screen.getByRole('button', { name: 'Ask' })).not.toHaveClass('btn-primary')
    unmount()

    render(<Home onCreateBlank={vi.fn()} onPalette={vi.fn()} ask={{ unavailable: 'Ask runs on your OpenRouter key. Add it to start.', onAsk }} />)
    expect(screen.getByRole('textbox', { name: /Or describe the job/ })).toBeDisabled()
    expect(screen.getByText(/Ask runs on your OpenRouter key/)).toBeInTheDocument()
  })
})
