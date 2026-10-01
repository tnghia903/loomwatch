import type { AgentStatus } from '../team-file/types'
import type { TaskState } from '../watch/events'

/**
 * Agent marks: a small woven swatch that identifies one agent everywhere it appears, and moves
 * only when the run record says that agent is doing something.
 *
 * Identity is the weave itself — three warp threads, three weft threads, and which one lies on top
 * at each of the nine crossings — derived from the agent's id, so the same agent always wears the
 * same swatch and two agents on one team almost never share one. No vendor colour and no face:
 * the mark says *who*, and the motion says *what is happening now*, nothing more.
 */
export interface MarkPattern {
  /** Row-major, 3 × 3: `true` where the weft (gold) crosses over the warp. */
  over: boolean[]
  /** A stable number for this agent, for choosing where an event's stitch lands. */
  seed: number
}

/** FNV-1a: small, stable, and spreads similar ids ("codex", "codex-2") far apart. */
export function hashId(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function markPattern(id: string): MarkPattern {
  const seed = hashId(id)
  let over = Array.from({ length: 9 }, (_, index) => Boolean((seed >>> index) & 1))
  // A swatch only reads as cloth when both threads show: keep between three and six overs by
  // folding in a fixed checkerboard when the hash is lopsided.
  const count = over.filter(Boolean).length
  if (count < 3 || count > 6) over = over.map((value, index) => value !== (index % 2 === 0))
  return { over, seed }
}

/**
 * What a mark shows, from the recorded run state only.
 *
 * - `still` — no run on screen (Build): the full swatch, at rest.
 * - `turn` — the run has not reached this agent yet: faint, unwoven.
 * - `starting`, `thinking`, `working` (a tool call), `writing` (streaming its reply) — live.
 * - `waiting` — parked on the operator.
 * - `done`, `failed`, `stopped` — settled.
 */
export type MarkState = 'still' | 'turn' | 'starting' | 'thinking' | 'working' | 'writing' | 'waiting' | 'done' | 'failed' | 'stopped'

export function markState(runtime: { status: AgentStatus; taskState?: TaskState } | null | undefined): MarkState {
  if (!runtime) return 'still'
  switch (runtime.status) {
    case 'starting': return 'starting'
    case 'running':
      return runtime.taskState === 'THINKING' ? 'thinking' : runtime.taskState === 'STREAMING' ? 'writing' : 'working'
    case 'waiting': return 'waiting'
    case 'succeeded': return 'done'
    case 'failed':
    case 'unavailable': return 'failed'
    case 'stopped': return 'stopped'
    default: return 'turn'
  }
}

/** The same state in words, for screen readers and the mark's tooltip. */
export const MARK_WORDS: Record<MarkState, string> = {
  still: '',
  turn: 'not started yet',
  starting: 'starting',
  thinking: 'thinking',
  working: 'using a tool',
  writing: 'writing its reply',
  waiting: 'waiting for you',
  done: 'done',
  failed: 'stopped with a problem',
  stopped: 'stopped',
}

/** Live states animate; settled ones only change their look. */
export const LIVE_MARK_STATES: ReadonlySet<MarkState> = new Set(['starting', 'thinking', 'working', 'writing', 'waiting'])

/** The crossing an event's stitch lands on: walks the swatch as events arrive. */
export function stitchCell(seed: number, events: number): number {
  return (seed + events * 7) % 9
}
