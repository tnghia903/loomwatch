import { describe, expect, it } from 'vitest'

import { formatTokens } from './format'

describe('formatTokens', () => {
  it('says a count the way people say it', () => {
    expect([840, 1000, 2_480, 12_480, 230_400, 1_000_000, 1_420_000].map(formatTokens)).toEqual(['840', '1k', '2.5k', '12k', '230k', '1M', '1.4M'])
  })
})
