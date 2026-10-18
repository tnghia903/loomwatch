import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import type { SavedJob } from '../../lib/library/jobs'
import type { AgentConfig } from '../../lib/team-file/types'
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
    agents: [], selected: null, onSelect: vi.fn(), teamName: 'Digest', teamPath: 'digest.yaml', editable: true,
    skills: [], skillsLoading: false, savedJobs: [reader, elsewhere],
    onEdit: vi.fn(), onApplyVersion: vi.fn(), onUnlink: vi.fn(), onShowWorkflow: vi.fn(), onAdd: vi.fn(), ...extra,
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

  it('shows what the team gives an agent to read on its workbench, and sends changes to Workflow', () => {
    const props = renderTeamAgents({ agents: [scoper], selected: 'scope' })
    const block = screen.getByRole('region', { name: 'What it reads' })
    expect(block).toHaveTextContent('Reads 1 folder, 1 file and 1 Notion page the team gives it')
    const held = within(block).getByRole('list', { name: 'In its file drawer' })
    expect(within(held).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'sutd-final-projectFolder · /Users/me/Developer/sutd-final-project',
      'brief.mdFile · scope.files/brief.md',
      'EKIS hubNotion page · read when each run starts',
    ])
    expect(screen.getByText(/has 1 recipe card, and reads 1 folder, 1 file and 1 Notion page\./)).toBeInTheDocument()
    // A team's own agent is given what it reads in Workflow only: nothing is added or taken here.
    expect(within(block).queryByRole('group', { name: 'Give it something to read' })).toBeNull()
    expect(within(block).queryByRole('button', { name: /^Stop reading/ })).toBeNull()
    fireEvent.click(within(block).getByRole('button', { name: 'Change it in Workflow' }))
    expect(props.onShowWorkflow).toHaveBeenCalled()
  })

  it('says when the team gives it nothing to read yet', () => {
    renderTeamAgents({ agents: [{ ...scoper, capabilities: [{ kind: 'skill', name: 'algorithmic-art' }] }], selected: 'scope' })
    const block = screen.getByRole('region', { name: 'What it reads' })
    expect(block).toHaveTextContent('The team gives it nothing to read yet')
    expect(within(block).queryByRole('list')).toBeNull()
    expect(within(block).getByRole('button', { name: 'Give it something in Workflow' })).toBeInTheDocument()
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
    expect(block).toHaveTextContent('Files, the web and commands, as its keys allow')
    expect(within(block).queryByRole('list', { name: 'Tools you gave it' })).toBeNull()
  })

  it('says on the bench which tools don’t fit in the tool drawer', async () => {
    const many = (count: number): AgentConfig => ({ ...scoper, capabilities: ['github', 'notion', 'linear', 'memory', 'browser', 'sentry'].slice(0, count).map((name) => ({ kind: 'tool' as const, name })) })
    renderTeamAgents({ agents: [many(6)], selected: 'scope' })
    expect(await screen.findByRole('button', { name: 'The tool drawer: Files, the web and commands; 6 tools aren’t connected (2 not in the drawer)' })).toHaveTextContent('Tools · 6 (2 not in the drawer)')
    cleanup()
    // Four fit: every one is in the drawer, and nothing is said.
    renderTeamAgents({ agents: [many(4)], selected: 'scope' })
    expect(await screen.findByRole('button', { name: 'The tool drawer: Files, the web and commands; 4 tools aren’t connected' })).toHaveTextContent(/^Tools · 4$/)
  })

  it('says on the bench, and in its block, what doesn’t fit in the file drawer', async () => {
    const folders = ['notes', 'drafts', 'sources', 'archive', 'inbox'].map((name) => ({ kind: 'knowledge' as const, name, path: `/Users/me/${name}` }))
    renderTeamAgents({ agents: [{ ...scoper, capabilities: folders }], selected: 'scope' })
    expect(await screen.findByRole('button', { name: 'The file drawer: Reads 5 folders the team gives it (1 not in the drawer)' })).toHaveTextContent('Reads · 5 (1 not in the drawer)')
    expect(screen.getByRole('region', { name: 'What it reads' })).toHaveTextContent('The drawer has room for 4, so inbox isn’t in it. It still reads it.')
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
    const held = within(block).getByRole('list', { name: 'In its file drawer' })
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
