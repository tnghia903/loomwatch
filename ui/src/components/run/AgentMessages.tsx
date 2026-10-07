import { FileSearch, FileText, Info, ShieldQuestionMark } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { bubbles as layOut, callsWhileWaiting, converse, fold, waited, type Bubble, type Party } from '../../lib/story/conversation'
import { APPROVAL_TEXT } from '../../lib/story/needsYou'
import { clockTime } from '../../lib/chat/format'
import { permissionAsks, permissionWhat } from '../../lib/runs/permissionRequests'
import { clock, describeEvidence } from '../../lib/story/weft'
import type { Evidence } from '../../lib/watch/events'
import type { PermissionOutcome, TeamMessage } from '../../lib/watch/messages'
import { Markdown } from '../ui/Markdown'

interface AgentMessagesProps {
  messages: readonly TeamMessage[]
  /** The team in the stage cards' order, so a member here wears its card's number. */
  order: readonly Party[]
  /** The team's connections into each agent, for runs that predate the recorded senders. */
  predecessors?: ReadonlyMap<string, readonly string[]>
  /** Every recorded call, for what an agent did between a question and its answer. */
  evidence: readonly Evidence[]
  /** Whether the run can still add to this: an answer not given yet is then being written. */
  live: boolean
  onInspectEvidence: (id: string) => void
  onInspectHandover?: (agentId: string) => void
  /** Show one message, from outside (the timeline). `at` makes a repeat request count. */
  reveal?: { id: string; at: number } | null
  /**
   * Drawn inside the team's chat (ADR 0051): no card or header of its own — the piece of work it
   * belongs to already says who worked on it — and nothing at all until someone has spoken.
   */
  bare?: boolean
  /**
   * What stands where the chat would say it is waiting for you: the buttons that answer it, on the
   * message that asks (ADR 0051). Absent, the dashed "waiting for your review" bubble shows.
   */
  yourTurn?: ReactNode
  /**
   * The answers to a permission request, drawn where you would reply to it (ADR 0040, 0051).
   * `undefined` for a request that no longer waits — answered elsewhere, or about to be.
   */
  permissionTurn?: (message: TeamMessage) => ReactNode
}

/** A member of the chat, as its messages show it. */
interface Member {
  id: string
  name: string
  you: boolean
  /** The stage card's number; a helper the team file does not list has none. */
  number: number | null
  initials: string
  /** Which of the name colours it wears, so its avatar and name match in every message. */
  hue: number
}

/** Past this a message shows its first lines, with the rest a click away. */
const LONG = { lines: 7, chars: 520 }
const HUES = 6

/**
 * What the agents said to each other, as a group chat: each agent a member with its own avatar and
 * name colour, your words on the right, an answer quoting the question it answers, a handover as a
 * document someone shared, and "… is typing" while an answer is on its way. Read only: this is the
 * record of the run, and reopening it never runs the agents again.
 */
export function AgentMessages({ messages, order, predecessors, evidence, live, onInspectEvidence, onInspectHandover, reveal = null, bare = false, yourTurn, permissionTurn }: AgentMessagesProps) {
  // What an agent was handed again from the work this follows is said once, as picked up, rather
  // than drawn as a handover and a review sent just now (ADR 0051).
  const { carried, fresh } = useMemo(() => ({ carried: messages.filter((message) => message.carried), fresh: messages.filter((message) => !message.carried) }), [messages])
  const [carriedOpen, setCarriedOpen] = useState(false)
  const { lanes, said } = useMemo(() => {
    const conversation = converse(fresh, order, predecessors)
    return { lanes: conversation.lanes, said: layOut(fold(conversation.lines, conversation.lanes), conversation.lanes, live, APPROVAL_TEXT) }
  }, [fresh, order, predecessors, live])
  const members = useMemo(() => membersOf(lanes, order), [lanes, order])
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const [flash, setFlash] = useState<string | null>(null)

  // The timeline asked to see a message: show it, opened. Null to start with, so a request made
  // before this loaded (it is loaded on demand) still counts, and a request for a message whose
  // events are still being read is honoured once it is there.
  const [honoured, setHonoured] = useState<typeof reveal>(null)
  if (reveal !== honoured) {
    const bubble = reveal ? said.find((candidate) => candidate.item.ids.includes(reveal.id)) : undefined
    const picked = reveal ? carried.some((message) => message.id === reveal.id) : false
    if (bubble || picked || !reveal) setHonoured(reveal)
    if (bubble) {
      setFlash(bubble.key)
      setOpened((current) => new Set(current).add(bubble.key))
    } else if (picked) {
      setFlash(PICKED_UP)
      setCarriedOpen(true)
    }
  }
  const log = useRef<HTMLOListElement>(null)
  useEffect(() => {
    if (!flash) return
    const target = [...(log.current?.querySelectorAll<HTMLElement>('[data-bubble]') ?? [])].find((item) => item.dataset.bubble === flash)
    target?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    target?.focus({ preventScroll: true })
    const timer = window.setTimeout(() => setFlash(null), 1800)
    return () => window.clearTimeout(timer)
  }, [flash, honoured])

  // Inside the team's chat every message wears the time of day, as the chat's own do; the record
  // beside it keeps the time since the run started.
  const when = (bubble: Bubble) => (bare ? clockTime(bubble.ts) : clock(bubble.offsetMs))
  const member = (id: string): Member => members.get(id) ?? { id, name: id, you: false, number: null, initials: initialsOf(id), hue: 1 }
  const count = said.filter((bubble) => bubble.part !== 'waiting').length
  if (count === 0 && carried.length === 0) {
    return live && !bare ? <p className="chat-none">Nothing has passed between the agents yet. When they talk, it shows here as a chat.</p> : null
  }
  const everyone = [...members.values()]
  return (
    <section className={`chat${bare ? ' bare' : ''}`} aria-label={bare ? 'What the agents said' : 'Team chat'}>
      {!bare && (
        <header className="chat-head">
          <span className="chat-faces" aria-hidden="true">{everyone.map((person) => <Avatar key={person.id} member={person} size={26} plain />)}</span>
          <span className="chat-title">
            <h3>Team chat</h3>
            <span>{nameList(everyone.map((person) => (person.you ? 'you' : person.name)))} · {count === 1 ? 'one message' : `${count} messages`}</span>
          </span>
        </header>
      )}
      <ol ref={log} className="chat-log">
        {carried.length > 0 && <PickedUp messages={carried} order={order} predecessors={predecessors} open={carriedOpen} flash={flash === PICKED_UP} onToggle={() => setCarriedOpen((value) => !value)} />}
        {said.map((bubble, index) => {
          if (isNotice(bubble)) return <Notice key={bubble.key} bubble={bubble} member={member} flash={flash === bubble.key} when={when} />
          const previous = said[index - 1]
          // Consecutive messages from one member share its avatar and name, as in any chat.
          const continued = previous !== undefined && !isNotice(previous) && previous.from[0] === bubble.from[0]
          return (
            <ChatMessage
              key={bubble.key}
              bubble={bubble}
              member={member}
              continued={continued}
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
              yourTurn={bubble.item.line.message.kind === 'permission' ? permissionTurn?.(bubble.item.line.message) : yourTurn}
              when={when}
            />
          )
        })}
      </ol>
    </section>
  )
}

/** A plain approval says nothing anyone typed: it reads as a note in the chat, not a message. */
/** The key the picked-up line answers to when the timeline asks for one of its messages. */
const PICKED_UP = 'picked-up'

/**
 * What an agent was handed again from the work this piece follows — a follow-up, or a one-agent
 * turn given the earlier handover and your earlier review (ADR 0051). One quiet line, so it does
 * not read as if those were sent just now; what it was given is a click away.
 */
function PickedUp({ messages, order, predecessors, open, flash, onToggle }: { messages: readonly TeamMessage[]; order: readonly Party[]; predecessors?: ReadonlyMap<string, readonly string[]>; open: boolean; flash: boolean; onToggle: () => void }) {
  const party = (id: string) => order.find((candidate) => candidate.id === id)
  const name = (id: string) => party(id)?.name ?? id
  const agents = (ids: readonly (string | null)[]) => [...new Set(ids.filter((id): id is string => id !== null && !party(id)?.operator))]
  // A handover passed on by a review step was written by the stage before it; in a turn where the
  // review step did not run again, the team's connections are what say who that was.
  const writersOf = (message: TeamMessage) => agents((message.handedBy?.from ?? []).flatMap((id) => (party(id)?.operator ? predecessors?.get(id) ?? [] : [id])))
  const receivers = agents(messages.map((message) => message.to))
  const handovers = messages.filter((message) => message.kind === 'handover')
  const writers = [...new Set(handovers.flatMap(writersOf))]
  const things = [
    handovers.length > 0 ? (writers.length > 0 ? `${nameList(writers.map(name))}’s handover` : 'the handover') : null,
    messages.some((message) => message.kind === 'direction') ? 'your review' : null,
  ].filter((thing): thing is string => thing !== null)
  const title = (message: TeamMessage) => {
    if (message.kind === 'direction') return 'Your review'
    const from = writersOf(message)
    return from.length > 0 ? `${nameList(from.map(name))}’s handover` : 'Handover'
  }
  return (
    <li className={`chat-notice chat-picked ${flash ? 'flash' : ''}`} data-bubble={PICKED_UP} tabIndex={-1}>
      <span>{receivers.length > 0 ? nameList(receivers.map(name)) : 'The team'} picked up {nameList(things)} from earlier work</span>
      <button type="button" className="chat-picked-toggle" aria-expanded={open} onClick={onToggle}>{open ? 'Hide' : 'Read it'}</button>
      {open && (
        <div className="chat-picked-body">
          {messages.map((message) => (
            <section key={message.id} aria-label={title(message)}>
              <h4>{title(message)}</h4>
              <div className="chat-text"><Markdown>{message.text}</Markdown></div>
            </section>
          ))}
        </div>
      )}
    </li>
  )
}

function isNotice(bubble: Bubble): boolean {
  return bubble.part === 'reply' && (bubble.word === 'approved' || bubble.item.line.message.kind === 'permission')
}

/** How a permission request was settled, as a line in the chat. */
const SETTLED: Record<PermissionOutcome, (agent: string) => string> = {
  allow_once: () => 'You allowed it, this once',
  allow_run: () => 'You allowed it for the rest of this run',
  deny: (agent) => `You denied it. ${agent} carries on without it`,
  timed_out: () => 'Nobody answered in time, so it was declined',
}

function Notice({ bubble, member, flash, when }: { bubble: Bubble; member: (id: string) => Member; flash: boolean; when: (bubble: Bubble) => string }) {
  const writer = bubble.item.line.senders[0]
  const outcome = bubble.item.line.message.permission?.outcome
  if (outcome) {
    return (
      <li className={`chat-notice ${flash ? 'flash' : ''}`} data-bubble={bubble.key} tabIndex={-1} aria-label={`${when(bubble)}, ${bubble.word}`}>
        <span>{SETTLED[outcome](writer ? member(writer).name : 'The agent')}</span>
        <time dateTime={bubble.ts}>{when(bubble)}</time>
      </li>
    )
  }
  const onward = bubble.to.map((id) => member(id).name)
  return (
    <li className={`chat-notice ${flash ? 'flash' : ''}`} data-bubble={bubble.key} tabIndex={-1} aria-label={`${when(bubble)}, You: approved`}>
      <span>
        You approved {writer ? `${member(writer).name}’s handover` : 'the handover'}
        {onward.length > 0 && <> · passed on to {nameList(onward)}</>}
      </span>
      <time dateTime={bubble.ts}>{when(bubble)}</time>
    </li>
  )
}

interface ChatMessageProps {
  bubble: Bubble
  member: (id: string) => Member
  continued: boolean
  open: boolean
  flash: boolean
  live: boolean
  calls: Evidence[]
  onToggle: () => void
  onInspectEvidence: (id: string) => void
  onInspectHandover?: (agentId: string) => void
  yourTurn?: ReactNode
  when: (bubble: Bubble) => string
}

function ChatMessage({ bubble, member, continued, open, flash, live, calls, onToggle, onInspectEvidence, onInspectHandover, yourTurn, when }: ChatMessageProps) {
  const { item, part, text } = bubble
  const { message } = item.line
  const speaker = bubble.from[0] ? member(bubble.from[0]) : null
  const mentions = bubble.to.map(member)
  const mine = speaker?.you ?? false
  const failed = part === 'said' && message.state === 'failed'
  const handover = part === 'said' && (message.kind === 'handover' || message.kind === 'handoff')
  const asking = part === 'said' && message.kind === 'permission'
  const long = text.length > LONG.chars || text.split('\n').length > LONG.lines
  const [more, setMore] = useState(false)
  const reply = message.reply
  const name = (person: Member) => (person.you ? 'You' : person.name)
  const label = `${when(bubble)}, ${speaker ? name(speaker) : 'Someone'}${mentions.length ? ` to ${mentions.map((person) => (person.you ? 'you' : person.name)).join(' and ')}` : ''}: ${bubble.word}`
  // What the message's info holds: the record behind it, what a stage was given in full.
  const handedTo = handover ? mentions.filter((person) => !person.you) : part === 'reply' ? item.passedOn.map((passed) => member(passed.to)) : []
  const info = part !== 'waiting' && (part === 'reply' ? Boolean(reply) : Boolean(message.evidenceId || message.context || handedTo.length > 0 || item.line.derived))
  // An answer quotes what it answers: the question, or for your review, the handover you read.
  const quoted = part === 'reply' ? { who: speakerOf(item.line.senders[0], member), text: message.kind === 'handover' ? `Handover: ${oneLine(message.text)}` : oneLine(message.text) } : null
  // A reply's quote already says whom it answers; it names someone only when it goes elsewhere, as
  // your approval does when it passes the work on.
  const addressed = part === 'reply' ? mentions.filter((person) => !item.line.senders.includes(person.id)) : mentions
  const caption = part === 'reply' && message.kind === 'handover'
    ? bubble.word === 'sent back' ? 'sent back' : `approved${item.passedOn.length ? ` · passed on to ${nameList(item.passedOn.map((passed) => member(passed.to).name))}` : ''}`
    : bubble.word === 'task' || bubble.word === 'direction' ? bubble.word : null

  return (
    <li
      className={`chat-msg ${mine ? 'mine' : ''} ${continued ? 'continued' : ''} ${flash ? 'flash' : ''} ${failed ? 'failed' : ''} hue-${speaker?.hue ?? 0}`}
      data-bubble={bubble.key}
      tabIndex={-1}
      aria-label={label}
    >
      {!mine && <span className="chat-gutter">{!continued && speaker && <Avatar member={speaker} size={32} />}</span>}
      <div className="chat-stack">
        {!continued && (
          <p className="chat-meta">
            <b className="chat-name">{speaker ? name(speaker) : 'Someone'}</b>
            <time dateTime={bubble.ts} title={new Date(bubble.ts).toLocaleString()}>{when(bubble)}</time>
          </p>
        )}
        {part === 'waiting' && mine && live && yourTurn ? (
          <div className="chat-your-turn">{yourTurn}</div>
        ) : part === 'waiting' ? (
          <div className={`chat-bubble typing ${live ? 'live' : ''}`}>
            {live && <span className="chat-dots" aria-hidden="true"><i /><i /><i /></span>}
            <span className="chat-typing-word">{typing(bubble.word, speaker, live)}</span>
          </div>
        ) : (
          <div className="chat-bubble">
            {quoted && (
              <blockquote className="chat-quote">
                <b>{quoted.who}</b>
                <span>{quoted.text}</span>
              </blockquote>
            )}
            {asking ? (
              <div className="chat-file chat-permission">
                <p className="chat-file-head"><ShieldQuestionMark size={15} aria-hidden="true" /><span>{permissionAsks(message.permission?.switch)}</span></p>
                <p className="permission-what" title={permissionWhat({ title: text, detail: message.permission?.detail })}>{permissionWhat({ title: text, detail: message.permission?.detail })}</p>
              </div>
            ) : handover ? (
              <div className="chat-file">
                <p className="chat-file-head"><FileText size={15} aria-hidden="true" /><span>Handover{mentions.length > 0 && <> to <Mentions people={mentions} /></>}</span></p>
                <Body text={text} long={long} more={more} />
              </div>
            ) : (
              <>
                {addressed.length > 0 && <Mentions people={addressed} />}
                {text && <Body text={text} long={long} more={more} />}
              </>
            )}
            {failed && <p className="chat-failed" role="note">Not delivered{message.error ? `: ${message.error}` : ''}</p>}
            {long && <button type="button" className="chat-more" aria-expanded={more} onClick={() => setMore((value) => !value)}>{more ? 'Show less' : 'Read more'}</button>}
          </div>
        )}
        {(caption || info || continued) && (
          <p className="chat-under">
            {caption && <span>{caption}</span>}
            {continued && <time dateTime={bubble.ts}>{when(bubble)}</time>}
            {info && (
              <button type="button" className={`chat-info ${open ? 'open' : ''}`} aria-expanded={open} onClick={onToggle}>
                <Info size={12} aria-hidden="true" />{open ? 'Hide info' : 'Info'}
              </button>
            )}
          </p>
        )}
        {open && info && (
          <div className="chat-details">
            {part === 'reply' && reply && (
              <p>
                {message.kind === 'handover' ? 'Reviewed' : 'Answered'} {waited(reply.offsetMs - message.offsetMs)} after it was {message.kind === 'handover' ? 'handed over' : 'asked'}
                {reply.source === 'open' && ', from the work it had already done'}
                {reply.source === 'fresh' && '. A fresh copy answered: it saw only its role and the question'}.
              </p>
            )}
            {part === 'said' && message.context && <p><b>Context:</b> {message.context}</p>}
            {calls.length > 0 && (
              <details className="chat-calls">
                <summary>{speaker ? name(speaker) : 'It'} made {calls.length === 1 ? 'one call' : `${calls.length} calls`} before answering</summary>
                <ul>{calls.map((call) => <li key={call.id}><button type="button" className="delivery-link" onClick={() => onInspectEvidence(call.id)}>{describeEvidence(speaker ? name(speaker) : 'It', call)}</button></li>)}</ul>
              </details>
            )}
            <p className="chat-links">
              {part === 'said' && message.evidenceId && <button type="button" className="delivery-link" onClick={() => onInspectEvidence(message.evidenceId as string)}><FileSearch size={13} aria-hidden="true" />Open the record</button>}
              {onInspectHandover && handedTo.map((person) => (
                <button key={person.id} type="button" className="delivery-link" onClick={() => onInspectHandover(person.id)}><FileText size={13} aria-hidden="true" />Everything {person.name} was given</button>
              ))}
              {part === 'said' && item.line.derived && <span className="chat-derived">Sender taken from the team’s connections; this run did not record it.</span>}
            </p>
          </div>
        )}
      </div>
    </li>
  )
}

/** What a message still owed says: who is writing it, or that it waits on you; or that none came. */
function typing(word: string, speaker: Member | null, live: boolean): string {
  const said = word.charAt(0).toUpperCase() + word.slice(1)
  if (!live || speaker?.you) return said
  return `${speaker?.name ?? 'Someone'} is writing an answer`
}

/** Who a message is for, as a chat names them. */
function Mentions({ people }: { people: Member[] }) {
  return <span className="chat-mentions">{people.map((person) => <span key={person.id} className={`chat-mention hue-${person.hue}`}>@{person.you ? 'You' : person.name}</span>)}</span>
}

/** A message's words, formatted as the agent wrote them, cut to its first lines when long. */
function Body({ text, long, more }: { text: string; long: boolean; more: boolean }) {
  return <div className={`chat-text selectable ${long && !more ? 'cut' : ''}`}><Markdown>{text}</Markdown></div>
}

function Avatar({ member, size, plain = false }: { member: Member; size: number; plain?: boolean }) {
  return (
    <span className={`chat-avatar hue-${member.hue}`} style={{ width: size, height: size }} title={member.you ? 'You' : member.name}>
      {member.you ? 'You' : member.initials}
      {!plain && member.number !== null && !member.you && <span className="chat-avatar-number">{member.number}</span>}
    </span>
  )
}

/** Everyone who took part, in the stage cards' order, each with the colour it keeps all chat long. */
function membersOf(lanes: readonly Party[], order: readonly Party[]): Map<string, Member> {
  const number = new Map(order.map((party, index) => [party.id, index + 1]))
  const members = new Map<string, Member>()
  let hue = 0
  for (const lane of lanes) {
    members.set(lane.id, { id: lane.id, name: lane.operator ? 'You' : lane.name, you: lane.operator, number: number.get(lane.id) ?? null, initials: initialsOf(lane.name), hue: lane.operator ? 0 : (hue++ % HUES) + 1 })
  }
  return members
}

/** "News Editor" → "NE", "Researcher" → "Re": enough to tell two avatars apart beside the number. */
function initialsOf(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean)
  return words.length > 1 ? (words[0][0] + words[1][0]).toUpperCase() : name.slice(0, 2).replace(/^./, (first) => first.toUpperCase())
}

function speakerOf(id: string | undefined, member: (id: string) => Member): string {
  return id ? (member(id).you ? 'You' : member(id).name) : 'Earlier'
}

/** The quoted message in one line: Markdown marks off, whitespace run together. CSS cuts it to fit. */
function oneLine(text: string): string {
  return text.replace(/^#+\s*/gm, '').replace(/[*_`>]/g, '').replace(/\s+/g, ' ').trim()
}

/** Names joined as a person would say them: "A", "A and B", "A, B and C". */
function nameList(names: readonly string[]): string {
  return names.length <= 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}
