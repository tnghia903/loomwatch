import { describe, expect, it } from 'vitest'

import { reviewProblems } from './problems'

describe('reviewProblems', () => {
  it('lists nothing for a team with nothing to fix', () => {
    expect(reviewProblems(null, new Map(), [], new Map())).toEqual([])
  })
})
