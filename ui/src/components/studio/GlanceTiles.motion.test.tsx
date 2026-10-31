import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { NeedsYouItem } from '../../lib/projects/glance'
import { GlanceTiles, type GlanceProps } from './GlanceTiles'

const item = (key: string, name: string): NeedsYouItem => ({
  key, kind: 'waiting', runId: `run-${key}`, teamPath: '/teams/blog.yaml', teamName: 'Blog',
  seat: { kind: 'agent', id: name.toLowerCase(), name }, says: 'has work for you to check', asks: 'check',
})

const props = (needs: NeedsYouItem[]): GlanceProps => ({
  needs, last: null, working: [], crew: [], finishedToday: [], spenders: [], cost: null,
  spend: { usd: 0, runs: 0, atLeast: false, byTeam: new Map() },
  doneBy: () => ({ seat: null, where: null }) as never,
  figureOf: () => ({ kind: 'yarn', color: 'sage' }),
  onReview: vi.fn(), onOpenRun: vi.fn(), stepUp: true,
})

beforeEach(() => sessionStorage.clear())
afterEach(cleanup)

const steppedUp = () => document.querySelector('li.glance-up')!

// The design review: the stepped-up figure sprang on every visit to Home, as if it were news.
it('pops the stepped-up figure once for an item, not on every visit', () => {
  const first = render(<GlanceTiles {...props([item('a', 'Writer')])} />)
  expect(steppedUp()).toHaveAttribute('data-new')
  first.unmount()
  // Back on Home with the same item first: it holds still.
  render(<GlanceTiles {...props([item('a', 'Writer')])} />)
  expect(steppedUp()).not.toHaveAttribute('data-new')
  cleanup()
  // A different item steps up: that one is news.
  render(<GlanceTiles {...props([item('b', 'Reader'), item('a', 'Writer')])} />)
  expect(steppedUp()).toHaveAttribute('data-new')
})
