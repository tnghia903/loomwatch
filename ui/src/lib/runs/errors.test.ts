import { describe, expect, it } from 'vitest'

import { failedAgent, plainRunError } from './errors'

const agents = new Map([['helper', { name: 'Helper' }]])

describe('plainRunError', () => {
  // Runs recorded while LoomWatch drove AI apps: the agent's app failed to start.
  it('names the agent a recorded run could not start, and the cause', () => {
    expect(plainRunError('failed to spawn ACP harness for agent helper: No such file or directory (os error 2)', agents))
      .toBe('Helper couldn’t start: No such file or directory (os error 2)')
    expect(plainRunError('failed to spawn ACP harness for pipeline node writer: Permission denied (os error 13)'))
      .toBe('writer couldn’t start: Permission denied (os error 13)')
  })

  // acp.rs `AppReportedError`, wrapped by the pipeline stage it stopped (2026-10-14).
  it('names the stage its app refused, in the app’s own words', () => {
    const refused = 'pipeline node gatherer failed: Codex reported an error instead of an answer: The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account.'
    expect(plainRunError(refused, new Map([['gatherer', { name: 'Gatherer' }]])))
      .toBe('Gatherer stopped. Codex reported an error instead of an answer: The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account.')
    expect(plainRunError('partial ACP session is recoverable with session_id=run-1: Codex reported an error instead of an answer: Quota exceeded.'))
      .toBe('Codex reported an error instead of an answer: Quota exceeded.')
  })

  it('leaves every other error exactly as the daemon wrote it', () => {
    expect(plainRunError('protocol failure: session execution failed', agents)).toBe('protocol failure: session execution failed')
  })
})

describe('failedAgent', () => {
  const failed = (error: string | null, more: { onlyAgent?: string | null; agentIds?: string[] } = {}) => ({ status: 'failed', error, agentIds: ['gatherer', 'writer'], ...more })

  it('is the agent the error names: a stage that stopped, or an app that couldn’t start', () => {
    expect(failedAgent(failed('pipeline node gatherer failed: Codex reported an error instead of an answer: Quota exceeded.'))).toBe('gatherer')
    expect(failedAgent(failed('failed to spawn ACP harness for agent writer: No such file or directory (os error 2)'))).toBe('writer')
  })

  it('is the one agent a one-agent turn ran, whatever its error says', () => {
    expect(failedAgent(failed('protocol failure', { onlyAgent: 'writer' }))).toBe('writer')
    expect(failedAgent(failed(null, { agentIds: ['writer'] }))).toBe('writer')
  })

  it('is nobody when the run didn’t fail, or its error names no one among many', () => {
    expect(failedAgent({ ...failed('pipeline node gatherer failed: boom'), status: 'cancelled' })).toBeNull()
    expect(failedAgent(failed('protocol failure: session execution failed'))).toBeNull()
  })
})
