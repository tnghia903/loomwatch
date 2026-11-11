import { figureFor, signFor, type FigureView } from '../library/figures'
import type { Room, RoomTeam, Seat } from './studio'

/** The colours a project's mark may take: the figures' own, so a mark never reads as a state. */
export const MARKS = ['sky', 'sage', 'rose', 'lilac', 'clay', 'oat', 'butter'] as const
export type MarkColor = (typeof MARKS)[number]

/** Each mark colour's name, as a person says it. */
export const MARK_NAMES: Record<MarkColor, string> = { sky: 'Sky blue', sage: 'Sage green', rose: 'Rose', lilac: 'Lilac', clay: 'Clay', oat: 'Oat', butter: 'Butter yellow' }

/** The colours picked for a project that chose none: never sky or butter, nearest the working blue
    and the waiting gold, so a mark nobody chose never reads as a state. */
const PICKED: readonly MarkColor[] = ['sage', 'lilac', 'oat', 'rose', 'clay']

/** A project's mark colour: the one it chose, or one picked from its id. */
export function markOf(id: string, mark?: string): MarkColor {
  if (mark && (MARKS as readonly string[]).includes(mark)) return mark as MarkColor
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return PICKED[hash % PICKED.length]
}

/** The team a room card shows: its first, since a room puts the team waiting for you or working first. */
export function leadTeam(room: Room): RoomTeam | null {
  return room.teams[0] ?? null
}

/** Where a project's room is. */
export function roomHref(id: string): string {
  return `/projects/${encodeURIComponent(id)}`
}

/**
 * Ask the bell's tray to open, where each waiting thing is answered in turn (one control, ADR 0043):
 * at the given run's item, or at the first.
 */
export function openNeedsYou(runId?: string): void {
  window.dispatchEvent(new CustomEvent('loomwatch:open-needs-you', { detail: runId }))
}

/** The figure each agent wears, by its id in My agents (or its id in the team). */
export type FigureOf = (seat: Pick<Seat, 'id' | 'agent'> & { name?: string }) => FigureView

/** `figures`: My agents' figures as drawn (`jobFigure`), by id; a seat for a team's own agent takes
    the sign its name suggests. */
export function defaultFigureOf(figures: ReadonlyMap<string, FigureView | undefined>): FigureOf {
  return (seat) => {
    const saved = seat.agent ? figures.get(seat.agent) : undefined
    return { ...figureFor(seat.agent ?? seat.id, saved), sign: saved?.sign ?? signFor({ name: seat.name ?? seat.id }) }
  }
}
