import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

import { OFFLINE_MODEL } from '../ai/modelIds'
import { CHECKER_ROLE } from '../library/checker'
import { ROLE_PRESETS } from '../library/roles'
import { needsReading, setupOf, trustedKind, type SuggestedAgent } from './agentSetup'
import type { TeamDocument } from './types'

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../examples')
const team = (file: string) => parse(readFileSync(path.join(examples, file), 'utf8')) as TeamDocument
const agentOf = (file: string, id: string) => {
  const found = team(file).agents.find((agent) => agent.id === id)
  if (!found) throw new Error(`${file} has no ${id}`)
  return found
}

describe('needsReading', () => {
  it('reads the bundled agents whose instructions name a job only to say it is someone else’s', () => {
    // "Do not judge the stories or write them": the free reading calls these writers.
    expect(needsReading(agentOf('usecases/daily-tech-digest.yaml', 'gatherer'))).toBe(true)
    expect(needsReading(agentOf('usecases/daily-tech-digest.yaml', 'reader'))).toBe(true)
    // "Do not teach it": the word "review" makes it a reviewer.
    expect(needsReading(agentOf('usecases/learn-from-first-principles.yaml', 'mapper'))).toBe(true)
    // Says it runs on another company's model on purpose, but has no `checks:`.
    expect(needsReading(agentOf('usecases/learn-from-first-principles.yaml', 'checker'))).toBe(true)
  })

  it('never reads an agent a fact already places', () => {
    for (const preset of ROLE_PRESETS) {
      // A built-in job's own instructions are that job, whatever the agent is called.
      expect(needsReading({ id: 'a', name: 'Step 2', role: preset.role }), preset.id).toBe(false)
    }
    const long = 'Read the draft you are handed and list every claim that its sources do not support, one per line.'
    expect(needsReading({ id: 'c', name: 'Step 3', role: long, checks: 'writer' })).toBe(false)
    expect(needsReading({ id: 'c', name: 'Checker', role: CHECKER_ROLE })).toBe(false)
    expect(needsReading({ id: 'd', name: 'Step 4', role: long, model: OFFLINE_MODEL })).toBe(false)
    // Too few words to read anything off.
    expect(needsReading({ id: 'e', name: 'Helper', role: 'Help out.' })).toBe(false)
  })

  it('trusts a name that names a job, unless the instructions say the job is someone else’s', () => {
    const role = 'Find five recent sources on the topic, check each one is real, and hand them on with a line on each.'
    expect(needsReading({ id: 'r', name: 'Researcher', role })).toBe(false)
    expect(needsReading({ id: 'r', name: 'Researcher', role: `${role} Do not write the report.` })).toBe(true)
    expect(needsReading({ id: 't', name: 'Triage', role: 'Read each support ticket and tag it with one of: billing, bug, how-to, other.' })).toBe(true)
  })
})

describe('setupOf', () => {
  it('sends the agent’s own setup by name only, in a fixed order', () => {
    const agent: SuggestedAgent = {
      id: 'scout', name: ' Scout ', role: ' Find sources. ', checks: undefined,
      doneWhen: [' Every source has a link ', ''],
      capabilities: [
        { kind: 'skill', name: 'web-research' },
        { kind: 'tool', name: 'Notion' },
        { kind: 'knowledge', name: 'Q3 notes', path: '/Users/ada/Q3' },
      ],
      allow: { web: true, edits: false, commands: true },
      allowRecruiting: true,
    }
    expect(setupOf(agent)).toEqual({
      name: 'Scout', instructions: 'Find sources.', doneWhen: ['Every source has a link'],
      skills: ['web-research'], tools: ['Notion'], reads: ['Q3 notes'], allow: ['commands', 'web'], recruits: true,
    })
    // A folder's path never leaves: only its label does.
    expect(JSON.stringify(setupOf(agent))).not.toContain('/Users/ada')
  })

  it('sends a label that is a path as its last name only', () => {
    const agent: SuggestedAgent = {
      id: 'scout', name: 'Scout', role: 'Find sources.',
      capabilities: [
        { kind: 'knowledge', name: '/Users/ada/Clients/Acme', path: '/Users/ada/Clients/Acme' },
        { kind: 'knowledge', name: 'C:\\Users\\ada\\Q3 notes.md', path: 'C:\\Users\\ada\\Q3 notes.md' },
        { kind: 'knowledge', name: 'team.files/brief.md', path: 'team.files/brief.md' },
      ],
    }
    expect(setupOf(agent).reads).toEqual(['Acme', 'Q3 notes.md', 'brief.md'])
    expect(JSON.stringify(setupOf(agent))).not.toMatch(/Users|ada|team\.files/)
  })
})

describe('trustedKind', () => {
  it('acts on a reading only when it is sure, and on a gatherer only when it is surer still', () => {
    expect(trustedKind(null)).toBeUndefined()
    expect(trustedKind({ kind: 'produce', probabilities: { produce: 0.62, gather: 0.38 } })).toBe('produce')
    expect(trustedKind({ kind: 'produce', probabilities: { produce: 0.55, gather: 0.45 } })).toBeUndefined()
    expect(trustedKind({ kind: 'gather', probabilities: { gather: 0.7, produce: 0.3 } })).toBeUndefined()
    expect(trustedKind({ kind: 'gather', probabilities: { gather: 0.8, produce: 0.2 } })).toBe('gather')
    expect(trustedKind({ kind: 'check', probabilities: { check: 0.9 }, confidence: 0.3 })).toBeUndefined()
  })

  it('reads how sure a reading is from its confidence when it gives no probabilities', () => {
    expect(trustedKind({ kind: 'produce', probabilities: {}, confidence: 0.8 })).toBe('produce')
    expect(trustedKind({ kind: 'gather', probabilities: {}, confidence: 0.7 })).toBeUndefined()
    expect(trustedKind({ kind: 'check', probabilities: {} })).toBeUndefined()
  })
})
