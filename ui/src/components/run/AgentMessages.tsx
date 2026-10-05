import { ArrowRight, ChevronDown, FileSearch, FileText, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { callsWhileWaiting, converse, fold, isQuestion, itemTouches, lineSentence, waited, type Item, type Party } from '../../lib/story/conversation'
import { APPROVAL_TEXT } from '../../lib/story/needsYou'
import { clock, describeEvidence } from '../../lib/story/weft'
import type { Evidence } from '../../lib/watch/events'
import type { TeamMessage } from '../../lib/watch/messages'
import { AgentMark } from '../ui/AgentMark'

interface AgentMessagesProps {
  messages: readonly TeamMessage[]
  /** The team in the run view's order; the review step is `operator`. */
  order: readonly Party[]
  /** The team's connections into each agent, for runs that predate the recorded senders. */
  predecessors?: ReadonlyMap<string, readonly string[]>
  /** Every recorded call, for what an agent did between a question and its answer. */
  evidence: readonly Evidence[]
  /** Whether the run can still add to this: a waiting question is then waiting, not unanswered. */
  live: boolean
  onInspectEvidence: (id: string) => void
  onInspectHandover?: (agentId: string) => void
  /** Open one message, from outside (the timeline). `at` makes a repeat request count. */
  reveal?: { id: string; at: number } | null
  /** Show only one agent's messages, from outside (a stage card). */
  focus?: { laneId: string; at: number } | null
}

/**
 * What the agents said to each other, in order: one row per message, read like a chat list — who
 * to whom, the first words, and the answer under it. A row opens to the whole text, verbatim, and
 * the way to its record. A review you approved is one row, with where it went on to, rather than
 * three rows repeating the same handover.
 */
export function AgentMessages({ messages, order, predecessors, evidence, live, onInspectEvidence, onInspectHandover, reveal = null, focus = null }: AgentMessagesProps) {
  const { lanes, items } = useMemo(() => {
    const conversation = converse(messages, order, predecessors)
    return { lanes: conversation.lanes, items: fold(conversation.lines, conversation.lanes) }
  }, [messages, order, predecessors])
  const [onlyQuestions, setOnlyQuestions] = useState(false)
  const [laneFocus, setLaneFocus] = useState<string | null>(null)
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const [flash, setFlash] = useState<string | null>(null)

  // Requests from outside, honoured during render so the list they filter arrives with them. Null
  // to start with, so a request made before this loaded (it is loaded on demand) still counts.
  const [honouredFocus, setHonouredFocus] = useState<typeof focus>(null)
  if (focus !== honouredFocus) {
    setHonouredFocus(focus)
    if (focus) { setLaneFocus(focus.laneId); setOnlyQuestions(false) }
  }
  const [honouredReveal, setHonouredReveal] = useState<typeof reveal>(null)
  if (reveal !== honouredReveal) {
    setHonouredReveal(reveal)
    const row = reveal ? items.find((item) => item.ids.includes(reveal.id)) : undefined
    if (row) {
      setLaneFocus(null)
      setOnlyQuestions(false)
      setFlash(row.line.message.id)
      setOpened((current) => new Set(current).add(row.line.message.id))
    }
  }
  const section = useRef<HTMLElement>(null)
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    if (!flash) return
    const row = [...(list.current?.querySelectorAll<HTMLElement>('[data-message]') ?? [])].find((item) => item.dataset.message === flash)
    row?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    row?.querySelector<HTMLElement>('.msg-row')?.focus({ preventScroll: true })
    const timer = window.setTimeout(() => setFlash(null), 1800)
    return () => window.clearTimeout(timer)
  }, [flash, honouredReveal])
  useEffect(() => {
    if (honouredFocus) section.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [honouredFocus])

  const laneById = useMemo(() => new Map(lanes.map((lane) => [lane.id, lane])), [lanes])
  const name = (id: string) => laneById.get(id)?.name ?? id
  const isYou = (id: string) => laneById.get(id)?.operator ?? false
  const questions = items.filter((item) => isQuestion(item.line.message.kind)).length
  // Only what expects an answer can be waiting for one.
  const waiting = items.filter(({ line }) => line.message.state === 'pending' && line.message.kind !== 'dispatch' && line.message.kind !== 'handoff').length
  const shown = items.filter((item) => (!onlyQuestions || isQuestion(item.line.message.kind)) && (!laneFocus || itemTouches(item, laneFocus)))
  const focusLane = laneFocus ? laneById.get(laneFocus) : undefined

  return (
    <section ref={section} className="msgs" aria-label="Messages between agents">
      <div className="msgs-head">
        <h2>Messages between agents</h2>
        <span>
          {items.length === 0 ? '' : items.length === 1 ? 'One message' : `${items.length} messages`}
          {waiting > 0 && ` · ${waiting} ${live ? 'waiting for an answer' : 'never answered'}`}
        </span>
        <span className="msgs-tools">
          {focusLane && (
            <button type="button" className="msgs-focus" onClick={() => setLaneFocus(null)} aria-label={`Showing messages with ${focusLane.operator ? 'you' : focusLane.name}. Show everyone's`}>
              With {focusLane.operator ? 'you' : focusLane.name}<X size={12} aria-hidden="true" />
            </button>
          )}
          {/* Worth a choice only when there is something to choose between. */}
          {questions > 0 && questions < items.length && (
            <span className="msgs-filter" role="group" aria-label="Show">
              <button type="button" aria-pressed={!onlyQuestions} onClick={() => setOnlyQuestions(false)}>All</button>
              <button type="button" aria-pressed={onlyQuestions} onClick={() => setOnlyQuestions(true)}>Questions</button>
            </span>
          )}
        </span>
      </div>
      {items.length === 0 && <p className="msgs-none">{live ? 'Nothing has passed between the agents yet. Handovers, questions and answers appear here as they happen.' : 'No messages passed between the agents in this run.'}</p>}
      {items.length > 0 && shown.length === 0 && <p className="msgs-none">No {onlyQuestions ? 'questions' : 'messages'}{focusLane ? ` with ${focusLane.operator ? 'you' : focusLane.name}` : ''}.</p>}
      <ol ref={list} className="msgs-list">
        {shown.map((item) => {
          const id = item.line.message.id
          return (
            <MessageRow
              key={id}
              item={item}
              name={name}
              isYou={isYou}
              live={live}
              open={opened.has(id)}
              flash={flash === id}
              calls={callsWhileWaiting(item.line.message, evidence)}
              onToggle={() => setOpened((current) => {
                const next = new Set(current)
                if (!next.delete(id)) next.add(id)
                return next
              })}
              onInspectEvidence={onInspectEvidence}
              onInspectHandover={onInspectHandover}
            />
          )
        })}
      </ol>
    </section>
  )
}

interface MessageRowProps {
  item: Item
  name: (laneId: string) => string
  isYou: (laneId: string) => boolean
  live: boolean
  open: boolean
  flash: boolean
  calls: Evidence[]
  onToggle: () => void
  onInspectEvidence: (id: string) => void
  onInspectHandover?: (agentId: string) => void
}

function MessageRow({ item, name, isYou, live, open, flash, calls, onToggle, onInspectEvidence, onInspectHandover }: MessageRowProps) {
  const details = useId()
  const { line, passedOn } = item
  const { message } = line
  const reply = message.reply
  const speaker = (id: string) => (isYou(id) ? 'You' : name(id))
  const sender = line.senders[0] ?? null
  const receiver = line.receiver
  const sentence = lineSentence(line, name, isYou)
  const badge = attention(message, live)
  const onwards = passedOn.map((passed) => name(passed.to))
  const replyLine = reply && line.replier !== null ? replySummary(message, speaker(line.replier), onwards, name) : null
  return (
    <li className={`msg ${open ? 'open' : ''} ${flash ? 'flash' : ''}`} data-message={message.id}>
      <button type="button" className="msg-row" aria-expanded={open} aria-controls={details} onClick={onToggle}>
        {/* Who to whom, at a glance: the same marks the stage cards and the timeline wear. */}
        <span className="msg-who" aria-hidden="true">
          {sender ? <AgentMark id={sender} size={16} operator={isYou(sender)} animate={false} /> : <span className="msg-who-none" />}
          <ArrowRight size={12} />
          {receiver ? <AgentMark id={receiver} size={16} operator={isYou(receiver)} animate={false} /> : <span className="msg-who-none" />}
        </span>
        <span className="msg-main">
          <span className="msg-line">
            <span className="msg-sentence">{sentence}</span>
            {badge && <span className={`msg-badge tone-${badge.tone}`}>{badge.tone === 'live' && <i className="msg-pulse" aria-hidden="true" />}{badge.text}</span>}
          </span>
          {message.text && <span className="msg-preview">{preview(message.text)}</span>}
          {replyLine && <span className="msg-preview msg-reply">↳ {replyLine}</span>}
        </span>
        <time className="msg-time" dateTime={message.ts} title={new Date(message.ts).toLocaleString()}>{clock(message.offsetMs)}</time>
        <ChevronDown className="msg-chevron" size={15} aria-hidden="true" />
      </button>
      {open && (
        <div id={details} className="msg-details">
          {message.text && <div className="msg-text selectable">{message.text}</div>}
          {message.context && <p className="msg-note"><b>Context:</b> {message.context}</p>}
          {message.error && <p className="msg-error" role="note">{message.error}</p>}
          {reply && line.replier !== null && (
            <div className="msg-answer">
              <p className="msg-note">
                <b>{reply.sentBackTo ? `${speaker(line.replier)} sent it back to ${name(reply.sentBackTo)}` : `${speaker(line.replier)} ${message.kind === 'handover' ? 'approved' : 'answered'}`}</b>, {waited(reply.offsetMs - message.offsetMs)} later
                {reply.source === 'open' && ', from the work it had already done'}
                {reply.source === 'fresh' && '. A fresh copy answered, so it saw only its role and the question'}.
              </p>
              {reply.text && <div className="msg-text answer selectable">{reply.text}</div>}
            </div>
          )}
          {calls.length > 0 && (
            <details className="msg-calls">
              <summary>{speaker(line.replier ?? '')} made {calls.length === 1 ? 'one call' : `${calls.length} calls`} before answering</summary>
              <ul>
                {calls.map((call) => (
                  <li key={call.id}><button type="button" className="delivery-link" onClick={() => onInspectEvidence(call.id)}>{describeEvidence(speaker(call.agentId), call)}</button></li>
                ))}
              </ul>
            </details>
          )}
          <p className="msg-links">
            {message.evidenceId && <button type="button" className="delivery-link" onClick={() => onInspectEvidence(message.evidenceId as string)}><FileSearch size={13} aria-hidden="true" />Open the record</button>}
            {message.kind === 'handover' && receiver && !isYou(receiver) && onInspectHandover && (
              <button type="button" className="delivery-link" onClick={() => onInspectHandover(receiver)}><FileText size={13} aria-hidden="true" />Everything {name(receiver)} was given</button>
            )}
            {passedOn.map((passed) => onInspectHandover && (
              <button key={passed.to} type="button" className="delivery-link" onClick={() => onInspectHandover(passed.to)}><FileText size={13} aria-hidden="true" />Everything {name(passed.to)} was given</button>
            ))}
            {line.derived && <span className="msg-derived">Sender taken from the team’s connections; this run did not record it.</span>}
          </p>
        </div>
      )}
    </li>
  )
}

/** The answer under a message, in a few words: who answered and how it began. */
function replySummary(message: TeamMessage, who: string, onwards: string[], name: (id: string) => string): string {
  const reply = message.reply as NonNullable<TeamMessage['reply']>
  if (reply.sentBackTo) return `${who} sent it back to ${name(reply.sentBackTo)}${reply.text ? `: ${preview(reply.text)}` : ''}`
  if (message.kind === 'handover') {
    // Where it went first: the note can be long, and the end of the line is what gets cut.
    const plain = reply.text.trim() === APPROVAL_TEXT || !reply.text.trim()
    const passed = onwards.length > 0 ? ` · passed on to ${onwards.join(' and ')}` : ''
    return plain ? `${who} approved${passed}` : `${who} approved${passed}${passed ? ' with' : ', with'} your note: ${preview(reply.text)}`
  }
  return `${who}: ${reply.text ? preview(reply.text) : '(an empty answer)'}`
}

/** A label only for what needs attention: something still waiting, or something that failed. */
function attention(message: TeamMessage, live: boolean): { text: string; tone: 'live' | 'muted' | 'bad' } | null {
  if (message.state === 'failed') return { text: 'Failed', tone: 'bad' }
  if (message.state !== 'pending') return null
  const words: Partial<Record<TeamMessage['kind'], [string, string]>> = {
    ask: ['Waiting for an answer', 'No answer'],
    note: ['Waiting for an answer', 'No answer'],
    question: ['Waiting for you', 'Not answered'],
    escalate: ['Waiting for you', 'Not answered'],
    handover: ['Waiting for your review', 'Not reviewed'],
  }
  const pair = words[message.kind]
  if (!pair) return null
  return live ? { text: pair[0], tone: 'live' } : { text: pair[1], tone: 'muted' }
}

/** The text as one line: Markdown heading marks off, whitespace run together. CSS cuts it to fit. */
function preview(text: string): string {
  return text.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim()
}
