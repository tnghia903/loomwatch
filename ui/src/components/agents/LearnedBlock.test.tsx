import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Lesson } from '../../lib/lessons/client'
import { LearnedBlock } from './LearnedBlock'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const lesson = (id: string, text: string, over: Partial<Lesson> = {}): Lesson => ({
  id, scope: 'agent:writer', agentId: 'writer', text, source: 'you', feedback: 'Too long.', runId: 'run-1', state: 'active',
  given: 3, backed: 2, missed: 0, createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-20T08:00:00.000Z', ...over,
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

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

  it('offers no Forget where nothing can be changed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ scope: 'agent:writer', learns: true, max: 12, lessons: [lesson('a', 'Use bullets.')] })))
    render(<LearnedBlock of={{ savedAgent: 'writer' }} name="Writer" readOnly />)
    await screen.findByText('Use bullets.')
    expect(screen.queryByRole('button', { name: /Forget/ })).toBeNull()
  })
})
