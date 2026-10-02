import { describe, expect, it } from 'vitest'

import { CAPABILITY_CARD, RELATION, capabilityIsCard, capabilityNodeId, freeCapabilitySlot, refuseCapabilityEdge, teamFileKind } from './types'

describe('capabilityNodeId', () => {
  it('is stable, so dropping the same Library row twice is one card', () => {
    expect(capabilityNodeId('skill', 'notebooklm')).toBe('skill:notebooklm')
    expect(capabilityNodeId('tool', '  Agent Memory ')).toBe('tool:agent-memory')
    expect(capabilityNodeId('knowledge', 'OpenCode history')).toBe('knowledge:opencode-history')
  })

  it('keeps the kinds apart, so a skill and a tool of the same name are two cards', () => {
    expect(capabilityNodeId('skill', 'memory')).not.toBe(capabilityNodeId('tool', 'memory'))
  })
})

// ADR 0036: knowledge is a folder or file chosen in the agent's Context, so no knowledge card is
// ever written to `agents[].capabilities` — memory goes through `memory.inherits` instead.
describe('teamFileKind', () => {
  it('wires skills and tools by name, and no knowledge card at all', () => {
    expect(teamFileKind({ kind: 'skill' })).toBe('skill')
    expect(teamFileKind({ kind: 'tool' })).toBe('tool')
    expect(teamFileKind({ kind: 'knowledge' })).toBeNull()
    expect(teamFileKind({ kind: 'knowledge', memory: { team: 'research' } })).toBeNull()
  })

  it('never matches a chosen folder to a knowledge card that happens to share its label', () => {
    expect(capabilityIsCard({ kind: 'knowledge', name: 'Reports' }, { kind: 'knowledge', name: 'Reports' })).toBe(false)
    expect(capabilityIsCard({ kind: 'tool', name: 'Computer' }, { kind: 'tool', name: 'Computer' })).toBe(true)
  })
})

describe('refuseCapabilityEdge', () => {
  const agent = { id: 'collector', isAgent: true }
  const skill = { id: 'skill:notebooklm', isAgent: false, kind: 'skill' as const }

  it('lets an agent reach a capability', () => {
    expect(refuseCapabilityEdge(agent, skill, [])).toBeNull()
  })

  // §4: "capabilities attach to agents rather than to each other".
  it('refuses a capability as the source, without touching anything', () => {
    expect(refuseCapabilityEdge({ id: 'skill:a', isAgent: false }, skill, []))
      .toBe('Only an agent can use a capability. Start the connection at an agent.')
  })

  it('refuses a second identical edge rather than stacking one on the other', () => {
    expect(refuseCapabilityEdge(agent, skill, [{ from: 'collector', to: 'skill:notebooklm' }]))
      .toBe('That agent already reaches this capability.')
    // A different agent reaching the same capability is a new, valid edge.
    expect(refuseCapabilityEdge({ id: 'editor', isAgent: true }, skill, [{ from: 'collector', to: 'skill:notebooklm' }]))
      .toBeNull()
  })

  it('leaves agent-to-agent edges to the team file rules', () => {
    expect(refuseCapabilityEdge(agent, { id: 'editor', isAgent: true }, [])).toBeNull()
  })
})

describe('RELATION', () => {
  it('gives each target kind exactly one relationship word (the typed matrix)', () => {
    expect(RELATION).toEqual({ skill: 'uses skill', tool: 'invokes', knowledge: 'reads' })
  })
})

describe('freeCapabilitySlot', () => {
  it('leaves a free spot alone', () => {
    expect(freeCapabilitySlot({ x: 100, y: 100 }, [{ x: 900, y: 900 }])).toEqual({ x: 100, y: 100 })
  })

  // Click- and keyboard-placed cards all arrive at the viewport centre; a 24 px nudge left them
  // visually stacked, because a card is 276 x 72.
  it('clears the whole card, not just the exact coordinate', () => {
    const first = { x: 100, y: 100 }
    const second = freeCapabilitySlot(first, [first])
    expect(second.y - first.y).toBeGreaterThanOrEqual(CAPABILITY_CARD.height)
    const third = freeCapabilitySlot(first, [first, second])
    expect([first, second].some((taken) => taken.x === third.x && taken.y === third.y)).toBe(false)
    expect(third.y - second.y).toBeGreaterThanOrEqual(CAPABILITY_CARD.height)
  })

  it('starts a new column instead of walking off the bottom', () => {
    const occupied = Array.from({ length: 6 }, (_, row) => ({ x: 100, y: 100 + row * (CAPABILITY_CARD.height + CAPABILITY_CARD.gap) }))
    expect(freeCapabilitySlot({ x: 100, y: 100 }, occupied).x).toBeGreaterThan(100)
  })
})
