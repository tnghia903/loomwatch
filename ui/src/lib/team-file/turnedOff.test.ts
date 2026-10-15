import { describe, expect, it } from 'vitest'
import { ownedByApp, turnedOffFor, withTurnedOff, withheldByApp, withoutWired } from './turnedOff'

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

describe('what an agent’s app has of its own', () => {
  const inventory = {
    tools: [{ name: 'Agent Memory', source: 'Claude Code + Codex + OpenCode' }, { name: 'Node REPL', source: 'Codex' }],
    connectors: [{ name: 'claude.ai Notion', source: 'Claude Code' }],
    skills: [
      { name: 'canvas-design', source: 'Claude Code' },
      { name: 'engineering:code-review', source: 'Claude Code · engineering' },
      { name: 'herdr', source: 'Codex' },
      { name: 'investment-banking:cim-builder', source: 'Codex · investment-banking' },
    ],
  }

  it('lists a Claude agent’s tools, connectors and skills, plugins included', () => {
    expect(ownedByApp('claude', inventory)?.items.map((item) => `${item.kind}:${item.name}`)).toEqual([
      'tool:Agent Memory', 'tool:claude.ai Notion', 'skill:canvas-design', 'skill:engineering:code-review',
    ])
  })

  it('leaves out Codex plugins, which run agents start without, and connectors, which are Claude’s', () => {
    expect(ownedByApp('codex', inventory)?.items.map((item) => `${item.kind}:${item.name}`)).toEqual(['tool:Agent Memory', 'tool:Node REPL', 'skill:herdr'])
    expect(ownedByApp(null, inventory)).toBeNull()
  })
})

describe('which apps LoomWatch can keep from their own copy', () => {
  it('withholds Claude’s skills and tools and Codex’s skills, and says so for the rest', () => {
    expect(withheldByApp('claude', 'tool')).toBe(true)
    expect(withheldByApp('claude', 'skill')).toBe(true)
    expect(withheldByApp('codex', 'skill')).toBe(true)
    expect(withheldByApp('codex', 'tool')).toBe(false)
    expect(withheldByApp('gemini', 'skill')).toBe(false)
    expect(withheldByApp(null, 'skill')).toBe(false)
  })
})
