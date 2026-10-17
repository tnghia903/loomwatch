import { describe, expect, it } from 'vitest'

import { reviewProblems, yamlLineForPath } from './problems'

describe('reviewProblems', () => {
  it('lists nothing for a team with nothing to fix', () => {
    expect(reviewProblems(null, new Map(), [], new Map())).toEqual([])
  })
})

describe('yamlLineForPath', () => {
  it('locates a top-level additional property and a nested value', () => {
    const yaml = 'schemaVersion: 1\nname: Demo\nunexpected: true\nguards:\n  maxDispatchDepth: -1\n'
    expect(yamlLineForPath(yaml, ['unexpected'])).toBe(3)
    expect(yamlLineForPath(yaml, ['guards', 'maxDispatchDepth'])).toBe(5)
  })
})
