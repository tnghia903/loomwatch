import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { isTerminalRun, RunApiError, type RunRecord } from '../runs/client'
import { fetchChatPage, itemAt, itemKey, type ChatItem, type ChatMessage, type ChatTarget, type SendResult } from './client'

/** Newest items are re-read this often while something is working or waiting, and when idle. */
const LIVE_POLL_MS = 1500
const IDLE_POLL_MS = 8000
const PAGE = 20

/** A message you sent that the daemon has not answered yet, or refused. */
export interface PendingMessage {
  localId: string
  text: string
  to: ChatTarget
  now: boolean
  state: 'sending' | 'failed'
  error?: string
  sentAt: string
}

interface ChatState {
  teamPath: string | null
  /** Every item seen, by key. */
  byKey: Map<string, ChatItem>
  loaded: boolean
  error: string | null
  more: boolean
  loadingOlder: boolean
  /** The team's path as the daemon files it, relative to the teams root. */
  relativePath: string | null
}

const empty = (teamPath: string | null): ChatState => ({ teamPath, byKey: new Map(), loaded: false, error: null, more: false, loadingOlder: false, relativePath: null })

/**
 * One team's chat: pages of its work and notes from the daemon, kept fresh, plus what you just
 * sent so it shows at once. Oldest first, the way a chat reads.
 */
export function useTeamChat(teamPath: string | null) {
  const [state, setState] = useState<ChatState>(() => empty(teamPath))
  const [pending, setPending] = useState<PendingMessage[]>([])
  const [generation, setGeneration] = useState(0)
  const current = state.teamPath === teamPath ? state : empty(teamPath)
  if (state.teamPath !== teamPath) {
    setState(empty(teamPath))
    setPending([])
  }

  const items = useMemo(() => [...current.byKey.values()].sort((left, right) => itemAt(left).localeCompare(itemAt(right))), [current.byKey])
  const live = useMemo(() => items.flatMap((item) => (item.kind === 'work' && !isTerminalRun(item.run.status) ? [item.run] : [])), [items])
  const busy = live.length > 0 || pending.some((message) => message.state === 'sending')

  const merge = useCallback((path: string, incoming: ChatItem[], patch: Partial<ChatState> = {}) => {
    setState((previous) => {
      if (previous.teamPath !== path) return previous
      const byKey = new Map(previous.byKey)
      for (const item of incoming) byKey.set(itemKey(item), item)
      return { ...previous, ...patch, byKey }
    })
  }, [])

  const busyRef = useRef(busy)
  useEffect(() => { busyRef.current = busy }, [busy])

  // The newest page: read now, then again on a timer that is quick while the team works. Each
  // mount reads for itself: a read the previous mount aborted must not hold this one back.
  useEffect(() => {
    if (!teamPath) return
    let cancelled = false
    let timer = 0
    const controller = new AbortController()
    const read = async () => {
      try {
        const page = await fetchChatPage(teamPath, null, PAGE, controller.signal)
        if (cancelled) return
        setState((previous) => {
          if (previous.teamPath !== teamPath) return previous
          const byKey = new Map(previous.byKey)
          for (const item of page.items) byKey.set(itemKey(item), item)
          return { ...previous, byKey, loaded: true, error: null, more: previous.loaded ? previous.more : page.more, relativePath: page.teamPath }
        })
      } catch (caught) {
        if (cancelled || (caught instanceof DOMException && caught.name === 'AbortError')) return
        // A team that is not saved yet has no chat to read: it is empty, not broken.
        if (caught instanceof RunApiError && caught.status === 404) {
          setState((previous) => (previous.teamPath === teamPath ? { ...previous, loaded: true, error: null } : previous))
          return
        }
        setState((previous) => (previous.teamPath === teamPath ? { ...previous, loaded: true, error: caught instanceof Error ? caught.message : String(caught) } : previous))
      }
    }
    const loop = async () => {
      await read()
      if (!cancelled) timer = window.setTimeout(() => void loop(), document.hidden ? IDLE_POLL_MS * 2 : busyRef.current ? LIVE_POLL_MS : IDLE_POLL_MS)
    }
    void loop()
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer) }
  }, [teamPath, generation])

  /** Read the next page back in time. */
  const loadOlder = useCallback(async () => {
    if (!teamPath || current.loadingOlder || !current.more) return
    const oldest = items[0]
    if (!oldest) return
    setState((previous) => (previous.teamPath === teamPath ? { ...previous, loadingOlder: true } : previous))
    try {
      const page = await fetchChatPage(teamPath, itemAt(oldest), PAGE)
      merge(teamPath, page.items, { more: page.more, loadingOlder: false })
    } catch (caught) {
      setState((previous) => (previous.teamPath === teamPath ? { ...previous, loadingOlder: false, error: caught instanceof Error ? caught.message : String(caught) } : previous))
    }
  }, [teamPath, current.loadingOlder, current.more, items, merge])

  /** Show a message before the daemon answers. Returns its local id. */
  const beginSend = useCallback((text: string, to: ChatTarget, now: boolean) => {
    const localId = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    setPending((list) => [...list, { localId, text, to, now, state: 'sending', sentAt: new Date().toISOString() }])
    return localId
  }, [])

  /** The daemon answered: the message becomes what it started, joined or left for next time. */
  const settleSend = useCallback((localId: string, result: SendResult) => {
    setPending((list) => list.filter((message) => message.localId !== localId))
    if (!teamPath) return
    if ((result.route === 'team' || result.route === 'agent') && result.run) {
      merge(teamPath, [{ kind: 'work', run: result.run, request: result.message, notes: [] }])
    } else if (result.route === 'note' && result.run) {
      const run = result.run
      setState((previous) => {
        if (previous.teamPath !== teamPath) return previous
        const byKey = new Map(previous.byKey)
        const key = `run:${run.runId}`
        const existing = byKey.get(key)
        const notes = existing?.kind === 'work' ? existing.notes.filter((note) => note.id !== result.message.id) : []
        byKey.set(key, { kind: 'work', run, request: existing?.kind === 'work' ? existing.request : null, notes: [...notes, result.message] })
        return { ...previous, byKey }
      })
    } else if (result.route === 'team_note') {
      merge(teamPath, [{ kind: 'note', message: result.message }])
    }
  }, [teamPath, merge])

  const failSend = useCallback((localId: string, error: string) => {
    setPending((list) => list.map((message) => (message.localId === localId ? { ...message, state: 'failed', error } : message)))
  }, [])

  const dismissPending = useCallback((localId: string) => {
    setPending((list) => list.filter((message) => message.localId !== localId))
  }, [])

  /** A run changed outside a page read (stopped, answered): show it now rather than at the next poll. */
  const applyRun = useCallback((run: RunRecord) => {
    if (!teamPath) return
    setState((previous) => {
      if (previous.teamPath !== teamPath) return previous
      const key = `run:${run.runId}`
      const existing = previous.byKey.get(key)
      const byKey = new Map(previous.byKey)
      byKey.set(key, { kind: 'work', run, request: existing?.kind === 'work' ? existing.request : null, notes: existing?.kind === 'work' ? existing.notes : [] })
      return { ...previous, byKey }
    })
  }, [teamPath])

  /** A team note that started work moves into the work it started. */
  const removeNote = useCallback((message: ChatMessage) => {
    setState((previous) => {
      const byKey = new Map(previous.byKey)
      byKey.delete(`note:${message.id}`)
      return { ...previous, byKey }
    })
  }, [])

  const refresh = useCallback(() => setGeneration((value) => value + 1), [])

  return {
    items,
    pending,
    live,
    loaded: current.loaded,
    error: current.error,
    more: current.more,
    loadingOlder: current.loadingOlder,
    relativePath: current.relativePath,
    loadOlder,
    beginSend,
    settleSend,
    failSend,
    dismissPending,
    applyRun,
    removeNote,
    refresh,
  }
}

export type TeamChat = ReturnType<typeof useTeamChat>
