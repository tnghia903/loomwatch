import { describe, expect, it } from 'vitest'

import { CHECK_MODEL, DEFAULT_MODEL, FAST_MODEL } from '../ai/modelIds'
import { CHECKER_ROLE } from '../library/checker'
import { suggestModel } from './modelSuggestion'

const researcher = { id: 'researcher', name: 'Researcher', role: 'Find sources on the topic and pass them on.' }
const writer = { id: 'writer', name: 'Writer', role: 'Write the article from what you are handed.', model: DEFAULT_MODEL }

describe('suggestModel', () => {
  it('puts a gatherer on the faster model when another agent writes the answer', () => {
    const suggestion = suggestModel({ agent: researcher, team: { agents: [researcher, writer], responder: 'writer' } })
    expect(suggestion.model).toBe(FAST_MODEL)
    expect(suggestion.why).toBe('It gathers facts for Writer to write up. A faster model does that well, for less, and leaves the strongest one for the step that writes.')
  })

  it('keeps a gatherer on the strongest model when its reply is the team’s answer', () => {
    const suggestion = suggestModel({ agent: researcher, team: { agents: [researcher], responder: 'researcher' } })
    expect(suggestion.model).toBe(DEFAULT_MODEL)
    expect(suggestion.why).toContain('Its reply is the team’s answer')
  })

  it('follows the job alone while the agent is built on its own', () => {
    expect(suggestModel({ agent: researcher })).toEqual({ model: FAST_MODEL, why: expect.stringContaining('for another agent to write up') })
  })

  it('reads a check on another maker’s model than the work it checks', () => {
    const checker = { id: 'checker', name: 'Checker', role: CHECKER_ROLE, checks: 'writer' }
    const onClaude = suggestModel({ agent: checker, team: { agents: [writer, checker], responder: 'writer' } })
    expect(onClaude.model).toBe(CHECK_MODEL)
    expect(onClaude.why).toBe('It checks Writer’s work, written on Claude Opus 5.5. A model from another maker reads it without sharing its blind spots.')

    const onGpt = suggestModel({ agent: checker, team: { agents: [{ ...writer, model: CHECK_MODEL }, checker], responder: 'writer' } })
    expect(onGpt.model).toBe(DEFAULT_MODEL)
    expect(suggestModel({ agent: { id: 'c', name: 'Checker', role: CHECKER_ROLE } }).model).toBe(CHECK_MODEL)
  })

  it('gives work that decides the result the strongest model, and says why in the job’s words', () => {
    expect(suggestModel({ agent: writer })).toEqual({ model: DEFAULT_MODEL, why: 'A writer drafts the finished piece. That work decides the result, so it gets the strongest model.' })
    expect(suggestModel({ agent: { id: 'a', name: 'Numbers', role: 'Analyse the sales sheet.' } }).why).toMatch(/^An analyst makes sense of data\./)
  })

  it('falls back to the strongest all-rounder when nothing says what the agent does', () => {
    const suggestion = suggestModel({ agent: { id: 'x', name: 'Helper', role: '' } })
    expect(suggestion.model).toBe(DEFAULT_MODEL)
    expect(suggestion.why).toContain('don’t say what kind of work it does')
  })
})
