import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FEEDBACK_EVENT } from '../../lib/feedback/report'
import { forgetKeyStatus } from '../../lib/ai/useKeyStatus'
import { resetFirstRunForTests } from '../../lib/firstrun/store'
import { readTourState, resetTourForTests } from '../../lib/tour/store'
import { forgetYou } from '../../lib/you/client'
import type { RunRecord } from '../../lib/runs/client'
import { cascaded, goldFilled, isGoldFill } from '../../test/cascade'
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

/** The daemon with no projects or teams and the OpenRouter key as `key` says. */
const keyed = (key: Record<string, unknown>) => (url: string) => respond(url === '/api/ai' ? { openrouter: key } : { root: '/teams', files: [], teams: [] })

const GATE = `schemaVersion: 1
id: gate
name: Research and design
project: sutd
entrypoint: researcher
agents:
  - id: researcher
    from: {agent: researcher}
  - id: review
    kind: operator
    role: Pick one.
  - id: designer
    from: {agent: designer}
edges:
  - {from: researcher, to: review, layer: configured, kind: sequence, ts: "2026-10-28T00:00:00Z"}
  - {from: review, to: designer, layer: configured, kind: sequence, ts: "2026-10-28T00:00:00Z"}
`
const BLOG = 'schemaVersion: 1\nid: blog\nname: Blog\nproject: blog\nentrypoint: writer\nagents:\n  - id: writer\n    from: {agent: writer}\nedges: []\n'
const JOBS = [
  { id: 'researcher', file: '.jobs/researcher.yaml', name: 'Researcher', instructions: 'Research.', version: 1 },
  { id: 'designer', file: '.jobs/designer.yaml', name: 'Designer', instructions: 'Design.', version: 1 },
  { id: 'writer', file: '.jobs/writer.yaml', name: 'Writer', instructions: 'Write.', version: 1 },
  { id: 'translator', file: '.jobs/translator.yaml', name: 'Translator', instructions: 'Translate.', version: 1 },
]

/** The daemon with two projects, their teams and My agents. */
function studio(url: string) {
  if (url === '/api/projects') {
    return respond({
      projects: [
        { id: 'blog', name: 'Blog', teams: ['blog.yaml'] },
        { id: 'sutd', name: 'SUTD final project', mark: 'sky', teams: ['sutd/gate.yaml'] },
      ],
      loose: [],
      missing: [],
    })
  }
  if (url === '/api/jobs') return respond({ folder: '/teams/.jobs', jobs: JOBS, problems: [] })
  if (url.startsWith('/api/team?')) {
    const path = new URLSearchParams(url.split('?')[1]).get('path')
    return respond({ path, yaml: path === 'blog.yaml' ? BLOG : GATE, revision: 'r' })
  }
  return respond({ root: '/teams', files: ['blog.yaml', 'sutd/gate.yaml'], teams: [{ path: 'blog.yaml', name: 'Blog', agentCount: 1 }, { path: 'sutd/gate.yaml', name: 'Research and design', agentCount: 3 }] })
}

function run(teamPath: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: `run-${teamPath}`, sessionId: 's', teamPath, prompt: 'p', status: 'running', mode: 'pipeline', entrypoint: 'researcher', responder: 'designer',
    agentIds: [], createdAt: '2026-10-28T09:00:00Z', startedAt: '2026-10-28T09:00:00Z', finishedAt: null, error: null, exitCode: null, eventCount: null, reply: null,
    ...extra,
  } as RunRecord
}

const waitingOnTheResearcher = run('sutd/gate.yaml', {
  waitingOn: { node: 'review', name: 'You', kind: 'review_stop', since: '2026-10-28T09:05:00Z', question: 'Pick one.', handoverFrom: 'researcher', park: 'none', parkNote: '', sendBackAvailable: true },
})

describe('Home, the studio (ADR 0097)', () => {
  it('asks what you are working on before there is any project, and Set up project asks Ask with your words', async () => {
    fetchMock.mockImplementation(() => respond({ root: '/teams', files: [], teams: [] }))
    const onAsk = vi.fn()
    render(<Home onPalette={vi.fn()} ask={{ unavailable: null, onAsk }} />)
    expect(await screen.findByRole('heading', { name: 'What are you working on?' })).toBeInTheDocument()
    expect(screen.getByText('You see the team before anything runs.')).toBeInTheDocument()
    const setUp = screen.getByRole('button', { name: 'Set up project' })
    // The getting-started guide points here to put your first agent to work (lib/tour/steps.ts).
    expect(setUp.closest('[data-tour="set-up-project"]')).toContainElement(screen.getByRole('textbox', { name: 'What you are working on' }))
    // With nothing said, it puts you where to say it, and asks nothing.
    fireEvent.click(setUp)
    expect(onAsk).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'What you are working on' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'My thesis' }))
    expect(screen.getByRole('textbox', { name: 'What you are working on' })).toHaveValue('My thesis')
    fireEvent.change(screen.getByRole('textbox', { name: 'What you are working on' }), { target: { value: 'My final-year project at SUTD' } })
    fireEvent.click(setUp)
    expect(onAsk).toHaveBeenCalledWith('Set up a project for this: My final-year project at SUTD')
    // And a way to chat with one agent outside any project.
    expect(screen.getByRole('button', { name: 'Chat with one agent' })).toBeInTheDocument()
    cleanup()

    render(<Home onPalette={vi.fn()} ask={{ unavailable: 'Ask runs on your OpenRouter key. Add it to start.', onAsk }} />)
    expect(await screen.findByText('Ask runs on your OpenRouter key. Add it to start.')).toBeInTheDocument()
  })

  it('shows each project as a room, the one waiting for you first, its agents at their desks, and opens it', async () => {
    fetchMock.mockImplementation(studio)
    render(<Home onPalette={vi.fn()} runs={[waitingOnTheResearcher]} />)
    const rooms = await screen.findAllByRole('article')
    await waitFor(() => expect(rooms[0]).toHaveTextContent('Researcher is waiting for you'))
    expect(rooms.map((room) => within(room).getByRole('heading').textContent)).toEqual(['SUTD final project', 'Blog'])
    // The guide's "Open a project" points at the rooms, New project with them.
    expect(rooms[0].closest('[data-tour="projects"]')).toContainElement(screen.getByRole('button', { name: 'New project' }))
    // The Researcher stands at Your desk, so its desk in the room is its outline, saying where it is.
    expect(within(rooms[0]).getByTitle('Researcher is at your desk')).toBeInTheDocument()
    expect(within(rooms[0]).getByRole('group', { name: /Research and design: Researcher is at your desk, then You check, then Designer/ })).toBeInTheDocument()
    expect(rooms[1]).toHaveTextContent('Ready')
    fireEvent.click(within(rooms[0]).getByRole('button', { name: 'SUTD final project' }))
    expect(assign).toHaveBeenCalledWith('/projects/sutd')
  })

  it('puts whoever waits for you first on Your desk, and Review opens what waits, as the bell does', async () => {
    fetchMock.mockImplementation(studio)
    const opened = vi.fn()
    window.addEventListener('loomwatch:open-needs-you', opened)
    render(<Home onPalette={vi.fn()} runs={[waitingOnTheResearcher]} />)
    const desk = await screen.findByRole('group', { name: 'Your desk' })
    const needs = await within(desk).findByRole('region', { name: 'Needs you · 1' })
    expect(within(needs).getByText('Researcher brought work for you to check')).toBeInTheDocument()
    expect(within(needs).getByText('Research and design')).toBeInTheDocument()
    fireEvent.click(within(needs).getByRole('button', { name: 'Review: Researcher brought work for you to check' }))
    expect(opened).toHaveBeenCalledTimes(1)
    // One gold fill on the screen: Review. The box beside it gives work with a plain Send meanwhile.
    expect(goldFilled()).toEqual(['Review'])
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    window.removeEventListener('loomwatch:open-needs-you', opened)
  })

  it('gives any team work from Home, its teams under their projects', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => (url === '/api/chat/messages' && init?.method === 'POST' ? respond({ route: 'team', message: { id: 'm1' }, run: null }) : studio(url)))
    renderHome()
    const box = await screen.findByRole('form', { name: 'Give work' })
    const to = within(box).getByRole('combobox', { name: 'To' })
    expect([...to.querySelectorAll('optgroup')].map((group) => [group.label, [...group.querySelectorAll('option')].map((option) => option.textContent)])).toEqual([
      ['Blog', ['Blog']],
      ['SUTD final project', ['Research and design']],
    ])
    fireEvent.change(to, { target: { value: 'sutd/gate.yaml' } })
    fireEvent.change(within(box).getByRole('textbox'), { target: { value: 'Find three gate designs.' } })
    // Nothing waits for you: Send is the one gold fill.
    expect(goldFilled()).toEqual(['Send'])
    fireEvent.click(within(box).getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/chat/messages')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([url]) => url === '/api/chat/messages') as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ teamPath: 'sutd/gate.yaml', text: 'Find three gate designs.', work: true })
    localStorage.removeItem('loomwatch:work-box-team')
  })

  it('lists each team in its room with what it is doing, and opens its chat from its name', async () => {
    fetchMock.mockImplementation(studio)
    render(<Home onPalette={vi.fn()} runs={[waitingOnTheResearcher, run('blog.yaml', { runId: 'b1', status: 'succeeded', finishedAt: new Date().toISOString(), made: ['/teams/post.md'], spend: { spentUsd: 0.25 }, createdAt: new Date().toISOString() })]} />)
    const [sutd, blog] = await screen.findAllByRole('article')
    const teams = within(sutd).getByRole('list', { name: 'SUTD final project’s teams' })
    expect(within(teams).getByRole('link', { name: 'Research and design' })).toHaveAttribute('href', '/?path=sutd%2Fgate.yaml&view=chat')
    expect(teams).toHaveTextContent('Researcher is waiting for you')
    // The newest thing made here, one press from being read, and what this month cost.
    expect(within(blog).getByRole('button', { name: /post\.md/ })).toBeInTheDocument()
    expect(blog).toHaveTextContent('$0.25 this month')
  })

  it('stands your agents in no project apart, each with Chat and Add to a project, and links to About you', async () => {
    fetchMock.mockImplementation((url: string) => (url === '/api/you' ? respond({ skipped: false }) : studio(url)))
    renderHome()
    const row = (await screen.findByRole('heading', { name: 'Not in a project' })).closest('section') as HTMLElement
    const translator = await within(row).findByRole('button', { name: /Translator/ })
    expect(within(row).queryByRole('button', { name: /Writer/ })).toBeNull()
    fireEvent.click(translator)
    expect(within(row).getByRole('menuitem', { name: 'Chat' })).toHaveAttribute('href', '/agents/translator?view=chat')
    fireEvent.click(within(row).getByRole('menuitem', { name: 'Add to a project' }))
    expect(within(row).getByRole('menuitem', { name: 'SUTD final project' })).toHaveAttribute('href', '/projects/sutd?add=translator')
    expect(within(row).getByRole('link', { name: 'All my agents (4)' })).toHaveAttribute('href', '/agents')
    expect(await within(row).findByRole('link', { name: 'Tell them about you' })).toHaveAttribute('href', '/you')
  })

  it('opens a chat with one of your agents from where you left off', async () => {
    fetchMock.mockImplementation(studio)
    renderHome()
    const row = await screen.findByRole('region', { name: 'Pick up where you left off' })
    fireEvent.click(within(row).getByRole('button', { name: 'Chat with one agent' }))
    expect(await within(row).findByRole('menuitem', { name: /Researcher/ })).toHaveAttribute('href', '/agents/researcher?view=chat')
  })

  it('starts a new project from New project, and from New team, since every team works in one', async () => {
    fetchMock.mockImplementation(studio)
    renderHome()
    await screen.findAllByRole('article')
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    expect(screen.getByRole('dialog', { name: 'What are you working on?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    window.dispatchEvent(new Event('loomwatch:new-team'))
    expect(await screen.findByRole('dialog', { name: 'What are you working on?' })).toBeInTheDocument()
  })

  it('lists the projects too, for a screen reader or anyone who prefers it', async () => {
    fetchMock.mockImplementation(studio)
    render(<Home onPalette={vi.fn()} runs={[waitingOnTheResearcher]} />)
    await screen.findAllByRole('article')
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    const list = screen.getByRole('list', { name: 'Projects' })
    expect(within(list).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'SUTD final projectResearcher is waiting for youResearch and design',
      'BlogReadyBlog',
      'New project',
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Rooms' }))
    localStorage.removeItem('loomwatch:studio-view')
  })

  it('says a file cannot be opened, so none goes missing from Home', async () => {
    fetchMock.mockImplementation(() => respond({
      root: '/teams',
      files: ['broken.yaml', 'notes.yaml'],
      teams: [{ path: 'broken.yaml', agentCount: 0, problem: 'unreadable' }, { path: 'notes.yaml', agentCount: 0, problem: 'not_a_team' }],
    }))
    renderHome()
    const problems = await screen.findByRole('list', { name: 'Files that can’t be opened' })
    expect(problems).toHaveTextContent('broken can’t be opened: the file has a mistake in it')
    expect(problems).toHaveTextContent('notes can’t be opened: not a team file')
  })

  it('says plainly when the server is down, and brings the projects back when it returns', async () => {
    let up = false
    fetchMock.mockImplementation((url: string) => (up ? studio(url) : Promise.reject(new TypeError('Failed to fetch'))))
    renderHome()
    const alert = await screen.findByText(/Couldn’t list your projects/)
    expect(alert).toHaveTextContent('Can’t reach the LoomWatch server')
    expect(alert).not.toHaveTextContent('Failed to fetch')
    up = true
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'SUTD final project' })).toBeInTheDocument()
  })

  it('asks how models are paid until one is connected', async () => {
    fetchMock.mockImplementation(keyed({ connected: false }))
    renderHome()
    // The ways to pay side by side, with the same weight (ADR 0073).
    expect(await screen.findByRole('region', { name: 'First, choose how your agents’ models are paid' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Your Claude API credit' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'OpenRouter (pay per use)' })).toBeInTheDocument()
    expect(screen.getByText('Connect your ChatGPT plan, your Claude API credit or an OpenRouter key so your agents can run.')).toBeInTheDocument()
    expect(await screen.findByLabelText('OpenRouter key')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Claude API key')).toHaveAttribute('type', 'password')
  })

  // One gold fill per screen (DESIGN_LANGUAGE §8): Set up project. Until a way to pay is connected,
  // the three cards' buttons are gold rings, with the same weight (ADR 0073), even with a key typed.
  it('fills only Set up project while the ways to pay wait, their buttons as rings', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/ai') return respond({ openrouter: { connected: false }, anthropic: { connected: false }, chatgpt: { available: true, connected: false, planUse: false } })
      if (url === '/api/ai/chatgpt/sign-in') return respond({ url: 'https://auth.openai.com/oauth/authorize?state=s' })
      return respond({ root: '/teams', files: [], teams: [] })
    })
    render(<Home onPalette={vi.fn()} ask={{ unavailable: null, onAsk: vi.fn() }} />)
    const go = await screen.findByRole('link', { name: /Continue with ChatGPT/ })
    fireEvent.change(await screen.findByLabelText('OpenRouter key'), { target: { value: 'sk-or-v1-typed' } })
    fireEvent.change(screen.getByLabelText('Claude API key'), { target: { value: 'sk-ant-api03-typed' } })
    const saves = screen.getAllByRole('button', { name: 'Save key' })
    expect(saves).toHaveLength(2)
    for (const save of saves) expect(save).toBeEnabled()
    await screen.findByRole('button', { name: 'Set up project' })
    expect(goldFilled()).toEqual(['Set up project'])
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
  const homeHeading = () => screen.findByRole('heading', { name: 'What are you working on?' })

  // ADR 0075: a newcomer makes something first. The guide no longer opens by itself over it.
  // LoomWatch removed and installed again keeps its address, so this browser still holds what an
  // earlier copy stored there; only what this copy has made decides.
  it('opens on the first run when nothing was ever made here, whatever this browser kept from an earlier LoomWatch', async () => {
    localStorage.setItem('loomwatch:first-run', 'done')
    fetchMock.mockImplementation(daemon())
    renderHome()
    expect(await screen.findByText('What shall we make first?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Just look around' }))
    expect(await homeHeading()).toBeInTheDocument()

    // Looking around holds for the visit: back on Home, it stays Home.
    cleanup()
    renderHome()
    expect(await homeHeading()).toBeInTheDocument()
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

  it('leaves someone who has run a team on Home, and lets them start the guide from the menu', async () => {
    fetchMock.mockImplementation(daemon({ runs: [ran], teams: [desk] }))
    renderHome()
    await homeHeading()
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/runs?preview=true')).toBe(true))
    expect(screen.queryByText('What shall we make first?')).toBeNull()
    expect(readTourState()).toBeNull()
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Getting started guide' }))
    expect(readTourState()).toMatchObject({ status: 'active', step: 'welcome' })
    // The guide's first step points at building an agent, which Home keeps.
    expect(document.querySelector('[data-tour="build-agent"]')).toHaveAttribute('href', '/agents/new')
  })
})
