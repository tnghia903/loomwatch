// What taking a skill or tool off the canvas turns off (ADR 0060).
//
// An agent chooses from every skill in LoomWatch's library. Taking a skill off the canvas says the
// team should not use it, so it is turned off for the agents it was taken from. Wiring it to an
// agent again turns it back on for that agent: the daemon never turns off what an agent is given.

import type { CapabilityRef, TurnedOff } from './types'

const same = (a: { kind: string; name: string }, b: { kind: string; name: string }) => a.kind === b.kind && a.name === b.name

/** What taking this card or line away turns off: a skill or a tool. Knowledge is only ever what
    LoomWatch gives, and the Team Bus is how a team hands work on, so neither is turned off. */
export function turnedOffFor(card: { kind: string; name: string; path?: string; notion?: unknown; memory?: unknown }): TurnedOff | null {
  if (card.memory || card.path || card.notion) return null
  if (card.kind !== 'skill' && card.kind !== 'tool') return null
  if (!card.name.trim() || card.name === 'loomwatch-team-bus') return null
  return { kind: card.kind, name: card.name }
}

/** `list` with `added` turned off too, each once, in the order they were turned off. */
export function withTurnedOff(list: readonly TurnedOff[] | undefined, added: readonly TurnedOff[]): TurnedOff[] {
  const next = [...(list ?? [])]
  for (const entry of added) if (!next.some((existing) => same(existing, entry))) next.push(entry)
  return next
}

/** `list` less whatever `capabilities` wires to the agent: wiring turns it back on. */
export function withoutWired(list: readonly TurnedOff[] | undefined, capabilities: readonly CapabilityRef[]): TurnedOff[] {
  return (list ?? []).filter((entry) => !capabilities.some((capability) => same(capability, entry)))
}

interface Listed { name: string }

/**
 * What every agent chooses from besides what it is given: the skills in LoomWatch's library, its
 * own skills folder and the team project's. Each can be turned off for one agent.
 */
export function inLibrary(inventory: { skills: readonly Listed[] }): { app: string; items: TurnedOff[] } {
  const items = inventory.skills.map((item) => ({ kind: 'skill' as const, name: item.name }))
  return { app: 'LoomWatch', items: items.filter((item, index) => items.findIndex((other) => same(other, item)) === index) }
}
