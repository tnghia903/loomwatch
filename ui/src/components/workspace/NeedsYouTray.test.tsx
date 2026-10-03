import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NeedsYouTray } from './NeedsYouTray'
import type { Ticket } from '../../lib/story/needsYou'

afterEach(cleanup)

const ticket: Ticket = {
  id: 'r1:permission:p1', kind: 'permission', runId: 'r1', teamPath: 'research.yaml', teamName: 'Research team', node: 'researcher', sendBackTo: null,
  asker: 'Researcher', text: 'Researcher wants to use the web', context: 'Web search · model cards 2019', since: new Date().toISOString(), requestId: 'p1',
}

describe('a permission ticket in the tray (ADR 0040)', () => {
  it('reads as a paused agent and answers Allow, Allow for this run or Deny from the buttons and keys', async () => {
    const onPermission = vi.fn(() => Promise.resolve())
    render(<NeedsYouTray tickets={[ticket]} working={0} onAnswer={vi.fn()} onPermission={onPermission} onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /1 needs you/ }))
    expect(screen.getByText('Permission')).toBeInTheDocument()
    expect(screen.getByText('Researcher wants to use the web. It is paused until you answer.')).toBeInTheDocument()
    expect(screen.getByText('Web search · model cards 2019')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Answer/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Allow\s*A$/ }))
    expect(onPermission).toHaveBeenLastCalledWith(ticket, 'allow_once')
    expect(await screen.findByText('Researcher: Allowed once.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this run' }))
    expect(onPermission).toHaveBeenLastCalledWith(ticket, 'allow_run')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'd' })
    expect(onPermission).toHaveBeenLastCalledWith(ticket, 'deny')
  })
})
