import { describe, expect, it } from 'vitest'

import { yamlLineForPath } from './problems'

describe('yamlLineForPath', () => {
  it('locates a top-level additional property and a nested value', () => {
    const yaml = 'schemaVersion: 1\nname: Demo\nunexpected: true\nbudget:\n  limitUsd: -1\n'
    expect(yamlLineForPath(yaml, ['unexpected'])).toBe(3)
    expect(yamlLineForPath(yaml, ['budget', 'limitUsd'])).toBe(5)
  })
})
