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

export function useSessionEvents(sessionId: string) {
  const [state, setState] = useState<{ sessionId: string; events: RunEvent[]; error: string | null; connected: boolean }>({ sessionId, events: [], error: null, connected: false })
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
    function publish(page: RunEvent[]) {
      const next = appendEvents(events, page, sessionId)
      if (next.length > 50_000) {
        stopped = true
        if (socket) { socket.onclose = null; socket.close() }
        throw new Error('The browser replay limit is 50,000 events. Export this session with loomwatchd show for full inspection.')
      }
      events = next
      setState({ sessionId, events, error: null, connected: live })
    }
    function failure(error: unknown) {
      live = false
      if (controller.signal.aborted) return
      setState({ sessionId, events, error: error instanceof Error ? error.message : String(error), connected: false })
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
      try { publish(batch) } catch (error) {
        if (socket) { socket.onclose = null; socket.close() }
        failure(error)
      }
    }
    async function connect() {
      try {
        // Recover from the archive, then stream after the last verified sequence.
        const query = new URLSearchParams({ session: sessionId, afterSeq: String(events.at(-1)?.seq ?? -1), limit: '200' })
        const page = parseEvents(await readArchive(`/api/session/events?${query}`, controller.signal))
        if (controller.signal.aborted) return
        publish(page)
        if (page.length === 200) { timer = setTimeout(() => void connect(), 0); return }
        const url = new URL('/api/session/stream', window.location.href)
        url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        url.search = new URLSearchParams({ session: sessionId, afterSeq: String(events.at(-1)?.seq ?? -1) }).toString()
        socket = new WebSocket(url)
        socket.onopen = () => { live = true; retry = 1000; setState({ sessionId, events, error: null, connected: true }) }
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
      } catch (error) { failure(error) }
    }
    void connect()
    return () => {
      controller.abort()
      clearTimeout(timer)
      clearTimeout(flushTimer)
      if (socket) { socket.onclose = null; socket.close() }
    }
  }, [sessionId])
  return state.sessionId === sessionId ? state : { sessionId, events: [], error: null, connected: false }
}
