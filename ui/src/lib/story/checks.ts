import type { RunEvent } from '../watch/events'

/** One item a check step judged (ADR 0062), as the daemon recorded it from its `## Check` block. */
export interface CheckItemResult {
  verdict: 'met' | 'not_met' | 'not_sure'
  item: string
  evidence: string
}

/** A check step's result on one agent's work: the last round it ran (a send-back makes a second). */
export interface CheckRound {
  checker: string
  checked: string
  round: number
  items: CheckItemResult[]
  /** False when the check step's reply had no `## Check` block to read: its Not sure items say
      nothing about the work. Absent when it could be, and on runs recorded before the daemon said. */
  readable?: false
  /** The first round's items, when a send-back made this a later one: what it found before the
      work was sent back. */
  first?: CheckItemResult[]
  /** You approved the work as it was at the check step's stop, with checks still not met
      (`check_approved`, ADR 0062). */
  approved?: true
}

const VERDICTS = new Set(['met', 'not_met', 'not_sure'])

/** The items a check record lists, as far as they can be read. */
export function checkItemsOf(items: unknown): CheckItemResult[] {
  if (!Array.isArray(items)) return []
  return items.flatMap((raw): CheckItemResult[] => {
    if (typeof raw !== 'object' || raw === null) return []
    const { verdict, item, evidence } = raw as Record<string, unknown>
    return typeof verdict === 'string' && VERDICTS.has(verdict) && typeof item === 'string'
      ? [{ verdict: verdict as CheckItemResult['verdict'], item, evidence: typeof evidence === 'string' ? evidence : '' }]
      : []
  })
}

/** The latest round of every check step in the run, in the order they first reported, with its first. */
export function checkRounds(events: readonly Pick<RunEvent, 'agentId' | 'kind' | 'payload' | 'seq'>[], throughSeq = Infinity): CheckRound[] {
  const rounds = new Map<string, CheckRound>()
  const firsts = new Map<string, CheckItemResult[]>()
  for (const event of events) {
    if (event.seq > throughSeq) break
    const payload = event.payload
    if (event.kind === 'session_meta' && payload.phase === 'check_approved' && typeof payload.checked === 'string') {
      const approved = rounds.get(`${event.agentId}>${payload.checked}`)
      if (approved) approved.approved = true
      continue
    }
    if (event.kind !== 'session_meta' || payload.phase !== 'check_result' || typeof payload.checked !== 'string' || !Array.isArray(payload.items)) continue
    const key = `${event.agentId}>${payload.checked}`
    const round = typeof payload.round === 'number' ? payload.round : 1
    const items = checkItemsOf(payload.items)
    if (round === 1) firsts.set(key, items)
    rounds.set(key, { checker: event.agentId, checked: payload.checked, round, items, ...(payload.readable === false ? { readable: false as const } : {}) })
  }
  return [...rounds.entries()].map(([key, round]) => {
    const first = round.round > 1 ? firsts.get(key) : undefined
    return first ? { ...round, first } : round
  })
}

/**
 * What a send-back did: how many problems the first round found, and how many of those the last
 * round met. `null` when the work was never sent back.
 */
export function checkProgress(round: CheckRound): { found: number; fixed: number } | null {
  if (!round.first) return null
  const missed = round.first.filter((item) => item.verdict === 'not_met')
  if (missed.length === 0) return null
  const met = new Set(round.items.filter((item) => item.verdict === 'met').map((item) => item.item))
  return { found: missed.length, fixed: missed.filter((item) => met.has(item.item)).length }
}

/**
 * What the answer's author set aside for you rather than for its reader (ADR 0062): the Done when
 * items it could not meet, what it needed and was not given, and after a send-back, the findings it
 * kept its work against. The daemon takes them off the end of the answer, so what is delivered and
 * copied is the work alone.
 */
export interface AnswerNotes {
  agentId: string
  notMet: string[]
  /** What it needed and was not given: the Writer job's "Missing" list. */
  missing: string[]
  notChanged: string[]
}

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [])

/** The run's answer notes, `null` when its answer had none. */
export function answerNotes(events: readonly Pick<RunEvent, 'agentId' | 'kind' | 'payload' | 'seq'>[], throughSeq = Infinity): AnswerNotes | null {
  let notes: AnswerNotes | null = null
  for (const event of events) {
    if (event.seq > throughSeq) break
    if (event.kind !== 'session_meta' || event.payload.phase !== 'answer_notes') continue
    notes = { agentId: event.agentId, notMet: strings(event.payload.not_met), missing: strings(event.payload.missing), notChanged: strings(event.payload.not_changed) }
  }
  return notes
}
