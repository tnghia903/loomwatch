import { ArrowUpRight, BellDot, Check, CornerDownLeft, X } from '../ui/icon'
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

import { plainWords } from '../../lib/chat/findWords'
import type { PermissionDecision, SpendDecision } from '../../lib/runs/client'
import { permissionSaid } from '../../lib/runs/permissionRequests'
import { historyRunUrl } from '../../lib/runs/history'
import { ago, APPROVAL_TEXT, type Ticket } from '../../lib/story/needsYou'
import { goToRun } from '../agents/route'
import { InlineMarkdown } from '../ui/Markdown'
import { stateLabel } from '../../lib/state/words'

interface NeedsYouTrayProps {
  tickets: readonly Ticket[]
  /** Runs working without needing anything, for the quiet "all clear" state. */
  working: number
  onAnswer: (ticket: Ticket, text: string, sendBack?: string) => Promise<void>
  /** A permission ticket's answer (ADR 0040). Absent: permission tickets only open their run. */
  onPermission?: (ticket: Ticket, decision: PermissionDecision) => Promise<void>
  /** A spend ticket's answer (ADR 0068). Absent: spend tickets only open their run. */
  onSpend?: (ticket: Ticket, decision: SpendDecision) => Promise<void>
  onDismiss: (runId: string) => void
  /** The run the screen shows, whose own answer box and permission card already ask (ADR 0043). */
  onScreenRunId?: string | null
  className?: string
}

const TAG: Record<Ticket['kind'], string> = { review: 'Review step', question: 'Question', permission: 'Permission', spend: 'Spending', failed: stateLabel('failed') }
/** A review's or a question's context is what an agent wrote, in Markdown; a permission's command is shown as it is. */
const agentWrote = (ticket: Ticket) => ticket.kind === 'review' || ticket.kind === 'question'


// Tickets the bell has already rung for, kept for the tab's session: Home, a team and an agent are
// separate pages, and each page's tray starts empty until its first poll, so a tray's own memory
// would ring again on every page.
const RUNG_KEY = 'loomwatch.needsYou.rung'
const rungHere = new Set<string>()
function rungFor(): Set<string> {
  try { for (const id of JSON.parse(sessionStorage.getItem(RUNG_KEY) ?? '[]') as string[]) rungHere.add(id) } catch { /* storage off: this page still remembers */ }
  return rungHere
}
function remember(ids: readonly string[]) {
  for (const id of ids) rungHere.add(id)
  try { sessionStorage.setItem(RUNG_KEY, JSON.stringify([...rungHere].slice(-200))) } catch { /* storage off: this page still remembers */ }
}
// A ring under way finishes, then the bell rests at least this long, so tickets arriving in
// back-to-back polls never add up to more than five seconds of motion (WCAG 2.2.2).
const REST_MS = 5000
let lastRingEnded = -REST_MS

/**
 * Every place a team is waiting on the operator, across all teams, as one-question tickets.
 *
 * Newcomers get notification-style cards with the obvious answers; experts triage from the keyboard
 * (J/K move, A approve, R reply, O open the run), and every ticket opens the exact run it came from.
 */
export function NeedsYouTray({ tickets, working, onAnswer, onPermission, onSpend, onDismiss, onScreenRunId = null, className = '' }: NeedsYouTrayProps) {
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
  const shown = Math.min(active, Math.max(0, count - 1))
  const current = tickets[shown]
  // One gold fill per screen: only the active ticket's main action is filled; J and K move it.
  const main = (index: number) => (index === shown ? 'btn btn-primary' : 'btn')

  // A Review or Answer on Home opens this tray at its own item, "Show N more" at the first (ADR
  // 0097): one control answers them all.
  const ticketsNow = useRef(tickets)
  useEffect(() => { ticketsNow.current = tickets })
  useEffect(() => {
    const show = (event: Event) => {
      const runId = (event as CustomEvent<string | undefined>).detail
      setOpen(true)
      setActive(Math.max(0, runId ? ticketsNow.current.findIndex((ticket) => ticket.runId === runId) : 0))
      setSaid('')
    }
    window.addEventListener('loomwatch:open-needs-you', show)
    return () => window.removeEventListener('loomwatch:open-needs-you', show)
  }, [])

  // The bell rings when something new needs you, then rests: ringing for as long as a ticket waits
  // runs past WCAG 2.2.2's five seconds. A count that only goes down never rings. The ring is the
  // glyph's CSS animation, started here and taken off when it ends.
  useEffect(() => {
    const glyph = bell.current?.querySelector('svg')
    // Answering the last ticket mid-ring stops the ring with no animationend: it counts as ended.
    if (tickets.length === 0 && glyph?.classList.contains('ringing')) { glyph.classList.remove('ringing'); lastRingEnded = Date.now() }
    const rung = rungFor()
    const fresh = tickets.filter((ticket) => !rung.has(ticket.id))
    if (fresh.length === 0) return
    remember(fresh.map((ticket) => ticket.id))
    // A ring under way just carries on: the class is already there.
    if (!glyph || Date.now() - lastRingEnded < REST_MS) return
    glyph.classList.add('ringing')
  }, [tickets])

  useEffect(() => {
    if (!open) return
    // A press or focus outside closes it, so a dialog opened from the keyboard, or a page button
    // reached with Tab, has its own gold fill back before anything is pressed.
    const outside = (event: Event) => {
      if (!panel.current?.contains(event.target as Node) && !bell.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('focusin', outside)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('focusin', outside) }
  }, [open])
  // While the tray shows its fill, the page's own fills step back to a ring (loom.css), so the open
  // tray is the screen's one gold fill. A ticket answered on this screen, a stopped run or an empty
  // tray has none, and the page keeps its own. Before paint, so the page's fill starts stepping back
  // in the frame the tray's first shows.
  useLayoutEffect(() => {
    if (!open || !panel.current?.querySelector('.btn-primary')) return
    const root = document.documentElement
    root.dataset.needsYouFill = ''
    return () => { delete root.dataset.needsYouFill }
  })
  useEffect(() => {
    if (!open) return
    // J and K move focus to the ticket; Tab into one of its buttons leaves focus on that button.
    const ticket = panel.current?.querySelector<HTMLElement>(`[data-ticket="${active}"]`)
    if (ticket && !ticket.contains(document.activeElement)) ticket.focus()
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
      setSaid(`${ticket.asker}: ${permissionSaid(decision, ticket.switch)}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }
  const spend = async (ticket: Ticket, decision: SpendDecision) => {
    if (!onSpend) return
    setBusy(ticket.id)
    setError(null)
    try {
      await onSpend(ticket, decision)
      setSaid(decision === 'add' ? `${ticket.asker}: money added, carrying on.` : `${ticket.asker}: ${ticket.spendActions?.finish ?? 'finished'}.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }
  const openRun = (ticket: Ticket) => goToRun(historyRunUrl({ id: ticket.runId, teamPath: ticket.teamPath }))
  const startReply = (ticket: Ticket) => { setReplying(ticket.id); setDraft('') }

  // The run on screen already asks with its own answer box and permission card, so its ticket
  // here only says so: a second set of the same buttons would be two controls for one thing
  // (ADR 0043). It still counts, because it still needs you.
  const onScreen = (ticket: Ticket) => ticket.runId === onScreenRunId && ticket.kind !== 'failed'
  const onKeys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); if (replying) setReplying(null); else { setOpen(false); bell.current?.focus() } return }
    const typing = (event.target as HTMLElement).closest('input, textarea')
    if (typing || !current || event.metaKey || event.ctrlKey || event.altKey) return
    if (onScreen(current) && event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && !['j', 'k'].includes(event.key.toLowerCase())) return
    const key = event.key.toLowerCase()
    if (key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); setActive(Math.min(count - 1, shown + 1)) }
    else if (key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); setActive(Math.max(0, shown - 1)) }
    else if (key === 'a' && current.kind === 'review') { event.preventDefault(); void send(current, APPROVAL_TEXT) }
    else if (key === 'a' && current.kind === 'permission') { event.preventDefault(); void decide(current, 'allow_once') }
    else if (key === 'd' && current.kind === 'permission') { event.preventDefault(); void decide(current, 'deny') }
    else if (key === 'r' && current.kind !== 'failed' && current.kind !== 'permission') { event.preventDefault(); startReply(current) }
    else if (key === 'o' && current.runId !== onScreenRunId) { event.preventDefault(); openRun(current) }
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
        <BellDot size={15} aria-hidden="true" onAnimationEnd={(event) => { event.currentTarget.classList.remove('ringing'); lastRingEnded = Date.now() }} />
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
              <li key={ticket.id} data-ticket={index} tabIndex={-1} className={`ticket kind-${ticket.kind} ${index === shown ? 'active' : ''}`} onFocus={() => setActive(index)}>
                <div className="ticket-head">
                  <span className={`ticket-tag kind-${ticket.kind}`}>{TAG[ticket.kind]}</span>
                  <span className="ticket-where">{ticket.teamName} · {ago(ticket.since)}</span>
                </div>
                <p className="ticket-text">
                  {ticket.kind === 'question' ? <><b>{ticket.asker}</b> asks: “<InlineMarkdown clickable={false}>{ticket.text}</InlineMarkdown>”</> : ticket.kind === 'permission' ? <>{ticket.text}. It is paused until you answer.</> : ticket.kind === 'spend' ? <>{ticket.text}</> : ticket.kind === 'review' ? <>{ticket.text ? <InlineMarkdown clickable={false}>{ticket.text}</InlineMarkdown> : `${ticket.asker} is waiting for your approval.`}</> : <>{ticket.text}</>}
                </p>
                {ticket.context && <blockquote className="ticket-context" title={agentWrote(ticket) ? plainWords(ticket.context) : ticket.context}>{agentWrote(ticket) ? <InlineMarkdown clickable={false}>{ticket.context}</InlineMarkdown> : ticket.context}</blockquote>}
                {onScreen(ticket) ? (
                  <p className="ticket-here t-meta">On this screen: answer it below.</p>
                ) : replying === ticket.id ? (
                  <form className="ticket-reply" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void send(ticket, draft.trim(), ticket.kind === 'review' ? ticket.sendBackTo ?? undefined : undefined) }}>
                    <label className="visually-hidden" htmlFor={`reply-${ticket.id}`}>{ticket.kind === 'question' ? 'Your answer' : 'What should change?'}</label>
                    <input id={`reply-${ticket.id}`} autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={ticket.kind === 'question' ? 'Type your answer' : ticket.sendBackTo ? 'What should change?' : 'Add a note for the team'} />
                    <button type="submit" className={main(index)} disabled={!draft.trim() || busy === ticket.id}><CornerDownLeft size={13} aria-hidden="true" />Send</button>
                    <button type="button" className="btn" onClick={() => setReplying(null)}>Cancel</button>
                  </form>
                ) : (
                  <div className="ticket-acts">
                    {ticket.kind === 'review' && <button type="button" className={main(index)} disabled={busy === ticket.id} onClick={() => void send(ticket, APPROVAL_TEXT)}><Check size={13} aria-hidden="true" />Approve<kbd>A</kbd></button>}
                    {ticket.kind === 'review' && <button type="button" className="btn" onClick={() => startReply(ticket)}>{ticket.sendBackTo ? 'Send back…' : 'Add a note…'}<kbd>R</kbd></button>}
                    {ticket.kind === 'question' && <button type="button" className={main(index)} onClick={() => startReply(ticket)}>Answer…<kbd>R</kbd></button>}
                    {ticket.kind === 'permission' && onPermission && <>
                      <button type="button" className={main(index)} disabled={busy === ticket.id} onClick={() => void decide(ticket, 'allow_once')}><Check size={13} aria-hidden="true" />Allow<kbd>A</kbd></button>
                      {/* A yes to the web is already for the rest of the run (ADR 0104). */}
                      {ticket.switch !== 'web' && <button type="button" className="btn" disabled={busy === ticket.id} onClick={() => void decide(ticket, 'allow_run')}>Allow for this run</button>}
                      {ticket.team && <button type="button" className="btn" disabled={busy === ticket.id} onClick={() => void decide(ticket, 'allow_team')}>Allow for the whole team</button>}
                      <button type="button" className="btn" disabled={busy === ticket.id} onClick={() => void decide(ticket, 'deny')}>Deny<kbd>D</kbd></button>
                    </>}
                    {ticket.kind === 'spend' && onSpend && ticket.spendActions && <>
                      <button type="button" className={main(index)} disabled={busy === ticket.id} onClick={() => void spend(ticket, 'add')}>{ticket.spendActions.add}</button>
                      <button type="button" className="btn" disabled={busy === ticket.id} onClick={() => void spend(ticket, 'finish')}>{ticket.spendActions.finish}</button>
                    </>}
                    {ticket.runId !== onScreenRunId && <button type="button" className="btn" onClick={() => openRun(ticket)}>Open run<ArrowUpRight size={13} aria-hidden="true" /></button>}
                    {ticket.kind === 'failed' && <button type="button" className="btn" onClick={() => onDismiss(ticket.runId)}>Dismiss</button>}
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
