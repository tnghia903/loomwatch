import { afterEach, describe, expect, it, vi } from 'vitest'

import { giveToolToGuest } from './bringIn'

afterEach(() => { vi.unstubAllGlobals() })

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('a tool one of your other agents suggested connecting (ADR 0126)', () => {
  it('is given to that agent in My agents, once, over the version read', async () => {
    const saved: { url: string; body: Record<string, unknown>; match?: string }[] = []
    const maya = { id: 'maya', file: 'maya.yaml', name: 'Maya', instructions: 'Plan my week.', tools: ['Linear'], version: 2 }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return json({ folder: '/teams', jobs: [maya], problems: [] })
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      saved.push({ url: String(input), body, match: new Headers(init?.headers).get('If-Match') ?? undefined })
      return json({ ...body, id: 'maya', file: 'maya.yaml', version: 3 })
    }))

    expect(await giveToolToGuest('maya', 'Apple Calendar')).toBeNull()
    expect(saved).toEqual([])

    await giveToolToGuest('mine+maya', 'Apple Calendar')
    expect(saved).toHaveLength(1)
    expect(saved[0].url).toBe('/api/jobs/maya')
    expect(saved[0].match).toBe('"2"')
    expect(saved[0].body.tools).toEqual(['Linear', 'Apple Calendar'])
    expect(saved[0].body).not.toHaveProperty('id')

    // Given already, whatever its case: nothing is saved again.
    await giveToolToGuest('mine+maya', 'linear')
    expect(saved).toHaveLength(1)
  })
})
