import { ExternalLink, Send } from 'lucide-react'

import { useNotionSend, type NotionSendRun, type NotionSendState } from '../../lib/notion/useNotionSend'

export type { NotionSendRun } from '../../lib/notion/useNotionSend'

interface NotionSendProps {
  run: NotionSendRun
  /** The answer is complete and has text: there is something to send. */
  answered: boolean
}

/**
 * Where this answer went, on the answer itself (ADR 0038): sent, already there, failed and why —
 * or, for a run whose team does not send its answers, a one-click "Send to Notion".
 */
export function NotionSend({ run, answered }: NotionSendProps) {
  const notion = useNotionSend(run, answered)
  if (notion.hidden) return null
  return (
    <div className="notion-send" role="group" aria-label="Notion">
      <span role="status" className="notion-send-status">{outcome(notion) ?? offer(notion)}</span>
      {notion.error && <span className="notion-send-note alert" role="alert">{notion.error}</span>}
    </div>
  )
}

/**
 * Only where the answer went — sending, sent, already there, not sent and why — and nothing while
 * it has gone nowhere: the chat keeps the offer to send it in its Share menu (ADR 0051).
 */
export function NotionOutcome({ notion }: { notion: NotionSendState }) {
  const said = notion.hidden ? null : outcome(notion)
  if (!said && !notion.error) return null
  return (
    <div className="notion-send" role="group" aria-label="Notion">
      {said && <span role="status" className="notion-send-status">{said}</span>}
      {notion.error && <span className="notion-send-note alert" role="alert">{notion.error}</span>}
    </div>
  )
}

/** The offer to send an answer that has gone nowhere yet, as an item of a menu. */
export function NotionOffer({ notion, onSent }: { notion: NotionSendState; onSent?: () => void }) {
  if (notion.hidden || outcome(notion)) return null
  if (notion.disconnected) return <span className="notion-send-note notion-send-connect">To send answers to Notion, connect it in Connections, from the menu.</span>
  return (
    <button type="button" disabled={notion.sending || notion.connection.state === 'loading'} onClick={() => void notion.send().then(onSent)}>
      <Send size={13} aria-hidden="true" />{notion.sending ? 'Sending…' : 'Send to Notion'}
    </button>
  )
}

function open(url: string | null) {
  return url && <a className="link notion-send-open" href={url} target="_blank" rel="noreferrer">Open page <ExternalLink size={12} aria-hidden="true" /></a>
}

function outcome({ pending, delivery, disconnected, connection, sending, send }: NotionSendState) {
  if (pending) return <span className="notion-send-note">Sending to Notion…</span>
  if (delivery?.status === 'published') return <><span className="notion-send-note ok">Sent to Notion.</span>{open(delivery.url)}</>
  if (delivery?.status === 'skipped') return <><span className="notion-send-note" title={delivery.message}>Already in Notion — a page with this title exists.</span>{open(delivery.url)}</>
  if (delivery?.status === 'failed' && disconnected) {
    // The daemon's own sentence also says "open Connections"; next to the link that is said twice.
    return <>
      <span className="notion-send-note alert" title={delivery.message}>Not sent to Notion — {connection.state === 'disconnected' ? 'Notion isn’t connected yet.' : 'no page is chosen for answers yet.'}</span>
      {/* Connections opens from the menu, its one way in (ADR 0043). */}
      <span className="notion-send-note">{connection.state === 'disconnected' ? 'Connect Notion' : 'Choose a page'} in Connections, from the menu.</span>
    </>
  }
  if (delivery?.status === 'failed') {
    return <>
      <span className="notion-send-note alert">Not sent to Notion: {delivery.message}</span>
      <button type="button" className="link" onClick={() => void send()} disabled={sending}>{sending ? 'Sending…' : 'Try again'}</button>
    </>
  }
  return null
}

function offer({ disconnected, sending, connection, send }: NotionSendState) {
  if (disconnected) return <span className="notion-send-note notion-send-connect">To send this answer, connect Notion in Connections, from the menu.</span>
  return <button type="button" className="btn notion-send-button" onClick={() => void send()} disabled={sending || connection.state === 'loading'}><Send size={13} aria-hidden="true" />{sending ? 'Sending…' : 'Send to Notion'}</button>
}
