import type { RunRecord } from '../runs/client'
import type { AllowSwitch } from '../team-file/types'

/**
 * Build by hand (AgentFigure): the agent as a figure at a workbench, doing the work.
 *
 * The figure is the one the agent wears (lib/library/figures.ts: a yarn ball, a spool, a button…),
 * a big head on a small body, typing on a laptop. It carries nothing: clicking it means the model,
 * the one thing about it you set. Everything else is on the bench, big enough to pick up:
 *
 * - `mind`: the figure itself, for the model it thinks with.
 * - `app`: the laptop it types on. Its lid names the app the agent works in.
 * - `name`: the nameplate on the front of the bench.
 * - `job`: the pattern on the clipboard, its instructions.
 * - `skills`: recipe cards pinned on the pegboard, one per skill.
 * - `reads`: the file drawer, left of the nameplate, open with a folder, file or page filed in it
 *   for each one it reads and shut when there is none.
 * - `tools`: the tool drawer, right of the nameplate, with a wrench standing in it for each tool
 *   (MCP server) it is given.
 *   The drawers hold what the team gives it with a line on the canvas (ADR 0042), so only a team's
 *   agent has them; what is its own (keys, skills) hangs on the wall.
 * - `keys`: keys on the pegboard hooks go ahead without asking; the ones in your dish ask you first.
 * - `reply`: the tray where what it hands back lands.
 *
 * Its scarf is woven in its mark (lib/story/mark.ts), the swatch it wears on the canvas. Its
 * motion is a reaction to a change you just made, or what the test bench's run record says: every
 * pose is something the record shows, never a feeling it guesses.
 */
export type FigurePart = 'mind' | 'app' | 'name' | 'job' | 'skills' | 'reads' | 'tools' | 'keys' | 'reply'

/**
 * The nodes in workbench.glb that stand for each part (the model's own names, as made in Blender).
 * The nearest named node wins, so the bench and the pegboard themselves, which stand for nothing,
 * stop the walk before it reaches the scene.
 */
const PART_PREFIXES: readonly [string, FigurePart | null][] = [
  ['nameplate', 'name'],
  ['laptop', 'app'],
  ['job', 'job'],
  ['card', 'skills'],
  ['key', 'keys'],
  ['hook', 'keys'],
  ['hooks', 'keys'],
  ['dish', 'keys'],
  ['tray', 'reply'],
  ['envelope', 'reply'],
  ['reads', 'reads'],
  ['tools', 'tools'],
  ['pegboard', null],
  ['bench', null],
  ['figure', 'mind'],
]

/** Which part a node of the model belongs to, from its own name or its nearest named ancestor's. */
export function partOfNode(names: readonly string[]): FigurePart | null {
  for (const name of names) {
    const found = PART_PREFIXES.find(([prefix]) => name === prefix || name.startsWith(`${prefix}_`))
    if (found) return found[1]
  }
  return null
}

/** The three keys, by the switch each one stands for, as the model names them. */
export const FIGURE_KEYS: readonly { key: AllowSwitch; node: string; word: string }[] = [
  { key: 'web', node: 'web', word: 'Web' },
  { key: 'edits', node: 'files', word: 'Files' },
  { key: 'commands', node: 'cmd', word: 'Commands' },
]

/** How many recipe cards fit on the pegboard; more skills than this still count, they just aren't pinned. */
export const CARD_SLOTS = 6

/** One thing it reads, as the drawer shows it: a linked folder, an added file, or a Notion page. */
export interface ReadSource {
  kind: 'folder' | 'file' | 'page'
  name: string
  /** Where it is, in words: the folder's or file's path, or that it is a Notion page. */
  where: string
}

/** How many fit in the drawer; more still count, they just aren't filed in it. */
export const READ_SLOTS = 4

/** How many wrenches fit in the tool drawer; more tools still count, they just aren't in it. */
export const TOOL_SLOTS = 4

/**
 * What the figure is doing, from the test bench's run record only.
 *
 * - `still`: no run on the bench.
 * - `starting`: the run is starting.
 * - `working`: the run is live and its record moved in the last few seconds (it types).
 * - `quiet`: the run is live and its record has not moved for a while: its hands rest on the keys.
 *   A quiet record says nothing about why (the model may be thinking, or waiting on the network),
 *   so the figure doesn't act out thinking.
 * - `asking`: it waits on you, for a permission or an answer (a hand up).
 * - `done`, `failed`, `stopped`: how the run ended.
 */
export type FigureMood = 'still' | 'starting' | 'working' | 'quiet' | 'asking' | 'done' | 'failed' | 'stopped'

/** A record that moved this recently counts as working; quieter than that, it is quiet. */
export const WORKING_WINDOW_MS = 3000

export function figureMood(record: Pick<RunRecord, 'status' | 'permissionRequests' | 'waitingOn'> | null, lastMoveAt: number | null, now: number): FigureMood {
  if (!record) return 'still'
  switch (record.status) {
    case 'queued':
    case 'starting':
      return 'starting'
    case 'running':
      if ((record.permissionRequests?.length ?? 0) > 0 || record.waitingOn) return 'asking'
      return lastMoveAt !== null && now - lastMoveAt < WORKING_WINDOW_MS ? 'working' : 'quiet'
    case 'succeeded':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'stopped'
  }
}

/** The key it is asking you for, when its first open request is one a switch would cover. */
export function askedKey(record: Pick<RunRecord, 'permissionRequests'> | null): AllowSwitch | null {
  return record?.permissionRequests?.find((request) => request.switch)?.switch ?? null
}

/** What the figure shows, for telling what changed between two moments. */
export interface FigureLook {
  name: string
  instructions: string
  app: string
  /** The model's id, or empty for the app's current one. */
  model: string
  skills: readonly string[]
  allow: Readonly<Partial<Record<AllowSwitch, boolean>>>
}

export type FigureReaction =
  | { kind: 'renamed' }
  | { kind: 'reread' }
  | { kind: 'rethought' }
  | { kind: 'rebenched' }
  | { kind: 'pinned'; skill: string }
  | { kind: 'unpinned'; skill: string }
  | { kind: 'key'; key: AllowSwitch; given: boolean }

/** The reactions a change from `before` to `after` calls for, one per thing that changed. */
export function reactionsBetween(before: FigureLook, after: FigureLook): FigureReaction[] {
  const out: FigureReaction[] = []
  if (before.name !== after.name) out.push({ kind: 'renamed' })
  if (before.instructions !== after.instructions) out.push({ kind: 'reread' })
  if (before.app !== after.app) out.push({ kind: 'rebenched' })
  if (before.model !== after.model || before.app !== after.app) out.push({ kind: 'rethought' })
  for (const skill of after.skills) if (!before.skills.includes(skill)) out.push({ kind: 'pinned', skill })
  for (const skill of before.skills) if (!after.skills.includes(skill)) out.push({ kind: 'unpinned', skill })
  for (const { key } of FIGURE_KEYS) {
    if (Boolean(before.allow[key]) !== Boolean(after.allow[key])) out.push({ kind: 'key', key, given: Boolean(after.allow[key]) })
  }
  return out
}
