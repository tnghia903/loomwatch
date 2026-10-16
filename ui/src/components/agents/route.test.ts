import { describe, expect, it } from 'vitest'

import { parseAgentsRoute, withView } from './route'

describe('Your agents’ addresses', () => {
  it('opens an agent on Build unless the address asks for its Chat', () => {
    expect(parseAgentsRoute('/agents', '')).toEqual({ kind: 'list' })
    expect(parseAgentsRoute('/agents/reader', '')).toEqual({ kind: 'agent', id: 'reader', team: null, view: 'build' })
    expect(parseAgentsRoute('/agents/reader', '?view=chat&team=news.yaml')).toEqual({ kind: 'agent', id: 'reader', team: 'news.yaml', view: 'chat' })
    expect(parseAgentsRoute('/agents/new', '?from=writer&view=chat')).toEqual({ kind: 'new', from: 'writer', team: null, view: 'chat' })
    // Anything else is Build: a mistyped tab never opens an empty page.
    expect(parseAgentsRoute('/agents/reader', '?view=weird')).toMatchObject({ view: 'build' })
  })

  it('switches tab in place, keeping what else the address says', () => {
    expect(withView('chat', { pathname: '/agents/reader', search: '?team=news.yaml' })).toBe('/agents/reader?team=news.yaml&view=chat')
    expect(withView('build', { pathname: '/agents/reader', search: '?team=news.yaml&view=chat' })).toBe('/agents/reader?team=news.yaml')
    expect(withView('build', { pathname: '/agents/new', search: '?view=chat' })).toBe('/agents/new')
  })
})
