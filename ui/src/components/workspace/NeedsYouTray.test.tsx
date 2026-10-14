import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

// ADR 0043: the run on screen asks with its own answer box and permission card, so its ticket in
// the tray says where to answer instead of offering the same buttons again; it still counts.
describe('a ticket for the run on screen', () => {
  it('points at the screen and offers none of the run’s own buttons or keys', () => {
    const onPermission = vi.fn(() => Promise.resolve())
    const other = { ...ticket, id: 'r2:permission:p2', runId: 'r2', teamName: 'Other team' }
    render(<NeedsYouTray tickets={[ticket, other]} working={0} onAnswer={vi.fn()} onPermission={onPermission} onDismiss={vi.fn()} onScreenRunId="r1" />)
    fireEvent.click(screen.getByRole('button', { name: /2 need you/ }))
    expect(screen.getByText('On this screen: answer it below.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Allow\s*A$/ })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /^Open run/ })).toHaveLength(1)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'a' })
    expect(onPermission).not.toHaveBeenCalled()
  })
})

// A bare class that turns the pointer off (the canvas's `.ghost` drop placeholder) silently kills
// any button reusing the name: the tray's Open run and Dismiss once wore it, and could not be clicked.
// Read from disk: vitest hands a `?raw` stylesheet import back empty.
const styles = resolve(process.cwd(), 'src/styles')
const sheets = readdirSync(styles).filter((name) => name.endsWith('.css')).map((name) => readFileSync(resolve(styles, name), 'utf8'))
const pointerless = new Set(sheets.flatMap((css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, , body]) => /pointer-events:\s*none/.test(body))
  .flatMap(([, selectors]) => selectors.split(',').map((one) => one.trim()).filter((one) => /^\.[\w-]+$/.test(one)).map((one) => one.slice(1)))))

describe('a stopped run’s ticket', () => {
  it('opens its run and dismisses from buttons the pointer can reach', () => {
    const onDismiss = vi.fn()
    const stopped: Ticket = { ...ticket, id: 'r9:failed', kind: 'failed', runId: 'r9', text: 'approach-research stopped.', context: null, requestId: undefined }
    render(<NeedsYouTray tickets={[stopped]} working={0} onAnswer={vi.fn()} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /1 needs you/ }))
    expect(pointerless.size).toBeGreaterThan(0)
    for (const button of screen.getByRole('dialog').querySelectorAll('button')) {
      expect([...button.classList].filter((name) => pointerless.has(name)), button.textContent ?? '').toEqual([])
    }
    expect(screen.getByRole('button', { name: /^Open run/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledWith('r9')
  })
})
