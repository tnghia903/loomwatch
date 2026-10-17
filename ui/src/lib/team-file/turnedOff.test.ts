import { describe, expect, it } from 'vitest'
import { inLibrary, turnedOffFor, withTurnedOff, withoutWired } from './turnedOff'

describe('turned off skills and tools (ADR 0060)', () => {
  it('turns off skills and tools, never knowledge, memory or the Team Bus', () => {
    expect(turnedOffFor({ kind: 'skill', name: 'canvas-design' })).toEqual({ kind: 'skill', name: 'canvas-design' })
    expect(turnedOffFor({ kind: 'tool', name: 'agentmemory' })).toEqual({ kind: 'tool', name: 'agentmemory' })
    expect(turnedOffFor({ kind: 'knowledge', name: 'notes', path: '/x' })).toBeNull()
    expect(turnedOffFor({ kind: 'knowledge', name: 'EKIS', notion: { page: '1' } })).toBeNull()
    expect(turnedOffFor({ kind: 'knowledge', name: 'Team memory', memory: { team: 't' } })).toBeNull()
    expect(turnedOffFor({ kind: 'tool', name: 'loomwatch-team-bus' })).toBeNull()
  })

  it('adds each entry once and takes back what is wired again', () => {
    const list = withTurnedOff([{ kind: 'skill', name: 'a' }], [{ kind: 'skill', name: 'a' }, { kind: 'tool', name: 'a' }])
    expect(list).toEqual([{ kind: 'skill', name: 'a' }, { kind: 'tool', name: 'a' }])
    expect(withoutWired(list, [{ kind: 'skill', name: 'a' }])).toEqual([{ kind: 'tool', name: 'a' }])
    expect(withoutWired(undefined, [])).toEqual([])
  })
})

describe('what every agent chooses from (ADR 0060)', () => {
  it('is every skill in LoomWatch’s library, each once', () => {
    const skills = [{ name: 'canvas-design' }, { name: 'brief-writer' }, { name: 'canvas-design' }]
    expect(inLibrary({ skills })).toEqual({ app: 'LoomWatch', items: [{ kind: 'skill', name: 'canvas-design' }, { kind: 'skill', name: 'brief-writer' }] })
    expect(inLibrary({ skills: [] }).items).toEqual([])
  })
})
