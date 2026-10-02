import { ExternalLink, Send } from 'lucide-react'
import { useEffect, useState } from 'react'

import { CONNECTIONS_HREF, useNotionConnection } from '../../lib/notion/connection'
import { deliverRun, fetchRun, type Delivery, type RunRecord } from '../../lib/runs/client'

/** How long the answer waits for an automatic delivery before offering the button instead. */
const WAIT_TRIES = 60
const WAIT_MS = 1500

export type NotionSendRun = Pick<RunRecord, 'runId' | 'status' | 'delivery' | 'deliverTitle'>

interface NotionSendProps {
  run: NotionSendRun
  /** The answer is complete and has text: there is something to send. */
  answered: boolean
}

/**
 * Where this answer went, on the answer itself (ADR 0038): sent, already there, failed and why —
 * or, for a run whose team does not send its answers, a one-click "Send to Notion". The daemon
 * stamps the delivery a moment after the run ends, so a run that is going to deliver is followed
 * until it has.
 */
export function NotionSend({ run, answered }: NotionSendProps) {
  const connection = useNotionConnection(answered)
  // What this card learned itself — a send, or a delivery found while waiting — and whether it
  // stopped waiting. Keyed by run, so switching runs never shows the previous run's outcome.
  const [learned, setLearned] = useState<{ runId: string; delivery: Delivery | null; gaveUp: boolean }>({ runId: run.runId, delivery: null, gaveUp: false })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mine = learned.runId === run.runId ? learned : { runId: run.runId, delivery: null, gaveUp: false }
  const delivery = mine.delivery ?? run.delivery ?? null
  const pending = run.status === 'succeeded' && Boolean(run.deliverTitle) && !delivery && !mine.gaveUp

  useEffect(() => {
    if (!pending) return
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const tick = async () => {
      tries += 1
      try {
        const next = await fetchRun(run.runId, controller.signal)
        if (controller.signal.aborted) return
        if (next.delivery) { setLearned({ runId: run.runId, delivery: next.delivery, gaveUp: false }); return }
      } catch {
        if (controller.signal.aborted) return
      }
      if (tries >= WAIT_TRIES) { setLearned({ runId: run.runId, delivery: null, gaveUp: true }); return }
      timer = setTimeout(() => void tick(), WAIT_MS)
    }
    timer = setTimeout(() => void tick(), WAIT_MS)
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [pending, run.runId])

  if (!answered || connection.state === 'unavailable') return null

  const send = async () => {
    if (sending) return
    setSending(true)
    setError(null)
    try {
      const next = await deliverRun(run.runId)
      setLearned({ runId: run.runId, delivery: next.delivery ?? null, gaveUp: false })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not send this answer.')
    } finally {
      setSending(false)
    }
  }
  const open = (url: string | null) => url && (
    <a className="link notion-send-open" href={url} target="_blank" rel="noreferrer">Open page <ExternalLink size={12} aria-hidden="true" /></a>
  )
  const disconnected = connection.state === 'disconnected' || (connection.state === 'connected' && !connection.destination)

  let body
  if (pending) {
    body = <span className="notion-send-note">Sending to Notion…</span>
  } else if (delivery?.status === 'published') {
    body = <><span className="notion-send-note ok">Sent to Notion.</span>{open(delivery.url)}</>
  } else if (delivery?.status === 'skipped') {
    body = <><span className="notion-send-note" title={delivery.message}>Already in Notion — a page with this title exists.</span>{open(delivery.url)}</>
  } else if (delivery?.status === 'failed' && disconnected) {
    // The daemon's own sentence also says "open Connections"; next to the link that is said twice.
    body = <>
      <span className="notion-send-note alert" title={delivery.message}>Not sent to Notion — {connection.state === 'disconnected' ? 'Notion isn’t connected yet.' : 'no page is chosen for answers yet.'}</span>
      <a className="link" href={CONNECTIONS_HREF} target="_blank" rel="noreferrer">{connection.state === 'disconnected' ? 'Connect Notion' : 'Choose a page'} <ExternalLink size={12} aria-hidden="true" /></a>
    </>
  } else if (delivery?.status === 'failed') {
    body = <>
      <span className="notion-send-note alert">Not sent to Notion: {delivery.message}</span>
      <button type="button" className="link" onClick={() => void send()} disabled={sending}>{sending ? 'Sending…' : 'Try again'}</button>
    </>
  } else if (disconnected) {
    body = <a className="link notion-send-connect" href={CONNECTIONS_HREF} target="_blank" rel="noreferrer">Connect Notion to send this answer <ExternalLink size={12} aria-hidden="true" /></a>
  } else {
    body = <button type="button" className="btn notion-send-button" onClick={() => void send()} disabled={sending || connection.state === 'loading'}><Send size={13} aria-hidden="true" />{sending ? 'Sending…' : 'Send to Notion'}</button>
  }
  return (
    <div className="notion-send" role="group" aria-label="Notion">
      <span role="status" className="notion-send-status">{body}</span>
      {error && <span className="notion-send-note alert" role="alert">{error}</span>}
    </div>
  )
}
