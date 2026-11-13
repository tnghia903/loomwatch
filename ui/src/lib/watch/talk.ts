import { converse, type Line, type Party } from '../story/conversation'
import { allMet, type TeamMessage } from './messages'

/**
 * Who is talking to whom at one moment of a run, for the run view's spotlight (owner, 2026-11-13):
 * the agents in a talk stay lit while the others dim, and one card says it in a sentence with their
 * faces ("Checker asks Researcher"). It is read from the messages the run recorded
 * (lib/watch/messages.ts) through the conversation the team's chat reads (lib/story/conversation.ts),
 * so both name the same senders. What was said stays in the chat beside the record (ADR 0051): a card
 * says who to whom, and opens the message there.
 *
 * Only talk between the team's stages is spotlit. A question for you, a permission and your own
 * review are answered in the chat and the permission prompt; a helper (ADR 0079) works at its lead's
 * bench, which shows it.
 */
export type TalkTone = 'live' | 'back' | 'ok' | 'failed' | 'halt'

export interface Talk {
  /** The message the card opens in the chat. */
  messageId: string
  /** Unique among the talks of one moment: the message, and whether this is its answer. */
  key: string
  /** Who speaks and who is spoken to, by lane id; several when one handed to many at once. */
  from: string[]
  to: string[]
  /** What goes between the names, agreeing with who speaks: "asks", "hand the work to". */
  verb: string
  /** What follows the receiver's name: "’s work" in "Checker checks Writer’s work"; else empty. */
  tail: string
  /** A word the sentence doesn't say already ("all met", "couldn’t finish"); `null` when it would
      only repeat the verb. */
  word: string | null
  /** `back`: a send-back, dashed and in the send-back's gold, as its arc was. `failed` and `halt`:
      work handed out that couldn't finish or was stopped. */
  tone: TalkTone
  /** When it was said, in ms since the epoch: the newest talks come last. */
  at: number
}

/** How long a talk stays in the spotlight once it is said. A question stays until it is answered. */
export const TALK_MS = 6000
/** Said this close together, by the same agent in the same way, is one talk to several. */
const TOGETHER_MS = 2000

/** A sentence's verb for one sender, and for several (or for you: "you hand the work to Writer"). */
interface Saying { verb: string; verbs: string; tail?: string; word?: string; tone: TalkTone }

/** What a message says, between its sender and its receiver; `null` for what isn't spotlit. */
function said(message: TeamMessage): Saying | null {
  switch (message.kind) {
    // The timeline's words for the same moment ("handed the work to"), so the two never differ.
    case 'handover':
    case 'handoff': return { verb: 'hands the work to', verbs: 'hand the work to', tone: 'live' }
    case 'dispatch': return { verb: 'gives a task to', verbs: 'give a task to', tone: 'live' }
    case 'ask': return message.clarifies ? { verb: 'answers', verbs: 'answer', tone: 'live' } : { verb: 'asks', verbs: 'ask', tone: 'live' }
    case 'check':
      if (!message.check) return null
      if (message.check.sentBack) return { verb: 'sends the work back to', verbs: 'send the work back to', tone: 'back' }
      return allMet(message.check)
        ? { verb: 'checks', verbs: 'check', tail: '’s work', word: 'all met', tone: 'ok' }
        : { verb: 'checks', verbs: 'check', tail: '’s work', tone: 'live' }
    default: return null
  }
}

/** What its answer says, going back the other way; `null` when it has none to spotlight. */
function answered(message: TeamMessage): Saying | null {
  const reply = message.reply
  if (!reply) return null
  switch (message.kind) {
    case 'ask': return reply.asksBack ? { verb: 'asks', verbs: 'ask', tail: ' back', tone: 'live' } : { verb: 'answers', verbs: 'answer', tone: 'live' }
    case 'dispatch':
    case 'handoff':
      // The timeline says "reported back to"; how it went is the one word the sentence lacks.
      if (reply.failed) return { verb: 'reports back to', verbs: 'report back to', word: 'couldn’t finish', tone: 'failed' }
      if (reply.stopped) return { verb: 'reports back to', verbs: 'report back to', word: 'stopped', tone: 'halt' }
      return { verb: 'reports back to', verbs: 'report back to', word: 'done', tone: 'ok' }
    // The work sent back comes back revised: the checked agent's next turn is the reply.
    case 'check': return message.check?.sentBack ? { verb: 'sends the revised work to', verbs: 'send the revised work to', tone: 'live' } : null
    default: return null
  }
}

/**
 * The talks at `at` (ms since the epoch): each message said less than `TALK_MS` before it, or its
 * answer if that came since, and a question still waiting for its answer. `order` is the team in its
 * stages' order, as the chat reads it; a talk with someone not in it is left out, since there is no
 * stage to light.
 */
export function talksAt(messages: readonly TeamMessage[], order: readonly Party[], at: number, predecessors?: ReadonlyMap<string, readonly string[]>): Talk[] {
  const stages = new Set(order.map((party) => party.id))
  const you = new Set(order.filter((party) => party.operator).map((party) => party.id))
  const talks: Talk[] = []
  const push = (line: Line, saying: Saying, from: string[], to: string[], when: number, reply: boolean) => {
    if (from.length === 0 || to.length === 0 || ![...from, ...to].every((id) => stages.has(id))) return
    // "you hand the work to", "Researcher and Price analyst hand the work to".
    const many = from.length > 1 || from.every((id) => you.has(id))
    talks.push({ messageId: line.message.id, key: `${line.message.id}:${reply ? 'reply' : 'said'}`, from, to, verb: many ? saying.verbs : saying.verb, tail: saying.tail ?? '', word: saying.word ?? null, tone: saying.tone, at: when })
  }
  for (const line of converse(messages, order, predecessors).lines) {
    const message = line.message
    if (message.carried || message.state === 'failed' || message.refused) continue
    const saying = said(message)
    const ts = Date.parse(message.ts)
    if (!saying || !(ts <= at)) continue
    const reply = message.reply && Date.parse(message.reply.ts) <= at ? message.reply : null
    if (reply) {
      const back = answered(message)
      const replyAt = Date.parse(reply.ts)
      if (back && line.replier !== null && at - replyAt < TALK_MS) push(line, back, [line.replier], line.senders.slice(0, 1), replyAt, true)
      continue
    }
    // A question stays lit until it is answered: the asker is waiting on the other. Its answer may
    // come after this moment (`reply` is null then), so its final state isn't what counts here.
    const waiting = message.kind === 'ask'
    if ((at - ts < TALK_MS || waiting) && line.receiver !== null) push(line, saying, line.senders, [line.receiver], ts, false)
  }
  return together(talks).sort((a, b) => a.at - b.at)
}

/** One agent handing over to several at once reads as one talk: "hands the work to A and B". */
function together(talks: readonly Talk[]): Talk[] {
  const out: Talk[] = []
  for (const talk of talks) {
    const same = out.find((other) => other.verb === talk.verb && other.tail === talk.tail && other.word === talk.word && other.tone === talk.tone
      && other.from.join() === talk.from.join() && Math.abs(other.at - talk.at) < TOGETHER_MS)
    if (same) same.to = [...same.to, ...talk.to.filter((id) => !same.to.includes(id))]
    else out.push({ ...talk, from: [...talk.from], to: [...talk.to] })
  }
  return out
}

/** Everyone in any of `talks`: the stages that stay lit. */
export function inTalks(talks: readonly Talk[]): Set<string> {
  return new Set(talks.flatMap((talk) => [...talk.from, ...talk.to]))
}
