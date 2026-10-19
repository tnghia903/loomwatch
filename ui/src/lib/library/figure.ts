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
 * - `tools`: the tool drawer, right of the nameplate, holding a tile with its own icon for each tool
 *   (MCP server) it is given, in its builder or with a line on the canvas.
 *   What it reads is given the same two ways: in its builder, for every team it joins, and by a
 *   team with a line on the canvas (ADR 0042).
 * - `keys`: keys on the pegboard hooks go ahead without asking; the ones in your dish ask you first.
 * - `reply`: the tray where what it hands back lands.
 *
 * Its motion is a reaction to a change you just made, or what the run in its chat says: every pose
 * is something the run shows, never a feeling it guesses.
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
  /** Which folder, file or page it is (lib/library/reads.ts `readKey`), whatever it is called. */
  key?: string
}

/** How many fit in the drawer; more still count, they just aren't filed in it. */
export const READ_SLOTS = 4

/** How many tools' tiles fit in the tool drawer; more tools still count, they just aren't in it. */
export const TOOL_SLOTS = 4

/**
 * What the figure is doing, from the run in its chat only: its record, and when it last moved.
 *
 * - `still`: no run on the bench.
 * - `starting`: the run is starting.
 * - `working`: the run is live and one of its events arrived in the last few seconds.
 * - `quiet`: the run is live and no event has arrived for a while.
 *   While it is live, what it is at (`WorkPhase`, from the run's events) says what it acts out.
 * - `asking`: it waits on you, for a permission or an answer (a hand up).
 * - `done`, `failed`, `stopped`: how the run ended.
 */
export type FigureMood = 'still' | 'starting' | 'working' | 'quiet' | 'asking' | 'done' | 'failed' | 'stopped'

/** A run that moved this recently counts as working; quieter than that, it is quiet. */
export const WORKING_WINDOW_MS = 3000

/**
 * What the agent is at while its run is live, from the run's events (lib/watch/workPhase.ts), as
 * its figure acts it out and its chat shows it:
 *
 * - `reading`: it reads the message it was given, before anything comes back from its model.
 * - `thinking`: its model reasons, or is quiet working out what to do next. A bulb glows over its head.
 * - `tools`: it uses a tool (a web search, a file, a command): it works at its laptop, whose
 *   screen flashes.
 * - `typing`: it writes its reply, and the chat shows it typing.
 */
export type WorkPhase = 'reading' | 'thinking' | 'tools' | 'typing'

/**
 * The short actions a figure takes in turn while it works, so it is never still for long. Each
 * phase has its own, picked by weight: it reads its message or its job sheet; it scratches its
 * head, rests its chin on a hand or looks up while it thinks; it clicks, types or leans in to the
 * screen while it uses a tool; and it types its reply, nodding now and then.
 */
export type BusyKind = 'read' | 'checkJob' | 'scratch' | 'ponder' | 'lookUp' | 'click' | 'peer' | 'type' | 'nod'

export const BUSY: Record<WorkPhase, readonly { kind: BusyKind; weight: number }[]> = {
  reading: [{ kind: 'read', weight: 3 }, { kind: 'checkJob', weight: 1 }],
  thinking: [{ kind: 'scratch', weight: 3 }, { kind: 'ponder', weight: 3 }, { kind: 'lookUp', weight: 2 }],
  tools: [{ kind: 'click', weight: 3 }, { kind: 'type', weight: 2 }, { kind: 'peer', weight: 2 }],
  typing: [{ kind: 'type', weight: 5 }, { kind: 'nod', weight: 1 }],
}

/** How long each action lasts, in seconds: somewhere between the two. */
export const BUSY_SECONDS: Record<BusyKind, readonly [number, number]> = {
  read: [3, 4.5], checkJob: [2.2, 2.8], scratch: [2.4, 3.2], ponder: [3.5, 5], lookUp: [3, 4], click: [2.5, 4], peer: [2.5, 3.5], type: [2.5, 5], nod: [1.4, 1.8],
}

/** Reading and typing carry on from one stretch to the next; anything else is not done twice in a row. */
const CARRIES_ON: ReadonlySet<BusyKind> = new Set(['read', 'type'])

/**
 * Something on the bench its agent just used, for its figure to go and get: a skill's recipe card
 * from the pegboard, a folder or file from the reads drawer, or a tool's tile from the tool drawer.
 * `id` is the run event that used it, so each use is fetched once.
 */
export interface BenchUse {
  kind: 'skill' | 'read' | 'tool'
  /** The skill's or the tool's name, or what it reads (ReadSource.name). */
  name: string
  id: string
}

/** The next action in `phase`, after `last`, for a roll of the dice in [0, 1). */
export function nextBusy(phase: WorkPhase, last: BusyKind | null, roll: number): BusyKind {
  const pool = BUSY[phase].filter(({ kind }) => kind !== last || CARRIES_ON.has(kind))
  const total = pool.reduce((sum, { weight }) => sum + weight, 0)
  let at = Math.min(Math.max(roll, 0), 0.999999) * total
  for (const { kind, weight } of pool) {
    if (at < weight) return kind
    at -= weight
  }
  return pool[pool.length - 1].kind
}

export function figureMood(record: Pick<RunRecord, 'status' | 'permissionRequests' | 'waitingOn' | 'spendStops'> | null, lastMoveAt: number | null, now: number): FigureMood {
  if (!record) return 'still'
  switch (record.status) {
    case 'queued':
    case 'starting':
      return 'starting'
    case 'running':
      if ((record.permissionRequests?.length ?? 0) > 0 || (record.spendStops?.length ?? 0) > 0 || record.waitingOn) return 'asking'
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
