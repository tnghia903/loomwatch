import { ArrowUp, AtSign, CornerDownLeft, MessageSquareText, Users, X, Zap } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import type { ChatTarget } from '../../lib/chat/client'
import { destination, findMention, mentionChoices, mentionQuery, type ChatAgent, type Destination } from '../../lib/chat/route'
import { Swap } from './Appearing'
import type { RunRecord } from '../../lib/runs/client'

/** What the team is waiting on you for, which a typed answer goes with. */
export interface OpenDecision {
  runId: string
  node: string
  kind: 'review_stop' | 'question'
  /** Who asked: the agent with the question, or whose handover is under review. */
  from: string
  fromName: string
}

interface ChatComposerProps {
  agents: readonly ChatAgent[]
  names: ReadonlyMap<string, string>
  steps: number
  live: readonly RunRecord[]
  /** A review or question the team is waiting on: typing answers it rather than the team. */
  decision: OpenDecision | null
  disabled?: string | null
  /** The draft, held by the chat so a review's buttons can send it as their note. */
  value: string
  onChange: (text: string) => void
  onSend: (text: string, to: ChatTarget, now: boolean) => Promise<boolean>
  /** Your answer to an agent's question; a review is answered by the buttons on its message. */
  onAnswer: (decision: OpenDecision, text: string) => Promise<boolean>
  /** Counts the faces clicked to @mention them: each time, the box takes the caret and glows once. */
  mentioned?: number
}

/**
 * The message box at the bottom of a team's chat (ADR 0051). It always says where a message will
 * go before you send it — "Starts the team · 3 steps", "Starts Writer only", "Note for Writer ·
 * after its current step", "Team note · starts nothing" — because only an @ starts work and
 * nothing is guessed from the words.
 */
export function ChatComposer({ agents, names, steps, live, decision, disabled = null, value: text, onChange: setText, onSend, onAnswer, mentioned = 0 }: ChatComposerProps) {
  const [caret, setCaret] = useState(0)
  const [picked, setPicked] = useState(0)
  const [pickerClosed, setPickerClosed] = useState(false)
  const [sending, setSending] = useState(false)
  const [teamInstead, setTeamInstead] = useState(false)
  // Each send ripples once from the box, the message leaving it.
  const [sent, setSent] = useState(0)
  const box = useRef<HTMLTextAreaElement>(null)
  const pickerId = useId()
  const hintId = useId()

  // The getting-started guide and the Build "Run" button put a request in the box; it is still
  // yours to read and send.
  useEffect(() => {
    const compose = (event: Event) => {
      const value = (event as CustomEvent<unknown>).detail
      if (typeof value !== 'string') return
      setText(value.startsWith('@') ? value : `@team ${value}`)
      window.setTimeout(() => box.current?.focus(), 0)
    }
    window.addEventListener('loomwatch:compose', compose)
    return () => window.removeEventListener('loomwatch:compose', compose)
  }, [setText])

  // A face clicked to @mention its agent: carry on writing after the name.
  useEffect(() => {
    if (mentioned === 0) return
    const field = box.current
    if (!field) return
    field.focus()
    const end = field.value.length
    field.setSelectionRange(end, end)
    setCaret(end)
  }, [mentioned])

  // A new decision takes the box back from "write to the team instead".
  const decisionKey = decision ? `${decision.runId}:${decision.node}` : null
  const [seenDecision, setSeenDecision] = useState(decisionKey)
  if (decisionKey !== seenDecision) {
    setSeenDecision(decisionKey)
    setTeamInstead(false)
  }
  const answering = decision && !teamInstead ? decision : null

  const mention = useMemo(() => findMention(text, agents), [text, agents])
  const target: ChatTarget = mention?.target ?? null
  const query = mentionQuery(text, caret)
  const choices = useMemo(() => (query && !pickerClosed ? mentionChoices(query.query, agents) : []), [query, pickerClosed, agents])
  const pickerOpen = choices.length > 0
  const where: Destination = destination(target, live, names, steps)
  const canSendNow = where.route === 'note'
  const trimmed = text.trim()

  // Where the caret goes once the text it belongs to is on screen: set in the same commit, so
  // whatever is typed next lands after the inserted name, however fast it comes.
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const at = pendingCaret.current
    if (at === null || !box.current) return
    pendingCaret.current = null
    box.current.focus()
    box.current.setSelectionRange(at, at)
  }, [text])
  const insert = (choice: { insert: string }) => {
    if (!query) return
    const next = `${text.slice(0, query.start)}${choice.insert}${text.slice(caret).replace(/^\S*\s?/, '')}`
    const at = query.start + choice.insert.length
    pendingCaret.current = at
    setCaret(at)
    setText(next)
    setPicked(0)
  }

  const send = async (now: boolean) => {
    if (!trimmed || sending || disabled) return
    // Out of the box at once, as in any chat: the message shows in the log while it goes. It comes
    // back only if it was held — a team that needs checking first — so nothing typed is lost.
    const kept = text
    setText('')
    setSent((count) => count + 1)
    setSending(true)
    const ok = answering && answering.kind === 'question'
      ? await onAnswer(answering, trimmed)
      : await onSend(trimmed, target, now)
    setSending(false)
    if (!ok) setText(kept)
  }

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setPicked((index) => (index + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        insert(choices[Math.min(picked, choices.length - 1)])
        return
      }
      if (event.key === 'Escape') {
        // Closes the picker and nothing else: the workspace's Escape would also leave the box.
        event.preventDefault()
        event.stopPropagation()
        setPickerClosed(true)
        return
      }
    }
    if (event.key === 'Escape' && answering) {
      event.preventDefault()
      event.stopPropagation()
      setTeamInstead(true)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      // A review is decided with its buttons; Enter never approves by accident.
      if (answering?.kind === 'review_stop') return
      void send(false)
    }
  }

  // An empty box says how to start work; once there are words, it says where they will go.
  const hint = !answering && !trimmed
  const answeringLabel = answering
    ? answering.kind === 'question'
      ? `Your answer to ${answering.fromName}'s question`
      : `A note to go with your review of ${answering.fromName}'s work · press Approve or Send back above`
    : null
  const route = answering ? null : where.route
  const icon = answering ? <MessageSquareText size={14} aria-hidden="true" />
    : route === 'team' ? <Users size={14} aria-hidden="true" />
      : route === 'agent' ? <AtSign size={14} aria-hidden="true" />
        : <MessageSquareText size={14} aria-hidden="true" />
  const sendLabel = answering ? 'Reply' : route === 'team' || route === 'agent' ? 'Start' : 'Send note'

  return (
    <form className={`tc-composer${answering ? ' answering' : ''}`} data-tour="composer" onSubmit={(event) => { event.preventDefault(); void send(false) }}>
      <div className={`tc-where route-${hint ? 'hint' : route ?? 'answer'}`} id={hintId} aria-live="polite">
        {hint ? <AtSign size={14} aria-hidden="true" /> : icon}
        {hint
          ? <Swap key="hint"><b>@team</b> starts everyone · <b>@name</b> starts one agent</Swap>
          : <Swap key={answeringLabel ?? where.label}>{answeringLabel ?? where.label}</Swap>}
        {answering && (
          <button type="button" className="tc-where-escape" onClick={() => setTeamInstead(true)}>
            <X size={12} aria-hidden="true" />Write to the team instead
          </button>
        )}
        {!answering && route === 'team_note' && trimmed && <em className="tc-where-hint">Add @team or @{agents.find((agent) => !agent.operator)?.name ?? 'name'} to start work.</em>}
      </div>
      <div className="tc-box">
        {sent > 0 && <span key={sent} className="tc-ripple" aria-hidden="true" />}
        {mentioned > 0 && <span key={`mention-${mentioned}`} className="tc-mention-glow" aria-hidden="true" />}
        {pickerOpen && (
          <ul className="tc-picker e2" id={pickerId} role="listbox" aria-label="Who to write to">
            {choices.map((choice, index) => {
              const working = live.some((run) => run.working?.includes(choice.id))
              return (
                <li key={choice.id} id={`${pickerId}-${choice.id}`} role="option" aria-selected={index === picked}
                  className={index === picked ? 'picked' : ''}
                  onMouseDown={(event) => { event.preventDefault(); insert(choice) }}
                  onMouseEnter={() => setPicked(index)}>
                  {choice.id === 'team' ? <Users size={14} aria-hidden="true" /> : <AtSign size={14} aria-hidden="true" />}
                  <b>{choice.id === 'team' ? '@team' : `@${choice.label}`}</b>
                  <span>{choice.id === 'team' ? `everyone, from step one` : working ? 'working now · a note joins its turn' : 'works alone on it'}</span>
                </li>
              )
            })}
          </ul>
        )}
        <textarea
          ref={box}
          className="tc-input"
          rows={1}
          value={text}
          placeholder={answering?.kind === 'question' ? `Answer ${answering.fromName}…`
            : answering ? 'A note for Approve, or what to change'
              : 'Message the team'}
          aria-label="Message the team"
          aria-describedby={hintId}
          aria-controls={pickerOpen ? pickerId : undefined}
          aria-expanded={pickerOpen}
          aria-activedescendant={pickerOpen ? `${pickerId}-${choices[Math.min(picked, choices.length - 1)].id}` : undefined}
          disabled={Boolean(disabled)}
          onChange={(event) => { setText(event.target.value); setCaret(event.target.selectionStart); setPickerClosed(false); setPicked(0) }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={keyDown}
        />
        <div className="tc-send">
          {canSendNow && !answering && (
            <button type="button" className="btn tc-now" disabled={!trimmed || sending} onClick={() => void send(true)} title={`Stop ${names.get(where.agent ?? '') ?? 'the agent'}'s current step and give it this at once`}>
              <Zap size={13} aria-hidden="true" />Send now
            </button>
          )}
          {/* A review is decided with the buttons on its message; this box only holds the note. */}
          {answering?.kind !== 'review_stop' && (
            <button type="submit" className="btn btn-primary tc-go" disabled={!trimmed || sending || Boolean(disabled)} aria-label={sendLabel}>
              {sendLabel === 'Start' ? <ArrowUp size={15} aria-hidden="true" /> : <CornerDownLeft size={14} aria-hidden="true" />}
              <span>{sendLabel}</span>
            </button>
          )}
        </div>
      </div>
      {disabled && <p className="tc-disabled" role="status">{disabled}</p>}
    </form>
  )
}
