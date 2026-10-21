import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { DEFAULT_MODEL } from '../../lib/ai/modelIds'
import { FEEDBACK_EVENT } from '../../lib/feedback/report'
import { forgetKeyStatus } from '../../lib/ai/useKeyStatus'
import { resetFirstRunForTests } from '../../lib/firstrun/store'
import { readTourState, resetTourForTests, startTour } from '../../lib/tour/store'
import { forgetYou } from '../../lib/you/client'
import { cascaded, goldFilled, isGoldFill } from '../../test/cascade'
import type { TeamDocument } from '../../lib/team-file/types'
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
  forgetYou()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderHome() {
  render(<Home onPalette={vi.fn()} />)
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

  // The app follows the landing page: Home opens on its headline, word for word, with the same words in gold.
  it('opens on the landing page’s headline', async () => {
    fetchMock.mockImplementation(() => respond({ root: '/teams', files: [], teams: [] }))
    renderHome()
    const heading = await screen.findByRole('heading', { level: 1 })
    const landing = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../site/index.html'), 'utf8').match(/<h1 id="hero-h">(.*?)<\/h1>/s)![1]
    const words = (text: string) => text.replace(/<[^>]+>/g, '').replace(/&nbsp;|\s+/g, ' ').trim()
    expect(words(heading.textContent!)).toBe(words(landing))
    expect(words(heading.querySelector('em')!.textContent!)).toBe(words(landing.match(/<em>(.*?)<\/em>/s)![1]))
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

  // Home's About you card went with the first run (ADR 0075), which left Home no way to About you.
  it('says beside your agents what they know about you, and links to About you', async () => {
    let you: Record<string, unknown> = { skipped: false }
    fetchMock.mockImplementation((url: string) => respond(
      url === '/api/you' ? you
        : url === '/api/jobs' ? { folder: '/teams/.jobs', jobs: [], problems: [] }
          : { root: '/teams', files: [], teams: [] }))
    renderHome()
    const shelf = () => screen.getByRole('heading', { name: /My agents/ }).closest('section')!
    expect(await screen.findByText(/Your agents don’t know you yet\./)).toBeInTheDocument()
    expect(within(shelf()).getByRole('link', { name: 'Tell them about you' })).toHaveAttribute('href', '/you')

    cleanup()
    forgetYou()
    you = { name: 'Mai', about: 'I teach English.', skipped: false }
    renderHome()
    expect(await screen.findByText('Mai')).toBeInTheDocument()
    expect(shelf().querySelector('.agents-know-you')).toHaveTextContent('Your agents know you as Mai. Edit')
    expect(within(shelf()).getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/you')
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
    expect(screen.queryByText(/Start here/)).toBeNull()
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
    const agents = await screen.findByRole('heading', { name: /My agents/ })
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
    render(<Home onPalette={vi.fn()} runs={runs} />)
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

  it('says how to start when there are no teams, and asks how models are paid until one is connected', async () => {
    fetchMock.mockImplementation(keyed({ connected: false }))
    renderHome()
    expect(await screen.findByText(/No teams yet/)).toBeInTheDocument()
    // The ways to pay side by side, with the same weight (ADR 0073).
    expect(await screen.findByRole('region', { name: 'First, choose how your agents’ models are paid' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Your Claude API credit' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'OpenRouter (pay per use)' })).toBeInTheDocument()
    expect(screen.getByText('Connect your ChatGPT plan, your Claude API credit or an OpenRouter key so your agents can run.')).toBeInTheDocument()
    // The OpenRouter card asks for the key's state itself, so its field comes once that answer does.
    expect(await screen.findByLabelText('OpenRouter key')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Claude API key')).toHaveAttribute('type', 'password')
  })

  // One gold fill per screen (DESIGN_LANGUAGE §8): Build an agent. Until a way to pay is connected,
  // the three cards' buttons are gold rings, with the same weight (ADR 0073), even with a key typed.
  it('fills only Build an agent while the ways to pay wait, their buttons as rings', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/ai') return respond({ openrouter: { connected: false }, anthropic: { connected: false }, chatgpt: { available: true, connected: false, planUse: false } })
      if (url === '/api/ai/chatgpt/sign-in') return respond({ url: 'https://auth.openai.com/oauth/authorize?state=s' })
      return respond({ root: '/teams', files: [], teams: [] })
    })
    renderHome()
    const go = await screen.findByRole('link', { name: /Continue with ChatGPT/ })
    fireEvent.change(await screen.findByLabelText('OpenRouter key'), { target: { value: 'sk-or-v1-typed' } })
    fireEvent.change(screen.getByLabelText('Claude API key'), { target: { value: 'sk-ant-api03-typed' } })
    const saves = screen.getAllByRole('button', { name: 'Save key' })
    expect(saves).toHaveLength(2)
    for (const save of saves) expect(save).toBeEnabled()
    expect(goldFilled()).toEqual(['Build an agent'])
    for (const ring of [go, ...saves]) {
      expect(isGoldFill(ring)).toBe(false)
      expect(cascaded(ring, 'border-color')).toBe('var(--color-accent)')
      expect(cascaded(ring, 'color')).toBe('var(--color-ink)')
    }
    // The maker's mark sits in the button without its own tile, which touched the ring's edge.
    const mark = go.querySelector('.maker-mark')!
    expect(cascaded(mark, ['background', 'background-color'])).toBe('none')
    expect(cascaded(mark, 'box-shadow')).toBe('none')
    expect(cascaded(mark, 'height')).toBe('20px')
  })

  it('keeps the cards away once a way to pay is connected, and says what agents can run on', async () => {
    fetchMock.mockImplementation(keyed({ connected: true, label: 'sk-or-v1-abc...xyz' }))
    renderHome()
    expect(await screen.findByText('Agents can run on OpenRouter')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'First, choose how your agents’ models are paid' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Manage' })).toHaveAttribute('href', '/connections')
    expect(screen.getByRole('link', { name: 'Usage' })).toHaveAttribute('href', '/usage')
  })

  // Home wears the header a team's and an agent's page have, the bell beside the menu. Skills and
  // Quests are Home's own, so they stand in the header as links, once: the menu doesn't repeat them.
  it('has Skills and Quests in its header, and the menu a team’s page has, with the theme and feedback in it', async () => {
    fetchMock.mockImplementation((url: string) => respond(url === '/api/wardrobe' ? { items: {} } : { root: '/teams', files: [], teams: [] }))
    const sent = vi.fn()
    window.addEventListener(FEEDBACK_EVENT, sent)
    render(<Home onPalette={vi.fn()} topActions={<button type="button">1 needs you</button>} />)
    const header = screen.getByRole('banner')
    expect(within(header).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Open the command palette', '1 needs you', 'Menu'])
    expect(within(header).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/skills', '/quests'])
    // The word alone names each, at every width: no stock icon has to carry it on a phone.
    const skills = within(header).getByRole('link', { name: 'Skills' })
    const quests = await within(header).findByRole('link', { name: 'Quests 0 of 13 earned' })
    for (const pill of [skills, quests]) expect(pill.querySelector('svg')).toBeNull()
    const menu = within(header).getByRole('button', { name: 'Menu' })
    fireEvent.click(menu)
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'My agents…', 'About you…', 'Connections…', 'Usage…', expect.stringMatching(/^Switch to (light|dark) theme$/), 'Getting started guide', 'Send feedback…',
    ])
    fireEvent.click(menu)
    const before = document.documentElement.dataset.theme
    fireEvent.click(menu)
    fireEvent.click(screen.getByRole('menuitem', { name: /^Switch to (light|dark) theme$/ }))
    expect(document.documentElement.dataset.theme).not.toBe(before)
    fireEvent.click(menu)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send feedback…' }))
    expect(sent.mock.calls.map(([event]) => (event as CustomEvent).detail)).toEqual([{ screen: 'home' }])
    window.removeEventListener(FEEDBACK_EVENT, sent)
    localStorage.removeItem('loomwatch:theme')
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

  // A team always starts with agents: the ones you built, or a template's. There is no empty team.
  it('starts a team with the agents you tick, linked to the versions you saved, and never with none', async () => {
    const reader = { id: 'reader', file: 'reader.yaml', name: 'Reader', instructions: 'Read the sources.', version: 2 }
    const writer = { id: 'writer', file: 'writer.yaml', name: 'Writer', instructions: 'Write the brief.', version: 1 }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/jobs') return respond({ folder: '/teams/.jobs', jobs: [reader, writer], problems: [] })
      if (url === '/api/team' && init?.method === 'PUT') return respond({ path: 'digest.yaml', yaml: '', revision: 'r1' })
      return respond({ root: '/teams', files: [], teams: [] })
    })
    renderHome()
    await screen.findByText(/No teams yet/)
    fireEvent.click(screen.getByRole('button', { name: 'New team' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a team' })
    expect(await within(dialog).findByRole('radio', { name: /My agents/ })).toBeChecked()
    expect(within(dialog).queryByRole('radio', { name: /Empty team/ })).toBeNull()
    fireEvent.change(within(dialog).getByLabelText('Team name'), { target: { value: 'Digest' } })
    // Two agents, none ticked yet: nothing to start with, so nothing is created.
    const create = within(dialog).getByRole('button', { name: 'Create team' })
    expect(create).toBeDisabled()
    expect(within(dialog).getByText('Tick at least one agent.')).toBeInTheDocument()
    const agents = within(dialog).getByRole('group', { name: 'Agents to start with' })
    fireEvent.click(within(agents).getByRole('checkbox', { name: /Writer/ }))
    fireEvent.click(within(agents).getByRole('checkbox', { name: /Reader/ }))
    fireEvent.click(create)

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/?path=digest.yaml'))
    const put = fetchMock.mock.calls.find(([url, init]) => url === '/api/team' && init?.method === 'PUT')
    const doc = parse(JSON.parse(String(put?.[1]?.body)).yaml as string) as TeamDocument
    // In the order they are listed in Your agents, each a copy of the version saved.
    expect(doc.agents.map((agent) => [agent.id, agent.role, agent.from])).toEqual([
      ['reader', 'Read the sources.', { agent: 'reader', version: 2 }],
      ['writer', 'Write the brief.', { agent: 'writer', version: 1 }],
    ])
    expect(doc.entrypoint).toBe('reader')
  })

  it('offers a template, and a way to build an agent, to someone who has none', async () => {
    fetchMock.mockImplementation((url: string) => respond(url === '/api/jobs' ? { folder: '/teams/.jobs', jobs: [], problems: [] } : { root: '/teams', files: [], teams: [] }))
    renderHome()
    await screen.findByText(/No teams yet/)
    fireEvent.click(screen.getByRole('button', { name: 'New team' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a team' })
    expect(await within(dialog).findByRole('link', { name: /Build your first agent/ })).toHaveAttribute('href', '/agents/new')
    expect(within(dialog).getByRole('radio', { name: /My agents/ })).toBeDisabled()
    expect(within(dialog).getByRole('radio', { name: /One assistant/ })).toBeChecked()
  })

})

describe('Home, the first run and the getting-started guide', () => {
  beforeEach(() => { resetTourForTests(); resetFirstRunForTests() })

  const desk = { path: 'desk.yaml', name: 'Research desk', agentCount: 3, modifiedAt: null }
  const helper = { id: 'helper', file: 'helper.yaml', name: 'Helper', version: 1 }
  const ran = { runId: 'run-1', teamPath: 'desk.yaml', status: 'succeeded' }
  /** The daemon: `runs` in the history, `agents` in My agents and `teams` in the teams folder. */
  const daemon = ({ runs = [] as unknown[], agents = [] as unknown[], teams = [] as (typeof desk)[] } = {}) => (url: string) => respond(
    url === '/api/runs?preview=true' ? runs
      : url === '/api/jobs' ? { folder: '/teams/.jobs', jobs: agents, problems: [] }
        : { root: '/teams', files: teams.map((team) => team.path), teams })
  const homeHeading = () => screen.findByRole('heading', { name: /Put AI agents to work/ })

  // ADR 0075: a newcomer makes something first. The guide no longer opens by itself over it.
  // LoomWatch removed and installed again keeps its address, so this browser still holds what an
  // earlier copy stored there; only what this copy has made decides.
  it('opens on the first run when nothing was ever made here, whatever this browser kept from an earlier LoomWatch', async () => {
    localStorage.setItem('loomwatch:first-run', 'done')
    startTour()
    fetchMock.mockImplementation(daemon())
    renderHome()
    expect(await screen.findByText('What shall we make first?')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Put AI agents to work/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Just look around' }))
    expect(await screen.findByText(/No teams yet/)).toBeInTheDocument()

    // Looking around holds for the visit: back on Home, it stays Home.
    cleanup()
    renderHome()
    expect(await screen.findByText(/No teams yet/)).toBeInTheDocument()
    expect(screen.queryByText('What shall we make first?')).toBeNull()
  })

  // A team counts too: one made with New team, or the offline demo copied in, though it never ran.
  it('is Home for someone with a run in the history, one of My agents or a team, and asks once a visit', async () => {
    for (const made of [{ runs: [ran] }, { agents: [helper] }, { teams: [desk] }]) {
      resetFirstRunForTests()
      fetchMock.mockReset()
      fetchMock.mockImplementation(daemon(made))
      renderHome()
      // Unseen while it asks (home.css), so a newcomer never sees Home before the first run.
      const home = () => document.querySelector('.lw-home')
      expect(home()).toHaveAttribute('data-checking')
      expect(await homeHeading()).toBeInTheDocument()
      await waitFor(() => expect(sessionStorage.getItem('loomwatch:first-run')).toBe('not-new'))
      await waitFor(() => expect(home()).not.toHaveAttribute('data-checking'))
      expect(screen.queryByText('What shall we make first?')).toBeNull()
      cleanup()
      // Work never goes away, so the next Home in this visit doesn't ask the history again.
      fetchMock.mockClear()
      renderHome()
      expect(home()).not.toHaveAttribute('data-checking')
      expect(await homeHeading()).toBeInTheDocument()
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/runs?preview=true')).toBe(false)
      cleanup()
    }
  })

  it('is Home when the history can’t be read', async () => {
    fetchMock.mockImplementation((url: string) => (url === '/api/runs?preview=true' ? respond({ error: 'busy' }, 500) : daemon()(url)))
    renderHome()
    expect(await homeHeading()).toBeInTheDocument()
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/runs?preview=true')).toBe(true))
    await expect(screen.findByText('What shall we make first?', {}, { timeout: 300 })).rejects.toThrow()
  })

  it('leaves someone who has run a team on Home, and lets them start the guide', async () => {
    fetchMock.mockImplementation(daemon({ runs: [ran], teams: [desk] }))
    renderHome()
    await screen.findByText('Research desk')
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/runs?preview=true')).toBe(true))
    expect(screen.queryByText('What shall we make first?')).toBeNull()
    expect(readTourState()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Take the 3-minute guide/ }))
    expect(readTourState()).toMatchObject({ status: 'active', step: 'welcome' })
  })

  it('takes the job in plain words for Ask LoomWatch, and says why when it cannot', async () => {
    fetchMock.mockImplementation(() => respond({ root: '/teams', files: [], teams: [] }))
    const onAsk = vi.fn()
    const { unmount } = render(<Home onPalette={vi.fn()} ask={{ unavailable: null, onAsk }} />)
    const box = screen.getByRole('textbox', { name: /Or describe the job/ })
    fireEvent.change(box, { target: { value: '  Brief me on chip news every weekday  ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onAsk).toHaveBeenCalledWith('Brief me on chip news every weekday')
    expect(box).toHaveValue('')
    // Build an agent stays the one gold button.
    expect(screen.getByRole('button', { name: 'Ask' })).not.toHaveClass('btn-primary')
    unmount()

    render(<Home onPalette={vi.fn()} ask={{ unavailable: 'Ask runs on your OpenRouter key. Add it to start.', onAsk }} />)
    expect(screen.getByRole('textbox', { name: /Or describe the job/ })).toBeDisabled()
    expect(screen.getByText(/Ask runs on your OpenRouter key/)).toBeInTheDocument()
  })
})
