import { expect, it } from 'vitest'

import { keepIfSame } from './keepIfSame'

it('keeps what a poll already had, and takes what changed', () => {
  const previous = [{ runId: 'a', status: 'running' }]
  expect(keepIfSame(previous, [{ runId: 'a', status: 'running' }])).toBe(previous)
  const next = [{ runId: 'a', status: 'succeeded' }]
  expect(keepIfSame(previous, next)).toBe(next)
})
