import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Lesson } from '../../lib/lessons/client'
import { LearnedBlock } from './LearnedBlock'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const lesson = (id: string, text: string, over: Partial<Lesson> = {}): Lesson => ({
  id, scope: 'agent:writer', agentId: 'writer', text, source: 'you', aboutYou: false, feedback: 'Too long.', runId: 'run-1', state: 'active',
  given: 3, backed: 2, missed: 0, createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-20T08:00:00.000Z', ...over,
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Where the keyboard was the moment the line under the list came or went. React runs a plain effect
// a task after its change, so focus moved from one would leave a moment with nothing focused.
const focusAtLine = () => {
  const seen: Array<{ line: boolean; focus: Element | null }> = []
  const watch = new MutationObserver(() => seen.push({ line: document.querySelector('[role="status"]') !== null, focus: document.activeElement }))
  watch.observe(document.body, { childList: true, subtree: true })
  return { when: (line: boolean) => seen.find((one) => one.line === line)?.focus, stop: () => watch.disconnect() }
}

describe('LearnedBlock', () => {
  it('lists what one of My agents learned, with where it came from, and forgets one', async () => {
    const calls: Array<{ url: string; body?: unknown }> = []
    const kept = [lesson('a', 'When writing the digest, use three bullets.'), lesson('b', 'When citing, link beside the claim.', { source: 'check', backed: 0, missed: 1 })]
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.startsWith('/api/lessons?')) return json({ scope: 'agent:writer', learns: true, max: 12, lessons: kept })
      return json({ undone: kept[0], lessons: [kept[1]] })
    }))
    render(<LearnedBlock of={{ savedAgent: 'writer' }} name="Writer" />)
    await screen.findByText('When writing the digest, use three bullets.')
    expect(calls[0].url).toBe('/api/lessons?savedAgent=writer')
    expect(screen.getByText(/In its instructions from its next work on\. 2 of 12\./)).toBeTruthy()
    expect(screen.getByText(/From what you said · .* · liked 2×/)).toBeTruthy()
    expect(screen.getByText(/From the check · .* · missed 1×/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Forget: When writing the digest, use three bullets.' }))
    await waitFor(() => expect(screen.queryByText('When writing the digest, use three bullets.')).toBeNull())
    expect(calls[1]).toEqual({ url: '/api/lessons/undo', body: { savedAgent: 'writer', id: 'a' } })
    expect(screen.getByText(/1 of 12/)).toBeTruthy()
  })

  it('says what learning is for before there is anything, and when it is off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ scope: 'team:desk#writer', learns: true, max: 12, lessons: [] })))
    const { unmount } = render(<LearnedBlock of={{ teamPath: 'desk.yaml', agent: 'writer' }} name="Writer" />)
    expect(await screen.findByText('Nothing yet. Tell Writer what to change about an answer, and it learns from it.')).toBeTruthy()
    unmount()
    vi.stubGlobal('fetch', vi.fn(async () => json({ scope: 'team:desk#quiet', learns: false, max: 12, lessons: [] })))
    render(<LearnedBlock of={{ teamPath: 'desk.yaml', agent: 'quiet' }} name="Quiet" />)
    expect(await screen.findByText(/Learning is off for this agent/)).toBeTruthy()
  })

  it('offers no Forget, and no Tell all my agents, where nothing can be changed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ scope: 'agent:writer', learns: true, max: 12, lessons: [lesson('a', 'Use bullets.'), lesson('b', 'Always write in Vietnamese.', { aboutYou: true })] })))
    render(<LearnedBlock of={{ savedAgent: 'writer' }} name="Writer" readOnly />)
    await screen.findByText('Use bullets.')
    expect(screen.queryByRole('button', { name: /Forget/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Tell all my agents/ })).toBeNull()
  })

  it('moves a lesson about you to About you once you say yes, and Undo moves it back', async () => {
    const vietnamese = 'When replying to this person, always write in Vietnamese.'
    const calls: Array<{ url: string; body?: unknown; asPage: boolean }> = []
    const bullets = lesson('a', 'When writing the digest, use three bullets.')
    const about = lesson('b', vietnamese, { aboutYou: true })
    const you = { name: 'Mai', about: `I teach English.\n${vietnamese}`, skipped: false }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, asPage: headers.get('X-LoomWatch-Request') === '1' })
      if (url.startsWith('/api/lessons?')) return json({ scope: 'agent:writer', learns: true, max: 12, lessons: [bullets, about] })
      if (url === '/api/lessons/tell-all') return json({ lesson: { ...about, state: 'dropped', droppedBy: 'about_you' }, lessons: [bullets], you, added: true })
      return json({ lesson: about, lessons: [bullets, about], you: { ...you, about: 'I teach English.' }, removed: true })
    }))
    render(<LearnedBlock of={{ savedAgent: 'writer' }} name="Writer" />)
    await screen.findByText(vietnamese)
    expect(screen.getAllByRole('button', { name: /^Tell all my agents/ }).map((button) => button.getAttribute('aria-label'))).toEqual([`Tell all my agents: ${vietnamese}`])
    const tell = screen.getByRole('button', { name: `Tell all my agents: ${vietnamese}` })
    fireEvent.click(tell)
    expect(screen.getByRole('group', { name: 'Tell all my agents' }).textContent).toContain('Add to About you, so every agent does this?')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(tell)
    expect(calls).toHaveLength(1)
    fireEvent.click(tell)
    const added = focusAtLine()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(`All your agents know: ${vietnamese}`))
    added.stop()
    expect(calls[1]).toEqual({ url: '/api/lessons/tell-all', body: { savedAgent: 'writer', id: 'b' }, asPage: true })
    expect(screen.queryByRole('group', { name: 'Tell all my agents' })).toBeNull()
    expect(screen.getByText(/1 of 12/)).toBeTruthy()
    const undo = within(screen.getByRole('status')).getByRole('button', { name: `Undo: ${vietnamese}` })
    expect(added.when(true)).toBe(undo)
    expect(document.activeElement).toBe(undo)
    const undone = focusAtLine()
    fireEvent.click(undo)
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    undone.stop()
    expect(undone.when(false)).toBe(screen.getByRole('button', { name: `Tell all my agents: ${vietnamese}` }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `Tell all my agents: ${vietnamese}` }))
    expect(calls[2]).toEqual({ url: '/api/lessons/tell-all/undo', body: { savedAgent: 'writer', id: 'b' }, asPage: true })
    expect(screen.getByText(vietnamese)).toBeTruthy()
    expect(screen.getByText(/2 of 12/)).toBeTruthy()
  })
})
