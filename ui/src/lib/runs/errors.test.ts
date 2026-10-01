import { describe, expect, it } from 'vitest'

import { plainRunError } from './errors'

const agents = new Map([['helper', { name: 'Helper', command: 'acme-agent-cli' }]])

describe('plainRunError', () => {
  it('says which agent could not start and what to do when its app is missing', () => {
    const text = plainRunError('failed to spawn ACP harness for agent helper: No such file or directory (os error 2)', agents)
    expect(text).toMatch(/^Helper couldn’t start: “acme-agent-cli” isn’t installed on this computer/)
    expect(text).toContain('choose another AI app for Helper in Build')
  })

  it('names a pipeline stage the same way', () => {
    expect(plainRunError('failed to spawn ACP harness for pipeline node helper: Permission denied (os error 13)', agents))
      .toBe('Helper couldn’t start: this computer doesn’t allow LoomWatch to run “acme-agent-cli”.')
  })

  it('falls back to the agent id when the team is not at hand', () => {
    expect(plainRunError('failed to spawn ACP harness for agent writer: No such file or directory (os error 2)')).toMatch(/^writer couldn’t start: its AI app isn’t installed/)
  })

  it('leaves every other error exactly as the daemon wrote it', () => {
    expect(plainRunError('protocol failure: session execution failed', agents)).toBe('protocol failure: session execution failed')
  })
})
