import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import type { SavedJob } from '../../lib/library/jobs'
import type { AgentConfig } from '../../lib/team-file/types'
import { cascaded, goldFilled, heightOf, isGoldFill, PHONE } from '../../test/cascade'
import type { AgentFigureProps } from '../agents/AgentFigure'
import { TeamAgents, type TeamAgentsProps } from './TeamAgents'

// The bench is drawn with WebGL, which jsdom has none of: here it is only its labels, as buttons.
vi.mock('../agents/AgentFigure', () => ({
  default: ({ labels }: AgentFigureProps) => <div>{labels.map((tag) => <button key={tag.anchor} type="button" aria-label={tag.label}>{tag.text}</button>)}</div>,
}))

const reader: SavedJob = { id: 'reader', file: '.jobs/reader.yaml', name: 'Reader', does: 'Checks each story', instructions: 'Check every story.', figure: { kind: 'button', color: 'sage' } }
const elsewhere: SavedJob = { id: 'coder', file: '.jobs/coder.yaml', name: 'Coder', instructions: 'Write code.', model: 'openai/gpt-6.1-sol' }

const scoper: AgentConfig = {
  id: 'scope', name: 'Project scope', role: 'Establish the project scope.', model: 'anthropic/claude-opus-5.5',
  capabilities: [
    { kind: 'skill', name: 'algorithmic-art' },
    { kind: 'knowledge', name: 'sutd-final-project', path: '/Users/me/Developer/sutd-final-project' },
    { kind: 'knowledge', name: 'brief.md', path: 'scope.files/brief.md' },
    { kind: 'knowledge', name: 'EKIS hub', notion: { page: 'abc123' } },
    { kind: 'tool', name: 'github' },
    { kind: 'tool', name: 'notion' },
  ],
}

// The model list is asked of the daemon; there is none here.
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no daemon')))) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** The tools in a list of the ones it was given, by name. */
const names = (list: HTMLElement) => within(list).getAllByRole('listitem').filter((item) => item.parentElement === list).map((item) => item.querySelector('b')?.textContent)

function renderTeamAgents(extra: Partial<TeamAgentsProps> = {}) {
  const props: TeamAgentsProps = {
    agents: [], responder: null, selected: null, onSelect: vi.fn(), teamName: 'Digest', teamPath: 'digest.yaml', editable: true,
    skills: [], skillsLoading: false, savedJobs: [reader, elsewhere],
    onEdit: vi.fn(), onAgentSaved: vi.fn(), onShowWorkflow: vi.fn(), onAdd: vi.fn(), ...extra,
  }
  render(<TeamAgents {...props} />)
  return props
}

describe('a team’s agents, the first of its views', () => {
  it('starts an empty team by choosing its agents: yours in one click, or a new one', () => {
    const props = renderTeamAgents()
    const add = screen.getByRole('region', { name: 'Add an agent to this team' })
    expect(add).toHaveTextContent('Start with its agents.')
    const row = within(add).getByText('Reader').closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'Add' }))
    expect(props.onAdd).toHaveBeenCalledWith(reader)
    expect(within(within(add).getByText('Coder').closest('li')!).getByRole('button', { name: 'Add' })).toBeEnabled()
    // A new one is built in Your agents, which leads back to this team.
    expect(within(add).getByRole('link', { name: 'Build a new agent' })).toHaveAttribute('href', '/agents/new?team=digest.yaml')
    fireEvent.click(within(add).getByRole('button', { name: 'Or start in Workflow' }))
    expect(props.onShowWorkflow).toHaveBeenCalled()
  })

  it('keeps the old way in when the team can’t be changed here', () => {
    renderTeamAgents({ onAdd: undefined, editable: false })
    expect(screen.queryByRole('region', { name: 'Add an agent to this team' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add one in Workflow' })).toBeInTheDocument()
  })

  it('shows what a team’s own agent reads on its workbench, and takes one away there', () => {
    const props = renderTeamAgents({ agents: [scoper], selected: 'scope' })
    const block = screen.getByRole('region', { name: 'What it reads' })
    expect(block).toHaveTextContent('Reads 1 folder, 1 file and 1 Notion page')
    const held = within(block).getByRole('list', { name: 'Folders, files and pages it reads' })
    expect(within(held).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'sutd-final-projectFolder · /Users/me/Developer/sutd-final-project',
      'brief.mdFile · scope.files/brief.md',
      'EKIS hubNotion page · read when each run starts',
    ])
    expect(screen.getByText(/has 1 skill, and reads 1 folder, 1 file and 1 Notion page\./)).toBeInTheDocument()
    // Given here or with a line in Workflow, it is the same card: either place changes it.
    expect(block).toHaveTextContent('Each is a card in Workflow with a line to this agent')
    expect(within(block).getByRole('group', { name: 'Give it something to read' })).toBeInTheDocument()
    fireEvent.click(within(held).getByRole('button', { name: 'Stop reading brief.md' }))
    expect(props.onEdit).toHaveBeenLastCalledWith('scope', 'reads', [
      { name: 'sutd-final-project', path: '/Users/me/Developer/sutd-final-project' },
      { name: 'EKIS hub', notion: { page: 'abc123' } },
    ])
    fireEvent.click(within(block).getByRole('button', { name: 'See it in Workflow' }))
    expect(props.onShowWorkflow).toHaveBeenCalled()
  })

  it('says when a team’s own agent reads nothing yet, and offers what it can be given', () => {
    renderTeamAgents({ agents: [{ ...scoper, capabilities: [{ kind: 'skill', name: 'algorithmic-art' }] }], selected: 'scope' })
    const block = screen.getByRole('region', { name: 'What it reads' })
    expect(within(block).getByText('Nothing yet')).toBeInTheDocument()
    expect(within(block).queryByRole('list')).toBeNull()
    const give = within(block).getByRole('group', { name: 'Give it something to read' })
    expect(within(give).getByRole('button', { name: 'Folder' })).toBeInTheDocument()
    expect(within(give).getByRole('button', { name: 'File' })).toBeInTheDocument()
    // Giving it something is right here, so there is no second way to it on this screen.
    expect(within(block).queryByRole('button', { name: /in Workflow$/ })).toBeNull()
  })

  it('gives a team’s own agent a folder, after what it reads already', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (String(url).startsWith('/api/folders')
      ? Promise.resolve(new Response(JSON.stringify({ path: '/Users/me/brand', name: 'brand', parent: '/Users/me', folders: [], files: ['logo.svg'], moreFiles: 0, places: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : Promise.reject(new Error('no daemon')))))
    const props = renderTeamAgents({ agents: [scoper], selected: 'scope' })
    fireEvent.click(within(screen.getByRole('region', { name: 'What it reads' })).getByRole('button', { name: 'Folder' }))
    const dialog = await screen.findByRole('dialog', { name: 'Give Project scope a folder' })
    expect(dialog).not.toHaveTextContent('in every team it joins')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add “brand”' }))
    expect(props.onEdit).toHaveBeenLastCalledWith('scope', 'reads', [
      { name: 'sutd-final-project', path: '/Users/me/Developer/sutd-final-project' },
      { name: 'brief.md', path: 'scope.files/brief.md' },
      { name: 'EKIS hub', notion: { page: 'abc123' } },
      { name: 'brand', path: '/Users/me/brand' },
    ])
  })

  it('keeps a file a team’s own agent is given beside the team file, as a canvas pick does', async () => {
    const sent: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      sent.push(String(url))
      return String(url).startsWith('/api/team/files')
        ? Promise.resolve(new Response(JSON.stringify({ name: 'plan.md', path: 'digest.files/plan.md', bytes: 7, chars: 7, excerpted: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        : Promise.reject(new Error('no daemon'))
    }))
    const props = renderTeamAgents({ agents: [{ ...scoper, capabilities: [] }], selected: 'scope' })
    fireEvent.change(within(screen.getByRole('region', { name: 'What it reads' })).getByLabelText('Files it reads'), { target: { files: [new File(['# Plan\n'], 'plan.md', { type: 'text/markdown' })] } })
    await waitFor(() => expect(props.onEdit).toHaveBeenLastCalledWith('scope', 'reads', [{ name: 'plan.md', path: 'digest.files/plan.md' }]))
    expect(sent.find((url) => url.startsWith('/api/team/files'))).toBe(`/api/team/files?${new URLSearchParams({ path: 'digest.yaml', name: 'plan.md' })}`)
  })

  it('gives nothing and takes nothing away when the team can’t be changed here', () => {
    renderTeamAgents({ agents: [scoper], selected: 'scope', editable: false })
    const block = screen.getByRole('region', { name: 'What it reads' })
    expect(within(block).queryByRole('group', { name: 'Give it something to read' })).toBeNull()
    expect(within(block).queryByRole('button', { name: /^Stop reading/ })).toBeNull()
  })

  it('says which tools it was given aren’t connected in LoomWatch, and takes one away', async () => {
    const props = renderTeamAgents({ agents: [scoper], selected: 'scope' })
    const block = screen.getByRole('region', { name: 'Tools it can use' })
    expect(await within(block).findByText('Files, the web and commands; 2 tools aren’t connected')).toBeInTheDocument()
    const has = within(block).getByRole('list', { name: 'Tools you gave it' })
    expect(names(has)).toEqual(['github', 'notion'])
    expect(has).toHaveTextContent('Not connected in LoomWatch, so it can’t use it yet.')
    fireEvent.click(within(has).getByRole('button', { name: 'Take github away' }))
    expect(props.onEdit).toHaveBeenLastCalledWith('scope', 'tools', ['notion'])
  })

  it('shows a connected tool’s calls it always may make, takes one back, and gives it another tool (ADR 0069)', async () => {
    const tool = (name: string, calls: string[]) => ({ id: name.toLowerCase(), name, url: `https://mcp.${name.toLowerCase()}.test/mcp`, auth: 'signIn', calls: calls.map((call) => ({ name: call, label: call.replace('_', ' ').replace(/^./, (first) => first.toUpperCase()), description: '', readOnly: false })), checkedAt: null, pending: false, problem: null, tokenHelp: null })
    vi.stubGlobal('fetch', vi.fn((url: string) => (String(url).startsWith('/api/tools')
      ? Promise.resolve(new Response(JSON.stringify({ tools: [tool('Linear', ['create_issue', 'list_teams']), tool('DeepWiki', ['ask_question'])], catalog: [], keptIn: 'keychain' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : Promise.reject(new Error('no daemon')))))
    const linear: AgentConfig = { ...scoper, capabilities: [{ kind: 'tool', name: 'Linear', alwaysAllow: ['create_issue'] }] }
    const props = renderTeamAgents({ agents: [linear], selected: 'scope' })
    const block = screen.getByRole('region', { name: 'Tools it can use' })
    expect(await within(block).findByText('Files, the web and commands, plus Linear')).toBeInTheDocument()
    const allowed = within(block).getByRole('list', { name: 'Always allowed for Linear' })
    expect(allowed).toHaveTextContent('Create issue')
    fireEvent.click(within(allowed).getByRole('button', { name: 'Ask again before Create issue' }))
    expect(props.onEdit).toHaveBeenLastCalledWith('scope', 'toolAllow', {})
    const offered = within(block).getByRole('list', { name: 'Tools you can give it' })
    fireEvent.click(within(offered).getByRole('button', { name: /DeepWiki/ }))
    expect(props.onEdit).toHaveBeenLastCalledWith('scope', 'tools', ['Linear', 'DeepWiki'])
    expect(within(block).getByRole('button', { name: 'Connect a new tool' })).toBeInTheDocument()
  })

  it('says what every agent can do without a tool', () => {
    renderTeamAgents({ agents: [{ ...scoper, capabilities: [{ kind: 'skill', name: 'algorithmic-art' }] }], selected: 'scope' })
    const block = screen.getByRole('region', { name: 'Tools it can use' })
    expect(block).toHaveTextContent('Files, the web and commands, as you allow')
    expect(within(block).queryByRole('list', { name: 'Tools you gave it' })).toBeNull()
  })

  it('says on the bench which tools aren’t shown', async () => {
    const many = (count: number): AgentConfig => ({ ...scoper, capabilities: ['github', 'notion', 'linear', 'memory', 'browser', 'sentry'].slice(0, count).map((name) => ({ kind: 'tool' as const, name })) })
    renderTeamAgents({ agents: [many(6)], selected: 'scope' })
    expect(await screen.findByRole('button', { name: 'Tools it can use: Files, the web and commands; 6 tools aren’t connected (2 not shown)' })).toHaveTextContent('Tools · 6 (2 not shown)')
    cleanup()
    // Four fit: every one is in the drawer, and nothing is said.
    renderTeamAgents({ agents: [many(4)], selected: 'scope' })
    expect(await screen.findByRole('button', { name: 'Tools it can use: Files, the web and commands; 4 tools aren’t connected' })).toHaveTextContent(/^Tools · 4$/)
  })

  it('says on the bench, and in its block, what it reads that isn’t shown', async () => {
    const folders = ['notes', 'drafts', 'sources', 'archive', 'inbox'].map((name) => ({ kind: 'knowledge' as const, name, path: `/Users/me/${name}` }))
    renderTeamAgents({ agents: [{ ...scoper, capabilities: folders }], selected: 'scope' })
    expect(await screen.findByRole('button', { name: 'What it reads: Reads 5 folders (1 not shown)' })).toHaveTextContent('Reads · 5 (1 not shown)')
    expect(screen.getByRole('region', { name: 'What it reads' })).toHaveTextContent('Only 4 fit in the picture. It still reads inbox.')
  })

  it('chats with a team’s own agent on its own, in a Chat tab beside its bench', async () => {
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
    const fetched = vi.fn((url: string) => (url === '/api/bench' ? json({ folder: '.jobs/.bench' }) : url.startsWith('/api/team?') ? json({ error: 'not found' }, 404) : Promise.reject(new Error('no daemon'))))
    vi.stubGlobal('fetch', fetched)
    renderTeamAgents({ agents: [scoper], selected: 'scope' })
    const tabs = screen.getByRole('navigation', { name: 'Agent view' })
    expect(within(tabs).getByRole('button', { name: 'Build' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('region', { name: 'Try it' })).toBeNull()

    fireEvent.click(within(tabs).getByRole('button', { name: 'Chat' }))
    expect(within(tabs).getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'true')
    // Its blocks give way to its chat, kept under this team and this agent.
    expect(screen.queryByRole('region', { name: 'What it reads' })).toBeNull()
    expect(await screen.findByRole('heading', { name: 'Talk to Project scope' })).toBeInTheDocument()
    expect(fetched).toHaveBeenCalledWith(`/api/team?${new URLSearchParams({ path: '.jobs/.bench/team-digest-scope.yaml' })}`)

    fireEvent.click(within(tabs).getByRole('button', { name: 'Build' }))
    expect(screen.getByRole('region', { name: 'What it reads' })).toBeInTheDocument()
  })

  // The daemon a chat opens on: the bench folder, no chat file yet, and every chat file it is sent.
  function benchDaemon(jobs: SavedJob[] = []) {
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
    const written = new Map<string, { agents: AgentConfig[] }>()
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/bench') return json({ folder: '.jobs/.bench' })
      if (url === '/api/team' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { path: string; yaml: string }
        written.set(body.path, parse(body.yaml) as { agents: AgentConfig[] })
        return json({ ...body, revision: 'r1' })
      }
      if (url.startsWith('/api/team?')) return json({ error: 'not found' }, 404)
      if (url.endsWith('/api/jobs')) return json({ jobs, problems: [] })
      return Promise.reject(new Error('no daemon'))
    }))
    return written
  }

  // What the team gives it to read, as its team file writes it: a linked folder, a file added beside
  // the team (read from the team file's folder, so named again from the chat's), and a Notion page.
  const teamReads = [
    { kind: 'knowledge', name: 'sutd-final-project', path: '/Users/me/Developer/sutd-final-project' },
    { kind: 'knowledge', name: 'brief.md', path: '../../scope.files/brief.md' },
    { kind: 'knowledge', name: 'EKIS hub', notion: { page: 'abc123' } },
  ]

  it('chats with a team’s own agent with what the team gives it to read', async () => {
    const written = benchDaemon()
    renderTeamAgents({ agents: [{ ...scoper, model: 'anthropic/claude-sonnet-5.5' }], selected: 'scope' })
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Agent view' })).getByRole('button', { name: 'Chat' }))
    await waitFor(() => expect(written.has('.jobs/.bench/team-digest-scope.yaml')).toBe(true))
    const capabilities = written.get('.jobs/.bench/team-digest-scope.yaml')!.agents[0].capabilities
    expect(capabilities?.filter((capability) => capability.kind === 'knowledge')).toEqual(teamReads)
    // Its skills and tools go with it as before.
    expect(capabilities?.filter((capability) => capability.kind !== 'knowledge').map((capability) => capability.name)).toEqual(['algorithmic-art', 'github', 'notion'])
  })

  // Versions stay behind the scenes: the strip says an update is ready, never which number.
  // ADR 0094: every agent is one of My agents, so nothing says "update"; one the team hasn't saved
  // yet says it joins them when the team is saved.
  it('names what each agent does, and says an agent not saved yet joins My agents with the team', () => {
    renderTeamAgents({ agents: [{ ...scoper, from: { agent: 'reader' } }, { ...scoper, id: 'new', name: 'New one', from: undefined }], selected: 'scope', savedJobs: [{ ...reader, does: 'Reads the news', version: 2 }] })
    const strip = screen.getByRole('navigation', { name: 'Digest’s agents' })
    expect(within(strip).getByText('Reads the news')).toBeInTheDocument()
    expect(within(strip).getByText('Joins My agents when you save')).toBeInTheDocument()
    expect(strip.textContent).not.toMatch(/update|\bv\d/i)
  })

  it('chats with an agent placed from My agents with what this team gives it to read', async () => {
    const versioned = { ...reader, model: 'anthropic/claude-sonnet-5.5' }
    const written = benchDaemon([versioned])
    renderTeamAgents({ agents: [{ ...scoper, from: { agent: 'reader', version: 1 } }], selected: 'scope', savedJobs: [versioned] })
    await screen.findByRole('region', { name: 'What it reads' })
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Agent view' })).getByRole('button', { name: 'Chat' }))
    // Its chat is the one it has in Your agents; from this team, it reads what this team gives it.
    await waitFor(() => expect(written.has('.jobs/.bench/reader.yaml')).toBe(true))
    expect(written.get('.jobs/.bench/reader.yaml')!.agents[0].capabilities?.filter((capability) => capability.kind === 'knowledge')).toEqual(teamReads)
  })

  it('shows the version’s tools on the bench of an agent placed from My agents, and the team’s reads', async () => {
    // Its bench loads the agent from Your agents; nothing else is asked of the daemon here.
    const tooled = { ...reader, tools: ['linear'] }
    vi.stubGlobal('fetch', vi.fn((url: string) => (String(url).endsWith('/api/jobs')
      ? Promise.resolve(new Response(JSON.stringify({ jobs: [tooled], problems: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : Promise.reject(new Error('no daemon')))))
    renderTeamAgents({ agents: [{ ...scoper, from: { agent: 'reader', version: 1 } }], selected: 'scope', savedJobs: [tooled] })
    const block = await screen.findByRole('region', { name: 'Tools it can use' })
    // Its tools are the version's, like its skills: saving there moves this team to them.
    expect(names(within(block).getByRole('list', { name: 'Tools you gave it' }))).toEqual(['linear'])
    expect(screen.getByRole('region', { name: 'What it reads' })).toHaveTextContent('Reads 1 folder, 1 file and 1 Notion page this team gives it')
    // It has its Chat here too: the one it has in Your agents.
    expect(within(screen.getByRole('navigation', { name: 'Agent view' })).getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('region', { name: 'Try it' })).toBeNull()
  })

  // One gold fill per screen (DESIGN_LANGUAGE §8): on the bench of an agent placed from My agents,
  // Save, at least 32 px; its keys are offered with plain buttons.
  it('fills only Save, at least 32 px, on the bench of an agent placed from My agents', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (String(url).endsWith('/api/jobs')
      ? Promise.resolve(new Response(JSON.stringify({ jobs: [reader], problems: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : Promise.reject(new Error('no daemon')))))
    renderTeamAgents({ agents: [{ ...scoper, from: { agent: 'reader', version: 1 } }], selected: 'scope', savedJobs: [reader] })
    fireEvent.change(await screen.findByRole('textbox', { name: /Instructions/ }), { target: { value: 'Check every story twice.' } })
    const save = await screen.findByRole('button', { name: 'Save' })
    expect(save.closest('.agent-builder-save')).not.toBeNull()
    expect(goldFilled()).toEqual(['Save'])
    expect(heightOf(save)).toBe(32)
    expect(heightOf(save, PHONE)).toBe(44)
    const offers = screen.getAllByRole('button', { name: /^Allow: / })
    expect(offers.length).toBeGreaterThan(1)
    for (const offer of offers) expect(isGoldFill(offer)).toBe(false)
  })

  // Opened from Workflow or the Agents tab, the bench of one of My agents is as wide as the page, as
  // it is in My agents: a width held on it, or on anything between it and the page, left the right
  // half of a wide window empty.
  it('gives the bench of an agent placed from My agents the page’s whole width, in Build and in Chat', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (String(url).endsWith('/api/jobs')
      ? Promise.resolve(new Response(JSON.stringify({ jobs: [reader], problems: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : Promise.reject(new Error('no daemon')))))
    renderTeamAgents({ agents: [{ ...scoper, from: { agent: 'reader' } }], selected: 'scope', savedJobs: [reader] })
    await screen.findByRole('textbox', { name: /Instructions/ })
    const page = document.querySelector('.team-agents')!
    /** Each width the stylesheets hold `from`, or anything above it below the page, to. */
    const held = (from: Element) => {
      const found: string[] = []
      for (let at: Element | null = from; at && at !== page; at = at.parentElement) {
        for (const property of ['width', 'max-width']) {
          const value = cascaded(at, property)
          if (value && /\d(px|ch|em|rem)\b/.test(value)) found.push(`.${[...at.classList].join('.')} { ${property}: ${value} }`)
        }
      }
      return found
    }
    expect(held(document.querySelector('.byhand-main')!)).toEqual([])
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Agent view' })).getByRole('button', { name: 'Chat' }))
    expect(held(await waitFor(() => document.querySelector('.byhand-chat')!))).toEqual([])
  })

  it('lists what an agent from My agents reads in every team apart from what this team gives it', async () => {
    const reading = { ...reader, reads: [{ name: 'Style guide', path: '/Users/me/style' }] }
    vi.stubGlobal('fetch', vi.fn((url: string) => (String(url).endsWith('/api/jobs')
      ? Promise.resolve(new Response(JSON.stringify({ jobs: [reading], problems: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : Promise.reject(new Error('no daemon')))))
    // The team copied its read when it placed it, and gives it a Notion page besides.
    const placed: AgentConfig = { ...scoper, from: { agent: 'reader', version: 1 }, capabilities: [{ kind: 'knowledge', name: 'Style guide', path: '/Users/me/style' }, { kind: 'knowledge', name: 'EKIS hub', notion: { page: 'abc123' } }] }
    renderTeamAgents({ agents: [placed], selected: 'scope', savedJobs: [reading] })
    const block = await screen.findByRole('region', { name: 'What it reads' })
    expect(block).toHaveTextContent('Reads 1 folder in every team it joins, and 1 Notion page this team gives it')
    const held = within(block).getByRole('list', { name: 'Folders, files and pages it reads' })
    expect(within(held).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Style guideFolder · /Users/me/style',
      'EKIS hubNotion page · read when each run startsThis team gives it',
    ])
    // Its own can be taken away here, as its next version; what the team gives it can't.
    expect(within(held).getByRole('button', { name: 'Stop reading Style guide' })).toBeInTheDocument()
    expect(within(held).queryByRole('button', { name: 'Stop reading EKIS hub' })).toBeNull()
    expect(within(block).getByRole('group', { name: 'Give it something to read' })).toBeInTheDocument()
  })
})
