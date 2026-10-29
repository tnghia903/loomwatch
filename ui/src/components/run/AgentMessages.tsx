import { FileSearch, FileText, Info, Reply, ShieldQuestionMark } from 'lucide-react'
import { Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { bubbles as layOut, callsWhileWaiting, converse, fold, handedWork, waited, type Bubble, type Party } from '../../lib/story/conversation'
import { APPROVAL_TEXT } from '../../lib/story/needsYou'
import { clockTime } from '../../lib/chat/format'
import type { ReplyKind, ReplyTo } from '../../lib/chat/client'
import { questionBackOf, SAID } from '../../lib/chat/reply'
import { autoNote, permissionAsks, permissionWhat } from '../../lib/runs/permissionRequests'
import { clock, describeEvidence } from '../../lib/story/weft'
import type { Evidence } from '../../lib/watch/events'
import { REACHED_WORD, reachedLine, type AskRefusal, type PermissionOutcome, type TeamMessage } from '../../lib/watch/messages'
import { broughtInLine } from '../../lib/chat/guests'
import { MentionChip, MentionedText } from '../chat/SaidText'
import { useAgentFaces } from '../../lib/chat/faces'
import { AgentFace } from '../chat/AgentFace'
import { Quote } from '../chat/ReplyQuote'
import { AvatarFace } from '../agents/AvatarFace'
import { GuestNamesContext, TeamFiguresContext } from '../agents/figureContext'
import { FIGURE_HUES, figureHue, type FigureChoice } from '../../lib/library/figures'
import { InlineMarkdown, Markdown } from '../ui/Markdown'
import { LOOMWATCH_CHECK_ID, LOOMWATCH_NAME, helperOf, wearerOf } from '../../lib/chat/helpers'
import { LoomFace } from '../ui/glyphs'

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
  /**
   * Reply to what an agent said (the team's chat, ADR 0051): a Reply under each agent's message,
   * which hands it to the message box as the message being answered. Absent, there is none.
   */
  onReply?: (reply: Omit<ReplyTo, 'runId'>) => void
  /**
   * Inside the team's chat: each thing said with its reactions under it (components/chat/Reactions.tsx).
   * Given the bubble and the message as drawn, it returns what to draw in its place.
   */
  reactions?: (bubble: Bubble, said: ReactNode) => ReactNode
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

/**
 * What the agents said to each other, as a group chat: each agent a member with its own avatar and
 * name colour, your words on the right, a handover said like any message, every reply quoting what
 * it answers, and "… is typing" while an answer is on its way. Read only: this is the record of the
 * run, and reopening it never runs the agents again.
 */
export function AgentMessages({ messages, order, predecessors, evidence, live, onInspectEvidence, onInspectHandover, reveal = null, bare = false, yourTurn, permissionTurn, onReply, reactions }: AgentMessagesProps) {
  // What an agent was handed again from the work this follows is said once, as picked up, rather
  // than drawn as a handover and a review sent just now (ADR 0051).
  const { carried, fresh } = useMemo(() => ({ carried: messages.filter((message) => message.carried), fresh: messages.filter((message) => !message.carried) }), [messages])
  const [carriedOpen, setCarriedOpen] = useState(false)
  const guests = useContext(GuestNamesContext)
  const { lanes, said } = useMemo(() => {
    const conversation = converse(fresh, order, predecessors, guests)
    return { lanes: conversation.lanes, said: layOut(fold(conversation.lines, conversation.lanes), conversation.lanes, live, APPROVAL_TEXT) }
  }, [fresh, order, predecessors, live, guests])
  // Whatever answers an earlier message quotes it, as a reply of yours does.
  const quotes = useMemo(() => repliesTo(said), [said])
  const figures = useContext(TeamFiguresContext)
  const members = useMemo(() => membersOf(lanes, order, figures), [lanes, order, figures])
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const [flash, setFlash] = useState<string | null>(null)

  // The timeline asked to see a message: show it, opened. Null to start with, so a request made
  // before this loaded (it is loaded on demand) still counts, and a request for a message whose
  // events are still being read is honoured once it is there.
  const [honoured, setHonoured] = useState<typeof reveal>(null)
  if (reveal !== honoured) {
    // By the bubble a reply quoted, or by any message folded into a row.
    const bubble = reveal ? said.find((candidate) => candidate.key === reveal.id) ?? said.find((candidate) => candidate.item.ids.includes(reveal.id)) : undefined
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
  // Someone not in this run (a handover picked up from earlier work) still has the team's name and colour.
  const member = (id: string): Member => {
    const known = members.get(id)
    if (known) return known
    const name = order.find((party) => party.id === id)?.name ?? guests.get(id) ?? id
    const worn = figures.get(id)
    return { id, name, you: false, number: null, initials: initialsOf(name), hue: worn ? figureHue(worn) : 1 }
  }
  // Whom an @ in what anyone said names, drawn as that agent's chip: the run's agents, never you.
  // The team's agents, the person's other agents a run may bring in, and whoever took part.
  const mentionable = useMemo<Mentionable>(() => {
    const named = new Map<string, string>(guests)
    for (const party of order) if (!party.operator) named.set(party.id, party.name)
    for (const person of members.values()) if (!person.you) named.set(person.id, person.name)
    return {
      agents: [...named].map(([id, name]) => ({ id, name })),
      hue: (id) => {
        const worn = figures.get(id)
        return members.get(id)?.hue ?? (worn ? figureHue(worn) : 1)
      },
    }
  }, [members, order, guests, figures])
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
        {carried.length > 0 && <PickedUp messages={carried} order={order} member={member} predecessors={predecessors} open={carriedOpen} flash={flash === PICKED_UP} onToggle={() => setCarriedOpen((value) => !value)} />}
        {said.map((bubble, index) => {
          if (isNotice(bubble)) return <Notice key={bubble.key} bubble={bubble} member={member} flash={flash === bubble.key} when={when} />
          const previous = said[index - 1]
          // Consecutive messages from one member share its avatar and name, as in any chat.
          const continued = previous !== undefined && !isNotice(previous) && previous.from[0] === bubble.from[0]
          const quote = quotes.get(bubble.key) ?? null
          return (
            <ChatMessage
              key={bubble.key}
              bubble={bubble}
              member={member}
              mentionable={mentionable}
              alone={order.filter((party) => !party.operator).length <= 1}
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
              quote={quote}
              onShowQuote={quote ? () => setFlash(quote.key) : undefined}
              bare={bare}
              onReply={onReply}
              reactions={reactions}
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
function PickedUp({ messages, order, member, predecessors, open, flash, onToggle }: { messages: readonly TeamMessage[]; order: readonly Party[]; member: (id: string) => Member; predecessors?: ReadonlyMap<string, readonly string[]>; open: boolean; flash: boolean; onToggle: () => void }) {
  const party = (id: string) => order.find((candidate) => candidate.id === id)
  const name = (id: string) => party(id)?.name ?? id
  const agents = (ids: readonly (string | null)[]) => [...new Set(ids.filter((id): id is string => id !== null && !party(id)?.operator))]
  // A handover passed on by a review step was written by the stage before it; in a turn where the
  // review step did not run again, the team's connections are what say who that was.
  const writersOf = (message: TeamMessage) => agents((message.handedBy?.from ?? []).flatMap((id) => (party(id)?.operator ? predecessors?.get(id) ?? [] : [id])))
  const receivers = agents(messages.map((message) => message.to))
  const handovers = messages.filter((message) => message.kind === 'handover')
  const writers = [...new Set(handovers.flatMap(writersOf))]
  const things: ReactNode[] = [
    handovers.length > 0 ? (writers.length > 0 ? <>{named(writers.map(member))}’s handover</> : 'the handover') : null,
    messages.some((message) => message.kind === 'direction') ? 'your review' : null,
  ].filter((thing) => thing !== null)
  const title = (message: TeamMessage) => {
    if (message.kind === 'direction') return 'Your review'
    const from = writersOf(message)
    return from.length > 0 ? `${nameList(from.map(name))}’s handover` : 'Handover'
  }
  return (
    <li className={`chat-notice chat-picked ${flash ? 'flash' : ''}`} data-bubble={PICKED_UP} tabIndex={-1}>
      <span>{receivers.length > 0 ? named(receivers.map(member)) : 'The team'} picked up {joined(things)} from earlier work</span>
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
  // A question the Team Bus would not put, and a check round that found nothing missing, are said
  // in a line, not a message (ADR 0062).
  if (bubble.part === 'said') {
    const { message } = bubble.item.line
    return Boolean(message.refused) || (message.kind === 'check' && bubble.word === 'all met')
  }
  return bubble.part === 'reply' && (bubble.word === 'approved' || bubble.item.line.message.kind === 'permission')
}

/** Why a question was not put, as a line in the chat. The Team Bus's own words are under it. */
const REFUSED: Record<AskRefusal, (asker: ReactNode, asked: ReactNode) => ReactNode> = {
  finished: (asker, asked) => <>{asker} asked {asked}, but {asked} had already finished its part of this run</>,
  limit: (asker, asked) => <>{asker} had already asked {asked} as many questions as this team allows, so this one wasn’t sent</>,
  asking_back: (asker, asked) => <>{asker} couldn’t ask {asked} back while answering its question</>,
  cannot_start: (asker, asked) => <>{asker} couldn’t bring in {asked} while answering a question</>,
  not_recruiting: (asker, asked) => <>{asker} may not bring in helpers, so {asked} wasn’t asked</>,
}

/** How a permission request was settled, as a line in the chat. What you typed instead shows its Markdown. */
const SETTLED: Record<PermissionOutcome, (agent: ReactNode, written: string) => ReactNode> = {
  allow_once: () => 'You allowed it, this once',
  allow_run: () => 'You allowed it for the rest of this run',
  allow_team: () => 'You allowed the whole team to do this for the rest of this run',
  deny: (agent) => <>You denied it. {agent} carries on without it</>,
  edited: (_agent, written) => `You changed it, then allowed it: ${written}`,
  answered: (agent, written) => <>You answered instead: “<InlineMarkdown>{written}</InlineMarkdown>”. {agent} carries on with that</>,
  timed_out: () => 'Nobody answered in time, so it was declined',
}

function Notice({ bubble, member, flash, when }: { bubble: Bubble; member: (id: string) => Member; flash: boolean; when: (bubble: Bubble) => string }) {
  const writer = bubble.item.line.senders[0]
  const { refused, error, text } = bubble.item.line.message
  if (refused) {
    const asker = writer ? member(writer).name : 'An agent'
    return (
      <li className={`chat-notice ${flash ? 'flash' : ''}`} data-bubble={bubble.key} tabIndex={-1} aria-label={`${when(bubble)}, ${asker}: not asked`} title={[text, error].filter(Boolean).join('\n\n')}>
        <span>{REFUSED[refused](writer ? named([member(writer)]) : 'An agent', bubble.to[0] ? named([member(bubble.to[0])]) : 'another agent')}</span>
        <time dateTime={bubble.ts}>{when(bubble)}</time>
      </li>
    )
  }
  const check = bubble.item.line.message.check
  if (check) {
    const checked = bubble.to[0] ? named([member(bubble.to[0])]) : 'the agent'
    return (
      <li className={`chat-notice ${flash ? 'flash' : ''}`} data-bubble={bubble.key} tabIndex={-1} aria-label={`${when(bubble)}, ${writer ? member(writer).name : 'The check'}: ${bubble.word}`}>
        <span>{writer ? named([member(writer)]) : 'The check'} checked {checked}’s {check.round > 1 ? 'revised work' : 'work'}: all {check.items.length} met</span>
        <time dateTime={bubble.ts}>{when(bubble)}</time>
      </li>
    )
  }
  const outcome = bubble.item.line.message.permission?.outcome
  if (outcome) {
    return (
      <li className={`chat-notice ${flash ? 'flash' : ''}`} data-bubble={bubble.key} tabIndex={-1} aria-label={`${when(bubble)}, ${bubble.word}`}>
        <span>{SETTLED[outcome](writer ? named([member(writer)]) : 'The agent', bubble.item.line.message.permission?.written ?? '')}</span>
        <time dateTime={bubble.ts}>{when(bubble)}</time>
      </li>
    )
  }
  const stop = bubble.item.line.message.checkStop
  if (stop) {
    // Approved at a check step's stop (ADR 0062): the work as it was, with what was still open.
    return (
      <li className={`chat-notice ${flash ? 'flash' : ''}`} data-bubble={bubble.key} tabIndex={-1} aria-label={`${when(bubble)}, You: approved`}>
        <span>You approved {named([member(stop.checked)])}’s work as it was, with {stop.open === 1 ? '1 check' : `${stop.open} checks`} not met</span>
        <time dateTime={bubble.ts}>{when(bubble)}</time>
      </li>
    )
  }
  const onward = bubble.to.map(member)
  return (
    <li className={`chat-notice ${flash ? 'flash' : ''}`} data-bubble={bubble.key} tabIndex={-1} aria-label={`${when(bubble)}, You: approved`}>
      <span>
        You approved {writer ? <>{named([member(writer)])}’s handover</> : 'the handover'}
        {onward.length > 0 && <> · passed on to {named(onward)}</>}
      </span>
      <time dateTime={bubble.ts}>{when(bubble)}</time>
    </li>
  )
}

/** The agents an @ in the chat's words can name, with each one's colour. */
interface Mentionable {
  agents: readonly { id: string; name: string }[]
  hue: (id: string) => number
}

interface ChatMessageProps {
  bubble: Bubble
  member: (id: string) => Member
  mentionable: Mentionable
  /** An agent's own chat: one agent and you, no team. */
  alone: boolean
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
  /** The earlier message this one answers, which it quotes (`repliesTo`). */
  quote: Bubble | null
  /** Shows the quoted message where it was said. */
  onShowQuote?: () => void
  /** Inside the team's chat, whose own messages wear a smaller face. */
  bare: boolean
  onReply?: (reply: Omit<ReplyTo, 'runId'>) => void
  reactions?: (bubble: Bubble, said: ReactNode) => ReactNode
}

function ChatMessage({ bubble, member, mentionable, alone, continued, open, flash, live, calls, onToggle, onInspectEvidence, onInspectHandover, yourTurn, when, quote, onShowQuote, bare, onReply, reactions }: ChatMessageProps) {
  const { item, part, text } = bubble
  const { message } = item.line
  const speaker = bubble.from[0] ? member(bubble.from[0]) : null
  const mentions = bubble.to.map(member)
  const mine = speaker?.you ?? false
  const failed = part === 'said' && message.state === 'failed'
  const handover = isHandover(bubble)
  const asking = part === 'said' && message.kind === 'permission'
  const words = spoken(bubble, member)
  const long = words.length > LONG.chars || words.split('\n').length > LONG.lines
  const [more, setMore] = useState(false)
  const reply = message.reply
  const name = (person: Member) => (person.you ? 'You' : person.name)
  const withReactions = (said: ReactNode) => (reactions ? reactions(bubble, said) : said)
  const label = `${when(bubble)}, ${speaker ? name(speaker) : 'Someone'}${mentions.length ? ` to ${mentions.map((person) => (person.you ? 'you' : person.name)).join(' and ')}` : ''}: ${bubble.word}`
  // What the message's info holds: the record behind it, what a stage was given in full.
  const handedTo = handover ? mentions.filter((person) => !person.you) : part === 'reply' ? item.passedOn.map((passed) => member(passed.to)) : []
  const info = part !== 'waiting' && (part === 'reply' ? Boolean(reply) : Boolean(message.evidenceId || message.context || handedTo.length > 0 || item.line.derived))
  // A reply quotes what it answers, as yours do: a question back by what it asks, anything else by
  // its first words.
  const quoted = quote ? { what: quoteWhat(quote, member), text: quote.part === 'reply' && quote.item.line.message.reply?.asksBack ? questionBackOf(quote.text) : spoken(quote, member) } : null
  // What you can reply to: anything an agent said, other than a permission request (answered with
  // its own buttons) and a message that never arrived.
  const toReply = onReply && speaker && !mine && part !== 'waiting' && !asking && !failed && text.trim() ? replyFor(bubble, speaker.id, mentions) : null
  // A reply's quote already says whom it answers; it names someone only when it goes elsewhere, as
  // your approval does when it passes the work on.
  const addressed = quote ? mentions.filter((person) => !quote.from.includes(person.id)) : mentions
  const kindWord = part === 'reply' && message.kind === 'handover'
    ? bubble.word === 'sent back' ? 'sent back' : `approved${item.passedOn.length ? ` · passed on to ${nameList(item.passedOn.map((passed) => member(passed.to).name))}` : ''}`
    : message.kind === 'check' && part !== 'waiting'
      ? `${bubble.word}${message.check && message.check.round > 1 ? ` · round ${message.check.round}` : ''}`
      : handover || bubble.word === 'task' || bubble.word === 'direction' || bubble.word === 'asks back' || bubble.word === 'clarifies' || (handedWork(message.kind) && part === 'reply') ? bubble.word : null
  // In a team with no fixed order: whether the teammate carried on in its conversation or a fresh
  // copy took it, said under the work handed out, and under a teammate's answer.
  const reach = message.reached && (message.kind === 'ask' ? part === 'reply' : part === 'said') ? REACHED_WORD[message.reached] : null
  const caption = reach ? `${kindWord ?? bubble.word} · ${reach}` : kindWord

  // ADR 0092: the first time one of the person's other agents is brought in, a quiet line of its
  // own above the message says who chose whom, as the chat's other events are said.
  const broughtIn = part === 'said' && message.broughtIn && speaker && mentions[0] ? { by: speaker, guest: mentions[0], words: broughtInLine(name(speaker), mentions[0].name, alone) } : null
  return (
    <>
    {broughtIn && (
      <li className="chat-notice chat-brought-in" aria-label={broughtIn.words}>
        <span aria-hidden="true">
          <MentionChip id={broughtIn.by.id} name={name(broughtIn.by)} hue={broughtIn.by.hue} bare />
          {alone ? ' added ' : ' brought in '}
          <MentionChip id={broughtIn.guest.id} name={broughtIn.guest.name} hue={broughtIn.guest.hue} bare />
          {alone ? ' to this chat' : ' from My agents'}
        </span>
      </li>
    )}
    <li
      className={`chat-msg ${mine ? 'mine' : ''} ${continued ? 'continued' : ''} ${flash ? 'flash' : ''} ${failed ? 'failed' : ''} hue-${speaker?.hue ?? 0}`}
      data-bubble={bubble.key}
      tabIndex={-1}
      aria-label={label}
    >
      {!mine && <span className="chat-gutter">{!continued && speaker && <Avatar member={speaker} size={bare ? 28 : 32} />}</span>}
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
        ) : withReactions(
          <div className="chat-bubble">
            {quoted && <Quote what={quoted.what} text={quoted.text} onShow={onShowQuote} />}
            {asking ? (
              <div className="chat-file chat-permission">
                <p className="chat-file-head"><ShieldQuestionMark size={15} aria-hidden="true" /><span>{permissionAsks(message.permission?.switch, message.permission?.tool)}</span></p>
                <p className="permission-what" title={permissionWhat({ title: text, detail: message.permission?.detail })}>{permissionWhat({ title: text, detail: message.permission?.detail })}</p>
                {message.permission?.auto && <p className="permission-auto">{autoNote(message.permission.auto)}</p>}
              </div>
            ) : (
              // A handover is said as any message is: to whom, then the work, with "handover" under it.
              <>
                {addressed.length > 0 && <Mentions people={addressed} />}
                {words && <Body text={words} long={long} more={more} mentionable={mentionable} />}
              </>
            )}
            {failed && <p className="chat-failed" role="note">Not delivered{message.error ? `: ${message.error}` : ''}</p>}
            {long && <button type="button" className="chat-more" aria-expanded={more} onClick={() => setMore((value) => !value)}>{more ? 'Show less' : 'Read more'}</button>}
          </div>,
        )}
        {(caption || info || continued || toReply) && (
          <p className="chat-under">
            {caption && <span>{caption}</span>}
            {continued && <time dateTime={bubble.ts}>{when(bubble)}</time>}
            {info && (
              <button type="button" className={`chat-info ${open ? 'open' : ''}`} aria-expanded={open} onClick={onToggle}>
                <Info size={12} aria-hidden="true" />{open ? 'Hide info' : 'Info'}
              </button>
            )}
            {toReply && onReply && (
              <button type="button" className="chat-reply" aria-label={`Reply to ${speaker ? name(speaker) : 'this'}: ${bubble.word}`} onClick={() => onReply(toReply)}>
                <Reply size={12} aria-hidden="true" />Reply
              </button>
            )}
          </p>
        )}
        {open && info && (
          <div className="chat-details">
            {part === 'reply' && reply && (
              <p>
                {message.kind === 'handover' ? 'Reviewed' : message.kind === 'check' ? 'Revised' : 'Answered'} {waited(reply.offsetMs - message.offsetMs)} after it was {message.kind === 'handover' ? 'handed over' : message.kind === 'check' ? 'sent back' : 'asked'}
                {reply.source === 'open' && ', from the work it had already done'}
                {reply.source === 'fresh' && '. A fresh copy answered: it saw only its role and the question'}.
              </p>
            )}
            {part === 'said' && message.context && <Context text={message.context} />}
            {part === 'said' && message.reached && mentions[0] && <p>{reachedLine(message.reached, name(mentions[0]))}</p>}
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
    </>
  )
}

/** What kind of message a bubble is, for a reply to it (`chat::ReplyKind`). */
function replyKind(bubble: Bubble): ReplyKind {
  const { message } = bubble.item.line
  if (bubble.part === 'reply') return message.reply?.asksBack ? 'question_back' : 'answer'
  if (message.kind === 'handover' || message.kind === 'handoff') return 'handover'
  if (message.kind === 'ask') return message.clarifies ? 'answer' : 'question'
  if (message.kind === 'question') return 'question'
  if (message.kind === 'dispatch') return 'task'
  if (message.kind === 'check') return 'check'
  return 'message'
}

/** A reply to this bubble: who said it, to which agent (none when it was to you), and its words. */
function replyFor(bubble: Bubble, from: string, mentions: readonly Member[]): Omit<ReplyTo, 'runId'> {
  return { messageId: bubble.key, from, to: mentions.find((person) => !person.you)?.id ?? null, kind: replyKind(bubble), text: bubble.text }
}

/**
 * What each reply answers, by the bubble it quotes. An answer quotes its question, or for your
 * review the handover you read. A clarification quotes the latest question back to it, and a check
 * the work it checked: the latest handover to it, or revision after its last round, from the agent
 * it checks.
 */
function repliesTo(said: readonly Bubble[]): Map<string, Bubble> {
  const quotes = new Map<string, Bubble>()
  said.forEach((bubble, index) => {
    if (bubble.part === 'reply') {
      const asked = said.find((earlier) => earlier.item === bubble.item && earlier.part === 'said')
      if (asked) quotes.set(bubble.key, asked)
      return
    }
    const { message } = bubble.item.line
    const answers = bubble.part !== 'said' ? null
      : message.clarifies ? (earlier: Bubble) => earlier.part === 'reply' && Boolean(earlier.item.line.message.reply?.asksBack)
      : message.kind === 'check' ? (earlier: Bubble) => (earlier.part === 'said' ? isHandover(earlier) : earlier.part === 'reply' && earlier.item.line.message.kind === 'check')
      : null
    const [speaker, heard] = [bubble.from[0], bubble.to[0]]
    if (!answers || !speaker || !heard) return
    for (let at = index - 1; at >= 0; at--) {
      const earlier = said[at]
      if (earlier.from.includes(heard) && earlier.to.includes(speaker) && answers(earlier)) {
        quotes.set(bubble.key, earlier)
        return
      }
    }
  })
  return quotes
}

function isHandover(bubble: Bubble): boolean {
  const { kind } = bubble.item.line.message
  return bubble.part === 'said' && (kind === 'handover' || kind === 'handoff')
}

/** What a reply's quote names: "Writer’s question", "your note", "Editor’s check". */
function quoteWhat(quoted: Bubble, member: (id: string) => Member): string {
  const who = quoted.from[0] ? member(quoted.from[0]) : null
  const { message } = quoted.item.line
  const thing = quoted.part === 'reply' && message.kind === 'check' ? 'revised work' : message.kind === 'note' ? 'note' : SAID[replyKind(quoted)]
  return `${who ? (who.you ? 'your' : `${who.name}’s`) : 'the'} ${thing}`
}

/**
 * A message's words as its speaker says them. A handover a check step is given opens on "Work from"
 * its writer, which the name above it already says.
 */
function spoken(bubble: Bubble, member: (id: string) => Member): string {
  if (!isHandover(bubble) || bubble.from.length !== 1) return bubble.text
  const [first, ...rest] = bubble.text.trimStart().split('\n')
  return first.replace(/^#+\s*/, '').trim() === `Work from ${member(bubble.from[0]).name}` ? rest.join('\n').trimStart() : bubble.text
}

/** What a message still owed says: who is writing it, or that it waits on you; or that none came. */
function typing(word: string, speaker: Member | null, live: boolean): string {
  const said = word.charAt(0).toUpperCase() + word.slice(1)
  if (!live || speaker?.you) return said
  return `${speaker?.name ?? 'Someone'} is ${word === 'revising' ? 'revising its work' : word === 'working…' ? 'working on its part' : 'writing an answer'}`
}

/** Who a message is for, as a chat names them. */
/** Whom a message is to: each agent as its chip, as in your own words; you by name. */
function Mentions({ people }: { people: Member[] }) {
  return <span className="chat-mentions">{people.map((person) => person.you
    ? <span key={person.id} className={`chat-mention hue-${person.hue}`}>@You</span>
    : <MentionChip key={person.id} id={person.id} name={person.name} hue={person.hue} />)}</span>
}

/** A message's words, formatted as the agent wrote them, cut to its first lines when long. */
function Body({ text, long, more, mentionable }: { text: string; long: boolean; more: boolean; mentionable: Mentionable }) {
  return <div className={`chat-text selectable ${long && !more ? 'cut' : ''}`}><MentionedText text={text} agents={mentionable.agents} hue={mentionable.hue} /></div>
}

/**
 * What a question added as context, formatted as it was written: one line beside its label, or,
 * when it runs to several lines (a list of checks not met), under it.
 */
function Context({ text }: { text: string }) {
  if (!text.trim().includes('\n')) return <p><b>Context:</b> <InlineMarkdown>{text}</InlineMarkdown></p>
  return <div className="chat-text selectable"><b>Context:</b><Markdown>{text}</Markdown></div>
}

function Avatar({ member, size, plain = false }: { member: Member; size: number; plain?: boolean }) {
  // In a team's chat an agent's face has its own card, and @mentions it when clicked.
  const faces = useAgentFaces()
  // LoomWatch's own check (ADR 0098) wears LoomWatch's face: it is no agent, so it has no card.
  if (member.id === LOOMWATCH_CHECK_ID) {
    return (
      <span className="chat-loomwatch" role="img" aria-label={LOOMWATCH_NAME} title={`${LOOMWATCH_NAME} checks the work itself when no checker is on the team.`}>
        <LoomFace size={size} />
      </span>
    )
  }
  const face = (
    <AvatarFace id={member.id} hue={member.hue} size={size} hidden={false} text={member.you ? 'You' : member.initials} title={faces && !member.you ? undefined : member.you ? 'You' : member.name}>
      {!plain && member.number !== null && !member.you && <span className="chat-avatar-number">{member.number}</span>}
    </AvatarFace>
  )
  return member.you ? face : <AgentFace id={member.id}>{face}</AgentFace>
}

/**
 * Everyone who took part, in the stage cards' order, each with the colour it keeps all chat long:
 * its figure's colour (lib/library/figures.ts figureHue), the same as everywhere else in the chat.
 * A helper the team file doesn't list has no figure and takes the next colour in turn.
 */
function membersOf(lanes: readonly Party[], order: readonly Party[], figures: ReadonlyMap<string, FigureChoice>): Map<string, Member> {
  const number = new Map(order.map((party, index) => [party.id, index + 1]))
  const members = new Map<string, Member>()
  let hue = 0
  for (const lane of lanes) {
    // A helper (ADR 0079) wears its agent's figure and colour, and its own number.
    const helper = helperOf(lane.id)
    const figure = figures.get(lane.id) ?? figures.get(wearerOf(lane.id))
    members.set(lane.id, { id: lane.id, name: lane.operator ? 'You' : lane.name, you: lane.operator, number: helper ? helper.number : number.get(lane.id) ?? null, initials: initialsOf(lane.name), hue: lane.operator ? 0 : figure ? figureHue(figure) : (hue++ % FIGURE_HUES) + 1 })
  }
  return members
}

/** "News Editor" → "NE", "Researcher" → "Re": enough to tell two avatars apart beside the number. */
function initialsOf(name: string): string {
  const words = name.split(/[\s_-]+/).filter(Boolean)
  return words.length > 1 ? (words[0][0] + words[1][0]).toUpperCase() : name.slice(0, 2).replace(/^./, (first) => first.toUpperCase())
}

/** Names joined as a person would say them: "A", "A and B", "A, B and C". */
/**
 * People named in a line of the chat's own: each agent as its chip, you as "You", joined as a
 * person would say them (the owner's ruling, 2026-10-25: an agent named is its chip, everywhere).
 */
function named(people: readonly Member[]): ReactNode {
  return joined(people.map((person) => (person.you ? 'You' : <MentionChip key={person.id} id={person.id} name={person.name} hue={person.hue} bare />)))
}

/** Parts joined as a person would say them: "A", "A and B", "A, B and C". */
function joined(parts: readonly ReactNode[]): ReactNode {
  return parts.map((part, index) => <Fragment key={index}>{index === 0 ? '' : index === parts.length - 1 ? ' and ' : ', '}{part}</Fragment>)
}

function nameList(names: readonly string[]): string {
  return names.length <= 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}
