import { ArrowUpRight, BellDot, Check, CornerDownLeft, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

import type { PermissionDecision } from '../../lib/runs/client'
import { historyRunUrl } from '../../lib/runs/history'
import { ago, APPROVAL_TEXT, type Ticket } from '../../lib/story/needsYou'

interface NeedsYouTrayProps {
  tickets: readonly Ticket[]
  /** Runs working without needing anything, for the quiet "all clear" state. */
  working: number
  onAnswer: (ticket: Ticket, text: string, sendBack?: string) => Promise<void>
  /** A permission ticket's answer (ADR 0040). Absent: permission tickets only open their run. */
  onPermission?: (ticket: Ticket, decision: PermissionDecision) => Promise<void>
  onDismiss: (runId: string) => void
  className?: string
}

const TAG: Record<Ticket['kind'], string> = { review: 'Review step', question: 'Question', permission: 'Permission', failed: 'Stopped' }

const PERMISSION_SAID: Record<PermissionDecision, string> = { allow_once: 'Allowed once.', allow_run: 'Allowed for the rest of the run.', deny: 'Denied. The agent carries on without it.' }

/**
 * Every place a team is waiting on the operator, across all teams, as one-question tickets.
 *
 * Newcomers get notification-style cards with the obvious answers; experts triage from the keyboard
 * (J/K move, A approve, R reply, O open the run), and every ticket opens the exact run it came from.
 */
export function NeedsYouTray({ tickets, working, onAnswer, onPermission, onDismiss, className = '' }: NeedsYouTrayProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [replying, setReplying] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [said, setSaid] = useState('')
  const [error, setError] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const bell = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const count = tickets.length
  const current = tickets[Math.min(active, Math.max(0, count - 1))]

  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node) && !bell.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  useEffect(() => {
    if (!open) return
    panel.current?.querySelector<HTMLElement>(`[data-ticket="${active}"]`)?.focus()
  }, [open, active])

  const send = async (ticket: Ticket, text: string, sendBack?: string) => {
    setBusy(ticket.id)
    setError(null)
    try {
      await onAnswer(ticket, text, sendBack)
      setSaid(sendBack ? `Sent back to ${ticket.teamName} with your note.` : text === APPROVAL_TEXT ? `Approved. ${ticket.teamName} carries on.` : `Answer sent to ${ticket.teamName}.`)
      setReplying(null)
      setDraft('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }
  const decide = async (ticket: Ticket, decision: PermissionDecision) => {
    if (!onPermission) return
    setBusy(ticket.id)
    setError(null)
    try {
      await onPermission(ticket, decision)
      setSaid(`${ticket.asker}: ${PERMISSION_SAID[decision]}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }
  const openRun = (ticket: Ticket) => window.location.assign(historyRunUrl({ id: ticket.runId, teamPath: ticket.teamPath }))
  const startReply = (ticket: Ticket) => { setReplying(ticket.id); setDraft('') }

  const onKeys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); if (replying) setReplying(null); else { setOpen(false); bell.current?.focus() } return }
    const typing = (event.target as HTMLElement).closest('input, textarea')
    if (typing || !current || event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key.toLowerCase()
    if (key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(count - 1, index + 1)) }
    else if (key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(0, index - 1)) }
    else if (key === 'a' && current.kind === 'review') { event.preventDefault(); void send(current, APPROVAL_TEXT) }
    else if (key === 'a' && current.kind === 'permission') { event.preventDefault(); void decide(current, 'allow_once') }
    else if (key === 'd' && current.kind === 'permission') { event.preventDefault(); void decide(current, 'deny') }
    else if (key === 'r' && current.kind !== 'failed' && current.kind !== 'permission') { event.preventDefault(); startReply(current) }
    else if (key === 'o') { event.preventDefault(); openRun(current) }
  }

  const label = count > 0 ? `${count} need${count === 1 ? 's' : ''} you` : working > 0 ? `${working} working` : 'All clear'
  return (
    <div className={`needs-you ${className}`} data-tour="needs-you">
      <button
        ref={bell}
        type="button"
        className={`needs-you-bell ${count > 0 ? 'has' : working > 0 ? 'working' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={count > 0 ? `${label}. Open the needs-you tray` : `${label}. Nothing is waiting on you`}
        title="Needs you"
        onClick={() => { setOpen((value) => !value); setActive(0); setSaid('') }}
      >
        <BellDot size={15} aria-hidden="true" />
        <span className="needs-you-label">{label}</span>
        {count > 0 && <b className="needs-you-n" aria-hidden="true">{count}</b>}
      </button>
      {open && (
        <div ref={panel} role="dialog" aria-labelledby={titleId} className="needs-you-panel e2" onKeyDown={onKeys}>
          <header>
            <h2 id={titleId}>Needs you</h2>
            <span>{count > 0 ? `${count} across your teams` : 'Nothing is waiting on you.'}</span>
            <button type="button" className="iconbtn" aria-label="Close" onClick={() => { setOpen(false); bell.current?.focus() }}><X size={15} /></button>
          </header>
          {count === 0 && <p className="needs-you-empty">{working > 0 ? `${working} run${working === 1 ? ' is' : 's are'} working. Anything that needs your decision will show up here.` : 'When a team pauses for your review, asks a question or asks permission, it shows up here — from any team.'}</p>}
          <ul className="needs-you-list">
            {tickets.map((ticket, index) => (
              <li key={ticket.id} data-ticket={index} tabIndex={-1} className={`ticket kind-${ticket.kind} ${index === active ? 'active' : ''}`} onFocus={() => setActive(index)}>
                <div className="ticket-head">
                  <span className={`ticket-tag kind-${ticket.kind}`}>{TAG[ticket.kind]}</span>
                  <span className="ticket-where">{ticket.teamName} · {ago(ticket.since)}</span>
                </div>
                <p className="ticket-text">
                  {ticket.kind === 'question' ? <><b>{ticket.asker}</b> asks: “{ticket.text}”</> : ticket.kind === 'permission' ? <>{ticket.text}. It is paused until you answer.</> : ticket.kind === 'review' ? <>{ticket.text || `${ticket.asker} is waiting for your approval.`}</> : <>{ticket.text}</>}
                </p>
                {ticket.context && <blockquote className="ticket-context" title={ticket.context}>{ticket.context}</blockquote>}
                {replying === ticket.id ? (
                  <form className="ticket-reply" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void send(ticket, draft.trim(), ticket.kind === 'review' ? ticket.sendBackTo ?? undefined : undefined) }}>
                    <label className="visually-hidden" htmlFor={`reply-${ticket.id}`}>{ticket.kind === 'question' ? 'Your answer' : 'What should change?'}</label>
                    <input id={`reply-${ticket.id}`} autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={ticket.kind === 'question' ? 'Type your answer' : ticket.sendBackTo ? 'What should change?' : 'Add a note for the team'} />
                    <button type="submit" className="btn btn-primary" disabled={!draft.trim() || busy === ticket.id}><CornerDownLeft size={13} aria-hidden="true" />Send</button>
                    <button type="button" className="btn" onClick={() => setReplying(null)}>Cancel</button>
                  </form>
                ) : (
                  <div className="ticket-acts">
                    {ticket.kind === 'review' && <button type="button" className="btn btn-primary" disabled={busy === ticket.id} onClick={() => void send(ticket, APPROVAL_TEXT)}><Check size={13} aria-hidden="true" />Looks good<kbd>A</kbd></button>}
                    {ticket.kind === 'review' && <button type="button" className="btn" onClick={() => startReply(ticket)}>{ticket.sendBackTo ? 'Send back…' : 'Add a note…'}<kbd>R</kbd></button>}
                    {ticket.kind === 'question' && <button type="button" className="btn btn-primary" onClick={() => startReply(ticket)}>Answer…<kbd>R</kbd></button>}
                    {ticket.kind === 'permission' && onPermission && <>
                      <button type="button" className="btn btn-primary" disabled={busy === ticket.id} onClick={() => void decide(ticket, 'allow_once')}><Check size={13} aria-hidden="true" />Allow<kbd>A</kbd></button>
                      <button type="button" className="btn" disabled={busy === ticket.id} onClick={() => void decide(ticket, 'allow_run')}>Allow for this run</button>
                      <button type="button" className="btn" disabled={busy === ticket.id} onClick={() => void decide(ticket, 'deny')}>Deny<kbd>D</kbd></button>
                    </>}
                    <button type="button" className="btn ghost" onClick={() => openRun(ticket)}>Open run<ArrowUpRight size={13} aria-hidden="true" /></button>
                    {ticket.kind === 'failed' && <button type="button" className="btn ghost" onClick={() => onDismiss(ticket.runId)}>Dismiss</button>}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {error && <p role="alert" className="needs-you-error">{error}</p>}
          <p className="needs-you-said" role="status">{said}</p>
          {count > 0 && <footer className="needs-you-keys" aria-hidden="true"><span><kbd>J</kbd><kbd>K</kbd> move</span><span><kbd>A</kbd> approve</span><span><kbd>R</kbd> reply</span><span><kbd>O</kbd> open run</span></footer>}
        </div>
      )}
    </div>
  )
}
