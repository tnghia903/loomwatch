import { ACCESSORIES, isAccessory, isGarment, migrateItem, type Accessory, type EarnedFigure, type Garment } from '../quests/catalog'
import { hashId } from '../story/mark'
import type { AgentConfig } from '../team-file/types'
import { guessIcon, ROLE_ICON_IDS, type RoleIcon } from './roleIcons'
import { COLOR_HEX } from './figureHex'
import { SIGN_TINT } from './signTints'

/**
 * The figures an agent wears in Your agents: a fluffy velvet figure in one of six builds and one of
 * six colours, so you can tell your agents apart at a glance. The figure is only how the agent looks
 * here: a team never copies it, so choosing one never makes a new version. The backend's figures.rs
 * is the twin: it accepts the same names and maps the same old ones (`migrateFigure`).
 */
/** The six builds, in the order an agent nobody dressed is given one: each sits where the old sewing
    figure of the same shape sat (yarn, spool, button, thimble, pincushion, cone), so it keeps its look. */
export const BUILDS = ['chubby', 'tall', 'wide', 'little', 'egg', 'slim'] as const
/** Every build anyone can choose: a figure is a build, in a colour. */
export const FIGURE_KINDS = BUILDS
export type FigureKind = (typeof FIGURE_KINDS)[number]

/** Soft and rich, and never one of the app's status colours: green ready, blue runs, gold is you, red is trouble. */
export const STARTER_COLORS = ['clay', 'sage', 'sky', 'lilac', 'rose', 'orchid'] as const
/** Every colour: the starters anyone can choose, then the finishes quests earn (lib/quests), which any
    build can be once earned. */
export const FIGURE_COLORS = [...STARTER_COLORS, 'plum', 'sunset'] as const satisfies readonly (string | EarnedFigure)[]
export type FigureColor = (typeof FIGURE_COLORS)[number]

export interface FigureChoice {
  kind: FigureKind
  color: FigureColor
  /** Accessories from the wardrobe it wears; absent or empty means none. */
  wear?: Accessory[]
}

/**
 * The job sign on a figure's head: the app's own symbol for the agent's job (`ROLE_ICONS`), so one
 * job has one symbol wherever it shows; a plain curl for an agent with no job's icon. It comes from
 * the agent, never from the figure a person picks.
 */
export type Sign = RoleIcon | 'curl'
export const SIGNS: readonly Sign[] = [...ROLE_ICON_IDS, 'curl']

/** A figure as it is drawn: what was chosen, and the sign its agent's job puts on its head. Only for
    drawing: a saved figure never holds a sign (the backend refuses one). */
export type FigureView = FigureChoice & { sign?: Sign }

/**
 * What a figure is doing, as its still shows it (step 5): a pose and a face of its own for each.
 * Ready stands with its paws together; working leans into its work, paws forward at shoulder height;
 * waiting raises a paw and holds it; done lifts both, eyes closed in a smile; failed slumps. Thinking
 * shows as working at the sizes stills are drawn.
 */
export type FigureState = 'ready' | 'working' | 'waiting' | 'done' | 'failed'
export const FIGURE_STATES: readonly FigureState[] = ['ready', 'working', 'waiting', 'done', 'failed']

/**
 * A still's state from the words the app already says a figure's state in: a presence or work state
 * (working, waiting, failed), a chat face's (idle, away: ready), an island moment (work, ask, done,
 * fail) or a glow. Anything else is ready.
 */
export function stateOf(word?: string | null): FigureState {
  switch (word) {
    case 'working': case 'work': case 'busy': return 'working'
    case 'waiting': case 'ask': return 'waiting'
    case 'done': return 'done'
    case 'failed': case 'fail': return 'failed'
    default: return 'ready'
  }
}

/** How a state's still is named after ready's: ready's has the plain name. */
export function posed(state: FigureState = 'ready'): string {
  return state === 'ready' ? '' : `-${state}`
}

/** The sign for an agent: its saved job's icon, else the one its name and instructions suggest (as a
    save picks one, `guessIcon`), else a plain curl. */
export function signFor(agent: { icon?: string | null; name?: string; instructions?: string; role?: string }): Sign {
  if (agent.icon && (ROLE_ICON_IDS as readonly string[]).includes(agent.icon)) return agent.icon as RoleIcon
  return guessIcon(agent.name ?? '', agent.instructions ?? agent.role ?? '') ?? 'curl'
}

/** A saved agent's figure as it is drawn, with its job's sign. */
export function jobFigure(job: { id: string; figure?: FigureChoice | null; icon?: string | null; name?: string; instructions?: string }): FigureView {
  return { ...figureFor(job.id, job.figure), sign: signFor(job) }
}

export const FIGURE_NAMES: Record<FigureKind, string> = {
  chubby: 'Round',
  tall: 'Tall',
  wide: 'Wide',
  little: 'Small',
  egg: 'Square',
  slim: 'Slim',
}

export const COLOR_NAMES: Record<FigureColor, string> = {
  clay: 'Clay',
  sage: 'Sage',
  sky: 'Sky',
  lilac: 'Lilac',
  rose: 'Rose',
  orchid: 'Orchid',
  plum: 'Plum',
  sunset: 'Sunset',
}

/**
 * The chat colour an agent wears (`.hue-N` in loom.css): its figure's colour, 1 to 8, so its name,
 * its avatar's disc and its figure agree. 0 is you.
 */
export function figureHue(figure: FigureChoice): number {
  return FIGURE_COLORS.indexOf(figure.color) + 1
}

/** How many agent colours there are: one per figure colour. */
export const FIGURE_HUES = FIGURE_COLORS.length

export { COLOR_HEX }

/** A colour's swatch in the picker: sunset is a gradient, as the figure is. */
export function colorSwatch(color: FigureColor): string {
  return color === 'sunset' ? 'linear-gradient(to top, #A8446A, #9C3D86 55%, #6B3A9E)' : COLOR_HEX[color]
}

/** The sewing figures an earlier LoomWatch drew, each the build of the same shape now; the two that
    were earned are that build in the finish earned now. */
const OLD_KINDS: Record<string, readonly [FigureKind, FigureColor?]> = {
  yarn: ['chubby'],
  spool: ['tall'],
  button: ['wide'],
  thimble: ['little'],
  pincushion: ['egg'],
  cone: ['slim'],
  scissors: ['slim', 'plum'],
  bobbin: ['tall', 'sunset'],
}
/** Retired colours: butter rendered as cream, too close to another company's figure; oat with it. */
const OLD_COLORS: Record<string, FigureColor> = { butter: 'clay', oat: 'orchid' }

/** A figure under today's names, so an agent saved by an earlier LoomWatch keeps its look. Today's
    names, and names this build does not know, pass through for `isFigureChoice` to judge. */
export function migrateFigure(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const { kind, color, wear } = value as Record<string, unknown>
  const old = typeof kind === 'string' ? OLD_KINDS[kind] : undefined
  const nextColor = old?.[1] ?? (typeof color === 'string' ? (OLD_COLORS[color] ?? color) : color)
  const nextWear = Array.isArray(wear) ? wear.map((item) => (typeof item === 'string' ? migrateItem(item) : item)) : wear
  return { ...(value as object), kind: old?.[0] ?? kind, color: nextColor, ...(wear === undefined ? {} : { wear: nextWear }) }
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

/** The colours an agent nobody dressed is given: the old seven, renamed, so it keeps the colour it had. */
const PICK_COLORS: readonly FigureColor[] = ['clay', 'clay', 'sage', 'sky', 'lilac', 'rose', 'orchid']

/** The figure an agent wears: the one chosen for it (under today's names), or one picked from its id,
    the same every time and the same as the backend's `figures::pick`. */
export function figureFor(id: string, chosen?: FigureChoice | null): FigureChoice {
  const today = migrateFigure(chosen)
  if (today && isFigureChoice(today)) return today
  const seed = hashId(id)
  return { kind: BUILDS[seed % BUILDS.length], color: PICK_COLORS[Math.floor(seed / BUILDS.length) % PICK_COLORS.length] }
}

/**
 * The figure a team's agent wears, so it looks the same in the team as it does in Your agents: one
 * placed from Your agents wears its saved agent's figure (found by the `from` link, not by its id in
 * the team, which can differ); a team's own agent wears the one its id picks. An agent's own chat
 * (`chatOf`, from `benchChatOwner`) is that agent on a team of one, written with no link, so its
 * agent wears the figure of the agent the chat is named for.
 */
export function agentFigure(agent: Pick<AgentConfig, 'id' | 'from'> & Partial<Pick<AgentConfig, 'name' | 'role'>>, saved: readonly { id: string; figure?: FigureChoice; icon?: string; name?: string; instructions?: string }[], chatOf: string | null = null): FigureView {
  const linked = agent.from?.agent ?? chatOf ?? undefined
  const job = linked ? saved.find((candidate) => candidate.id === linked) : undefined
  return { ...figureFor(linked ?? agent.id, job?.figure), sign: signFor(job ?? { name: agent.name ?? agent.id, role: agent.role }) }
}

/**
 * A figure for a new agent that none of `worn` already has, so a new agent never looks like one
 * you have; a new kind before a new colour, because a shape tells apart at a glance better than a
 * colour. Only when every pairing is taken does it repeat one.
 */
export function freshFigure(seed: string, worn: readonly FigureChoice[]): FigureChoice {
  const start = figureFor(seed)
  const kinds = rotate<FigureKind>(BUILDS, BUILDS.indexOf(start.kind))
  const colors = rotate<FigureColor>(STARTER_COLORS, Math.max(0, STARTER_COLORS.indexOf(start.color as (typeof STARTER_COLORS)[number])))
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

/**
 * The 3D bench's model (workbench.glb) still carries the old sewing heads, until it is remade from
 * the Blender figures. Until then each build shows the old head of
 * the same shape there, and each item the old piece that rewarded the same quest.
 */
export const BENCH_HEAD: Record<FigureKind, string> = { chubby: 'yarn', tall: 'spool', wide: 'button', little: 'thimble', egg: 'pincushion', slim: 'cone' }
export const BENCH_ITEM: Record<Accessory, string> = {
  striped_top: 'tee', cardigan: 'overalls', black_dress: 'apron', trench_coat: 'vest', ballet_flats: 'cushion',
  gloves: 'pin', coffee: 'band', collar: 'patch', silk_scarf: 'shuttle', beret: 'monocle', bow: 'chalk',
}

/** Its portrait, rendered in Blender, in its state's pose: for cards and the picker. */
export function figureStill(figure: FigureChoice, state: FigureState = 'ready'): string {
  return `/agent/figures/${figure.kind}-${figure.color}${posed(state)}.webp`
}

/** Where the figure shows when it wears `garment`, in that state, as an alpha mask the size of the
    still: the bare still is drawn through it under the garment's layer, so its fur never stands round
    clothes that would cover it. A garment is fabric settled on the figure by the figure pipeline. */
export function garmentMask(kind: FigureKind, garment: Garment, state: FigureState = 'ready'): string {
  return `/agent/masks/${kind}-${garment}${posed(state)}.webp`
}

/** Its job sign, drawn in a neutral grey to be tinted to the figure's colour (`signTint`), the size of
    the still and laid over it. */
export function signStill(kind: FigureKind, sign: Sign, state: FigureState = 'ready'): string {
  return `/agent/signs/${kind}-${sign}${posed(state)}.webp`
}

/** The colour a sign is tinted to: the head's own colour, so the sign reads as the same velvet. */
export function signTint(color: FigureColor): string {
  return SIGN_TINT[color]
}

/** The figure in words, for its picture's alt text. */
export function figureWords(figure: FigureChoice): string {
  return `${COLOR_NAMES[figure.color].toLowerCase()} ${FIGURE_NAMES[figure.kind].toLowerCase()}`
}
