// What taking a skill or tool off the canvas turns off (ADR 0060).
//
// An agent chooses from everything its app has. Taking a skill or tool off the canvas says the
// team should not use it, so it is turned off for the agents it was taken from, including the copy
// their app has of its own. Wiring it to an agent again turns it back on for that agent: wiring is
// how a skill is shared across apps, and the daemon never turns off what an agent is given.

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

/** The name each app's skills and tools are listed under in the Library scan (capabilities.rs). */
const PROVIDER: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', hermes: 'Hermes', gemini: 'Gemini' }
/** Apps whose plugins LoomWatch already turns off for run agents (ADR 0047): their plugins'
    skills are not the agent's to choose from. */
const PLUGINS_OFF = new Set(['codex'])

interface Listed { name: string; source: string }

/**
 * What an agent's app has of its own, by the scan of this computer: its tools, Claude's claude.ai
 * connectors, and its skills. The agent chooses from these as well as what it is given; each can
 * be turned off. Null for an app LoomWatch does not scan.
 */
export function ownedByApp(harnessId: string | null | undefined, inventory: { skills: readonly Listed[]; tools: readonly Listed[]; connectors?: readonly Listed[] }): { app: string; items: TurnedOff[] } | null {
  const app = harnessId ? PROVIDER[harnessId] : undefined
  if (!app || !harnessId) return null
  const plugins = !PLUGINS_OFF.has(harnessId)
  const fromApp = (item: Listed) => item.source.split(' + ').some((part) => part === app || (plugins && part.startsWith(`${app} · `)))
  const tools = [...inventory.tools.filter(fromApp), ...(harnessId === 'claude' ? inventory.connectors ?? [] : [])]
  const items: TurnedOff[] = [
    ...tools.map((item) => ({ kind: 'tool' as const, name: item.name })),
    ...inventory.skills.filter(fromApp).map((item) => ({ kind: 'skill' as const, name: item.name })),
  ]
  return { app, items: items.filter((item, index) => items.findIndex((other) => same(other, item)) === index) }
}

/** Whether LoomWatch can keep an app from using its own copy of a turned-off item (ADR 0060):
    Claude Code's skills and tools, Codex's skills. Codex's own MCP servers cannot be turned off
    through codex-acp, and the other apps are not probed yet. */
export function withheldByApp(harnessId: string | null | undefined, kind: TurnedOff['kind']): boolean {
  return harnessId === 'claude' || (harnessId === 'codex' && kind === 'skill')
}
