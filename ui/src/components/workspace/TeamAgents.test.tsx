import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DetectedHarness } from '../../lib/harnesses'
import type { SavedJob } from '../../lib/library/jobs'
import { TeamAgents, type TeamAgentsProps } from './TeamAgents'

const claude: DetectedHarness = { id: 'claude', name: 'Claude Code', command: 'claude-agent-acp', executablePath: '/bin/claude-agent-acp', acpAvailable: true, spawn: { cmd: 'claude-agent-acp', args: [] } }
const reader: SavedJob = { id: 'reader', file: '.jobs/reader.yaml', name: 'Reader', does: 'Checks each story', instructions: 'Check every story.', apps: ['claude'], figure: { kind: 'button', color: 'sage' } }
const elsewhere: SavedJob = { id: 'codex-only', file: '.jobs/codex-only.yaml', name: 'Coder', instructions: 'Write code.', apps: ['codex'] }

afterEach(cleanup)

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
})
