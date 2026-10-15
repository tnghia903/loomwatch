import { describe, expect, it } from 'vitest'
import { namesSource, removedSource, sentencesNaming } from './mentions'
import type { AgentConfig } from './types'

const ekis = removedSource({ id: 'notion@807', kind: 'knowledge', name: '🧠 EKIS — SUTD Final Project Hub', notion: { page: '807a-11' } })

function agent(role: string, capabilities: AgentConfig['capabilities'] = []): Pick<AgentConfig, 'role' | 'capabilities'> {
  return { role, capabilities }
}

describe('instructions that name a removed source', () => {
  it('says what kind of thing each card was', () => {
    expect(ekis.kind).toBe('Notion page')
    expect(removedSource({ id: 'skill:canvas-design', kind: 'skill', name: 'canvas-design' }).kind).toBe('skill')
    expect(removedSource({ id: 'knowledge@/p', kind: 'knowledge', name: 'p', path: '/Users/me/project' }).kind).toBe('folder')
    expect(removedSource({ id: 'knowledge@notes.md', kind: 'knowledge', name: 'notes.md', path: 'team.files/notes.md' }).kind).toBe('file')
  })

  it('finds a Notion page by its short name and, once no page is left, by "Notion"', () => {
    // The roles the user's research team kept after the EKIS card was removed.
    expect(namesSource(agent('Update only the Technical approach section under the verified EKIS page.'), ekis)).toBe(true)
    expect(namesSource(agent('Report which Notion updates succeeded.'), ekis)).toBe(true)
    expect(namesSource(agent('Report which Notion updates succeeded.', [{ kind: 'knowledge', name: 'Roadmap', notion: { page: 'ffff' } }]), ekis)).toBe(false)
    expect(namesSource(agent('Read the hub of the SUTD final project and plan.'), ekis)).toBe(false)
  })

  it('matches whole words only', () => {
    expect(namesSource(agent('Check the EKISTICS literature.'), ekis)).toBe(false)
    expect(namesSource(agent('Notionally, plan first.'), ekis)).toBe(false)
  })

  it('reads a skill name with spaces for its dashes, but a folder name only as written', () => {
    const skill = removedSource({ id: 'skill:canvas-design', kind: 'skill', name: 'canvas-design' })
    expect(namesSource(agent('Use the canvas design skill for the poster.'), skill)).toBe(true)
    const folder = removedSource({ id: 'knowledge@/Users/me/sutd-final-project', kind: 'knowledge', name: 'sutd-final-project', path: '/Users/me/sutd-final-project' })
    expect(namesSource(agent("Establish the SUTD final project's problem."), folder)).toBe(false)
    expect(namesSource(agent('Read the notes in sutd-final-project first.'), folder)).toBe(true)
    expect(namesSource(agent('Start from /Users/me/sutd-final-project/README.md.'), folder)).toBe(true)
  })

  it('quotes the sentences that name it, in order', () => {
    const role = 'Establish the problem from the EKIS Notion page and the run request.\nDistinguish confirmed requirements from assumptions. Locate the exact EKIS page through the connected Notion tools.'
    expect(sentencesNaming(agent(role), ekis)).toEqual([
      'Establish the problem from the EKIS Notion page and the run request.',
      'Locate the exact EKIS page through the connected Notion tools.',
    ])
  })
})
