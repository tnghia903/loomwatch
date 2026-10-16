import { useEffect, useState } from 'react'
import { appendEvents, parseEvents, type RunEvent } from './events'

export async function readArchive<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-store' })
  const body: unknown = await response.json()
  if (!response.ok) {
    const message = typeof body === 'object' && body && 'error' in body ? String(body.error) : `Archive request failed (${response.status}).`
    throw new Error(message)
  }
  return body as T
}

/** The most the archive returns per page (watch_api.rs). */
const PAGE = 500

/**
 * A session's evidence: the archive read whole, then followed live. `loading` holds until that
 * first read is done; the pages are shown together, so a finished run opens finished rather than
 * rebuilding itself page by page.
 */
export function useSessionEvents(sessionId: string) {
  const [state, setState] = useState<{ sessionId: string; events: RunEvent[]; error: string | null; connected: boolean; loading: boolean }>({ sessionId, events: [], error: null, connected: false, loading: Boolean(sessionId) })
  useEffect(() => {
    if (!sessionId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    let socket: WebSocket | null = null
    let events: RunEvent[] = []
    let pending: RunEvent[] = []
    let retry = 1000
    let stopped = false
    let live = false
    function verify(current: RunEvent[], page: RunEvent[]) {
      const next = appendEvents(current, page, sessionId)
      if (next.length > 50_000) {
        stopped = true
        if (socket) { socket.onclose = null; socket.close() }
        throw new Error('The browser replay limit is 50,000 events. Export this session with loomwatchd show for full inspection.')
      }
      return next
    }
    function publish(next: RunEvent[]) {
      events = next
      setState({ sessionId, events, error: null, connected: live, loading: false })
    }
    function failure(error: unknown) {
      live = false
      if (controller.signal.aborted) return
      setState({ sessionId, events, error: error instanceof Error ? error.message : String(error), connected: false, loading: false })
      if (!stopped) {
        clearTimeout(timer)
        timer = setTimeout(() => void connect(), retry)
        retry = Math.min(retry * 2, 30_000)
      }
    }
    function flush() {
      flushTimer = undefined
      const batch = pending
      pending = []
      if (controller.signal.aborted) return
      try { publish(verify(events, batch)) } catch (error) {
        if (socket) { socket.onclose = null; socket.close() }
        failure(error)
      }
    }
    async function connect() {
      let recovered = events
      try {
        // Recover from the archive, then stream after the last verified sequence.
        for (;;) {
          const query = new URLSearchParams({ session: sessionId, afterSeq: String(recovered.at(-1)?.seq ?? -1), limit: String(PAGE) })
          const page = parseEvents(await readArchive(`/api/session/events?${query}`, controller.signal))
          if (controller.signal.aborted) return
          recovered = verify(recovered, page)
          if (page.length < PAGE) break
        }
        publish(recovered)
        const url = new URL('/api/session/stream', window.location.href)
        url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        url.search = new URLSearchParams({ session: sessionId, afterSeq: String(events.at(-1)?.seq ?? -1) }).toString()
        socket = new WebSocket(url)
        socket.onopen = () => { live = true; retry = 1000; setState({ sessionId, events, error: null, connected: true, loading: false }) }
        socket.onmessage = (message) => {
          try {
            pending.push(...parseEvents([JSON.parse(String(message.data))]))
            flushTimer ??= setTimeout(flush, 50)
          } catch (error) {
            clearTimeout(flushTimer)
            flushTimer = undefined
            pending = []
            if (socket) { socket.onclose = null; socket.close() }
            failure(error)
          }
        }
        socket.onclose = () => {
          live = false
          clearTimeout(flushTimer)
          flushTimer = undefined
          // Unpublished frames are replayed from the unchanged verified cursor.
          pending = []
          failure(new Error('Live connection lost. Recovering from the archive…'))
        }
        socket.onerror = () => socket?.close()
      } catch (error) {
        // A read that fails part-way keeps the pages it verified, and the retry continues after them.
        events = recovered
        failure(error)
      }
    }
    void connect()
    return () => {
      controller.abort()
      clearTimeout(timer)
      clearTimeout(flushTimer)
      if (socket) { socket.onclose = null; socket.close() }
    }
  }, [sessionId])
  return state.sessionId === sessionId ? state : { sessionId, events: [], error: null, connected: false, loading: Boolean(sessionId) }
}
