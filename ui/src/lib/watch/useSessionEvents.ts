import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
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
 * The archive's query for a session's events after `afterSeq`. `lean` leaves out the app's raw
 * frame except on `message`, `session_meta` and `turn_end` events, the only ones whose frame the UI
 * reads: on a long run the frames of tool output alone are most of what would be downloaded and kept.
 */
export function eventsQuery(sessionId: string, afterSeq: number, limit?: number): URLSearchParams {
  const query = new URLSearchParams({ session: sessionId, afterSeq: String(afterSeq) })
  if (limit !== undefined) query.set('limit', String(limit))
  query.set('lean', 'true')
  return query
}

export interface SessionEventsState { sessionId: string; events: RunEvent[]; error: string | null; connected: boolean; loading: boolean }

/**
 * One session's evidence, shared by every view on the page that shows it: the archive is read once
 * and followed over one socket, however many views hold it. It is followed live only while a
 * holder wants more than the archive had (a run still going, or a finished run's last events still
 * on their way), and let go when the last holder is.
 */
class SharedSession {
  readonly sessionId: string
  state: SessionEventsState
  private readonly listeners = new Set<() => void>()
  private readonly controller = new AbortController()
  /** For each holder that follows: how many events it waits for, or `null` for as many as come. */
  private readonly followers = new Map<symbol, number | null>()
  private holders = 0
  private socket: WebSocket | null = null
  private events: RunEvent[] = []
  private pending: RunEvent[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private retry = 1000
  private stopped = false
  private live = false
  /** The archive was read whole (since the last failure), so a socket can start after it. */
  private recovered = false

  constructor(sessionId: string) {
    this.sessionId = sessionId
    this.state = { sessionId, events: [], error: null, connected: false, loading: true }
    void this.connect()
  }

  listen(notify: () => void) {
    this.listeners.add(notify)
    return () => { this.listeners.delete(notify) }
  }

  hold() { this.holders += 1 }

  /** Let go; the last holder ends the session once the current render has settled. */
  release() {
    this.holders -= 1
    // A view that moves (one unmounts as another mounts in the same commit) keeps the session.
    void Promise.resolve().then(() => {
      if (this.holders > 0 || sessions.get(this.sessionId) !== this) return
      sessions.delete(this.sessionId)
      this.close()
    })
  }

  follow(key: symbol, until: number | null) {
    this.followers.set(key, until)
    this.followLive()
  }

  unfollow(key: symbol) {
    this.followers.delete(key)
    this.followLive()
  }

  private wantsLive() {
    for (const until of this.followers.values()) if (until === null || this.events.length < until) return true
    return false
  }

  /** Opens the socket when a holder wants more than has arrived, and closes it when none does. */
  private followLive() {
    if (this.controller.signal.aborted || this.stopped) return
    if (this.wantsLive()) {
      if (!this.socket && this.recovered) this.open()
    } else if (this.socket) {
      this.closeSocket()
      this.live = false
      this.set({ connected: false })
    }
  }

  private set(next: Partial<SessionEventsState>) {
    this.state = { ...this.state, ...next }
    for (const notify of this.listeners) notify()
  }

  private verify(current: RunEvent[], page: RunEvent[]) {
    const next = appendEvents(current, page, this.sessionId)
    if (next.length > 50_000) {
      this.stopped = true
      this.closeSocket()
      throw new Error('The browser replay limit is 50,000 events. Export this session with loomwatchd show for full inspection.')
    }
    return next
  }

  private publish(next: RunEvent[]) {
    this.events = next
    this.set({ events: next, error: null, connected: this.live, loading: false })
  }

  private failure(error: unknown) {
    this.live = false
    this.recovered = false
    if (this.controller.signal.aborted) return
    this.set({ events: this.events, error: error instanceof Error ? error.message : String(error), connected: false, loading: false })
    if (!this.stopped) {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => void this.connect(), this.retry)
      this.retry = Math.min(this.retry * 2, 30_000)
    }
  }

  private flush() {
    this.flushTimer = undefined
    const batch = this.pending
    this.pending = []
    if (this.controller.signal.aborted) return
    try {
      this.publish(this.verify(this.events, batch))
      this.followLive()
    } catch (error) {
      this.closeSocket()
      this.failure(error)
    }
  }

  private async connect() {
    let recovered = this.events
    try {
      // Recover from the archive, then stream after the last verified sequence.
      for (;;) {
        const query = eventsQuery(this.sessionId, recovered.at(-1)?.seq ?? -1, PAGE)
        const page = parseEvents(await readArchive(`/api/session/events?${query}`, this.controller.signal))
        if (this.controller.signal.aborted) return
        recovered = this.verify(recovered, page)
        if (page.length < PAGE) break
      }
      this.recovered = true
      this.publish(recovered)
      this.followLive()
    } catch (error) {
      // A read that fails part-way keeps the pages it verified, and the retry continues after them.
      this.events = recovered
      this.failure(error)
    }
  }

  private open() {
    const url = new URL('/api/session/stream', window.location.href)
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    url.search = eventsQuery(this.sessionId, this.events.at(-1)?.seq ?? -1).toString()
    let socket: WebSocket
    try { socket = new WebSocket(url) } catch (error) { this.failure(error); return }
    this.socket = socket
    socket.onopen = () => { this.live = true; this.retry = 1000; this.set({ events: this.events, error: null, connected: true, loading: false }) }
    socket.onmessage = (message) => {
      try {
        this.pending.push(...parseEvents([JSON.parse(String(message.data))]))
        this.flushTimer ??= setTimeout(() => this.flush(), 50)
      } catch (error) {
        this.closeSocket()
        this.failure(error)
      }
    }
    socket.onclose = () => {
      this.socket = null
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
      // Unpublished frames are replayed from the unchanged verified cursor.
      this.pending = []
      this.failure(new Error('Live connection lost. Recovering from the archive…'))
    }
    socket.onerror = () => socket.close()
  }

  /** Closes the socket without treating it as lost; frames not yet shown come again on the next. */
  private closeSocket() {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.pending = []
    if (this.socket) { this.socket.onclose = null; this.socket.close() }
    this.socket = null
  }

  private close() {
    this.controller.abort()
    clearTimeout(this.timer)
    this.closeSocket()
  }
}

const sessions = new Map<string, SharedSession>()

function held(sessionId: string): SharedSession {
  let session = sessions.get(sessionId)
  if (!session) {
    session = new SharedSession(sessionId)
    sessions.set(sessionId, session)
  }
  session.hold()
  return session
}

/**
 * A session's evidence: the archive read whole, then followed live. `loading` holds until that
 * first read is done; the pages are shown together, so a finished run opens finished rather than
 * rebuilding itself page by page. Every view showing the same session shares one read and one
 * socket.
 *
 * `followUntil` is how many events the session will have in all once that is known (a finished
 * run's count): it is followed live only until they have all arrived, and a session already whole
 * in the archive opens no socket at all. Left out, it is followed for as long as it is shown.
 */
export function useSessionEvents(sessionId: string, followUntil: number | null = null): SessionEventsState {
  const placeholder = useMemo<SessionEventsState>(() => ({ sessionId, events: [], error: null, connected: false, loading: Boolean(sessionId) }), [sessionId])
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionId) return () => {}
    const session = held(sessionId)
    const stop = session.listen(notify)
    return () => { stop(); session.release() }
  }, [sessionId])
  const state = useSyncExternalStore(subscribe, () => (sessionId ? sessions.get(sessionId)?.state : undefined) ?? placeholder)
  const [key] = useState(() => Symbol('follower'))
  useEffect(() => {
    if (!sessionId) return
    const session = held(sessionId)
    return () => { session.unfollow(key); session.release() }
  }, [sessionId, key])
  // A changed count (the run just finished) updates what is waited for; the socket stays open.
  useEffect(() => {
    if (sessionId) sessions.get(sessionId)?.follow(key, followUntil)
  }, [sessionId, key, followUntil])
  return state.sessionId === sessionId ? state : placeholder
}
