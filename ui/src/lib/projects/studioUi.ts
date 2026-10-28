import { figureFor, type FigureChoice } from '../library/figures'
import type { Room, RoomTeam, Seat } from './studio'

/** The colours a project's mark may take: the figures' own, so a mark never reads as a state. */
export const MARKS = ['sky', 'sage', 'rose', 'lilac', 'clay', 'oat', 'butter'] as const
export type MarkColor = (typeof MARKS)[number]

/** A project's mark colour: the one it chose, or one picked from its id. */
export function markOf(id: string, mark?: string): MarkColor {
  if (mark && (MARKS as readonly string[]).includes(mark)) return mark as MarkColor
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return MARKS[hash % MARKS.length]
}

/** The team a room card shows: the one waiting for you or working, else its first. */
export function leadTeam(room: Room): RoomTeam | null {
  return room.teams.find((team) => team.state === 'waiting') ?? room.teams.find((team) => team.state === 'working') ?? room.teams[0] ?? null
}

/** Where a project's room is. */
export function roomHref(id: string): string {
  return `/projects/${encodeURIComponent(id)}`
}

/** Ask the bell's tray to open, where each waiting thing is answered in turn (one control, ADR 0043). */
export function openNeedsYou(): void {
  window.dispatchEvent(new Event('loomwatch:open-needs-you'))
}

/** The figure each agent wears, by its id in My agents (or its id in the team). */
export type FigureOf = (seat: Seat) => FigureChoice

export function defaultFigureOf(figures: ReadonlyMap<string, FigureChoice | undefined>): FigureOf {
  return (seat) => figureFor(seat.agent ?? seat.id, seat.agent ? figures.get(seat.agent) : undefined)
}
