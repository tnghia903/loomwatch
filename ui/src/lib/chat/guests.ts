import { figureFor, type FigureChoice } from '../library/figures'

/**
 * Guests (ADR 0092): the agent a team's work starts with, or an agent working alone, may bring in
 * one of the person's other agents from My agents for a part no one on the team does. It runs
 * under `mine+<id>`, which no agent of a team file can have, so a guest is told apart by its id
 * alone, and named and drawn as it is in My agents.
 */

export const GUEST_PREFIX = 'mine+'

/** The agent in My agents a guest's id names; `null` for an agent of the team, a helper or you. */
export function guestOf(id: string): string | null {
  return id.startsWith(GUEST_PREFIX) && id.length > GUEST_PREFIX.length ? id.slice(GUEST_PREFIX.length) : null
}

/**
 * The line the chat says the first time an agent brings in one of the person's other agents: in a
 * team, who chose whom and from where; in an agent's own chat, that the chat has one more in it.
 */
export function broughtInLine(by: string, guest: string, alone: boolean): string {
  return alone ? `${by} added ${guest} to this chat` : `${by} brought in ${guest} from My agents`
}

interface Saved {
  id: string
  name: string
  figure?: FigureChoice
}

/**
 * Every agent of My agents as a guest of this team could appear in its chat: its name, with
 * "(My agents)" after it when one of the team's agents has the same name, so the two are told
 * apart; and the figure it wears in My agents.
 */
export function guestsOf(saved: readonly Saved[], teamNames: Iterable<string>): { names: Map<string, string>; figures: Map<string, FigureChoice> } {
  const taken = new Set([...teamNames].map((name) => name.trim().toLowerCase()))
  const names = new Map<string, string>()
  const figures = new Map<string, FigureChoice>()
  for (const job of saved) {
    const id = `${GUEST_PREFIX}${job.id}`
    names.set(id, taken.has(job.name.trim().toLowerCase()) ? `${job.name} (My agents)` : job.name)
    figures.set(id, figureFor(job.id, job.figure))
  }
  return { names, figures }
}
