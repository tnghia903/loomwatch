import { describe, expect, it } from 'vitest'

import { answeringAgent } from './checker'

// The same rule as the daemon's `responder_id`: the canvas names who answers before any run does.
describe('answeringAgent', () => {
  const stop = (id: string) => ({ id, kind: 'operator' as const })
  const agent = (id: string, checks?: string) => ({ id, ...(checks ? { checks } : {}) })

  it('is the last agent of a plain chain', () => {
    expect(answeringAgent('writer', [agent('researcher'), agent('writer')], [{ from: 'researcher', to: 'writer' }])).toBe('writer')
  })

  it('is the checked work when the pipeline ends on a check step', () => {
    expect(answeringAgent('checker', [agent('writer'), agent('checker', 'writer')], [{ from: 'writer', to: 'checker' }])).toBe('writer')
  })

  // What you typed to approve the work ("Approved") is not the team's answer: the work is.
  it('is the approved work when the pipeline ends on a review stop', () => {
    const edges = [{ from: 'researcher', to: 'review' }]
    expect(answeringAgent('review', [agent('researcher'), stop('review')], edges)).toBe('researcher')
  })

  it('walks back through stops in a row, then applies the check-step rule', () => {
    const agents = [agent('writer'), agent('checker', 'writer'), stop('first'), stop('second')]
    const edges = [{ from: 'writer', to: 'checker' }, { from: 'checker', to: 'first' }, { from: 'first', to: 'second' }]
    expect(answeringAgent('second', agents, edges)).toBe('writer')
  })

  it('stays on a final stop fed by more than one stage, as the daemon does', () => {
    const agents = [agent('a'), agent('b'), stop('review')]
    const edges = [{ from: 'a', to: 'review' }, { from: 'b', to: 'review' }]
    expect(answeringAgent('review', agents, edges)).toBe('review')
  })

  it('has no answer without a terminal', () => {
    expect(answeringAgent(null, [agent('a')], [])).toBeNull()
  })
})
