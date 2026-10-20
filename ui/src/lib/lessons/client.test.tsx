import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { forgetYou, useYou } from '../you/client'
import { inAboutYou, tellAllAgents, undoTellAllAgents } from './client'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  forgetYou()
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function Told() {
  const you = useYou()
  return <p>{you ? (you.about ?? 'nothing') : 'not read'}</p>
}

describe('Tell all my agents', () => {
  it('asks as LoomWatch’s own page, and everything showing About you shows it at once', async () => {
    const sent: Array<{ url: string; asPage: boolean }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url, asPage: new Headers(init?.headers).get('X-LoomWatch-Request') === '1' })
      if (url === '/api/lessons/tell-all') return json({ lesson: {}, lessons: [], you: { name: 'Mai', about: 'Always write in Vietnamese.', skipped: false }, added: true })
      if (url === '/api/lessons/tell-all/undo') return json({ lesson: {}, lessons: [], you: { name: 'Mai', about: null, skipped: false }, removed: true })
      return json({ error: 'not asked' }, 500)
    }))
    await tellAllAgents({ teamPath: 'news.yaml', agent: 'writer' }, 'l1')
    render(<Told />)
    expect(screen.getByText('Always write in Vietnamese.')).toBeTruthy()
    await undoTellAllAgents({ teamPath: 'news.yaml', agent: 'writer' }, 'l1')
    expect(await screen.findByText('nothing')).toBeTruthy()
    expect(sent).toEqual([{ url: '/api/lessons/tell-all', asPage: true }, { url: '/api/lessons/tell-all/undo', asPage: true }])
  })

  it('says why it could not, and changes nothing shown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'That lesson is about this agent’s work, so it stays with this agent.' }, 422)))
    await expect(tellAllAgents({ savedAgent: 'writer' }, 'l1')).rejects.toThrow('so it stays with this agent')
    render(<Told />)
    expect(screen.getByText('not read')).toBeTruthy()
  })

  it('knows a lesson moved to About you from one dropped any other way', () => {
    expect(inAboutYou({ state: 'dropped', droppedBy: 'about_you' })).toBe(true)
    expect(inAboutYou({ state: 'dropped', droppedBy: 'you' })).toBe(false)
    expect(inAboutYou({ state: 'active' })).toBe(false)
  })
})
