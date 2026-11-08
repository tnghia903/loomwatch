import { describe, expect, it } from 'vitest'

import { agentProposalLines, savedSinceAsk } from './agentProposal'
import type { JobSpec } from '../library/jobs'

const researcher: JobSpec = {
  name: 'Researcher',
  instructions: 'You find facts.\nHow to work:\n- Use primary sources.\nReply with the facts.',
  model: 'anthropic/claude-sonnet-5.5',
  skills: ['cite'],
  doneWhen: ['Every fact has a link'],
  allow: { web: true },
}

describe('an agent Ask proposed, as its card says it (ADR 0119)', () => {
  it('says what a new agent starts with, in the page’s own words', () => {
    const spec: JobSpec = { ...researcher, name: 'Email helper', reads: [{ name: 'Client notes', path: '/x' }], tools: ['Gmail'], allow: { web: true, edits: true, commands: true } }
    expect(agentProposalLines({ isNew: true, spec, inTeams: [] }, null)).toEqual([
      'Thinks with Claude Sonnet 5.5',
      'Skill: cite',
      'Reads Client notes',
      'Uses Gmail, asking before each action',
      'Searches the web without asking',
      'Edits files without asking',
      'Runs commands without asking',
      'Done when: “Every fact has a link”',
    ])
  })

  it('says only what a change changes, then the teams saving changes too', () => {
    const spec: JobSpec = {
      ...researcher,
      instructions: 'You find facts.\nHow to work:\n- Use primary sources.\n- Say how sure you are.\nReply with the facts.',
      skills: ['cite', 'house-style'],
      doneWhen: ['Every fact has a link', 'Says how sure it is'],
      allow: {},
    }
    expect(agentProposalLines({ isNew: false, spec, inTeams: ['Market brief', 'Client review'] }, researcher)).toEqual([
      'Instructions: 1 line put in',
      'Gets house-style as a skill',
      'Asks before it searches the web',
      'Adds to Done when: “Says how sure it is”',
      'Saving also changes it in Market brief and Client review',
    ])
  })

  it('counts a line that was rewritten as changed, skips blank lines, and counts a repeated line once each time', () => {
    const saved: JobSpec = { ...researcher, instructions: 'You find facts.\nHow to work:\n- Check it.\n- Use primary sources.\nReply with the facts.' }
    const spec: JobSpec = { ...researcher, name: 'Fact finder', instructions: 'You find facts.\n\nHow to work:\n- Check it.\n- Check it.\n- Use primary sources only.\nReply with the facts.' }
    expect(agentProposalLines({ isNew: false, spec, inTeams: ['Market brief'] }, saved)).toEqual([
      'New name: Fact finder (was Researcher)',
      'Instructions: 1 line changed, 1 line put in',
      'Saving also changes it in Market brief',
    ])
    expect(agentProposalLines({ isNew: false, spec: { ...saved, instructions: 'You find facts.\nReply with the facts.' }, inTeams: [] }, saved)).toEqual(['Instructions: 3 lines taken out'])
  })

  it('says what a change takes away, and a new model or thinking effort', () => {
    const spec: JobSpec = { ...researcher, model: 'openai/gpt-6.1-sol', thinkingEffort: 'high', skills: [], doneWhen: [], tools: [], reads: [] }
    const saved: JobSpec = { ...researcher, skills: ['cite', 'house-style'], tools: ['Linear'], reads: [{ name: 'Notes', path: '/n' }] }
    expect(agentProposalLines({ isNew: false, spec, inTeams: [] }, saved)).toEqual([
      'Thinks with GPT-6.1 Sol',
      'Thinking effort: High',
      'No longer has cite and house-style as skills',
      'No longer reads Notes',
      'No longer uses Linear',
      'Takes out of Done when: “Every fact has a link”',
    ])
  })

  it('names the teams while the saved agent is not known yet', () => {
    expect(agentProposalLines({ isNew: false, spec: researcher, inTeams: ['Market brief'] }, null)).toEqual(['Saving also changes it in Market brief'])
    expect(agentProposalLines({ isNew: false, spec: researcher, inTeams: [] }, null)).toEqual([])
  })

  it('knows when the agent was saved again after Ask read it', () => {
    expect(savedSinceAsk({ isNew: false, baseVersion: 2 }, { version: 3 })).toBe(true)
    expect(savedSinceAsk({ isNew: false, baseVersion: 2 }, { version: 2 })).toBe(false)
    expect(savedSinceAsk({ isNew: false, baseVersion: 1 }, {})).toBe(false)
    expect(savedSinceAsk({ isNew: false, baseVersion: 2 }, null)).toBe(false)
    expect(savedSinceAsk({ isNew: true, baseVersion: null }, { version: 5 })).toBe(false)
  })
})
