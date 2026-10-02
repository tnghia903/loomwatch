import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useSessionEvents } from '../watch/useSessionEvents'
import {
  AskApiError, fetchAskApps, fetchConversation, fetchInbox, sendAskMessage, setAskBeforeRun as saveAskBeforeRun,
  startConversation, endConversation, type AskApps, type AskContext, type InboxItem,
} from './client'
import { currentActivity, EMPTY_THREAD, projectAskThread, type AskThread } from './thread'

// The panel moves between pages with the person (every team opens as a page load), so what it
// needs to come back is kept for the tab: the conversation's id and whether it was open. The
// conversation itself is the daemon's and is read back from the archive.
const CONVERSATION_KEY = 'loomwatch:ask:conversation'
const OPEN_KEY = 'loomwatch:ask:open'
const ASK_FIRST_KEY = 'loomwatch:ask:ask-before-run'
const INBOX_SEEN_KEY = 'loomwatch:ask:inbox-seen'
const INBOX_POLL_MS = 20_000
/** A day is long enough to come back to something a connected app did; after that it is history. */
const INBOX_WINDOW_MS = 24 * 60 * 60 * 1000

function readStore(store: () => Storage, key: string): string | null {
  try { return store().getItem(key) } catch { return null }
}
function writeStore(store: () => Storage, key: string, value: string | null) {
  try {
    if (value === null) store().removeItem(key)
    else store().setItem(key, value)
  } catch {
    // Private windows can refuse storage; the panel still works for this page.
  }
}
const session = () => window.sessionStorage
const local = () => window.localStorage

export interface AskController {
  open: boolean
  setOpen: (open: boolean) => void
  apps: AskApps | null
  conversationId: string | null
  /** Why Ask can't be used here, in plain words, or null when it can. */
  unavailable: string | null
  thread: AskThread
  /** What the assistant is doing now, or null when it is waiting for the person. */
  activity: string | null
  /** The message on its way to the daemon, shown until the archive has it. */
  pending: string | null
  /** The daemon no longer has this conversation; the next message starts a new one. */
  ended: boolean
  sending: boolean
  /** When this page last sent a message (epoch ms), so only answers to it act on their own. */
  sentAt: number | null
  error: string | null
  dismissError: () => void
  askBeforeRun: boolean
  setAskBeforeRun: (value: boolean) => void
  draft: string
  setDraft: (text: string) => void
  /** Bumped to move the caret into the panel's message box. */
  focusRequest: number
  /** Open the panel; with text, send it straight away. */
  ask: (text?: string) => void
  send: (text: string) => Promise<boolean>
  startOver: () => void
  inbox: InboxItem[]
  inboxUnseen: number
  markInboxSeen: () => void
}

export function useAsk(context: AskContext): AskController {
  const [open, setOpenState] = useState(() => readStore(session, OPEN_KEY) === '1')
  const [conversationId, setConversationId] = useState<string | null>(() => readStore(session, CONVERSATION_KEY))
  const [ended, setEnded] = useState(false)
  const [apps, setApps] = useState<AskApps | null>(null)
  const [appsError, setAppsError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState<{ text: string; after: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sentAt, setSentAt] = useState<number | null>(null)
  const [askBeforeRun, setAskBeforeRunState] = useState(() => readStore(local, ASK_FIRST_KEY) !== '0')
  const [draft, setDraft] = useState('')
  const [focusRequest, setFocusRequest] = useState(0)
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [inboxSeen, setInboxSeen] = useState(() => readStore(local, INBOX_SEEN_KEY) ?? '')
  // Read when a message is sent, so a send always carries where the person is at that moment.
  const contextRef = useRef(context)
  useEffect(() => { contextRef.current = context })

  const { events } = useSessionEvents(conversationId ?? '')
  const thread = useMemo(() => (conversationId ? projectAskThread(events) : EMPTY_THREAD), [conversationId, events])
  const personCount = thread.items.filter((item) => item.kind === 'person').length
  const shownPending = pending && personCount <= pending.after ? pending.text : null

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next)
    writeStore(session, OPEN_KEY, next ? '1' : null)
    if (next) setFocusRequest((count) => count + 1)
  }, [])

  // Which apps can host the assistant: asked once, so the Home box and the panel can say up front
  // when there is none instead of failing on the first message.
  useEffect(() => {
    const controller = new AbortController()
    fetchAskApps(controller.signal)
      .then((value) => setApps(value))
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return
        setAppsError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => controller.abort()
  }, [])

  // A conversation kept from an earlier page may have ended since: idle for twenty minutes, or a
  // daemon restart. Its transcript still reads from the archive; only sending needs a new one.
  useEffect(() => {
    if (!conversationId) return
    const controller = new AbortController()
    fetchConversation(conversationId, controller.signal)
      .then((info) => { if (!info) setEnded(true) })
      .catch(() => {})
    return () => controller.abort()
  }, [conversationId])

  // What connected apps did with LoomWatch's tools, so a proposal made from Claude Code or Codex
  // has somewhere to be applied.
  useEffect(() => {
    const controller = new AbortController()
    const poll = () => {
      fetchInbox(controller.signal)
        .then((items) => { const since = Date.now() - INBOX_WINDOW_MS; setInbox(items.filter((item) => Date.parse(item.at) >= since)) })
        .catch(() => {})
    }
    const first = window.setTimeout(poll, 1500)
    const timer = window.setInterval(poll, INBOX_POLL_MS)
    return () => { controller.abort(); window.clearTimeout(first); window.clearInterval(timer) }
  }, [])

  const begin = useCallback(async (): Promise<string> => {
    const info = await startConversation(askBeforeRun)
    setConversationId(info.id)
    writeStore(session, CONVERSATION_KEY, info.id)
    setEnded(false)
    return info.id
  }, [askBeforeRun])

  const finished = ended || thread.state === 'ended' || thread.state === 'failed'
  const send = useCallback(async (text: string): Promise<boolean> => {
    const trimmed = text.trim()
    if (!trimmed || sending) return false
    setSending(true)
    setError(null)
    setSentAt(Date.now())
    setPending({ text: trimmed, after: finished ? 0 : personCount })
    try {
      let id = conversationId && !finished ? conversationId : await begin()
      try {
        await sendAskMessage(id, trimmed, contextRef.current)
      } catch (caught) {
        // Gone between the last check and this message: carry on in a new conversation.
        if (!(caught instanceof AskApiError) || (caught.status !== 404 && caught.status !== 410)) throw caught
        setPending({ text: trimmed, after: 0 })
        id = await begin()
        await sendAskMessage(id, trimmed, contextRef.current)
      }
      return true
    } catch (caught) {
      setPending(null)
      setError(caught instanceof Error ? caught.message : String(caught))
      return false
    } finally {
      setSending(false)
    }
  }, [sending, conversationId, finished, begin, personCount])

  const ask = useCallback((text?: string) => {
    setOpen(true)
    if (text?.trim()) void send(text)
  }, [setOpen, send])

  const startOver = useCallback(() => {
    if (conversationId && !finished) void endConversation(conversationId).catch(() => {})
    setConversationId(null)
    writeStore(session, CONVERSATION_KEY, null)
    setEnded(false)
    setPending(null)
    setError(null)
    setFocusRequest((count) => count + 1)
  }, [conversationId, finished])

  const setAskBeforeRun = useCallback((value: boolean) => {
    setAskBeforeRunState(value)
    writeStore(local, ASK_FIRST_KEY, value ? null : '0')
    if (conversationId && !finished) void saveAskBeforeRun(conversationId, value).catch(() => {})
  }, [conversationId, finished])

  const inboxUnseen = inbox.filter((item) => item.at > inboxSeen && item.phase !== 'ask_proposal_outcome').length
  const markInboxSeen = useCallback(() => {
    const latest = inbox.at(-1)?.at
    if (!latest) return
    setInboxSeen(latest)
    writeStore(local, INBOX_SEEN_KEY, latest)
  }, [inbox])

  const noApp = apps && !apps.defaultApp
  const unavailable = appsError
    ? `Ask isn’t available: ${appsError}`
    : noApp
      ? 'Ask needs Claude Code, Codex, Gemini CLI or OpenCode on this computer. Install one, sign in, then start LoomWatch again.'
      : null

  return {
    open, setOpen, apps, conversationId, unavailable, thread,
    activity: currentActivity(thread) ?? (shownPending ? 'Sending' : null),
    pending: shownPending, ended: ended && !sending, sending, sentAt, error, dismissError: () => setError(null),
    askBeforeRun, setAskBeforeRun, draft, setDraft, focusRequest, ask, send, startOver,
    inbox, inboxUnseen, markInboxSeen,
  }
}
