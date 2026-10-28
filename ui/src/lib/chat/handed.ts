import { splitPath } from '../files/paths'
import { helperOf } from './helpers'
import type { Evidence } from '../watch/events'

/** What a written file is read from: the call that wrote it. */
type Write = Pick<Evidence, 'agentId' | 'toolKind' | 'status' | 'declined' | 'locations' | 'ts'>

/**
 * What a finished piece of work hands over (ADR 0077): the files its answer names, those the work
 * wrote, and whether its answer is long enough to be read as a document.
 */
export interface HandOver {
  runId: string
  files: readonly string[]
  written: readonly string[]
  document: boolean
}

/** Files an agent handed over in the chat: who, which, and when it last wrote one of them. */
export interface Handed {
  agent: string
  files: string[]
  at: string
}

/**
 * The files among `files` — those an answer names — that an agent other than `responder` wrote,
 * grouped by the agent that wrote each last, in the order they finished: who hands each one over
 * in the team's chat (ADR 0051). A file nobody on the team was recorded writing, or that a helper
 * wrote for its agent, stays with the answer that names it.
 */
export function handedBy(files: readonly string[], evidence: readonly Write[], responder: string): Handed[] {
  const writes = evidence.filter((item) => item.toolKind === 'edit' && !item.declined && item.status !== 'failed' && item.status !== 'rejected')
  const groups: Handed[] = []
  for (const path of files) {
    const wrote = writes.findLast((item) => item.locations.some((location) => samePath(location.path, path)))
    if (!wrote?.agentId || wrote.agentId === responder || helperOf(wrote.agentId)) continue
    const group = groups.find((each) => each.agent === wrote.agentId)
    if (!group) groups.push({ agent: wrote.agentId, files: [path], at: wrote.ts })
    else {
      group.files.push(path)
      if (wrote.ts > group.at) group.at = wrote.ts
    }
  }
  return groups.sort((left, right) => left.at.localeCompare(right.at))
}

/**
 * One file written two ways: in full, and from the folder an agent works in (`guide.md` and
 * `/Users/ana/…/writer/guide.md`), with either separator.
 */
function samePath(left: string, right: string): boolean {
  const [short, long] = [splitPath(left), splitPath(right)].sort((one, other) => one.length - other.length)
  return short.length > 0 && short.every((name, index) => name === long[long.length - short.length + index])
}
