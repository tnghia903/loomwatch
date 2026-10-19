import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { modelForTier } from '../ai/modelIds'
import { SOURCE_INFO, canRun, connectedSources, sourceOf } from '../ai/sources'
import { useAiStatus } from '../ai/useKeyStatus'
import { useSessionEvents } from '../watch/useSessionEvents'
import {
  AskApiError, fetchConversation, sendAskMessage, setAskBeforeRun as saveAskBeforeRun,
  startConversation, endConversation, type AskContext,
} from './client'
import { currentActivity, EMPTY_THREAD, projectAskThread, type AskThread } from './thread'

// The panel moves between pages with the person (every team opens as a page load), so what it
// needs to come back is kept for the tab: the conversation's id and whether it was open. The
// conversation itself is the daemon's and is read back from the archive.
const CONVERSATION_KEY = 'loomwatch:ask:conversation'
const OPEN_KEY = 'loomwatch:ask:open'
const ASK_FIRST_KEY = 'loomwatch:ask:ask-before-run'
const MODEL_KEY = 'loomwatch:ask:model'

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
  /** The OpenRouter model the next conversation runs on: the person's choice, else the default. */
  selectedModel: string
  /** Use this model from now on. A conversation on a different one is ended, because a
      conversation is one session on one model. */
  chooseModel: (model: string) => void
  /** No way to pay for models is connected, so Ask can't answer until one is (ADR 0073). */
  needsKey: boolean
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
}

export function useAsk(context: AskContext): AskController {
  const [open, setOpenState] = useState(() => readStore(session, OPEN_KEY) === '1')
  const [conversationId, setConversationId] = useState<string | null>(() => readStore(session, CONVERSATION_KEY))
  const [ended, setEnded] = useState(false)
  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState<{ text: string; after: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sentAt, setSentAt] = useState<number | null>(null)
  const [askBeforeRun, setAskBeforeRunState] = useState(() => readStore(local, ASK_FIRST_KEY) !== '0')
  const [draft, setDraft] = useState('')
  const [focusRequest, setFocusRequest] = useState(0)
  const [choice, setChoice] = useState<string | null>(() => readStore(local, MODEL_KEY))
  /** The model the live conversation was started with, as the daemon reported it. */
  const [conversationModel, setConversationModel] = useState<string | null>(null)
  const ai = useAiStatus()
  // Read when a message is sent, so a send always carries where the person is at that moment.
  const contextRef = useRef(context)
  useEffect(() => { contextRef.current = context })

  // Followed live while you can see it or wait on it; a conversation kept from an earlier page is
  // read from the archive, with no socket held open for it while the panel is shut.
  const { events } = useSessionEvents(conversationId ?? '', !ended && (open || pending !== null) ? null : 0)
  const thread = useMemo(() => (conversationId ? projectAskThread(events) : EMPTY_THREAD), [conversationId, events])
  const personCount = thread.items.filter((item) => item.kind === 'person').length
  const shownPending = pending && personCount <= pending.after ? pending.text : null

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next)
    writeStore(session, OPEN_KEY, next ? '1' : null)
    if (next) setFocusRequest((count) => count + 1)
  }, [])

  // A conversation kept from an earlier page may have ended since: idle for twenty minutes, or a
  // daemon restart. Its transcript still reads from the archive; only sending needs a new one.
  useEffect(() => {
    if (!conversationId) return
    const controller = new AbortController()
    fetchConversation(conversationId, controller.signal)
      .then((info) => {
        if (!info) setEnded(true)
        else if (info.model) setConversationModel(info.model)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [conversationId])

  // The strongest model on the sources connected, the plans the person pays for first.
  const selectedModel = choice || modelForTier('strong', ai ? connectedSources(ai) : undefined)

  const begin = useCallback(async (): Promise<string> => {
    const info = await startConversation(askBeforeRun, selectedModel)
    setConversationModel(info.model ?? selectedModel)
    setConversationId(info.id)
    writeStore(session, CONVERSATION_KEY, info.id)
    setEnded(false)
    return info.id
  }, [askBeforeRun, selectedModel])

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
    setConversationModel(null)
    writeStore(session, CONVERSATION_KEY, null)
    setEnded(false)
    setPending(null)
    setError(null)
    setFocusRequest((count) => count + 1)
  }, [conversationId, finished])

  const chooseModel = useCallback((model: string) => {
    setChoice(model)
    writeStore(local, MODEL_KEY, model)
    if (!conversationId) return
    const live = conversationModel ?? thread.model
    if (live !== model) startOver()
  }, [conversationId, conversationModel, thread.model, startOver])

  const setAskBeforeRun = useCallback((value: boolean) => {
    setAskBeforeRunState(value)
    writeStore(local, ASK_FIRST_KEY, value ? null : '0')
    if (conversationId && !finished) void saveAskBeforeRun(conversationId, value).catch(() => {})
  }, [conversationId, finished])

  // No key, no Ask: the panel shows the key card in its place. Until the daemon has said, Ask is
  // usable, and a message sent without a key is refused with the daemon's own words.
  const needsKey = ai !== null && connectedSources(ai).length === 0
  const unavailable = needsKey
    ? 'Ask needs a way to pay for its model. Connect your ChatGPT plan, your Claude API credit or an OpenRouter key to start.'
    : ai !== null && !canRun(selectedModel, ai)
      ? `Ask’s model runs ${SOURCE_INFO[sourceOf(selectedModel)].on}, which isn’t connected. Choose another model for Ask.`
      : null

  return {
    open, setOpen, selectedModel, chooseModel, needsKey, conversationId, unavailable, thread,
    activity: currentActivity(thread) ?? (shownPending ? 'Sending' : null),
    pending: shownPending, ended: ended && !sending, sending, sentAt, error, dismissError: () => setError(null),
    askBeforeRun, setAskBeforeRun, draft, setDraft, focusRequest, ask, send, startOver,
  }
}
