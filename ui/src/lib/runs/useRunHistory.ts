import { useCallback, useEffect, useRef, useState } from 'react'

import type { SessionSummary } from '../watch/events'
import { readArchive } from '../watch/useSessionEvents'
import { fetchRuns, isTerminalRun, RunApiError, type RunRecord } from './client'

/**
 * The run history behind the composer's history button: live registry records merged with
 * archived sessions. Polled slowly in the background (so a run started elsewhere shows up)
 * and quickly while the popover is open.
 */
export function useRunHistory(open: boolean) {
  const [records, setRecords] = useState<RunRecord[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const generation = useRef(0)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const mine = ++generation.current
    try {
      const [runs, archived] = await Promise.all([
        fetchRuns(signal),
        readArchive<SessionSummary[]>('/api/sessions', signal).catch((caught: unknown) => { throw caught }),
      ])
      if (signal?.aborted || mine !== generation.current) return
      setRecords(runs)
      setSessions(archived)
      setError(null)
      setUnavailable(null)
    } catch (caught) {
      if (signal?.aborted) return
      if (caught instanceof RunApiError && caught.status === 503) { setUnavailable(caught.message); setError(null) }
      else setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (!signal?.aborted) setLoaded(true)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const live = records.some((record) => !isTerminalRun(record.status))
    const interval = open ? 3000 : live ? 5000 : 20000
    const tick = async () => {
      await refresh(controller.signal)
      if (!controller.signal.aborted) timer = setTimeout(() => void tick(), interval)
    }
    void tick()
    return () => { controller.abort(); clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refresh, records.some((record) => !isTerminalRun(record.status))])

  return { records, sessions, error, unavailable, loaded, refresh }
}
