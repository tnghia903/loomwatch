import { describe, expect, it } from 'vitest'

import { CHECK_MODEL, DEFAULT_MODEL, FAST_MODEL, NEW_AGENT, effortFor, jobNeeds } from '../ai/modelIds'
import { CHECKER_ROLE } from '../library/checker'
import { onTheFastTier } from '../library/onTheFastTier'
import { ROLE_PRESETS } from '../library/roles'
import type { SetupReading } from './agentSetup'
import { suggestModel } from './modelSuggestion'

const researcher = { id: 'researcher', name: 'Researcher', role: 'Find sources on the topic and pass them on.' }
const writer = { id: 'writer', name: 'Writer', role: 'Write the article from what you are handed.', model: DEFAULT_MODEL }

describe('suggestModel', () => {
  it('keeps a researcher on the strongest model while its job is on the strong tier', () => {
    const suggestion = suggestModel({ agent: researcher, team: { agents: [researcher, writer], responder: 'writer' } })
    expect(suggestion).toEqual({ model: DEFAULT_MODEL, tier: 'strong', effort: 'medium', why: 'A researcher finds and checks sources. That work decides the result, so it gets the strongest model.' })
  })

  it('puts a gatherer on the faster model when another agent writes the answer', onTheFastTier(() => {
    const suggestion = suggestModel({ agent: researcher, team: { agents: [researcher, writer], responder: 'writer' } })
    expect(suggestion.model).toBe(FAST_MODEL)
    expect(suggestion.why).toBe('It gathers facts for Writer to write up. A faster model does that well, for less, and leaves the strongest one for the step that writes.')
  }))

  it('keeps a gatherer on the strongest model when its reply is the team’s answer', onTheFastTier(() => {
    const suggestion = suggestModel({ agent: researcher, team: { agents: [researcher], responder: 'researcher' } })
    expect(suggestion.model).toBe(DEFAULT_MODEL)
    expect(suggestion.why).toContain('Its reply is the team’s answer')
  }))

  it('follows the job alone while the agent is built on its own', onTheFastTier(() => {
    expect(suggestModel({ agent: researcher })).toEqual({ model: FAST_MODEL, tier: 'fast', effort: 'medium', why: expect.stringContaining('for another agent to write up') })
  }))

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
    expect(suggestModel({ agent: writer })).toEqual({ model: DEFAULT_MODEL, tier: 'strong', effort: 'medium', why: 'A writer drafts the finished piece. That work decides the result, so it gets the strongest model.' })
    expect(suggestModel({ agent: { id: 'a', name: 'Numbers', role: 'Analyse the sales sheet.' } }).why).toMatch(/^An analyst answers questions about your data\./)
  })

  it('falls back to the strongest all-rounder when nothing says what the agent does', () => {
    const suggestion = suggestModel({ agent: { id: 'x', name: 'Helper', role: '' } })
    expect(suggestion.model).toBe(DEFAULT_MODEL)
    expect(suggestion.why).toContain('don’t say what kind of work it does')
  })

  it('thinks as hard as the table Ask uses gives its kind of work', () => {
    const job = (id: string) => ROLE_PRESETS.find((preset) => preset.id === id)!
    const asAsk = (id: string) => effortFor(jobNeeds(id).effort)
    // A check step thinks as the checker does, whether checks:, its instructions or its reading say so.
    const checker = { id: 'checker', name: 'Step 3', role: 'Read the draft.', checks: 'writer' }
    expect(suggestModel({ agent: checker, team: { agents: [writer, checker], responder: 'writer' } }).effort).toBe(asAsk('checker'))
    expect(suggestModel({ agent: { id: 'c', name: 'Checker', role: CHECKER_ROLE } }).effort).toBe(asAsk('checker'))
    expect(suggestModel({ agent: { id: 'c', name: 'Step 3', role: 'Look it over.' }, reading: { kind: 'check', probabilities: { check: 0.9 }, confidence: 0.9 } }).effort).toBe(asAsk('checker'))
    // A built-in job thinks as its own, by name or by instructions.
    for (const id of ['editor', 'coder', 'analyst', 'writer']) {
      expect(suggestModel({ agent: { id: 's', name: 'Step 2', role: job(id).role } }).effort).toBe(asAsk(id))
    }
    expect(asAsk('editor')).not.toBe(asAsk('coder'))
    // Anything else thinks as a new agent does.
    expect(suggestModel({ agent: { id: 'x', name: 'Helper', role: '' } }).effort).toBe(effortFor(NEW_AGENT.effort))
  })

  it('places an agent holding a built-in job’s own instructions on that job, whatever it is called', () => {
    const lead = ROLE_PRESETS.find((preset) => preset.id === 'lead')!
    // "Step 2" names nothing, and the lead's instructions mention research: it was put on the faster model.
    expect(suggestModel({ agent: { id: 's', name: 'Step 2', role: lead.role } }).model).toBe(DEFAULT_MODEL)
  })
})

describe('suggestModel with a reading of the whole setup', () => {
  const gatherer = { id: 'gatherer', name: 'Gatherer', role: 'Find what happened in tech today. Do not judge the stories or write them: the Writer does.' }
  const sure = (kind: SetupReading['kind'], probability = 0.9): SetupReading => ({ kind, probabilities: { [kind]: probability }, confidence: 0.9 })
  const team = { agents: [gatherer, writer], responder: 'writer' }

  it('puts a gatherer the keywords call a writer on the faster model, and says it was read', () => {
    expect(suggestModel({ agent: gatherer, team }).model).toBe(DEFAULT_MODEL)
    const read = suggestModel({ agent: gatherer, team, reading: sure('gather') })
    expect(read).toEqual({ model: FAST_MODEL, tier: 'fast', effort: 'medium', read: true, why: 'Its configuration says it gathers for Writer rather than writing the answer. A faster model does that well, for less, and leaves the strongest one for the step that writes.' })
  })

  it('keeps the team’s answer on the strongest model whatever the reading says', () => {
    expect(suggestModel({ agent: gatherer, team: { agents: [gatherer], responder: 'gatherer' }, reading: sure('gather') }).model).toBe(DEFAULT_MODEL)
  })

  it('puts a check step without checks: on another maker’s model', () => {
    const checker = { id: 'checker', name: 'Checker', role: 'You run on a different company’s model from the teacher on purpose. Make every rung follow.' }
    expect(suggestModel({ agent: checker, reading: sure('check') })).toMatchObject({ model: CHECK_MODEL, read: true })
  })

  it('lets checks: decide over any reading', () => {
    const checker = { id: 'checker', name: 'Step 3', role: 'Read the draft.', checks: 'writer' }
    expect(suggestModel({ agent: checker, team: { agents: [writer, checker], responder: 'writer' }, reading: sure('produce') }).model).toBe(CHECK_MODEL)
  })

  it('keeps work the reading says decides the result on the strongest model, even where keywords said gatherer', onTheFastTier(() => {
    const lead = { id: 'lead', name: 'Step 1', role: 'Plan the research, hand each question out to a teammate, and judge when the answers are enough.' }
    expect(suggestModel({ agent: lead }).model).toBe(FAST_MODEL)
    expect(suggestModel({ agent: lead, reading: sure('produce') })).toMatchObject({ model: DEFAULT_MODEL, read: true })
  }))

  it('ignores a reading that isn’t sure, and falls back to the keywords', () => {
    expect(suggestModel({ agent: gatherer, team, reading: sure('gather', 0.7) })).toEqual(suggestModel({ agent: gatherer, team }))
  })
})
