import { ExternalLink } from 'lucide-react'
import { useState } from 'react'

import { CONNECTIONS_HREF, DEFAULT_RUN_NOTION_TITLE, previewNotionTitle, useNotionConnection, type NotionConnection } from '../../lib/notion/connection'
import type { DeliverConfig } from '../../lib/team-file/types'

interface NotionDeliverySettingsProps {
  /** The team-wide `deliver` block (ADR 0038); `null` when answers stay in LoomWatch. */
  deliver: DeliverConfig | null
  onChange: (deliver: DeliverConfig | null) => void
  readOnly: boolean
  /** For the title preview: `{{team}}`. */
  teamName: string
  /** A routine's own `schedule.deliver` title, when it has one: scheduled runs go there already. */
  routineTitle: string | null
}

/**
 * The Team response's "Send to Notion": where a finished answer goes besides this window. It owns
 * the one setting a person reaches for — on or off, and what the page is called — and reads the
 * connection only to say, in place, whether the page would actually arrive and where. Connecting
 * and choosing the page stay in Connections, opened beside the canvas so nothing here is lost.
 */
export function NotionDeliverySettings({ deliver, onChange, readOnly, teamName, routineTitle }: NotionDeliverySettingsProps) {
  const connection = useNotionConnection()
  const on = Boolean(deliver?.notion)
  const savedTitle = deliver?.notion?.title ?? ''
  // Edited as a draft and written on blur or Enter, so typing a title is one undo step, not one per key.
  const [draft, setDraft] = useState<string | null>(null)
  const title = draft ?? savedTitle
  const commitTitle = () => {
    if (draft === null) return
    setDraft(null)
    const trimmed = draft.trim()
    if (trimmed === savedTitle.trim()) return
    onChange({ notion: trimmed && trimmed !== DEFAULT_RUN_NOTION_TITLE ? { title: trimmed } : {} })
  }
  const toggle = () => {
    if (readOnly) return
    setDraft(null)
    onChange(on ? null : { notion: savedTitle ? { title: savedTitle } : {} })
  }
  const preview = previewNotionTitle(title.trim() || DEFAULT_RUN_NOTION_TITLE, teamName)

  return (
    <section className="output-send" aria-label="Send the answer">
      <span className="output-send-eyebrow">Where the answer goes</span>
      <button type="button" className={`check ${on ? 'on' : ''}`} aria-pressed={on} disabled={readOnly} onClick={toggle}>
        <span className="box"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></span>
        <span className="txt">
          <b className="t-body">Send every answer to Notion</b>
          <span className="t-meta">{on ? 'Each finished run becomes a new Notion page.' : 'Answers stay in LoomWatch.'}</span>
        </span>
      </button>
      <ConnectionLine connection={connection} on={on} />
      {on && (
        <>
          <label className="output-send-title">Page title
            <input
              value={title}
              placeholder={DEFAULT_RUN_NOTION_TITLE}
              disabled={readOnly}
              maxLength={2000}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitTitle() } if (event.key === 'Escape') setDraft(null) }}
              aria-describedby="output-send-title-hint"
            />
          </label>
          <small id="output-send-title-hint" className="output-send-hint">
            Next page: <q>{preview}</q>. <code>{'{{date}}'}</code>, <code>{'{{time}}'}</code> and <code>{'{{team}}'}</code> fill in when it is made.
          </small>
          <small className="output-send-hint">Runs you start here, scheduled runs and runs from Ask all send their answer.</small>
        </>
      )}
      {routineTitle && <small className="output-send-hint">{on ? 'Scheduled runs use their own title' : 'Scheduled runs already go to Notion'}: <q>{previewNotionTitle(routineTitle, teamName)}</q>.</small>}
    </section>
  )
}

/** Whether a page would actually arrive, and the one place to fix it when it would not. */
function ConnectionLine({ connection, on }: { connection: NotionConnection; on: boolean }) {
  const link = (label: string) => (
    <a className="link output-send-link" href={CONNECTIONS_HREF} target="_blank" rel="noreferrer">{label} <ExternalLink size={12} aria-hidden="true" /></a>
  )
  if (connection.state === 'loading') return <p className="output-send-status t-meta" role="status">Checking your Notion connection…</p>
  if (connection.state === 'unavailable') return <p className="output-send-status t-meta" role="status">{connection.message}</p>
  if (connection.state === 'disconnected') {
    return <p className={`output-send-status t-meta ${on ? 'warn' : ''}`} role="status">{on ? 'Notion isn’t connected yet, so nothing can be sent.' : 'Notion isn’t connected yet.'} {link('Connect Notion')}</p>
  }
  if (!connection.destination) {
    return <p className={`output-send-status t-meta ${on ? 'warn' : ''}`} role="status">Connected to {connection.workspace}. Choose the page answers go under. {link('Choose a page')}</p>
  }
  return <p className="output-send-status t-meta" role="status">New pages go under <strong>{connection.destination.title}</strong> in {connection.workspace}. {link('Change')}</p>
}
