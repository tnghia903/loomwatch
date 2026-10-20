import { useCallback, useEffect, useRef, useState } from 'react'

import { keepIfSame } from '../keepIfSame'
import { fetchRuns, isTerminalRun, RunApiError, type RunRecord } from './client'

/**
 * Every run the daemon knows, for the run view's attempt numbers ("Retry of Run 02"). Polled slowly
 * in the background, so a run started elsewhere counts, and more often while one is live. The
 * archive's session list is not read: a session the daemon has forgotten names no team, so it never
 * counts, and that list carries each run's whole prompt.
 */
export function useRunHistory() {
  const [records, setRecords] = useState<RunRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const generation = useRef(0)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const mine = ++generation.current
    try {
      const runs = await fetchRuns(signal)
      if (signal?.aborted || mine !== generation.current) return
      setRecords((previous) => keepIfSame(previous, runs))
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

  const live = records.some((record) => !isTerminalRun(record.status))
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const interval = live ? 5000 : 20000
    const tick = async () => {
      await refresh(controller.signal)
      if (!controller.signal.aborted) timer = setTimeout(() => void tick(), interval)
    }
    void tick()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [live, refresh])

  return { records, error, unavailable, loaded, refresh }
}
