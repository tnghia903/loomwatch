import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { keepIfSame } from '../keepIfSame'
import { isTerminalRun, RunApiError, type RunRecord } from '../runs/client'
import { fetchChatPage, itemAnchor, itemAt, itemKey, reactTo, stillAnswering, type ChatItem, type ChatMessage, type ChatTarget, type ReplyTo, type SendResult } from './client'
import { yoursOn, type Face, type Reaction, type ReactionAbout } from './reactions'

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
  /** The message it replies to, kept so Try again sends it as the same reply. */
  replyTo: ReplyTo | null
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

/**
 * A reaction of yours the daemon has not shown back yet, so it shows at once and a page read
 * before the daemon answered cannot undo it. Settled once the daemon has it; dropped when a page
 * agrees, or after a while in case another window changed it since.
 */
interface Override {
  /** The run, or the team note, it is on. */
  anchor: string
  target: string
  face: Face | null
  settled: number | null
}
const OVERRIDE_MS = 30_000

/** The piece or note with your reactions that are on their way put in, or the item itself when they change nothing. */
function withOverrides(item: ChatItem, overrides: ReadonlyMap<string, Override>): ChatItem {
  let reactions: Reaction[] = item.reactions ?? []
  let changed = false
  for (const override of overrides.values()) {
    if (override.anchor !== itemAnchor(item) || yoursOn(reactions, override.target) === override.face) continue
    reactions = reactions.filter((reaction) => reaction.target !== override.target)
    if (override.face) reactions = [...reactions, { target: override.target, face: override.face, at: new Date().toISOString() }]
    changed = true
  }
  return changed ? { ...item, reactions } : item
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
  // Agents answering a message themselves count as work: their answers arrive with the next read.
  const answering = items.some((item) => item.kind === 'note' && stillAnswering(item.message).length > 0)
  const busy = live.length > 0 || answering || pending.some((message) => message.state === 'sending')

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
  const overrides = useRef(new Map<string, Override>())

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
          // An item that reads as it did keeps its object, so its piece is not drawn again; a page
          // with nothing new leaves the chat as it was.
          let changed = false
          const byKey = new Map(previous.byKey)
          for (const read of page.items) {
            // A reaction on its way stays until the daemon has it and a page shows it back.
            for (const [key, override] of overrides.current) {
              if (override.anchor !== itemAnchor(read) || override.settled === null) continue
              if (yoursOn(read.reactions, override.target) === override.face || Date.now() - override.settled > OVERRIDE_MS) overrides.current.delete(key)
            }
            const item = withOverrides(read, overrides.current)
            const key = itemKey(item)
            const before = byKey.get(key)
            if (before && keepIfSame(before, item) === before) continue
            byKey.set(key, item)
            changed = true
          }
          const more = previous.loaded ? previous.more : page.more
          if (!changed && previous.loaded && previous.error === null && previous.more === more && previous.relativePath === page.teamPath) return previous
          return { ...previous, byKey: changed ? byKey : previous.byKey, loaded: true, error: null, more, relativePath: page.teamPath }
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
  const beginSend = useCallback((text: string, to: ChatTarget, now: boolean, replyTo: ReplyTo | null = null) => {
    const localId = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    setPending((list) => [...list, { localId, text, to, now, replyTo, state: 'sending', sentAt: new Date().toISOString() }])
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
        byKey.set(key, { kind: 'work', run, request: existing?.kind === 'work' ? existing.request : null, notes: [...notes, result.message], reactions: existing?.kind === 'work' ? existing.reactions : undefined })
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
      byKey.set(key, { kind: 'work', run, request: existing?.kind === 'work' ? existing.request : null, notes: existing?.kind === 'work' ? existing.notes : [], reactions: existing?.kind === 'work' ? existing.reactions : undefined })
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

  /**
   * Put one face on something said in a piece of work or on a team note (`anchor`: its run, or the
   * note), or take yours off with `null`. It shows at once; if the daemon refuses, it goes back to
   * what it was and the error is thrown.
   */
  const react = useCallback(async (anchor: string, target: string, face: Face | null, about?: ReactionAbout) => {
    if (!teamPath) return
    const key = `${anchor}\n${target}`
    const override: Override = { anchor, target, face, settled: null }
    let before: Face | null = null
    const show = (reactions?: Reaction[], first = false) => setState((previous) => {
      if (previous.teamPath !== teamPath) return previous
      const found = [`run:${anchor}`, `note:${anchor}`].find((candidate) => previous.byKey.has(candidate))
      const item = found ? previous.byKey.get(found) : undefined
      if (!found || !item) return previous
      if (first) before = yoursOn(item.reactions, target)
      const next = withOverrides(reactions ? { ...item, reactions } : item, overrides.current)
      if (next === item) return previous
      const byKey = new Map(previous.byKey)
      byKey.set(found, next)
      return { ...previous, byKey }
    })
    overrides.current.set(key, override)
    show(undefined, true)
    try {
      const result = await reactTo(teamPath, anchor, target, face, about)
      if (overrides.current.get(key) === override) override.settled = Date.now()
      show(result.reactions)
    } catch (caught) {
      // Back to what it was, until a page says otherwise.
      if (overrides.current.get(key) === override) {
        overrides.current.set(key, { anchor, target, face: before, settled: Date.now() })
        show()
      }
      throw caught
    }
  }, [teamPath])

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
    react,
  }
}

export type TeamChat = ReturnType<typeof useTeamChat>
