import { afterEach, beforeEach } from 'vitest'

import { benchRows } from '../components/agents/benchRows'

/**
 * An agent's settings are rows that open (round 3, ADR 0101). Tests about a setting's editor start
 * with every row open, as a person would open one before changing it, so each editor can be found
 * and used. Call it once at the top of such a test file.
 */
export function openBenchRows() {
  beforeEach(() => { benchRows.allOpen = true })
  afterEach(() => { benchRows.allOpen = false })
}
