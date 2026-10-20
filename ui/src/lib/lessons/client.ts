import { daemonFetch } from '../daemonFetch'
import { readRun } from '../runs/client'

/**
 * What an agent learned from your feedback on its work (ADR 0078, `crates/…/lessons.rs`): one
 * sentence each, in its standing instructions from its next work on. Learned only from something
 * outside the agent: your own words about a finished answer, or a check that found a Done when item
 * not met and then met after the send-back. Each shows where it came from; Undo takes it back.
 */
export interface Lesson {
  id: string
  /** Whose list: `agent:<id>` for one of My agents, `team:<scope>#<agent>` for a team's own. */
  scope: string
  agentId: string
  text: string
  /** `you`: your words. `check`: the check's missed-then-met item. */
  source: 'you' | 'check'
  /** What it was learned from, as you saw it: your words, or the check's item and finding. */
  feedback: string
  /** The piece of work the feedback was about. */
  runId: string | null
  state: 'active' | 'dropped' | 'replaced'
  replaces?: string
  droppedBy?: 'you' | 'learning' | 'room'
  /** Pieces of work it was given in. */
  given: number
  /** Of those, the ones whose answer you marked Good or Love it. */
  backed: number
  /** Later feedback said the agent did it again although it had this lesson. */
  missed: number
  createdAt: string
  updatedAt: string
}

/** Whose lessons: an agent in a team file, or one of My agents, the same in every team. */
export type LessonsOf = { teamPath: string; agent: string } | { savedAgent: string }

export interface AgentLessons {
  scope: string
  /** It learns from feedback: off when the team file says `learns: false`. */
  learns: boolean
  /** The most it keeps; past this the least backed makes room. */
  max: number
  lessons: Lesson[]
}

const whose = (of: LessonsOf): Record<string, string> => ('savedAgent' in of ? { savedAgent: of.savedAgent } : { teamPath: of.teamPath, agent: of.agent })

export async function fetchLessons(of: LessonsOf, signal?: AbortSignal): Promise<AgentLessons> {
  const query = new URLSearchParams(whose(of))
  const response = await daemonFetch(`/api/lessons?${query.toString()}`, { signal, cache: 'no-store' })
  return readRun<AgentLessons>(response)
}

/** Take a lesson back. One that changed another brings the old one back. */
export async function undoLesson(of: LessonsOf, id: string): Promise<{ undone: Lesson; lessons: Lesson[] }> {
  const response = await daemonFetch('/api/lessons/undo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...whose(of), id }),
    cache: 'no-store',
  })
  return readRun<{ undone: Lesson; lessons: Lesson[] }>(response)
}

/** Put a lesson in your own words. */
export async function rewriteLesson(of: LessonsOf, id: string, text: string): Promise<{ lesson: Lesson }> {
  const response = await daemonFetch('/api/lessons', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...whose(of), id, text }),
    cache: 'no-store',
  })
  return readRun<{ lesson: Lesson }>(response)
}

/** Where a lesson came from, in a few words: "From your reply" or "From the check". */
export function learnedFrom(lesson: Pick<Lesson, 'source'>): string {
  return lesson.source === 'check' ? 'From the check' : 'From what you said'
}
