import type { AgentRuntime } from '../runs/graph'
import type { AgentConfig } from '../team-file/types'
import { verbFor } from './teamSentence'

/**
 * Semantic zoom: how far the operator has leaned in decides what a card says.
 *
 * - **Story** (zoomed out, which is where "fit the team" usually lands on a large team): each card
 *   is a name and one plain sentence, in type big enough to read at that zoom.
 * - **Team** (around 100%): today's card — app, name, instructions, run state.
 * - **Trace** (zoomed in): the same card plus what an expert checks — id, model, command, folder,
 *   skills and the full instructions.
 *
 * Nothing is hidden behind a mode: depth is a place on the zoom slider, so a newcomer never has to
 * find a setting and an expert reaches the detail with the gesture they already use.
 */
export type Depth = 'story' | 'team' | 'trace'

export const DEPTHS: readonly Depth[] = ['story', 'team', 'trace']

/** The zoom each depth button jumps to. Inside the Build (0.35–1.5) and Run (0.1–2) ranges. */
export const DEPTH_ZOOM: Record<Depth, number> = { story: 0.55, team: 1, trace: 1.4 }

export function depthForZoom(zoom: number): Depth {
  if (zoom < 0.72) return 'story'
  if (zoom >= 1.25) return 'trace'
  return 'team'
}

export const DEPTH_LABEL: Record<Depth, { name: string; hint: string }> = {
  story: { name: 'Story', hint: 'Each helper in one sentence' },
  team: { name: 'Team', hint: 'Cards with app, instructions and status' },
  trace: { name: 'Trace', hint: 'Ids, models, commands, folders and full instructions' },
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** The one sentence a card says at Story depth: what it does, or, during a run, how it is doing. */
export function storyLine(agent: Pick<AgentConfig, 'name' | 'role' | 'kind'>, runtime?: Pick<AgentRuntime, 'status' | 'task'> | null): string {
  if (runtime) {
    switch (runtime.status) {
      case 'starting': return 'Getting ready…'
      case 'running': return runtime.task?.trim() ? capitalize(runtime.task.trim()) : 'Working…'
      case 'waiting': return agent.kind === 'operator' ? 'Waiting for your answer' : 'Waiting'
      case 'succeeded': return 'Done'
      case 'failed': return 'Stopped with a problem'
      case 'stopped': return 'Stopped'
      case 'unavailable': return 'Could not start'
      default: return 'Waiting its turn'
    }
  }
  if (agent.kind === 'operator') return 'Approves or sends work back'
  return capitalize(verbFor(agent))
}
