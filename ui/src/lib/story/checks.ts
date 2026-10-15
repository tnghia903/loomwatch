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
