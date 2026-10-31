import { afterEach, describe, expect, it, vi } from 'vitest'

import { alwaysAllowGuest } from '../library/bringIn'
import { broughtInLine, guestOf, guestsOf } from './guests'

afterEach(() => { vi.unstubAllGlobals() })

describe('one of my agents brought in (ADR 0092)', () => {
  it('is told apart by its id alone', () => {
    expect(guestOf('mine+researcher')).toBe('researcher')
    expect(guestOf('researcher')).toBeNull()
    expect(guestOf('writer~2')).toBeNull()
    expect(guestOf('mine+')).toBeNull()
  })

  it('is named and drawn as in My agents, told apart from a team agent with its name', () => {
    const guests = guestsOf([
      { id: 'researcher', name: 'Researcher', figure: { kind: 'cone', color: 'sky' } },
      { id: 'coder', name: 'Coder' },
    ], ['Researcher', 'Writer'])
    expect(guests.names.get('mine+researcher')).toBe('Researcher (My agents)')
    expect(guests.names.get('mine+coder')).toBe('Coder')
    expect(guests.figures.get('mine+researcher')).toEqual({ kind: 'cone', color: 'sky' })
    expect(guests.figures.get('mine+coder')).toBeTruthy()
  })

  it('is brought in by name in a team, and added to an agent’s own chat', () => {
    expect(broughtInLine('Ada', 'Coder', false)).toBe('Ada brought in Coder from My agents')
    expect(broughtInLine('Writer', 'Researcher', true)).toBe('Writer added Researcher to this chat')
  })

  it('is allowed for good in My agents itself, for every team, not in the team that asked', async () => {
    const puts: { url: string; body: Record<string, unknown>; ifMatch: string | null }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/jobs') return new Response(JSON.stringify({ folder: '.jobs', problems: [], jobs: [{ id: 'researcher', file: '.jobs/researcher.yaml', name: 'Researcher', instructions: 'Find facts.', tools: ['Linear'], version: 4 }] }), { status: 200 })
      if (url === '/api/jobs/researcher' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        puts.push({ url, body, ifMatch: new Headers(init.headers).get('If-Match') })
        return new Response(JSON.stringify({ ...body, id: 'researcher', file: '.jobs/researcher.yaml', version: 5 }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }))
    expect(await alwaysAllowGuest('writer', 'web')).toBeNull()
    await alwaysAllowGuest('mine+researcher', 'web')
    await alwaysAllowGuest('mine+researcher', { tool: 'Linear', call: 'create_issue', label: 'Create an issue' })
    expect(puts.map((put) => [put.body.allow, put.body.toolAllow, put.ifMatch])).toEqual([
      [{ web: true }, undefined, '"4"'],
      [undefined, { Linear: ['create_issue'] }, '"4"'],
    ])
    expect(puts[0].body).not.toHaveProperty('id')
  })
})
