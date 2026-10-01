import { describe, expect, it } from 'vitest'

import type { AppProblem } from './appChecks'
import { reviewProblems, yamlLineForPath } from './problems'

describe('reviewProblems', () => {
  const missing: AppProblem = {
    agentId: 'helper', cmd: 'acme-agent-cli', status: 'not_found',
    sentence: 'Helper’s app “acme-agent-cli” isn’t installed on this computer.',
    remedy: 'Install it, or choose another AI app for Helper.',
  }

  // The file is valid; the app is just not on this computer. Something to finish, not an error,
  // and with no YAML path, so choosing it selects the agent whose inspector picks the app.
  it('lists an agent whose app is missing as something to finish, on that agent', () => {
    const problems = reviewProblems(null, new Map(), [], new Map([['helper', 'Helper']]), [missing])
    expect(problems).toEqual([{
      title: 'Helper · AI app',
      message: 'Helper’s app “acme-agent-cli” isn’t installed on this computer. Install it, or choose another AI app for Helper.',
      agentId: 'helper',
      weight: 'incomplete',
    }])
  })

  it('lists nothing when every app is here', () => {
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
