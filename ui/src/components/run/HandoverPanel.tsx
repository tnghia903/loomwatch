import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'

import type { ContextPacket, PacketSection } from '../../lib/memory/client'

/**
 * What an agent was given: the packet inspector (docs/TEAM_MEMORY.md → "What an agent was given").
 *
 * This panel used to reconstruct the handover by regex-splitting the archived prompt on a literal
 * heading, which broke the moment the daemon gained a new prompt section. It now reads records:
 * the handover text comes from the archived `prompt_sections` event through the projector, and the
 * memory packet — with its per-section selection rationale — from
 * `GET /api/runs/{id}/context?agent=`.
 *
 * The words are the design's: **supplied** is not followed. This shows what was in the opening
 * prompt and why; the run story shows what the agent then did with it.
 */
export function HandoverPanel({ text, toLabel, fromLabel, packet, packetLoading, packetError, onClose, modal = false }: {
  /** The handover a later stage was given, verbatim. Empty when this agent had no predecessor. */
  text: string
  toLabel: string
  fromLabel: string
  /** The stored memory packet for this agent, when the run recorded one. */
  packet?: ContextPacket | null
  packetLoading?: boolean
  packetError?: string | null
  modal?: boolean
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (modal && dialog.current && !dialog.current.open) dialog.current.showModal()
  }, [modal])
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeButton.current?.focus() }, [text])
  const supplied = packet ? `${format(packet.usedChars)} of ${format(packet.budgetChars)} chars` : null
  // e2, not e1: DESIGN_LANGUAGE §7 keeps carefully-read text off a blurred backdrop, and this
  // panel exists to be read at length.
  const content = (
    <aside
      className="panel right top e2 lw-activity"
      role="region"
      aria-labelledby="handover-title"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}
    >
      <header className="insp-head">
        <span className="insp-text">
          <div className="insp-title t-title" id="handover-title">What {toLabel} was given</div>
          <div className="insp-id t-mono">
            {text ? `handover from ${fromLabel} · ${text.length.toLocaleString()} characters` : 'no preceding stage'}
            {supplied ? ` · memory ${supplied}` : ''}
          </div>
        </span>
        <button ref={closeButton} type="button" className="iconbtn" onClick={onClose} aria-label="Close" title="Close (Esc)"><X size={15} aria-hidden="true" /></button>
      </header>

      {(packetLoading || packetError || packet) && (
        <div className="zone">
          <div className="zone-head t-micro"><span>Supplied from memory</span>{packet && <span>{format(packet.usedChars)} chars</span>}</div>
          {packetLoading && <p className="hint t-meta" style={{ margin: 0 }}>Reading the stored packet…</p>}
          {packetError && !packetLoading && <p className="hint t-meta" role="alert" style={{ margin: 0, color: 'var(--color-alert)' }}>{packetError}</p>}
          {packet && packet.sections.map((section, index) => (
            <SectionRow key={`${section.kind}-${section.label}-${index}`} section={section} />
          ))}
          {packet && (
            <details>
              <summary className="t-meta">Show the raw text</summary>
              <pre className="ent-out t-mono-sm">{packet.text}</pre>
            </details>
          )}
        </div>
      )}

      <div className="zone">
        <div className="zone-head t-micro">Handed over</div>
        {text
          ? <pre className="ent-out t-mono-sm">{text}</pre>
          : <p className="hint t-meta" style={{ margin: 0 }}>Nothing: this stage is the entry point, so it was given only the goal and the team's memory.</p>}
      </div>

      <div className="zone">
        <p className="hint t-meta" style={{ margin: 0 }}>
          Supplied is not followed. This is what was in the opening prompt and why; the run story
          shows what {toLabel} then did with it.
        </p>
      </div>
    </aside>
  )
  return modal ? <dialog ref={dialog} className="prototype-handover-dialog" onCancel={onClose}>{content}</dialog> : content
}

function SectionRow({ section }: { section: PacketSection }) {
  const excluded = section.kind === 'excluded'
  return (
    <div className="rt-strip t-meta" style={{ borderTop: 0, padding: '8px 10px', borderRadius: 'var(--r-sm)', background: 'var(--color-panel-solid)', border: '1px solid var(--color-hairline)', alignItems: 'flex-start', flexDirection: 'column', gap: 3, opacity: excluded ? 0.7 : 1 }}>
      <span style={{ display: 'flex', width: '100%', gap: 'var(--sp-3)', alignItems: 'baseline' }}>
        <b className="t-body-m" style={{ color: 'var(--color-ink)', flex: 1, minWidth: 0 }}>{section.label}</b>
        <span className="t-mono-sm" style={{ color: 'var(--color-ink-3)' }}>{excluded ? 'not included' : `${section.chars.toLocaleString()}`}</span>
      </span>
      <span style={{ color: 'var(--color-ink-2)' }}>{section.rationale}</span>
      {section.source && <span className="t-mono-sm" style={{ color: 'var(--color-ink-3)' }}>{section.source.path} · {section.source.sha256.slice(0, 12)}</span>}
      {/* The note revisions this section supplied, read from the stored packet rather than from
          the notebook as it stands now. A note corrected after the run still shows here as the
          revision the agent was actually given, which is the whole point of recording them. */}
      {(section.notes ?? []).map((note) => (
        <span key={note.id} className="t-mono-sm" style={{ color: 'var(--color-ink-3)' }}>
          {note.kind} · {note.title} · {note.originTeamId ?? note.authorAgentId} · revision {note.revision}
        </span>
      ))}
    </div>
  )
}

function format(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}
