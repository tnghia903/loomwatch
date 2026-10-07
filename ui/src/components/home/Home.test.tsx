import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DetectedHarness } from '../../lib/harnesses'
import { readTourState, resetTourForTests } from '../../lib/tour/store'
import { Home } from './Home'

const claude: DetectedHarness = { id: 'claude', name: 'Claude', command: 'claude', executablePath: '/bin/claude', acpAvailable: true, spawn: { cmd: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] } }
const geminiReason = 'Gemini: sign-in or version problem — run "gemini" in Terminal to fix'
const brokenGemini: DetectedHarness = { id: 'gemini', name: 'Gemini', command: 'gemini', executablePath: '/bin/gemini', acpAvailable: true, health: 'error', healthReason: geminiReason, healthDetail: 'ACP session/new failed during model discovery: This client is no longer supported', spawn: { cmd: 'gemini', args: ['--acp'] } }

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
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderHome(harnesses: DetectedHarness[] = [claude], onCreateBlank = vi.fn(), onRetryHarnesses = vi.fn()) {
  render(<Home harnesses={harnesses} harnessesLoading={false} harnessesError={null} onRetryHarnesses={onRetryHarnesses} onCreateBlank={onCreateBlank} onPalette={vi.fn()} />)
  return { onCreateBlank, onRetryHarnesses }
}

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
    render(<Home harnesses={[claude]} harnessesLoading={false} harnessesError={null} onRetryHarnesses={vi.fn()} onCreateBlank={vi.fn()} onPalette={vi.fn()} runs={runs} />)
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

  it('says how to start when there are no teams, and opens app setup when no AI app is installed', async () => {
    fetchMock.mockImplementation((url: string) => respond(url === '/api/harnesses' ? { harnesses: [], searchedPath: [], knownIds: [] } : { root: '/teams', files: [], teams: [] }))
    renderHome([])
    expect(await screen.findByText(/No teams yet/)).toBeInTheDocument()
    expect(screen.getByText('No AI app is ready yet.')).toBeInTheDocument()
    const setup = screen.getByRole('region', { name: 'Set up an AI app' })
    expect(within(setup).getByRole('listitem', { name: /^Claude Code: Not installed/ })).toBeInTheDocument()
    // Hidden, it is one footer link away.
    fireEvent.click(within(setup).getByRole('button', { name: 'Hide' }))
    expect(screen.queryByRole('region', { name: 'Set up an AI app' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Set up an AI app' }))
    expect(screen.getByRole('region', { name: 'Set up an AI app' })).toBeInTheDocument()
  })

  it('keeps app setup out of the way once an app can run, one footer link away', async () => {
    fetchMock.mockImplementation((url: string) => respond(url === '/api/harnesses' ? { harnesses: [claude], searchedPath: [], knownIds: [] } : { root: '/teams', files: [], teams: [] }))
    renderHome([claude])
    await screen.findByText(/No teams yet/)
    expect(screen.queryByRole('region', { name: 'Set up an AI app' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Set up another app' }))
    expect(screen.getByRole('region', { name: 'Set up an AI app' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Set up another app' })).toBeNull()
  })

  it('takes someone from New team to app setup when no app can build a template', async () => {
    fetchMock.mockImplementation((url: string) => respond(url === '/api/harnesses' ? { harnesses: [], searchedPath: [], knownIds: [] } : { root: '/teams', files: [], teams: [] }))
    renderHome([])
    await screen.findByText(/No teams yet/)
    fireEvent.click(within(screen.getByRole('region', { name: 'Set up an AI app' })).getByRole('button', { name: 'Hide' }))
    fireEvent.click(screen.getByRole('button', { name: 'New team' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a team' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set up an AI app' }))
    expect(screen.queryByRole('dialog', { name: 'Create a team' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Set up an AI app' })).toBeInTheDocument()
  })

  it('creates a ready-to-run team from a template and opens it', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/teams') return respond({ root: '/teams', files: ['blog-writer.yaml'], teams: [{ path: 'blog-writer.yaml', name: 'Blog writer', agentCount: 1 }] })
      if (url === '/api/harnesses/claude/models') return respond({ harnessId: 'claude', models: [{ id: 'default', name: 'Default', thinkingEfforts: [] }], currentModelId: 'sonnet' })
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
    // The existing file is never overwritten, and the agent uses the app's own current model.
    expect(body.path).toBe('blog-writer-2.yaml')
    expect(body.yaml).toContain('model: sonnet')
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

  it('does not call an app that failed to start ready, and says how to fix it', async () => {
    fetchMock.mockImplementation(() => respond({ root: '/teams', files: [], teams: [] }))
    renderHome([claude, brokenGemini])
    await screen.findByText(/No teams yet/)
    expect(screen.getByText('Ready to use: Claude')).toBeInTheDocument()
    const problem = within(screen.getByRole('list', { name: 'Apps that need attention' })).getByText(geminiReason)
    // The harness's own words stay one hover away for whoever needs them.
    expect(problem).toHaveAttribute('title', brokenGemini.healthDetail)
  })

  // An app that needs a key from you is waiting on a step, not broken: a note, and the way to do it.
  it('reads an app that needs an API key as a setup note, not an error, with Set it up', async () => {
    fetchMock.mockImplementation(() => respond({ root: '/teams', files: [], teams: [] }))
    const keyReason = 'Gemini CLI needs a Gemini API key to work with other apps: set GEMINI_API_KEY, then restart LoomWatch.'
    renderHome([claude, { ...brokenGemini, healthCause: 'needs_api_key', healthReason: keyReason }])
    await screen.findByText(/No teams yet/)
    const note = within(screen.getByRole('list', { name: 'Apps that need attention' })).getByText(keyReason).closest('li')
    expect(note).toHaveClass('setup')
    expect(note).not.toHaveClass('failed')
    fireEvent.click(within(note as HTMLElement).getByRole('button', { name: 'Set it up' }))
    expect(screen.getByRole('region', { name: 'Set up an AI app' })).toBeInTheDocument()
    // A failure with no step to take stays an alert.
    cleanup()
    renderHome([claude, brokenGemini])
    await screen.findByText(/No teams yet/)
    expect(within(screen.getByRole('list', { name: 'Apps that need attention' })).getByText(geminiReason).closest('li')).toHaveClass('failed')
  })

  it('re-checks a failing app on request, then reloads the list', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/harnesses/gemini/models') return respond({ error: 'still signed out' }, 502)
      if (url === '/api/harnesses') return respond({ harnesses: [brokenGemini], searchedPath: [], knownIds: [] })
      if (url.startsWith('/api/commands?')) return respond({ commands: [{ cmd: 'gemini', status: 'found', path: '/bin/gemini' }] })
      return respond({ root: '/teams', files: [], teams: [] })
    })
    const { onRetryHarnesses } = renderHome([brokenGemini])
    await screen.findByText(/No teams yet/)
    expect(screen.getByText('None of your AI apps can start right now.')).toBeInTheDocument()
    // Hidden, the footer re-checks every failing app at once.
    fireEvent.click(within(screen.getByRole('region', { name: 'Set up an AI app' })).getByRole('button', { name: 'Hide' }))
    expect(within(screen.getByRole('list', { name: 'Apps that need attention' })).getByText(geminiReason)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(onRetryHarnesses).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/harnesses/gemini/models')).toBe(true)
  })

  it('lists a failing app inside app setup, with its own Check again', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/harnesses/gemini/models') return respond({ error: 'still signed out' }, 502)
      if (url === '/api/harnesses') return respond({ harnesses: [brokenGemini], searchedPath: [], knownIds: [] })
      if (url.startsWith('/api/commands?')) return respond({ commands: [{ cmd: 'gemini', status: 'found', path: '/bin/gemini' }] })
      return respond({ root: '/teams', files: [], teams: [] })
    })
    renderHome([brokenGemini])
    await screen.findByText(/No teams yet/)
    // While setup is open it is the one place for app problems; the footer only states the outcome.
    expect(screen.queryByRole('list', { name: 'Apps that need attention' })).toBeNull()
    const gemini = within(screen.getByRole('region', { name: 'Set up an AI app' })).getByRole('listitem', { name: /^Gemini: Can’t start/ })
    expect(within(gemini).getByRole('alert')).toHaveTextContent(geminiReason)
    fireEvent.click(within(gemini).getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/harnesses/gemini/models')).toBe(true))
  })

  it('never builds a template on an app that failed to start', async () => {
    fetchMock.mockImplementation(() => respond({ root: '/teams', files: [], teams: [] }))
    renderHome([brokenGemini])
    await screen.findByText(/No teams yet/)
    fireEvent.click(screen.getByRole('button', { name: 'New team' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a team' })
    expect(within(dialog).getByRole('radio', { name: /One assistant/ })).toBeDisabled()
    expect(within(dialog).getByRole('radio', { name: /Empty team/ })).toBeChecked()
    expect(within(dialog).getByText(/None of your AI apps can start right now/)).toBeInTheDocument()
    expect(within(dialog).getByText(geminiReason)).toBeInTheDocument()
  })
})

describe('Home and the getting-started guide', () => {
  beforeEach(() => resetTourForTests())

  const demoTeam = { root: '/teams', files: ['operator-stop.yaml'], teams: [{ path: 'operator-stop.yaml', name: 'Review stop demo', agentCount: 3, modifiedAt: null }] }

  it('offers the guide to someone who has never run a team, though the demo team is there', async () => {
    fetchMock.mockImplementation((url: string) => respond(url === '/api/runs' ? [] : demoTeam))
    renderHome()
    await screen.findByText('Review stop demo')
    await waitFor(() => expect(readTourState()).toMatchObject({ status: 'active', step: 'welcome' }))
  })

  it('leaves someone who has run a team alone, but lets them start it', async () => {
    fetchMock.mockImplementation((url: string) => respond(url === '/api/runs' ? [{ runId: 'run-1', teamPath: 'operator-stop.yaml', status: 'succeeded' }] : demoTeam))
    renderHome()
    await screen.findByText('Review stop demo')
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/runs')).toBe(true))
    expect(readTourState()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Take the 3-minute guide/ }))
    expect(readTourState()).toMatchObject({ status: 'active', step: 'welcome' })
  })

  it('takes the job in plain words for Ask LoomWatch, and says why when it cannot', async () => {
    fetchMock.mockImplementation(() => respond({ root: '/teams', files: [], teams: [] }))
    const onAsk = vi.fn()
    const { unmount } = render(<Home harnesses={[claude]} harnessesLoading={false} harnessesError={null} onRetryHarnesses={vi.fn()} onCreateBlank={vi.fn()} onPalette={vi.fn()} ask={{ unavailable: null, onAsk }} />)
    const box = screen.getByRole('textbox', { name: /Or describe the job/ })
    fireEvent.change(box, { target: { value: '  Brief me on chip news every weekday  ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onAsk).toHaveBeenCalledWith('Brief me on chip news every weekday')
    expect(box).toHaveValue('')
    // New team stays the one gold button.
    expect(screen.getByRole('button', { name: 'Ask' })).not.toHaveClass('btn-primary')
    unmount()

    render(<Home harnesses={[]} harnessesLoading={false} harnessesError={null} onRetryHarnesses={vi.fn()} onCreateBlank={vi.fn()} onPalette={vi.fn()} ask={{ unavailable: 'Ask needs Claude Code, Codex, Gemini CLI or OpenCode on this computer.', onAsk }} />)
    expect(screen.getByRole('textbox', { name: /Or describe the job/ })).toBeDisabled()
    expect(screen.getByText(/Ask needs Claude Code/)).toBeInTheDocument()
  })
})
