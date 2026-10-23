import { ACCESSORIES, isAccessory, isGarment, type Accessory, type EarnedFigure } from '../quests/catalog'
import { hashId } from '../story/mark'
import type { AgentConfig } from '../team-file/types'

/**
 * The figures an agent wears in Your agents: a sewing-box crew, so you can tell your agents apart
 * at a glance. Each is a big head on a small sitting body (ui/blender/workbench.py models them, and
 * the backend's jobs.rs accepts the same names). The figure is only how the agent looks here: a
 * team never copies it, so choosing one never makes a new version.
 */
export const STARTER_KINDS = ['yarn', 'spool', 'button', 'thimble', 'pincushion', 'cone'] as const
/** Every figure: the starters anyone can choose, then the ones quests earn (lib/quests). Only the
    starters are ever picked for an agent, so an agent nobody dressed keeps the figure it had. */
export const FIGURE_KINDS = [...STARTER_KINDS, 'scissors', 'bobbin'] as const satisfies readonly (string | EarnedFigure)[]
export type FigureKind = (typeof FIGURE_KINDS)[number]

/** Soft and quiet, and never one of the app's status colours: blue runs, gold is you, red is trouble. */
export const FIGURE_COLORS = ['clay', 'butter', 'sage', 'sky', 'lilac', 'rose', 'oat'] as const
export type FigureColor = (typeof FIGURE_COLORS)[number]

export interface FigureChoice {
  kind: FigureKind
  color: FigureColor
  /** Accessories from the wardrobe it wears; absent or empty means none. */
  wear?: Accessory[]
}

export const FIGURE_NAMES: Record<FigureKind, string> = {
  yarn: 'Yarn ball',
  spool: 'Spool',
  button: 'Button',
  thimble: 'Thimble',
  pincushion: 'Pincushion',
  cone: 'Thread cone',
  scissors: 'Scissors',
  bobbin: 'Bobbin',
}

export const COLOR_NAMES: Record<FigureColor, string> = {
  clay: 'Clay',
  butter: 'Butter',
  sage: 'Sage',
  sky: 'Sky',
  lilac: 'Lilac',
  rose: 'Rose',
  oat: 'Oat',
}

/**
 * The chat colour an agent wears (`.hue-N` in loom.css): its figure's colour, 1 to 7, so its name,
 * its avatar's disc and its figure agree. 0 is you.
 */
export function figureHue(figure: FigureChoice): number {
  return FIGURE_COLORS.indexOf(figure.color) + 1
}

/** How many agent colours there are: one per figure colour. */
export const FIGURE_HUES = FIGURE_COLORS.length

/** The skin colours, the same as the model's (workbench.py PALETTE). */
export const COLOR_HEX: Record<FigureColor, string> = {
  clay: '#E3A386',
  butter: '#F1D488',
  sage: '#9FBF9E',
  sky: '#9EC3E6',
  lilac: '#BDB0E6',
  rose: '#EBB3C0',
  oat: '#E8DFCF',
}

export function isFigureChoice(value: unknown): value is FigureChoice {
  if (!value || typeof value !== 'object') return false
  const { kind, color, wear } = value as Record<string, unknown>
  return FIGURE_KINDS.includes(kind as FigureKind) && FIGURE_COLORS.includes(color as FigureColor) && (wear === undefined || (Array.isArray(wear) && wear.every(isAccessory)))
}

/** What it wears, each once, in the wardrobe's order, and one set of clothes at most. */
export function wornBy(figure: Pick<FigureChoice, 'wear'>): Accessory[] {
  const worn = new Set(figure.wear ?? [])
  const clothes = (figure.wear ?? []).find(isGarment)
  return ACCESSORIES.filter((item) => worn.has(item) && (!isGarment(item) || item === clothes))
}

/** The figure an agent wears: the one chosen for it, or one picked from its id, the same every time. */
export function figureFor(id: string, chosen?: FigureChoice | null): FigureChoice {
  if (chosen && isFigureChoice(chosen)) return chosen
  const seed = hashId(id)
  return { kind: STARTER_KINDS[seed % STARTER_KINDS.length], color: FIGURE_COLORS[Math.floor(seed / STARTER_KINDS.length) % FIGURE_COLORS.length] }
}

/**
 * The figure a team's agent wears, so it looks the same in the team as it does in Your agents: one
 * placed from Your agents wears its saved agent's figure (found by the `from` link, not by its id in
 * the team, which can differ); a team's own agent wears the one its id picks.
 */
export function agentFigure(agent: Pick<AgentConfig, 'id' | 'from'>, saved: readonly { id: string; figure?: FigureChoice }[]): FigureChoice {
  const linked = agent.from?.agent
  const job = linked ? saved.find((candidate) => candidate.id === linked) : undefined
  return figureFor(linked ?? agent.id, job?.figure)
}

/**
 * A figure for a new agent that none of `worn` already has, so a new agent never looks like one
 * you have; a new kind before a new colour, because a shape tells apart at a glance better than a
 * colour. Only when every pairing is taken does it repeat one.
 */
export function freshFigure(seed: string, worn: readonly FigureChoice[]): FigureChoice {
  const start = figureFor(seed)
  const kinds = rotate<FigureKind>(STARTER_KINDS, STARTER_KINDS.indexOf(start.kind as (typeof STARTER_KINDS)[number]))
  const colors = rotate(FIGURE_COLORS, FIGURE_COLORS.indexOf(start.color))
  const count = (kind: FigureKind) => worn.filter((figure) => figure.kind === kind).length
  const byUse = [...kinds].sort((a, b) => count(a) - count(b))
  for (const kind of byUse) {
    const color = colors.find((candidate) => !worn.some((figure) => figure.kind === kind && figure.color === candidate))
    if (color) return { kind, color }
  }
  return start
}

function rotate<T>(list: readonly T[], from: number): T[] {
  return [...list.slice(from), ...list.slice(0, from)]
}

/** Its portrait, rendered with the model (workbench.py `stills`): for cards and the picker. */
export function figureStill(figure: FigureChoice): string {
  return `/agent/figures/${figure.kind}-${figure.color}.webp`
}

/** The figure in words, for its picture's alt text. */
export function figureWords(figure: FigureChoice): string {
  return `${COLOR_NAMES[figure.color].toLowerCase()} ${FIGURE_NAMES[figure.kind].toLowerCase()}`
}
