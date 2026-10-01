import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { projectRun, type RunProjection } from '../watch/events'
import { useSessionEvents } from '../watch/useSessionEvents'
import { isTerminalRun, useRunRecord } from './client'

export type ViewMode = 'live' | 'replay'

/**
 * One run, as the canvas sees it: the registry record (while the daemon still knows the
 * run), the exact archive evidence (recovered, then followed), and the pure projection at
 * the replay cursor. `cursor === null` follows the newest evidence.
 */
export function useRunSession(runId: string | null, responder: string | null) {
  const { record, missing, apply: applyRecord } = useRunRecord(runId)
  const { events, error, connected } = useSessionEvents(runId ?? '')
  const [cursor, setCursorState] = useState<number | null>(null)
  const previousRun = useRef(runId)

  useEffect(() => {
    if (previousRun.current !== runId) {
      previousRun.current = runId
      setCursorState(null)
    }
  }, [runId])

  const lastSeq = events.length > 0 ? events[events.length - 1].seq : -1
  const through = cursor === null ? Infinity : cursor
  // The no-canonical-response classification (CONTRACT §4) is only safe when the run
  // cannot produce more evidence: a terminal registry record with every archived event
  // already delivered, or a run the daemon no longer knows.
  const evidenceComplete = record
    ? isTerminalRun(record.status) && (record.eventCount === null || events.length >= record.eventCount)
    : missing
  const context = useMemo(() => ({ responder: record?.responder ?? responder, status: record?.status ?? null, error: record?.error ?? null, evidenceComplete }), [responder, record?.responder, record?.status, record?.error, evidenceComplete])
  const projection: RunProjection = useMemo(() => projectRun(events, through, context), [events, through, context])
  const latest: RunProjection = useMemo(() => (cursor === null ? projection : projectRun(events, Infinity, context)), [cursor, projection, events, context])

  const registryTerminal = isTerminalRun(record?.status)
  const eventsTerminal = ['succeeded', 'partial', 'failed', 'cancelled'].includes(latest.phase)
  // A run the daemon no longer remembers (restart) is history: its evidence decides.
  const terminal = registryTerminal || (missing || !record ? eventsTerminal : false)
  const mode: ViewMode = cursor !== null || terminal ? 'replay' : 'live'

  const setCursor = useCallback((seq: number | null) => {
    setCursorState(seq === null || seq >= lastSeq ? null : Math.max(0, seq))
  }, [lastSeq])

  return { record, applyRecord, missing, events, error, connected, projection, latest, cursor, setCursor, lastSeq, mode, terminal }
}
