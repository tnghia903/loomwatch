import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SavedJob } from '../../lib/library/jobs'
import type { RunRecord } from '../../lib/runs/client'
import { AgentChip } from './AgentChip'
import type { LeaveGuard } from './leave'

const coby: SavedJob = { id: 'coby', file: '.jobs/coby.yaml', name: 'Coby', does: 'Colin’s Secretary', instructions: 'Answer questions.', model: 'fake/offline' }
const maya: SavedJob = { id: 'maya', file: '.jobs/maya.yaml', name: 'Maya', does: 'Writes the weekly report', instructions: 'Write the report.', model: 'fake/offline' }

// Maya is at work in her own chat: her line says so instead of what she does.
const runs = { records: [{ runId: 'r1', teamPath: '.jobs/.bench/maya.yaml', status: 'running' } as unknown as RunRecord] }
vi.mock('../../lib/story/useNeedsYou', () => ({ useRunRecords: () => runs }))

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input) === '/api/jobs'
    ? new Response(JSON.stringify({ folder: '.jobs', jobs: [coby, maya], problems: [] }), { status: 200 })
    : new Response('{}', { status: 404 }))))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Chip({ leave = null, saveError = null, go = vi.fn() }: { leave?: LeaveGuard | null; saveError?: string | null; go?: (href: string) => void }) {
  return <AgentChip name="Coby" state={leave ? 'dirty' : 'clean'} detail={leave ? 'Unsaved changes' : 'Saved'} onRemove={() => {}} switcher={{ open: 'coby', view: 'chat', leave, saveError, go }} />
}

async function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /open agent menu/ }))
  return within(await screen.findByRole('navigation', { name: 'My agents' }))
}

describe('an agent’s name menu, like a team’s', () => {
  it('lists My agents, this one marked, and opens another on the tab on screen', async () => {
    const go = vi.fn()
    render(<Chip go={go} />)
    const list = await openMenu()
    const lines = await list.findAllByRole('link')
    expect(lines.map((line) => line.textContent)).toEqual(['CobyColin’s Secretary', 'MayaWorking'])
    expect(lines[0]).toHaveAttribute('aria-current', 'page')
    expect(lines[1]).toHaveAttribute('href', '/agents/maya?view=chat')
    fireEvent.click(lines[1])
    expect(go).toHaveBeenCalledWith('/agents/maya?view=chat')
    // What is done to the agent itself stays in the menu.
    expect(screen.queryByRole('navigation', { name: 'My agents' })).toBeNull()
  })

  it('asks first about changes not saved: keeps them, drops them, or stays', async () => {
    const go = vi.fn()
    const save = vi.fn(async () => false)
    render(<Chip go={go} leave={{ name: 'Coby', save, problem: null }} saveError="You already have an agent called “Maya”. Give this one another name." />)
    let list = await openMenu()
    fireEvent.click(await list.findByRole('link', { name: /Maya/ }))
    const asks = screen.getByRole('alertdialog', { name: 'Save changes to Coby?' })
    expect(go).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Remove from My agents/ })).toBeNull()

    // A save that fails says why, as the team's menu does, and stays.
    fireEvent.click(within(asks).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('alertdialog', { name: 'Couldn’t save: You already have an agent called “Maya”. Give this one another name.' })).toBeInTheDocument())
    expect(go).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('button', { name: /Remove from My agents/ })).toBeInTheDocument()

    save.mockResolvedValue(true)
    list = within(screen.getByRole('navigation', { name: 'My agents' }))
    fireEvent.click(list.getByRole('link', { name: /Maya/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(go).toHaveBeenCalledWith('/agents/maya?view=chat'))
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('goes without saving when asked to, and says why it can’t save when it can’t', async () => {
    const go = vi.fn()
    const save = vi.fn(async () => true)
    render(<Chip go={go} leave={{ name: 'Coby', save, problem: 'Write its instructions.' }} />)
    const list = await openMenu()
    fireEvent.click(await list.findByRole('link', { name: /Maya/ }))
    const asks = screen.getByRole('alertdialog', { name: 'Coby can’t be saved yet. Write its instructions.' })
    expect(within(asks).queryByRole('button', { name: 'Save' })).toBeNull()
    fireEvent.click(within(asks).getByRole('button', { name: 'Don’t save' }))
    expect(go).toHaveBeenCalledWith('/agents/maya?view=chat')
    expect(save).not.toHaveBeenCalled()
  })
})
