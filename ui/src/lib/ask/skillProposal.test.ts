import { describe, expect, it } from 'vitest'

import { changedSinceAsk, skillProposalLines, skillProposalName } from './skillProposal'

const saved = {
  description: 'Writes the weekly update.',
  instructions: '# Weekly update\n\n1. Read the notes.\n2. Write five bullets.\n3. Sign it Mai.',
  base: 'base-1',
}

const change = {
  isNew: false, skill: 'weekly-update', title: null, base: 'base-1', givenTo: [] as string[],
  description: saved.description,
  instructions: '# Weekly update\n\n1. Read the notes.\n2. Write three bullets.\n3. Sign it Mai.\n4. Keep it under 100 words.',
}

describe('a skill Ask proposed, as its card says it (ADR 0121)', () => {
  it('says when agents use a new skill, cut short on the card, and names it as it will show once saved', () => {
    const fresh = { ...change, isNew: true, skill: 'mais-report', title: 'Mai’s report', base: null, description: 'Writes Mai’s report. Use it when asked for the report.' }
    expect(skillProposalName(fresh)).toBe('Mais report')
    expect(skillProposalLines(fresh, null)).toEqual(['When to use it: “Writes Mai’s report. Use it when asked for the report.”'])
    const long = skillProposalLines({ ...fresh, description: 'word '.repeat(60).trim() }, null)[0]
    expect(Array.from(long).length).toBeLessThan(180)
    expect(long.endsWith('…”')).toBe(true)
  })

  it('says what a change changes, by line, and who saving changes it for', () => {
    expect(skillProposalName(change)).toBe('Weekly update')
    expect(skillProposalLines(change, saved)).toEqual([
      'What to do: 1 line changed, 1 line put in',
      'Saving changes it for every agent that uses it',
    ])
    expect(skillProposalLines({ ...change, description: 'Writes the weekly update for clients.', givenTo: ['Writer', 'Researcher'] }, saved)).toEqual([
      'When to use it, changed to: “Writes the weekly update for clients.”',
      'What to do: 1 line changed, 1 line put in',
      'Saving changes it for every agent that uses it, including Writer and Researcher',
    ])
    // Until the skill's words are known, only who it is for.
    expect(skillProposalLines(change, null)).toEqual(['Saving changes it for every agent that uses it'])
  })

  it('is stale only when a change was made from words the skill no longer has', () => {
    expect(changedSinceAsk(change, saved)).toBe(false)
    expect(changedSinceAsk(change, { base: 'base-2' })).toBe(true)
    expect(changedSinceAsk(change, null)).toBe(false)
    expect(changedSinceAsk({ ...change, isNew: true, base: null }, { base: 'base-2' })).toBe(false)
  })
})
