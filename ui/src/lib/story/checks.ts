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
}

const VERDICTS = new Set(['met', 'not_met', 'not_sure'])

/** The latest round of every check step in the run, in the order they first reported. */
export function checkRounds(events: readonly Pick<RunEvent, 'agentId' | 'kind' | 'payload' | 'seq'>[], throughSeq = Infinity): CheckRound[] {
  const rounds = new Map<string, CheckRound>()
  for (const event of events) {
    if (event.seq > throughSeq) break
    const payload = event.payload
    if (event.kind !== 'session_meta' || payload.phase !== 'check_result' || typeof payload.checked !== 'string' || !Array.isArray(payload.items)) continue
    const items = payload.items.flatMap((raw): CheckItemResult[] => {
      if (typeof raw !== 'object' || raw === null) return []
      const { verdict, item, evidence } = raw as Record<string, unknown>
      return typeof verdict === 'string' && VERDICTS.has(verdict) && typeof item === 'string'
        ? [{ verdict: verdict as CheckItemResult['verdict'], item, evidence: typeof evidence === 'string' ? evidence : '' }]
        : []
    })
    rounds.set(`${event.agentId}>${payload.checked}`, { checker: event.agentId, checked: payload.checked, round: typeof payload.round === 'number' ? payload.round : 1, items })
  }
  return [...rounds.values()]
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
