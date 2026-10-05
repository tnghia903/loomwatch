import { CornerDownRight, FileSearch, FileText, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { callsWhileWaiting, converse, GROUP_OF, goesBack, lineSentence, touches, waited, type Lane, type Line, type MessageGroup, type Party } from '../../lib/story/conversation'
import { clock, describeEvidence } from '../../lib/story/weft'
import type { Evidence } from '../../lib/watch/events'
import type { TeamMessage } from '../../lib/watch/messages'
import { AgentMark } from '../ui/AgentMark'

interface AgentMessagesProps {
  messages: readonly TeamMessage[]
  /** The team in the run view's order; the review step is `operator`. */
  order: readonly Party[]
  /** The team's connections into each agent, which is how the daemon builds a handover. */
  predecessors?: ReadonlyMap<string, readonly string[]>
  /** Every recorded call, for what an agent did between a question and its answer. */
  evidence: readonly Evidence[]
  /** Whether the run can still add to this: a waiting question is then waiting, not unanswered. */
  live: boolean
  /** A pipeline: a question to an earlier stage is then worth pointing out. */
  pipeline: boolean
  onInspectEvidence: (id: string) => void
  onInspectHandover?: (agentId: string) => void
  /** Bring one message into view, from outside (the timeline). `at` makes a repeat request count. */
  reveal?: { id: string; at: number } | null
  /** Show only one agent's messages, from outside (a stage card). */
  focus?: { laneId: string; at: number } | null
}

const FILTERS: { key: 'all' | MessageGroup; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'questions', label: 'Questions' },
  { key: 'handovers', label: 'Handovers' },
]

/** Past this a message body folds to its first lines, with a way to read the rest. */
const LONG = { lines: 5, chars: 360 }

/**
 * Every message that passed between the agents of a run, in order: handovers, the questions one
 * agent put to another and the answers it got, work sent off, and the questions put to you.
 *
 * Read like a sequence diagram: on the left, one thread per party; each message crosses from its
 * sender's thread to its receiver's, and an answer crosses back. On the right, the same message in
 * words, with its text verbatim. The threads are drawing only — the words carry everything, so a
 * screen reader and a narrow screen lose nothing.
 */
export function AgentMessages({ messages, order, predecessors, evidence, live, pipeline, onInspectEvidence, onInspectHandover, reveal = null, focus = null }: AgentMessagesProps) {
  const { lanes, lines } = useMemo(() => converse(messages, order, predecessors), [messages, order, predecessors])
  const [filter, setFilter] = useState<'all' | MessageGroup>('all')
  const [laneFocus, setLaneFocus] = useState<string | null>(null)
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const [flash, setFlash] = useState<string | null>(null)

  // Requests from outside, honoured during render (React's "adjusting state when a prop changes"),
  // so a request and the list it filters arrive in the same commit.
  const [honouredFocus, setHonouredFocus] = useState(focus)
  if (focus !== honouredFocus) {
    setHonouredFocus(focus)
    if (focus) { setLaneFocus(focus.laneId); setFilter('all') }
  }
  const [honouredReveal, setHonouredReveal] = useState(reveal)
  if (reveal !== honouredReveal) {
    setHonouredReveal(reveal)
    if (reveal) { setLaneFocus(null); setFilter('all'); setFlash(reveal.id) }
  }
  const section = useRef<HTMLElement>(null)
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    if (!flash) return
    const row = [...(list.current?.querySelectorAll<HTMLElement>('[data-message]') ?? [])].find((item) => item.dataset.message === flash)
    row?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    row?.focus({ preventScroll: true })
    const timer = window.setTimeout(() => setFlash(null), 1800)
    return () => window.clearTimeout(timer)
  }, [flash, honouredReveal])
  // A stage card asked for its agent's messages: bring the section into view with them.
  useEffect(() => {
    if (honouredFocus) section.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }, [honouredFocus])

  const laneById = useMemo(() => new Map(lanes.map((lane) => [lane.id, lane])), [lanes])
  const name = (id: string) => laneById.get(id)?.name ?? id
  const isYou = (id: string) => laneById.get(id)?.operator ?? false
  const counts = useMemo(() => {
    const tally = { all: lines.length, questions: 0, handovers: 0 }
    for (const line of lines) tally[GROUP_OF[line.message.kind]] += 1
    return tally
  }, [lines])
  const shown = lines.filter((line) => (filter === 'all' || GROUP_OF[line.message.kind] === filter) && (!laneFocus || touches(line, laneFocus)))
  // Only what expects an answer can be waiting for one: a task sent off is just being sent.
  const waiting = lines.filter((line) => line.message.state === 'pending' && line.message.kind !== 'dispatch' && line.message.kind !== 'handoff').length
  const width = lanes.length <= 4 ? 30 : lanes.length <= 6 ? 22 : 15
  const gutter = lanes.length * width

  if (lines.length === 0) {
    return (
      <section className="msgs msgs-empty" aria-label="Messages between agents">
        <div className="msgs-head"><h2>Messages between agents</h2></div>
        <p className="msgs-none">{live ? 'Nothing has passed between the agents yet. Handovers, questions and answers appear here as they happen.' : 'No messages passed between the agents in this run.'}</p>
      </section>
    )
  }
  const focusLane = laneFocus ? laneById.get(laneFocus) : undefined
  return (
    <section ref={section} className="msgs" aria-label="Messages between agents" style={{ ['--msgs-gutter' as string]: `${gutter}px`, ['--msgs-col' as string]: `${width}px` }}>
      <div className="msgs-head">
        <h2>Messages between agents</h2>
        <span>
          {lines.length === 1 ? 'One message' : `${lines.length} messages`}
          {waiting > 0 && ` · ${waiting} ${live ? 'waiting for an answer' : 'never answered'}`}
        </span>
      </div>
      <div className="msgs-row msgs-heads">
        {/* One mark per party, over its thread: pick one to read only what it sent and received. */}
        <div className="msgs-gutter" role="group" aria-label="Show the messages of one agent">
          {lanes.map((lane, index) => (
            <button
              key={lane.id}
              type="button"
              className={`msgs-party ${laneFocus === lane.id ? 'on' : ''}`}
              style={{ left: index * width + width / 2 }}
              aria-pressed={laneFocus === lane.id}
              aria-label={lane.operator ? 'Show only messages with you' : `Show only messages with ${lane.name}`}
              title={lane.operator ? 'You' : lane.name}
              onClick={() => setLaneFocus((current) => (current === lane.id ? null : lane.id))}
            >
              <AgentMark id={lane.id} size={width >= 22 ? 16 : 13} operator={lane.operator} animate={false} />
            </button>
          ))}
        </div>
        <div className="msgs-filters">
          <div role="group" aria-label="Message type">
            {FILTERS.filter((item) => item.key === 'all' || counts[item.key] > 0).map((item) => (
              <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>
                {item.label} <span>{counts[item.key]}</span>
              </button>
            ))}
          </div>
          {focusLane && (
            <button type="button" className="msgs-focus" onClick={() => setLaneFocus(null)} aria-label={`Showing messages with ${focusLane.operator ? 'you' : focusLane.name}. Show everyone's`}>
              <AgentMark id={focusLane.id} size={13} operator={focusLane.operator} animate={false} />
              With {focusLane.operator ? 'you' : focusLane.name}<X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {shown.length === 0 && <p className="msgs-none">No {filter === 'all' ? 'messages' : filter}{focusLane ? ` with ${focusLane.operator ? 'you' : focusLane.name}` : ''}.</p>}
      <ol ref={list} className="msgs-list">
        {shown.map((line) => (
          <MessageItem
            key={line.message.id}
            line={line}
            lanes={lanes}
            width={width}
            name={name}
            isYou={isYou}
            back={pipeline && line.message.kind === 'ask' && goesBack(line, lanes)}
            live={live}
            open={opened.has(line.message.id)}
            flash={flash === line.message.id}
            calls={callsWhileWaiting(line.message, evidence)}
            onToggle={() => setOpened((current) => {
              const next = new Set(current)
              if (!next.delete(line.message.id)) next.add(line.message.id)
              return next
            })}
            onInspectEvidence={onInspectEvidence}
            onInspectHandover={onInspectHandover}
          />
        ))}
      </ol>
    </section>
  )
}

interface MessageItemProps {
  line: Line
  lanes: readonly Lane[]
  width: number
  name: (laneId: string) => string
  isYou: (laneId: string) => boolean
  back: boolean
  live: boolean
  open: boolean
  flash: boolean
  calls: Evidence[]
  onToggle: () => void
  onInspectEvidence: (id: string) => void
  onInspectHandover?: (agentId: string) => void
}

function MessageItem({ line, lanes, width, name, isYou, back, live, open, flash, calls, onToggle, onInspectEvidence, onInspectHandover }: MessageItemProps) {
  const { message } = line
  const sentence = lineSentence(line, name, isYou)
  const index = (id: string | null) => (id === null ? -1 : lanes.findIndex((lane) => lane.id === id))
  const senders = line.senders.map(index).filter((value) => value >= 0)
  const receiver = index(line.receiver)
  // An answer crosses back only where the record says it went back: the Team Bus returns an `ask`'s
  // reply to the asker, and your answer to a question is the asker's next turn. What you answer at a
  // review step goes on to the next stage (or back, if you sent it back), so it stays on your thread.
  // A note's answer goes back to you, and a send-back goes to the stage it was sent back to.
  const answersBack = message.kind === 'ask' || message.kind === 'question' || message.kind === 'escalate' || message.kind === 'note'
  const sentBack = index(message.reply?.sentBackTo ?? null)
  const replyTo = sentBack >= 0 ? [sentBack] : answersBack && line.replier !== null && senders.length > 0 ? [senders[0]] : []
  const state = stateWords(line, live)
  const sender = line.senders[0]
  const speaker = (id: string) => (isYou(id) ? 'You' : name(id))
  const touched = [...senders, receiver, ...line.via.map(index), index(line.replier), sentBack]
  return (
    <li
      className={`msg k-${message.kind} s-${message.state} ${flash ? 'flash' : ''}`}
      data-message={message.id}
      tabIndex={-1}
      aria-label={`${clock(message.offsetMs)}: ${sentence}. ${state.text}.`}
    >
      <div className="msgs-row">
        <Gutter lanes={lanes} width={width} from={senders} to={receiver} via={line.via.map(index)} kind={message.kind} state={message.state} y={18} involved={touched} />
        <div className="msg-body">
          <p className="msg-top">
            <time dateTime={message.ts} title={new Date(message.ts).toLocaleString()}>{clock(message.offsetMs)}</time>
            <span className="msg-sentence">
              {sender && <AgentMark id={sender} size={14} operator={isYou(sender)} animate={false} />}
              {sentence}
              {back && <span className="msg-tag" title="Asked a stage that ran before it">earlier stage</span>}
            </span>
            <span className={`msg-state tone-${state.tone}`}>{state.tone === 'live' && <i className="msg-pulse" aria-hidden="true" />}{state.text}</span>
          </p>
          <Said text={message.text || (message.kind === 'handover' ? '' : '(no text recorded)')} open={open} onToggle={onToggle} />
          {message.context && <p className="msg-context"><b>Context</b> {message.context}</p>}
          {message.error && <p className="msg-error" role="note">{message.error}</p>}
        </div>
      </div>
      {message.reply && line.replier !== null && (
        <div className="msgs-row">
          <Gutter lanes={lanes} width={width} from={[index(line.replier)]} to={replyTo[0] ?? -1} kind="reply" state="answered" y={16} involved={touched} />
          <div className="msg-body msg-answer">
            <p className="msg-who">
              <CornerDownRight size={13} aria-hidden="true" />
              <AgentMark id={line.replier} size={14} operator={isYou(line.replier)} animate={false} />
              <span>
                <b>{sentBack >= 0 ? `${speaker(line.replier)} sent it back to ${name(lanes[sentBack].id)}` : `${speaker(line.replier)} answered`}</b>
                {message.reply.source === 'open' && ', from the session it already had'}
                {message.reply.source === 'fresh' && ' — a fresh start, so it saw only its role and the question'}
              </span>
              <time dateTime={message.reply.ts}>{clock(message.reply.offsetMs)}</time>
            </p>
            <Said text={message.reply.text || '(an empty answer)'} open={open} onToggle={onToggle} answer />
          </div>
        </div>
      )}
      <div className="msgs-row">
        <Gutter lanes={lanes} width={width} involved={touched} />
        <div className="msg-body msg-foot">
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
          <span className="msg-acts">
            <code>{expertLine(message)}{line.derived ? ' · sender read from the team file, not recorded' : ''}</code>
            {message.evidenceId && <button type="button" className="delivery-link" onClick={() => onInspectEvidence(message.evidenceId as string)}><FileSearch size={13} aria-hidden="true" />Open the record</button>}
            {message.kind === 'handover' && message.to && onInspectHandover && !isYou(message.to) && (
              <button type="button" className="delivery-link" onClick={() => onInspectHandover(message.to as string)}><FileText size={13} aria-hidden="true" />Everything {name(message.to)} was given</button>
            )}
          </span>
        </div>
      </div>
    </li>
  )
}

/** A message's words, verbatim, folded when long. */
function Said({ text, open, onToggle, answer = false }: { text: string; open: boolean; onToggle: () => void; answer?: boolean }) {
  if (!text) return null
  const long = text.length > LONG.chars || text.split('\n').length > LONG.lines
  return (
    <div className={`msg-said ${answer ? 'answer' : ''} ${long && !open ? 'folded' : ''}`}>
      <div className="msg-text selectable">{text}</div>
      {long && <button type="button" className="msg-more" aria-expanded={open} onClick={onToggle}>{open ? 'Show less' : `Show all · ${text.length.toLocaleString()} characters`}</button>}
    </div>
  )
}

/**
 * The threads beside one part of a message. `from`/`to` are lane indexes; with neither, only the
 * threads are drawn, which is what keeps them continuous between messages.
 */
function Gutter({ lanes, width, from = [], to = -1, via = [], kind, state, y = 16, involved }: { lanes: readonly Lane[]; width: number; from?: number[]; to?: number; via?: number[]; kind?: TeamMessage['kind'] | 'reply'; state?: TeamMessage['state']; y?: number; involved: number[] }) {
  const x = (index: number) => index * width + width / 2
  const ends = [...from, ...(to >= 0 ? [to] : [])]
  const left = Math.min(...ends)
  const right = Math.max(...ends)
  const pointsRight = to >= 0 && from.length > 0 && to > Math.min(...from)
  const head = 5
  return (
    <div className="msgs-gutter" aria-hidden="true">
      {lanes.map((lane, index) => <i key={lane.id} className={`msg-life ${involved.includes(index) ? 'on' : ''} ${lane.operator ? 'you' : ''}`} style={{ left: x(index) }} />)}
      {kind && ends.length > 0 && (
        <svg className={`msg-arrow k-${kind} s-${state}`} width={lanes.length * width} height={14} style={{ top: y - 7 }}>
          {to >= 0 && right > left && (
            <line x1={x(left) + (pointsRight ? 0 : head)} x2={x(right) - (pointsRight ? head : 0)} y1={7} y2={7} />
          )}
          {to >= 0 && right > left && (
            <path className="msg-head" d={pointsRight ? `M${x(to) - head - 1} 2.5 L${x(to)} 7 L${x(to) - head - 1} 11.5 Z` : `M${x(to) + head + 1} 2.5 L${x(to)} 7 L${x(to) + head + 1} 11.5 Z`} />
          )}
          {from.map((index) => <circle key={index} cx={x(index)} cy={7} r={3.2} />)}
          {/* A review step the handover passed through: a ring on your thread, not a sender's dot. */}
          {via.filter((index) => index >= 0).map((index) => <circle key={`via${index}`} className="msg-via" cx={x(index)} cy={7} r={3} />)}
          {state === 'failed' && to >= 0 && <path className="msg-cross" d={`M${x(to) - 3.5} 3.5 L${x(to) + 3.5} 10.5 M${x(to) + 3.5} 3.5 L${x(to) - 3.5} 10.5`} />}
        </svg>
      )}
    </div>
  )
}

/** The state beside a message, said for what its kind expects. */
function stateWords(line: Line, live: boolean): { text: string; tone: 'ok' | 'live' | 'muted' | 'bad' | 'plain' } {
  const { message } = line
  if (message.state === 'failed') return { text: 'Failed', tone: 'bad' }
  if (message.state === 'answered' && message.reply) {
    const after = waited(message.reply.offsetMs - message.offsetMs)
    if (message.reply.sentBackTo) return { text: `Sent back after ${after}`, tone: 'plain' }
    return { text: message.kind === 'handover' ? `Reviewed after ${after}` : `Answered after ${after}`, tone: 'ok' }
  }
  if (message.state === 'pending') {
    const words: Partial<Record<TeamMessage['kind'], [string, string]>> = {
      ask: ['Waiting for an answer', 'No answer recorded'],
      question: ['Waiting for you', 'Not answered'],
      handover: ['Waiting for your review', 'Not reviewed'],
      escalate: ['Waiting for you', 'Not answered'],
      note: ['Waiting for an answer', 'No answer recorded'],
    }
    const [waiting, never] = words[message.kind] ?? ['Sending', 'Not confirmed']
    return live ? { text: waiting, tone: 'live' } : { text: never, tone: 'muted' }
  }
  switch (message.kind) {
    case 'handover': return { text: `${message.text.length.toLocaleString()} characters`, tone: 'plain' }
    case 'direction': return { text: 'Your direction', tone: 'plain' }
    case 'dispatch': return { text: 'Sent · no reply expected', tone: 'plain' }
    case 'handoff': return { text: 'Handed over · sender stopped', tone: 'plain' }
    default: return { text: 'Sent', tone: 'plain' }
  }
}

/** For an expert: where in the archive this message lives. */
function expertLine(message: TeamMessage): string {
  const span = message.reply ? `seq ${message.seq} → ${message.reply.seq}` : `seq ${message.seq}`
  switch (message.kind) {
    case 'handover': return `prompt record · stage_results · ${span}`
    case 'direction': return `prompt record · direction · ${span}`
    case 'question': return `ask_user · awaiting_operator · ${span}`
    case 'note': return `operator_answer · ${span}`
    default: return `team bus · ${message.kind} · ${span}`
  }
}
