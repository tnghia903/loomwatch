import { afterEach, describe, expect, it, vi } from 'vitest'

import { goToRun, parseAgentsRoute, withView } from './route'

describe('My agents’ addresses', () => {
  it('opens an agent on Build unless the address asks for its Chat', () => {
    expect(parseAgentsRoute('/agents', '')).toEqual({ kind: 'list' })
    expect(parseAgentsRoute('/agents/reader', '')).toEqual({ kind: 'agent', id: 'reader', team: null, view: 'build', run: null })
    expect(parseAgentsRoute('/agents/reader', '?view=chat&team=news.yaml')).toEqual({ kind: 'agent', id: 'reader', team: 'news.yaml', view: 'chat', run: null })
    // A link to a piece of its chat (`historyRunUrl`) names the run whose Details it opens.
    expect(parseAgentsRoute('/agents/reader', '?view=chat&run=r1')).toEqual({ kind: 'agent', id: 'reader', team: null, view: 'chat', run: 'r1' })
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

// A link to a run (`historyRunUrl`), followed from the bell: on the agent's own page it opens in
// place; another agent's page, or a team's, is where the link goes.
describe('following a link to a run', () => {
  const real = window.location
  const at = (pathname: string) => {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { configurable: true, value: { href: `http://localhost${pathname}`, origin: 'http://localhost', pathname, search: '', assign } })
    return assign
  }
  afterEach(() => { Object.defineProperty(window, 'location', { configurable: true, value: real }); vi.restoreAllMocks() })

  it('opens a piece of the agent on screen in place', () => {
    const assign = at('/agents/cole')
    const pushed = vi.spyOn(window.history, 'pushState').mockImplementation(() => {})
    goToRun('/agents/cole?view=chat&run=r2')
    expect(pushed).toHaveBeenCalledWith({}, '', '/agents/cole?view=chat&run=r2')
    expect(assign).not.toHaveBeenCalled()
  })

  it('goes to another agent’s page, or a team’s, as a page load', () => {
    const assign = at('/agents/cole')
    goToRun('/agents/maya?view=chat&run=r3')
    expect(assign).toHaveBeenCalledWith('/agents/maya?view=chat&run=r3')
    goToRun('/?path=trip.yaml&run=r1')
    expect(assign).toHaveBeenLastCalledWith('/?path=trip.yaml&run=r1')
  })
})
