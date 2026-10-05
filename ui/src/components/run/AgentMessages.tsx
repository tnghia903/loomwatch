import { FileSearch, FileText } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

import { bubbles as layOut, callsWhileWaiting, converse, fold, waited, type Bubble, type Party } from '../../lib/story/conversation'
import { APPROVAL_TEXT } from '../../lib/story/needsYou'
import { clock, describeEvidence } from '../../lib/story/weft'
import type { Evidence } from '../../lib/watch/events'
import type { TeamMessage } from '../../lib/watch/messages'

interface AgentMessagesProps {
  messages: readonly TeamMessage[]
  /** The team in the stage cards' order, so a column here is the card above it, by number. */
  order: readonly Party[]
  /** The team's connections into each agent, for runs that predate the recorded senders. */
  predecessors?: ReadonlyMap<string, readonly string[]>
  /** Every recorded call, for what an agent did between a question and its answer. */
  evidence: readonly Evidence[]
  /** Whether the run can still add to this: an answer not given yet is then on its way. */
  live: boolean
  onInspectEvidence: (id: string) => void
  onInspectHandover?: (agentId: string) => void
  /** Open one message, from outside (the timeline). `at` makes a repeat request count. */
  reveal?: { id: string; at: number } | null
}

/** Past this a bubble shows its first lines, with the rest one click away. */
const LONG = { lines: 4, chars: 280 }

/**
 * What the agents said to each other, under the stage cards that said it.
 *
 * One column per agent, numbered as its card is. Each message is a speech bubble that stretches
 * from the column of whoever said it to the column of whoever it was for, its square corner on the
 * speaker's side, so who is talking to whom is where the bubble is. A question to an earlier stage
 * and its answer are two bubbles over the same two columns, facing each other; work moving on down
 * the line moves right. Your own words are tinted, and an answer still owed shows as one on its way.
 */
export function AgentMessages({ messages, order, predecessors, evidence, live, onInspectEvidence, onInspectHandover, reveal = null }: AgentMessagesProps) {
  const { lanes, said } = useMemo(() => {
    const conversation = converse(messages, order, predecessors)
    return { lanes: conversation.lanes, said: layOut(fold(conversation.lines, conversation.lanes), conversation.lanes, live, APPROVAL_TEXT) }
  }, [messages, order, predecessors, live])
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const [flash, setFlash] = useState<string | null>(null)

  // The timeline asked to see a message: open its first bubble. Null to start with, so a request
  // made before this loaded (it is loaded on demand) still counts.
  const [honoured, setHonoured] = useState<typeof reveal>(null)
  if (reveal !== honoured) {
    setHonoured(reveal)
    const bubble = reveal ? said.find((candidate) => candidate.item.ids.includes(reveal.id)) : undefined
    if (bubble) {
      setFlash(bubble.key)
      setOpened((current) => new Set(current).add(bubble.key))
    }
  }
  const board = useRef<HTMLOListElement>(null)
  useEffect(() => {
    if (!flash) return
    const target = [...(board.current?.querySelectorAll<HTMLElement>('[data-bubble]') ?? [])].find((item) => item.dataset.bubble === flash)
    target?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    target?.focus({ preventScroll: true })
    const timer = window.setTimeout(() => setFlash(null), 1800)
    return () => window.clearTimeout(timer)
  }, [flash, honoured])

  const column = new Map(lanes.map((lane, index) => [lane.id, index]))
  // The stage cards are numbered by their place in the team; a helper the team file does not list has none.
  const number = new Map(order.map((party, index) => [party.id, index + 1]))
  const laneById = new Map(lanes.map((lane) => [lane.id, lane]))
  const who = (id: string) => ({ id, name: laneById.get(id)?.name ?? id, you: laneById.get(id)?.operator ?? false, number: number.get(id) ?? null })
  const owed = said.filter((bubble) => bubble.part === 'waiting').length
  // Every bubble someone actually said counts, answers included; one still owed does not.
  const count = said.filter((bubble) => bubble.part !== 'waiting').length

  if (count === 0) {
    return live ? <p className="talk-none">Nothing has passed between the agents yet. What they say to each other appears here, under them.</p> : null
  }
  return (
    <section className="talk" aria-label="What the agents said to each other">
      <div className="talk-head">
        <h3>What they said to each other</h3>
        <span>{count === 1 ? 'One message' : `${count} messages`}{owed > 0 && ` · ${owed} ${live ? 'answer on its way' : 'never answered'}`}</span>
      </div>
      <div className="talk-board" style={{ ['--lanes' as string]: lanes.length }}>
        {/* The cards above, in a word each: whose column is whose. */}
        <div className="talk-lanes" aria-hidden="true">
          {lanes.map((lane) => <span key={lane.id} className={lane.operator ? 'you' : ''}><Badge party={who(lane.id)} />{lane.operator ? 'You' : lane.name}</span>)}
        </div>
        <ol ref={board} className="talk-list">
          {said.map((bubble, row) => {
            const ends = [...bubble.from, ...bubble.to].map((id) => column.get(id)).filter((index): index is number => index !== undefined)
            let first = Math.min(...ends)
            let last = Math.max(...ends)
            // A bubble needs room to be read: one that concerns a single column borrows its neighbour.
            if (first === last) {
              if (last + 1 < lanes.length) last += 1
              else if (first > 0) first -= 1
            }
            const speaker = bubble.from[0] ?? null
            const side = speaker !== null && column.get(speaker) === last && first !== last ? 'end' : 'start'
            return (
              <SpeechBubble
                key={bubble.key}
                bubble={bubble}
                style={{ ['--from' as string]: first + 1, ['--to' as string]: last + 2, gridRow: row + 1 }}
                side={side}
                who={who}
                open={opened.has(bubble.key)}
                flash={flash === bubble.key}
                live={live}
                calls={bubble.part === 'reply' ? callsWhileWaiting(bubble.item.line.message, evidence) : []}
                onToggle={() => setOpened((current) => {
                  const next = new Set(current)
                  if (!next.delete(bubble.key)) next.add(bubble.key)
                  return next
                })}
                onInspectEvidence={onInspectEvidence}
                onInspectHandover={onInspectHandover}
              />
            )
          })}
        </ol>
      </div>
    </section>
  )
}

type Who = { id: string; name: string; you: boolean; number: number | null }

/** The stage card's number, so a name here and a card above are visibly the same agent. */
function Badge({ party }: { party: Who }) {
  return <span className={`talk-badge ${party.you ? 'you' : ''}`} aria-hidden="true">{party.number ?? '+'}</span>
}

interface SpeechBubbleProps {
  bubble: Bubble
  style: CSSProperties
  side: 'start' | 'end'
  who: (id: string) => Who
  open: boolean
  flash: boolean
  live: boolean
  calls: Evidence[]
  onToggle: () => void
  onInspectEvidence: (id: string) => void
  onInspectHandover?: (agentId: string) => void
}

function SpeechBubble({ bubble, style, side, who, open, flash, live, calls, onToggle, onInspectEvidence, onInspectHandover }: SpeechBubbleProps) {
  const { item, part, text } = bubble
  const { message } = item.line
  const speakers = bubble.from.map(who)
  const listeners = bubble.to.map(who)
  const voice = speakers[0]
  const failed = part === 'said' && message.state === 'failed'
  const long = text.length > LONG.chars || text.split('\n').length > LONG.lines
  const name = (party: Who) => (party.you ? 'You' : party.name)
  const said = `${speakers.map(name).join(' and ') || 'Someone'}${listeners.length ? ` to ${listeners.map((party) => (party.you ? 'you' : party.name)).join(' and ')}` : ''}`
  // What the details hold: the record behind a message, and what a stage was given in full.
  const handedTo = message.kind === 'handover' && part === 'said' ? listeners.filter((party) => !party.you) : part === 'reply' ? item.passedOn.map((passed) => who(passed.to)) : []
  const reply = message.reply
  // Whether opening shows anything the bubble does not: how it was answered, the record, the rest.
  const more = part === 'reply' ? Boolean(reply) : Boolean(message.evidenceId || message.context || handedTo.length > 0 || item.line.derived)
  return (
    <li
      className={`talk-bubble part-${part} side-${side} ${voice?.you ? 'you' : ''} ${failed ? 'failed' : ''} ${part === 'waiting' && live ? 'live' : ''} ${flash ? 'flash' : ''}`}
      style={style}
      data-bubble={bubble.key}
      tabIndex={-1}
      aria-label={`${clock(bubble.offsetMs)}, ${said}: ${bubble.word}`}
    >
      <p className="talk-who">
        {speakers.map((party) => <span key={party.id} className="talk-name"><Badge party={party} />{name(party)}</span>)}
        {listeners.length > 0 && <span className="talk-arrow" aria-hidden="true">→</span>}
        {listeners.map((party) => <span key={party.id} className="talk-name to"><Badge party={party} />{party.you ? 'You' : party.name}</span>)}
        <span className="talk-word">{bubble.word}</span>
        {/* Time and a short bubble's way in wrap together, so a narrow bubble never gets a line of
            nothing but a hidden button; a cut one has "Read all" under its text instead. */}
        <span className="talk-meta">
          <time dateTime={bubble.ts} title={new Date(bubble.ts).toLocaleString()}>{clock(bubble.offsetMs)}</time>
          {part !== 'waiting' && !long && (more || open) && (
            <button type="button" className={`talk-more ${open ? '' : 'quiet'}`} aria-expanded={open} onClick={onToggle}>{open ? 'Less' : 'Details'}</button>
          )}
        </span>
      </p>
      {part === 'waiting' && live && <p className="talk-typing" aria-hidden="true"><i /><i /><i /></p>}
      {failed && message.error && <p className="talk-error" role="note">{message.error}</p>}
      {text && <div className={`talk-text selectable ${long && !open ? 'folded' : ''}`}>{open ? text : shown(text)}</div>}
      {part !== 'waiting' && long && (
        <button type="button" className="talk-more" aria-expanded={open} onClick={onToggle}>{open ? 'Show less' : 'Read all'}</button>
      )}
      {open && (
        <div className="talk-details">
          {part === 'reply' && reply && (
            <p>
              {waited(reply.offsetMs - message.offsetMs)} later
              {reply.source === 'open' && ', from the work it had already done'}
              {reply.source === 'fresh' && '. A fresh copy answered: it saw only its role and the question'}.
            </p>
          )}
          {part === 'said' && message.context && <p><b>Context:</b> {message.context}</p>}
          {calls.length > 0 && (
            <details className="talk-calls">
              <summary>{voice ? name(voice) : 'It'} made {calls.length === 1 ? 'one call' : `${calls.length} calls`} before answering</summary>
              <ul>{calls.map((call) => <li key={call.id}><button type="button" className="delivery-link" onClick={() => onInspectEvidence(call.id)}>{describeEvidence(voice ? name(voice) : 'It', call)}</button></li>)}</ul>
            </details>
          )}
          <p className="talk-links">
            {part === 'said' && message.evidenceId && <button type="button" className="delivery-link" onClick={() => onInspectEvidence(message.evidenceId as string)}><FileSearch size={13} aria-hidden="true" />Open the record</button>}
            {onInspectHandover && handedTo.map((party) => (
              <button key={party.id} type="button" className="delivery-link" onClick={() => onInspectHandover(party.id)}><FileText size={13} aria-hidden="true" />Everything {party.name} was given</button>
            ))}
            {part === 'said' && item.line.derived && <span className="talk-derived">Sender taken from the team’s connections; this run did not record it.</span>}
          </p>
        </div>
      )}
    </li>
  )
}

/** The text as a bubble shows it folded: Markdown heading marks off, so a handover reads as words. */
function shown(text: string): string {
  return text.replace(/^#+\s*/gm, '')
}
