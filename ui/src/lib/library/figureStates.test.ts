import { describe, expect, it } from 'vitest'

import { wearLayer } from './accessorySpots'
import { FIGURE_STATES, figureStill, signStill, stateOf } from './figures'

describe('a figure’s state, as its still shows it (step 5)', () => {
  it('names each state’s pictures after ready’s, which keep their plain names', () => {
    expect(figureStill({ kind: 'slim', color: 'sky' })).toBe('/agent/figures/slim-sky.webp')
    expect(FIGURE_STATES.map((state) => figureStill({ kind: 'slim', color: 'sky' }, state))).toEqual([
      '/agent/figures/slim-sky.webp', '/agent/figures/slim-sky-working.webp', '/agent/figures/slim-sky-waiting.webp',
      '/agent/figures/slim-sky-done.webp', '/agent/figures/slim-sky-failed.webp',
    ])
    expect(signStill('egg', 'review', 'failed')).toBe('/agent/signs/egg-review-failed.webp')
    expect(wearLayer('wide', 'coffee', 'clay', 'waiting')).toBe('/agent/wear/wide-coffee-waiting.webp')
  })

  it('reads the state from every word the app says it in: presence, a chat face, an island moment', () => {
    expect(['working', 'work', 'busy'].map(stateOf)).toEqual(['working', 'working', 'working'])
    expect(['waiting', 'ask'].map(stateOf)).toEqual(['waiting', 'waiting'])
    expect(['failed', 'fail'].map(stateOf)).toEqual(['failed', 'failed'])
    expect(stateOf('done')).toBe('done')
    // Resting, away, stopped or unknown: ready, its glow and the words say the rest.
    expect(['ready', 'idle', 'away', 'stopped', 'rest', undefined, null].map(stateOf)).toEqual(['ready', 'ready', 'ready', 'ready', 'ready', 'ready', 'ready'])
  })
})
