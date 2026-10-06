import { useEffect, useState } from 'react'

import { deliverRun, fetchRun, type Delivery, type RunRecord } from '../runs/client'
import { useNotionConnection, type NotionConnection } from './connection'

/** How long the answer waits for an automatic delivery before offering the button instead. */
const WAIT_TRIES = 60
const WAIT_MS = 1500

export type NotionSendRun = Pick<RunRecord, 'runId' | 'status' | 'delivery' | 'deliverTitle'>

export interface NotionSendState {
  /** Nothing about Notion applies: no answer yet, or a LoomWatch without Notion. */
  hidden: boolean
  connection: NotionConnection
  /** The team sends its answers and this one is on its way. */
  pending: boolean
  delivery: Delivery | null
  /** Notion is not connected, or no page is chosen for answers. */
  disconnected: boolean
  sending: boolean
  error: string | null
  send: () => Promise<void>
}

/**
 * Where an answer went in Notion (ADR 0038): sent, already there, failed and why — and, for a run
 * whose team does not send its answers, a way to send it. The daemon stamps the delivery a moment
 * after the run ends, so a run that is going to deliver is followed until it has. One state for an
 * answer, so where it went and the way to send it can be drawn in different places and agree.
 */
export function useNotionSend(run: NotionSendRun, answered: boolean): NotionSendState {
  const connection = useNotionConnection(answered)
  // What was learned here — a send, or a delivery found while waiting — and whether it stopped
  // waiting. Keyed by run, so switching runs never shows the previous run's outcome.
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
  const disconnected = connection.state === 'disconnected' || (connection.state === 'connected' && !connection.destination)
  return { hidden: !answered || connection.state === 'unavailable', connection, pending, delivery, disconnected, sending, error, send }
}
