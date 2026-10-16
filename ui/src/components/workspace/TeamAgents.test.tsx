import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DetectedHarness } from '../../lib/harnesses'
import type { SavedJob } from '../../lib/library/jobs'
import type { AgentConfig } from '../../lib/team-file/types'
import { TeamAgents, type TeamAgentsProps } from './TeamAgents'

const claude: DetectedHarness = { id: 'claude', name: 'Claude Code', command: 'claude-agent-acp', executablePath: '/bin/claude-agent-acp', acpAvailable: true, spawn: { cmd: 'claude-agent-acp', args: [] } }
const reader: SavedJob = { id: 'reader', file: '.jobs/reader.yaml', name: 'Reader', does: 'Checks each story', instructions: 'Check every story.', apps: ['claude'], figure: { kind: 'button', color: 'sage' } }
const elsewhere: SavedJob = { id: 'codex-only', file: '.jobs/codex-only.yaml', name: 'Coder', instructions: 'Write code.', apps: ['codex'] }

const scoper: AgentConfig = {
  id: 'scope', name: 'Project scope', role: 'Establish the project scope.', model: '',
  spawn: { cmd: 'claude-agent-acp', args: [], env: {}, cwd: '.' },
  capabilities: [
    { kind: 'skill', name: 'algorithmic-art' },
    { kind: 'knowledge', name: 'sutd-final-project', path: '/Users/me/Developer/sutd-final-project' },
    { kind: 'knowledge', name: 'brief.md', path: 'scope.files/brief.md' },
    { kind: 'knowledge', name: 'EKIS hub', notion: { page: 'abc123' } },
    { kind: 'tool', name: 'github' },
    { kind: 'tool', name: 'notion' },
  ],
}

// The agent's own models are asked of the daemon; there is none here.
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no daemon')))) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderTeamAgents(extra: Partial<TeamAgentsProps> = {}) {
  const props: TeamAgentsProps = {
    agents: [], selected: null, onSelect: vi.fn(), teamName: 'Digest', teamPath: 'digest.yaml', editable: true,
    harnesses: [claude], harnessesLoading: false, skills: [], skillsLoading: false, savedJobs: [reader, elsewhere],
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
    // One whose own app isn't here still runs, on the best app there is.
    expect(within(within(add).getByText('Coder').closest('li')!).getByRole('button', { name: 'Add' })).toBeEnabled()
    // A new one is built in Your agents, which leads back to this team.
    expect(within(add).getByRole('link', { name: 'Build a new agent' })).toHaveAttribute('href', '/agents/new?team=digest.yaml')
    fireEvent.click(within(add).getByRole('button', { name: 'Or start in Workflow' }))
    expect(props.onShowWorkflow).toHaveBeenCalled()
  })

  it('can’t add an agent when no AI app on this computer can run it', () => {
    renderTeamAgents({ harnesses: [] })
    const row = within(screen.getByRole('region', { name: 'Add an agent to this team' })).getByText('Reader').closest('li')!
    expect(within(row).getByRole('button', { name: 'Add' })).toBeDisabled()
    expect(row).toHaveTextContent('No AI app on this computer can run it')
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
    expect(screen.getByText(/has 1 recipe card, reads 1 folder, 1 file and 1 Notion page, and uses 2 tools\./)).toBeInTheDocument()
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

  it('shows the tools the team gives an agent on its workbench, and sends changes to Workflow', () => {
    const props = renderTeamAgents({ agents: [scoper], selected: 'scope' })
    const block = screen.getByRole('region', { name: 'Tools it can use' })
    expect(block).toHaveTextContent('Can use 2 tools the team gives it, while it works')
    const rack = within(block).getByRole('list', { name: 'In its tool drawer' })
    expect(within(rack).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'githubTool · an MCP server it can use while it works',
      'notionTool · an MCP server it can use while it works',
    ])
    fireEvent.click(within(block).getByRole('button', { name: 'Change it in Workflow' }))
    expect(props.onShowWorkflow).toHaveBeenCalled()
  })

  it('says when the team gives it no tools yet', () => {
    renderTeamAgents({ agents: [{ ...scoper, capabilities: [{ kind: 'skill', name: 'algorithmic-art' }] }], selected: 'scope' })
    const block = screen.getByRole('region', { name: 'Tools it can use' })
    expect(block).toHaveTextContent('The team gives it no tools yet')
    expect(within(block).queryByRole('list')).toBeNull()
    expect(within(block).getByRole('button', { name: 'Give it a tool in Workflow' })).toBeInTheDocument()
    expect(screen.getByText(/and uses no tools yet\./)).toBeInTheDocument()
  })

  it('shows the team’s tools on the bench of an agent placed from Your agents too', async () => {
    // Its bench loads the agent from Your agents; nothing else is asked of the daemon here.
    vi.stubGlobal('fetch', vi.fn((url: string) => (String(url).endsWith('/api/jobs')
      ? Promise.resolve(new Response(JSON.stringify({ jobs: [reader], problems: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : Promise.reject(new Error('no daemon')))))
    renderTeamAgents({ agents: [{ ...scoper, from: { agent: 'reader', version: 1 } }], selected: 'scope', savedJobs: [reader] })
    const block = await screen.findByRole('region', { name: 'Tools it can use' })
    expect(within(block).getAllByRole('listitem').map((item) => item.querySelector('b')?.textContent)).toEqual(['github', 'notion'])
    expect(screen.getByRole('region', { name: 'What it reads' })).toHaveTextContent('Reads 1 folder, 1 file and 1 Notion page the team gives it')
  })
})
