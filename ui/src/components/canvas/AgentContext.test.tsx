import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentConfig } from '../../lib/team-file/types'
import { chosenKnowledge } from '../../lib/knowledge/chosen'
import { AgentContext } from './AgentContext'

const client = vi.hoisted(() => ({ listFolder: vi.fn(), addTeamFile: vi.fn() }))
vi.mock('../../lib/knowledge/client', () => client)

const agent: AgentConfig = { id: 'check', name: 'Fact-checker', role: 'Verify.', model: 'm', spawn: { cmd: 'claude-agent-acp', args: [], env: {}, cwd: '.' } }

const home = {
  path: '/Users/me', name: 'me', parent: '/Users', files: ['notes.txt'], moreFiles: 0,
  folders: [{ name: 'Documents', path: '/Users/me/Documents' }],
  places: [{ name: 'Home', path: '/Users/me' }, { name: 'Documents', path: '/Users/me/Documents' }],
}
const documents = { ...home, path: '/Users/me/Documents', name: 'Documents', parent: '/Users/me', folders: [{ name: 'Reports', path: '/Users/me/Documents/Reports' }], files: [] }

beforeEach(() => {
  client.listFolder.mockImplementation(async (path?: string) => (path === '/Users/me/Documents' ? documents : home))
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AgentContext — Add folder', () => {
  it('walks folders from home and links the chosen one by its full path', async () => {
    const onAddKnowledge = vi.fn()
    render(<AgentContext agent={agent} teamPath="desk.yaml" onAddKnowledge={onAddKnowledge} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))

    const dialog = await screen.findByRole('dialog', { name: 'Add a folder' })
    expect(dialog).toHaveTextContent('notes.txt')
    fireEvent.click(within(await screen.findByRole('list', { name: 'In me' })).getByRole('button', { name: 'Documents' }))
    await screen.findByRole('button', { name: 'Reports' })
    fireEvent.click(screen.getByRole('button', { name: 'Add “Documents”' }))

    expect(onAddKnowledge).toHaveBeenCalledWith([{ kind: 'knowledge', name: 'Documents', path: '/Users/me/Documents' }])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does not link the same folder twice', async () => {
    const onAddKnowledge = vi.fn()
    const linked = { ...agent, capabilities: [{ kind: 'knowledge' as const, name: 'me', path: '/Users/me' }] }
    render(<AgentContext agent={linked} teamPath="desk.yaml" onAddKnowledge={onAddKnowledge} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add “me”' }))
    expect(onAddKnowledge).not.toHaveBeenCalled()
  })
})

describe('AgentContext — Add file', () => {
  const choose = (files: File[]) => fireEvent.change(screen.getByLabelText('Files to add'), { target: { files } })

  it('adds every chosen file in one change, with a label of its own, and passes on what the daemon said', async () => {
    client.addTeamFile
      .mockResolvedValueOnce({ name: 'memo.pdf', path: 'desk.files/memo.pdf', bytes: 10, chars: 900, excerpted: false, note: 'Install pdftotext.' })
      .mockResolvedValueOnce({ name: 'notes.md', path: 'desk.files/notes.md', bytes: 4, chars: 4, excerpted: false })
    const onAddKnowledge = vi.fn()
    const withNotes = { ...agent, capabilities: [{ kind: 'knowledge' as const, name: 'notes.md', path: 'old/notes.md' }] }
    render(<AgentContext agent={withNotes} teamPath="desk.yaml" onAddKnowledge={onAddKnowledge} />)

    choose([new File(['%PDF-'], 'memo.pdf'), new File(['x'], 'notes.md')])

    await waitFor(() => expect(onAddKnowledge).toHaveBeenCalledOnce())
    expect(client.addTeamFile).toHaveBeenNthCalledWith(1, 'desk.yaml', expect.any(File))
    expect(onAddKnowledge).toHaveBeenCalledWith([
      { kind: 'knowledge', name: 'memo.pdf', path: 'desk.files/memo.pdf' },
      { kind: 'knowledge', name: 'notes.md (2)', path: 'desk.files/notes.md' },
    ])
    expect(screen.getByText('memo.pdf: Install pdftotext.')).toBeInTheDocument()
  })

  it('says which file failed and still adds the rest', async () => {
    client.addTeamFile
      .mockRejectedValueOnce(new Error('too big'))
      .mockResolvedValueOnce({ name: 'ok.txt', path: 'desk.files/ok.txt', bytes: 1, chars: 1, excerpted: false })
    const onAddKnowledge = vi.fn()
    render(<AgentContext agent={agent} teamPath="desk.yaml" onAddKnowledge={onAddKnowledge} />)
    choose([new File(['x'], 'huge.mov'), new File(['x'], 'ok.txt')])
    expect(await screen.findByRole('alert')).toHaveTextContent('huge.mov was not added: too big')
    expect(onAddKnowledge).toHaveBeenCalledWith([{ kind: 'knowledge', name: 'ok.txt', path: 'desk.files/ok.txt' }])
  })

  it('waits for a saved team, because the file is copied next to the team file', () => {
    render(<AgentContext agent={agent} teamPath={null} onAddKnowledge={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Add file…' })).toBeDisabled()
    expect(screen.getByText(/Save the team to add a file/)).toBeInTheDocument()
  })

  it('offers neither action read-only', () => {
    render(<AgentContext agent={agent} teamPath="desk.yaml" readOnly onAddKnowledge={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Add folder…' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add file…' })).not.toBeInTheDocument()
  })
})

describe('chosenKnowledge', () => {
  it('tells an added file from a linked folder', () => {
    expect(chosenKnowledge({ kind: 'knowledge', name: 'memo', path: 'desk.files/memo.pdf' })?.label).toMatch(/^Added file/)
    expect(chosenKnowledge({ kind: 'knowledge', name: 'Reports', path: '/Users/me/Reports' })?.label).toMatch(/^Linked folder/)
    expect(chosenKnowledge({ kind: 'knowledge', name: 'q3', path: '/Users/me/q3.csv' })?.label).toMatch(/^Added file/)
    expect(chosenKnowledge({ kind: 'knowledge', name: 'loomwatch project' })).toBeNull()
  })
})
