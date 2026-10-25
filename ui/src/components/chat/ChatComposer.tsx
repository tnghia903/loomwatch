import { ArrowUp, AtSign, CornerDownLeft, MessageSquareText, Paperclip, Reply, TextQuote, Users, X, Zap } from 'lucide-react'
import { createElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { pastedName, type Attachment, type ChatAttachments } from '../../lib/chat/attachments'
import type { ChatTarget, ReplyTo } from '../../lib/chat/client'
import { extensionOf } from '../../lib/files/fileRefs'
import { fileIcon } from '../../lib/files/icons'
import { rawFileUrl } from '../../lib/files/reader'
import { replyWhat, replyWords } from '../../lib/chat/reply'
import { destination, findMention, mentionChoices, mentionQuery, type ChatAgent, type Destination } from '../../lib/chat/route'
import { InlineMarkdown } from '../ui/Markdown'
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
  /**
   * The one agent this chat is with (an agent's own chat in Your agents): every message goes to it,
   * so there is nothing to @ and no picker. It starts work when the agent is free, and joins its
   * turn as a note while it works.
   */
  solo?: ChatAgent | null
  /**
   * The message this one replies to (Reply under something an agent said): shown above the box
   * until it is sent or let go. The message still goes where its @ sends it.
   */
  replyTo?: ReplyTo | null
  onCancelReply?: () => void
  /** Address the message to another agent the reply is about: its @ takes the place of the one there. */
  onAddress?: (agent: string) => void
  /** Counts the times Reply was pressed on what the team waits on you for: the box goes back to answering it. */
  answerAsked?: number
  /** Pictures and files pasted, dropped or chosen to go with the words (ADR 0082). */
  attachments?: ChatAttachments
  /** A line about something just done from the chat, such as a dropped folder added. */
  notice?: string | null
}

/**
 * The message box at the bottom of a team's chat (ADR 0051). It always says where a message will
 * go before you send it — "Starts the team · 3 steps", "Starts Writer only", "Note for Writer ·
 * after its current step", "Team note · starts nothing" — because only an @ starts work and
 * nothing is guessed from the words.
 */
export function ChatComposer({ agents, names, steps, live, decision, disabled = null, value: text, onChange: setText, onSend, onAnswer, mentioned = 0, solo = null, replyTo = null, onCancelReply, onAddress, answerAsked = 0, attachments, notice = null }: ChatComposerProps) {
  const [caret, setCaret] = useState(0)
  const [picked, setPicked] = useState(0)
  const [pickerClosed, setPickerClosed] = useState(false)
  const [sending, setSending] = useState(false)
  const [teamInstead, setTeamInstead] = useState(false)
  // Each send ripples once from the box, the message leaving it.
  const [sent, setSent] = useState(0)
  const box = useRef<HTMLTextAreaElement>(null)
  const chooser = useRef<HTMLInputElement>(null)
  const pickerId = useId()
  const whereId = useId()

  // The getting-started guide and the Build "Run" button put a request in the box; it is still
  // yours to read and send.
  useEffect(() => {
    const compose = (event: Event) => {
      const value = (event as CustomEvent<unknown>).detail
      if (typeof value !== 'string') return
      setText(value.startsWith('@') || solo ? value : `@team ${value}`)
      window.setTimeout(() => box.current?.focus(), 0)
    }
    window.addEventListener('loomwatch:compose', compose)
    return () => window.removeEventListener('loomwatch:compose', compose)
  }, [setText, solo])

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
  // So does Reply on the message that asks.
  const [seenAsked, setSeenAsked] = useState(answerAsked)
  if (answerAsked !== seenAsked) {
    setSeenAsked(answerAsked)
    setTeamInstead(false)
  }
  useEffect(() => {
    if (answerAsked > 0) box.current?.focus()
  }, [answerAsked])
  const attached = attachments?.items ?? []
  // A reply to something else is a message of its own, not your answer to what the team waits on.
  const answering = decision && !teamInstead && !replyTo ? decision : null
  // Files go with words, and only once each is kept; one that can't be kept is taken out first.
  // An answer takes words only, so files wait for a message of their own.
  const filesHold = attached.some((item) => item.state !== 'ready') || Boolean(answering && attached.length > 0)

  const mention = useMemo(() => (solo ? null : findMention(text, agents)), [solo, text, agents])
  const target: ChatTarget = solo ? { kind: 'agent', agent: solo.id } : mention?.target ?? null
  const query = solo ? null : mentionQuery(text, caret)
  const choices = useMemo(() => (query && !pickerClosed ? mentionChoices(query.query, agents) : []), [query, pickerClosed, agents])
  const pickerOpen = choices.length > 0
  const routed: Destination = destination(target, live, names, steps)
  // With one agent there is nobody else it could start: the box just says who it goes to.
  const where: Destination = solo && routed.route === 'agent' ? { ...routed, label: `To ${solo.name || solo.id}` } : routed
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
    if (!trimmed || sending || disabled || filesHold) return
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
    if (event.key === 'Escape' && replyTo && onCancelReply) {
      // Lets go of the reply and nothing else; the words stay in the box.
      event.preventDefault()
      event.stopPropagation()
      onCancelReply()
      return
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

  // An empty box has nothing above it; once there are words, it says where they will go. A chat
  // with one agent has only one place a message can go, so it says that from the start.
  const quiet = !solo && !answering && !trimmed && !replyTo
  const answeringLabel = answering
    ? answering.kind === 'question'
      ? `Your answer to ${answering.fromName}'s question`
      : `A note to go with your review of ${answering.fromName}'s work · press Approve or Send back above`
    : null
  const route = answering ? null : where.route
  const icon = answering ? <MessageSquareText size={14} aria-hidden="true" />
    : route === 'team' ? <Users size={14} aria-hidden="true" />
      : route === 'agent' && !solo ? <AtSign size={14} aria-hidden="true" />
        : <MessageSquareText size={14} aria-hidden="true" />
  const starts = !answering && (route === 'team' || route === 'agent')
  const sendLabel = answering ? 'Reply' : starts ? (solo ? 'Send' : 'Start') : 'Send note'
  const name = (id: string) => names.get(id) ?? id
  const addressed = target?.kind === 'agent' ? target.agent : null
  const them = attached.length === 1 ? 'it' : 'them'
  // A part of a file asked about says so first, though its picture is in the box too (ADR 0091); a
  // thing in a web page is named for what it is.
  const thisPart = replyTo?.at?.kind === 'element' ? `this ${replyTo.at.what}` : 'this part'
  const placeholder = replyTo?.kind === 'passage' && !answering ? `Ask ${name(addressed ?? replyTo.from)} about ${thisPart}…`
    : attached.length > 0 && !answering ? (solo || target ? `Say what to do with ${them}` : `@team, then what to do with ${them}`)
    : answering?.kind === 'question' ? `Answer ${answering.fromName}…`
    : answering ? 'A note for Approve, or what to change'
      : replyTo?.kind === 'passage' ? `Ask ${name(addressed ?? replyTo.from)} about ${thisPart}…`
        : replyTo ? `Reply to ${name(replyTo.from)}…`
        : solo ? `Message ${solo.name || solo.id}` : 'Message the team'
  // A reply about two agents — a handover, a question between them — can go to either: the other
  // one is a click away.
  const parties = replyTo && !solo ? [replyTo.from, replyTo.to].filter((id): id is string => id !== null && agents.some((agent) => agent.id === id && !agent.operator)) : []
  const other = parties.length === 2 && parties[0] !== parties[1] ? parties.find((id) => id !== addressed) ?? null : null

  return (
    <form className={`tc-composer${answering ? ' answering' : ''}`} data-tour="composer" onSubmit={(event) => { event.preventDefault(); void send(false) }}>
      {!quiet && (
        <div className={`tc-where route-${route ?? 'answer'}`} id={whereId} aria-live="polite">
          {icon}
          <Swap key={answeringLabel ?? where.label}>{answeringLabel ?? where.label}</Swap>
          {answering && (
            <button type="button" className="tc-where-escape" onClick={() => setTeamInstead(true)}>
              <X size={12} aria-hidden="true" />{solo ? 'Write a note instead' : 'Write to the team instead'}
            </button>
          )}
          {!answering && route === 'team_note' && trimmed && <em className="tc-where-hint">Add @team or @{agents.find((agent) => !agent.operator)?.name ?? 'name'} to start work.</em>}
          {answering && attached.length > 0 && <em className="tc-where-hint">Pictures and files can’t go with an answer yet. Take them out to answer.</em>}
        </div>
      )}
      {notice && <p className="tc-notice" role="status">{notice}</p>}
      {replyTo && (
        <div className={`tc-replying${replyTo.kind === 'passage' ? ' passage' : ''}`} role="group" aria-label={`${replyTo.kind === 'passage' ? 'Asking about' : 'Replying to'} ${replyWhat(replyTo, name)}`}>
          {replyTo.kind === 'passage' ? <TextQuote size={14} aria-hidden="true" /> : <Reply size={14} aria-hidden="true" />}
          <span className="tc-replying-body">
            <span className="tc-replying-what">{replyTo.kind === 'passage' ? 'Asking about' : 'Replying to'} {replyWhat(replyTo, name)}</span>
            <span className="tc-replying-quote"><InlineMarkdown clickable={false}>{replyWords(replyTo)}</InlineMarkdown></span>
          </span>
          {other && onAddress && <button type="button" className="tc-link" onClick={() => onAddress(other)}>To {name(other)} instead</button>}
          {onCancelReply && <button type="button" className="tc-link tc-replying-close" onClick={onCancelReply} aria-label="Don't reply to it" title="Don't reply to it (Esc)"><X size={13} aria-hidden="true" /></button>}
        </div>
      )}
      {attachments && attached.length > 0 && <Attached items={attached} onRemove={attachments.remove} />}
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
          placeholder={placeholder}
          aria-label={solo ? `Message ${solo.name || solo.id}` : 'Message the team'}
          aria-describedby={quiet ? undefined : whereId}
          aria-controls={pickerOpen ? pickerId : undefined}
          aria-expanded={pickerOpen}
          aria-activedescendant={pickerOpen ? `${pickerId}-${choices[Math.min(picked, choices.length - 1)].id}` : undefined}
          disabled={Boolean(disabled)}
          onChange={(event) => { setText(event.target.value); setCaret(event.target.selectionStart); setPickerClosed(false); setPicked(0) }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={keyDown}
          onPaste={(event) => {
            // A screenshot or a file copied in Finder goes with the words; text pastes as text.
            const files = Array.from(event.clipboardData?.files ?? [])
            if (!attachments || files.length === 0) return
            event.preventDefault()
            attachments.add(files, (file) => pastedName(file))
          }}
        />
        <div className="tc-send">
          {attachments && (
            <>
              <input ref={chooser} type="file" multiple hidden tabIndex={-1} aria-hidden="true" onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                if (files.length > 0) attachments.add(files)
              }} />
              <button type="button" className="tc-attach" disabled={Boolean(disabled)} onClick={() => chooser.current?.click()} aria-label="Add pictures or files" title="Add pictures or files">
                <Paperclip size={16} aria-hidden="true" />
              </button>
            </>
          )}
          {canSendNow && !answering && (
            <button type="button" className="btn tc-now" disabled={!trimmed || sending || filesHold} onClick={() => void send(true)} title={`Stop ${names.get(where.agent ?? '') ?? 'the agent'}'s current step and give it this at once`}>
              <Zap size={13} aria-hidden="true" />Send now
            </button>
          )}
          {/* A review is decided with the buttons on its message; this box only holds the note. */}
          {answering?.kind !== 'review_stop' && (
            <button type="submit" className="btn btn-primary tc-go" disabled={!trimmed || sending || Boolean(disabled) || filesHold} aria-label={sendLabel} title={filesHold && !answering ? 'Waits for your files' : undefined}>
              {starts ? <ArrowUp size={15} aria-hidden="true" /> : <CornerDownLeft size={14} aria-hidden="true" />}
              <span>{sendLabel}</span>
            </button>
          )}
        </div>
      </div>
      {disabled && <p className="tc-disabled" role="status">{disabled}</p>}
    </form>
  )
}

/**
 * The files going with the words, above the box as a reply's quote is: a picture drawn small, any
 * other file as its sheet and name. Each comes out with its ✕; one that can't be sent says why.
 */
function Attached({ items, onRemove }: { items: readonly Attachment[]; onRemove: (id: string) => void }) {
  return (
    <ul className="tc-attached" aria-label="Going with your message">
      {items.map((item) => {
        const shown = item.state === 'failed' ? null : item.preview ?? (item.picture && item.kept ? rawFileUrl(item.kept.path) : null)
        const extension = extensionOf(item.name).toUpperCase()
        return (
          <li key={item.id} className={`tc-attached-item ${item.state}${shown ? ' picture' : ''}`} aria-busy={item.state === 'uploading'} aria-label={item.problem ? `${item.name}: ${item.problem}` : item.name} title={item.detail ?? item.problem ?? item.name}>
            {shown
              ? <img src={shown} alt="" decoding="async" />
              : <span className="tc-attached-sheet" aria-hidden="true">{createElement(fileIcon(undefined, item.name), { size: 13 })}{extension && <b>{extension}</b>}</span>}
            {!shown && <span className="tc-attached-name">{item.name}</span>}
            {item.problem && <span className="tc-attached-problem">{item.problem}</span>}
            <button type="button" className="tc-attached-remove" onClick={() => onRemove(item.id)} aria-label={`Don’t send ${item.name}`} title="Don’t send it">
              <X size={12} aria-hidden="true" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
