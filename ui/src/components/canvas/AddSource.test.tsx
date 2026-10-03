import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AddSource } from './AddSource'

const client = vi.hoisted(() => ({ listFolder: vi.fn(), addTeamFile: vi.fn() }))
vi.mock('../../lib/knowledge/client', () => client)

const home = {
  path: '/Users/me', name: 'me', parent: '/Users', files: [], moreFiles: 0,
  folders: [{ name: 'Reports', path: '/Users/me/Reports' }],
  places: [{ name: 'Home', path: '/Users/me' }],
}

beforeEach(() => {
  client.listFolder.mockResolvedValue(home)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ADR 0042: the add panel makes a card no agent reads yet; connecting it is a separate choice.
describe('AddSource', () => {
  it('hands back a linked folder by its full path, connected to nobody', async () => {
    const onAdd = vi.fn()
    render(<AddSource teamPath="desk.yaml" onAdd={onAdd} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add “me”' }))
    expect(onAdd).toHaveBeenCalledWith([{ name: 'me', path: '/Users/me', source: 'Linked folder' }])
  })

  it('copies every chosen file beside the team and hands them back in one change', async () => {
    client.addTeamFile
      .mockResolvedValueOnce({ name: 'memo.pdf', path: 'desk.files/memo.pdf', bytes: 10, chars: 900, excerpted: false })
      .mockRejectedValueOnce(new Error('too large'))
    const onAdd = vi.fn()
    render(<AddSource teamPath="desk.yaml" onAdd={onAdd} />)
    fireEvent.change(screen.getByLabelText('Files to add to the team'), { target: { files: [new File(['a'], 'memo.pdf'), new File(['b'], 'huge.mov')] } })
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith([{ name: 'memo.pdf', path: 'desk.files/memo.pdf', source: 'Added file' }]))
    expect(await screen.findByRole('alert')).toHaveTextContent('huge.mov was not added: too large')
  })

  it('waits for a saved team before it takes a file', () => {
    render(<AddSource teamPath={null} onAdd={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Add file…' })).toBeDisabled()
    expect(screen.getByText(/Save the team to add a file/)).toBeInTheDocument()
  })
})
