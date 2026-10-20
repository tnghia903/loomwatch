import { daemonFetch } from '../daemonFetch'
import { readRun } from '../runs/client'
import { announceYou, type AboutYou } from '../you/client'

/**
 * What an agent learned from your feedback on its work (ADR 0078, `crates/…/lessons.rs`): one
 * sentence each, in its standing instructions from its next work on. Learned only from something
 * outside the agent: your own words about a finished answer, an answer you marked Love it, or a
 * check that found a Done when item not met and then met after the send-back. Each shows where it
 * came from; Undo takes it back. A lesson about you rather than one job can go to About you
 * (ADR 0074), for every agent, when you say so: Tell all my agents.
 */
export interface Lesson {
  id: string
  /** Whose list: `agent:<id>` for one of My agents, `team:<scope>#<agent>` for a team's own. */
  scope: string
  agentId: string
  text: string
  /** `you`: your words. `check`: the check's missed-then-met item. `liked`: an answer you loved. */
  source: 'you' | 'check' | 'liked'
  /** It is about you, not one kind of work ("always write in Vietnamese"): it can go to About you. */
  aboutYou: boolean
  /** What it was learned from, as you saw it: your words, or the check's item and finding. */
  feedback: string
  /** The piece of work the feedback was about. */
  runId: string | null
  state: 'active' | 'dropped' | 'replaced'
  replaces?: string
  /** `about_you`: Tell all my agents moved it to About you. */
  droppedBy?: 'you' | 'learning' | 'room' | 'about_you'
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

/** Tell all my agents moved it to About you: every agent follows it, and Undo moves it back. */
export function inAboutYou(lesson: Pick<Lesson, 'state' | 'droppedBy'>): boolean {
  return lesson.state === 'dropped' && lesson.droppedBy === 'about_you'
}

/** What Tell all my agents, or its Undo, did: the lesson, the agent's list, and About you now. */
export interface Told {
  lesson: Lesson
  lessons: Lesson[]
  you: AboutYou
}

async function tell(path: string, of: LessonsOf, id: string): Promise<Told> {
  const response = await daemonFetch(path, {
    method: 'POST',
    // It changes About you, which only LoomWatch's own page may (crates/…/you.rs).
    headers: { 'Content-Type': 'application/json', 'X-LoomWatch-Request': '1' },
    body: JSON.stringify({ ...whose(of), id }),
    cache: 'no-store',
  })
  const told = await readRun<Told>(response)
  // Home's line and the About you page show what every agent is told now.
  announceYou(told.you)
  return told
}

/**
 * Tell all my agents: a lesson about you goes into About you, which every agent reads, and leaves
 * this agent's list. Only on your click, after you said yes.
 */
export function tellAllAgents(of: LessonsOf, id: string): Promise<Told> {
  return tell('/api/lessons/tell-all', of, id)
}

/** Undo Tell all my agents: the lesson is back in the agent's list, and out of About you. */
export function undoTellAllAgents(of: LessonsOf, id: string): Promise<Told> {
  return tell('/api/lessons/tell-all/undo', of, id)
}

/** Where a lesson came from, in a few words: "From what you said", "From the check", "From your Love it". */
export function learnedFrom(lesson: Pick<Lesson, 'source'>): string {
  if (lesson.source === 'check') return 'From the check'
  if (lesson.source === 'liked') return 'From your Love it'
  return 'From what you said'
}
