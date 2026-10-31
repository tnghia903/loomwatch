import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cascaded } from '../../test/cascade'
import { RemoveAgentDialog } from './RemoveAgentDialog'

let running: string[] = []
beforeEach(() => {
  running = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/runs')) return new Response(JSON.stringify(running.map((teamPath, at) => ({ runId: `r${at}`, sessionId: 's', teamPath, prompt: 'p', status: 'running', mode: 'pipeline', entrypoint: 'a', responder: 'a', agentIds: [], createdAt: '2026-10-30T09:00:00Z', startedAt: null, finishedAt: null, error: null, exitCode: null, eventCount: null, reply: null }))), { status: 200 })
    if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', jobs: [{ id: 'editor', file: '.jobs/editor.yaml', name: 'Editor', instructions: 'Edit.' }], problems: [] }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const editor = { id: 'editor', name: 'Editor', agent: 'editor' }
const dialog = (uses: Parameters<typeof RemoveAgentDialog>[0]['uses']) => render(<RemoveAgentDialog agent={{ id: 'writer', name: 'Writer' }} uses={uses} onRemoved={vi.fn()} onClose={vi.fn()} />)

// ADR 0100: the confirmation says what happens in each team, in plain words, before anything does.
describe('Removing one of My agents', () => {
  it('names the teams it leaves, and says who starts each, once for every team alike', () => {
    dialog([
      { teamPath: 'blog.yaml', teamName: 'Blog', agentId: 'writer', takeOff: { startsInstead: editor } },
      { teamPath: 'notes.yaml', teamName: 'Notes', agentId: 'writer', takeOff: { startsInstead: editor } },
    ])
    const said = screen.getByRole('alertdialog')
    expect(said).toHaveTextContent('It leaves the teams Blog and Notes too.')
    expect(said).toHaveTextContent('Both start with Editor now.')
  })

  it('says "each" for three teams, and names the teams when only some change', () => {
    dialog([
      { teamPath: 'a.yaml', teamName: 'A', agentId: 'writer', takeOff: { startsInstead: editor } },
      { teamPath: 'b.yaml', teamName: 'B', agentId: 'writer', takeOff: { startsInstead: editor } },
      { teamPath: 'c.yaml', teamName: 'C', agentId: 'writer', takeOff: { startsInstead: editor } },
    ])
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Each starts with Editor now.')
    cleanup()
    dialog([
      { teamPath: 'a.yaml', teamName: 'A', agentId: 'writer', takeOff: { startsInstead: editor } },
      { teamPath: 'b.yaml', teamName: 'B', agentId: 'writer', takeOff: { startsInstead: editor } },
      { teamPath: 'c.yaml', teamName: 'C', agentId: 'writer' },
    ])
    expect(screen.getByRole('alertdialog')).toHaveTextContent('A and B start with Editor now.')
  })

  it('says a team left with no agent goes too, and that LoomWatch keeps a copy of both', () => {
    dialog([{ teamPath: 'solo.yaml', teamName: 'Solo', agentId: 'writer', takeOff: { empty: true } }])
    const said = screen.getByRole('alertdialog')
    expect(said).toHaveTextContent('Solo has no other agent, so that team is deleted too.')
    expect(said).toHaveTextContent('LoomWatch keeps a copy of it, and of the teams it deletes, in your teams folder.')
  })

  it('waits while a team it would delete is working, saying so as a wait, not a fault', async () => {
    running = ['solo.yaml']
    dialog([{ teamPath: 'solo.yaml', teamName: 'Solo', agentId: 'writer', takeOff: { empty: true } }])
    const wait = await screen.findByRole('alert')
    expect(wait).toHaveTextContent('Solo is working right now. Wait for it to finish, then remove Writer.')
    expect(cascaded(wait, 'color')).toBe('var(--color-ink-2)')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled())
  })
})
