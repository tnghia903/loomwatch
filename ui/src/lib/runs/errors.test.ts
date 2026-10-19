import { describe, expect, it } from 'vitest'

import { failedAgent, plainRunError, problemAction } from './errors'

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

describe('problemAction', () => {
  // The daemon's sentences, as agent/error.rs and engine/mod.rs write them.
  it.each([
    ['LoomWatch has reached a usage limit on your ChatGPT plan: the plan’s own limit, or the share you allowed LoomWatch. See it under Manage usage in ChatGPT’s settings.', 'Manage usage'],
    ['Your Claude API credit is used up. It comes back with your plan’s next bill, or add credits in the Claude Console.', 'See your Claude balance'],
    ['Your OpenRouter account is out of credits. Add credits at openrouter.ai, then try again.', 'Add OpenRouter credits'],
    ['This agent runs on your ChatGPT plan. Sign in with ChatGPT on LoomWatch’s Connections page, then run the team again.', 'Open Connections'],
    ['LoomWatch’s sign-in with ChatGPT has ended. Sign in with ChatGPT again on LoomWatch’s Connections page.', 'Open Connections'],
  ])('offers the way out of %s', (message, label) => {
    expect(problemAction(message)?.label).toBe(label)
  })

  it('offers nothing for a stop it can’t place', () => {
    expect(problemAction('The model stopped with an error partway through its reply.')).toBeNull()
    expect(problemAction(null)).toBeNull()
  })
})
