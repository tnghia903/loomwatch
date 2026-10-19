import type { Bubble } from '../story/conversation'
import { listNames } from './format'
import { allMet, OPERATOR_ID, type TeamMessage } from '../watch/messages'

/**
 * Reactions in a team's chat: the crew's face, the one LoomWatch's mark wears, pulling a face at
 * something said (components/chat/Reactions.tsx draws them). The face says it; its word is its name.
 *
 * Your face is feedback the team uses. You put one on something an agent said — its answer, a
 * handover, a question — the way a tapback works, and the daemon keeps it (`chat_reactions`). The
 * next time the team works, its conversation says what the reaction means and what it was on: Good
 * and Love it, keep doing this; Not sure, it is revisited; Wrong, nothing is built on it. Seen
 * tells the team nothing. A run already working is not told.
 *
 * The agents react too, but never by guessing how they feel: each of their faces is a fact the run
 * recorded, read back here as a receipt. An agent looks up at what it was handed (`seen`) — your
 * request when its turn began, your note when its next turn took it, a handover, a task, your
 * answer to its question — and a check step that found everything met puts `met` on the work it
 * checked. Once the work is done, everyone who worked on it puts `done` on your request, with how
 * long it took: the piece says who did it with their figures rather than a line of words.
 *
 * `Face` keeps the names the daemon stores; what you see is `faceLabel`.
 */
export type Face = 'glad' | 'love' | 'hmm' | 'off' | 'seen' | 'met' | 'done'

/**
 * The faces you can pick, in the tray's order: what each is called, and what it tells the team the
 * next time it works. The daemon keeps the same list and says the same thing to the agents.
 */
export const PALETTE: readonly { face: Face; label: string; tells: string }[] = [
  { face: 'glad', label: 'Good', tells: 'The team keeps doing this' },
  { face: 'love', label: 'Love it', tells: 'Exactly right. The team keeps to it' },
  { face: 'hmm', label: 'Not sure', tells: 'The team looks at it again' },
  { face: 'off', label: 'Wrong', tells: 'The team won’t build on it' },
  { face: 'seen', label: 'Seen', tells: 'You read it. The team isn’t told' },
]

/** What the tray says before you point at a reaction. */
export const TRAY_SAYS = 'The team reads your reaction next time'

const LABELS: Record<Face, string> = { ...Object.fromEntries(PALETTE.map(({ face, label }) => [face, label])) as Record<Face, string>, met: 'All met', done: 'Done' }

/** What your face tells the team, in a sentence; `null` for a face only the agents put on. */
export const faceTells = (face: Face): string | null => PALETTE.find((entry) => entry.face === face)?.tells ?? null

/** What a reaction says, in a word or two: "Good", "Not sure", "All met". */
export const faceLabel = (face: Face): string => LABELS[face]

/** What an agent's face means, said of it: "Writer picked this up". */
const AGENT_SAYS: Partial<Record<Face, string>> = { seen: 'picked this up', met: 'checked this and found everything met', done: 'worked on this' }

/** One of the operator's reactions, as the daemon keeps it. */
export interface Reaction {
  /** What in the piece of work: `answer`, or `talk:<line>` for a line of the agents' talk. */
  target: string
  face: Face
  at: string
}

/**
 * What a line of the agents' talk was, sent with your face on it so the next work's conversation
 * can say what the face was on: who said it, in a word what it was, and its words.
 */
export interface ReactionAbout {
  agent: string | null
  what: string
  quote: string
}

/** A face an agent put on something, read from the run's record. */
export interface AgentReaction {
  face: Face
  /** The agent's id. */
  by: string
  at: string
  /** A fact the face carries, shown beside it: how long the work took. */
  detail?: string
}

/** One face on a message, and everyone who put it there: what one chip under the message shows. */
export interface Chip {
  face: Face
  /** You put it there; picking it again takes it off. */
  you: boolean
  /** The agents who did, first to react first. */
  agents: string[]
  /** What the agents' faces carry, shown beside them: how long the work took. */
  detail?: string
}

/** What a piece of work names the things the agents said in it, for a reaction. */
export const targets = {
  answer: 'answer',
  talk: (bubble: Pick<Bubble, 'key'>) => `talk:${bubble.key}`,
} as const

/** Your face on one thing said, from the piece's reactions. */
export function yoursOn(reactions: readonly Reaction[] | undefined, target: string): Face | null {
  return reactions?.find((reaction) => reaction.target === target)?.face ?? null
}

/**
 * The chips under one message: a face each, yours and the agents' together, in the order the faces
 * first came. An agent that put two faces on one message is not possible from the record, but if
 * it were, each would count.
 */
export function chipsOf(yours: Face | null, agents: readonly AgentReaction[]): Chip[] {
  const chips: Chip[] = []
  const chip = (face: Face) => {
    let found = chips.find((candidate) => candidate.face === face)
    if (!found) {
      found = { face, you: false, agents: [] }
      chips.push(found)
    }
    return found
  }
  for (const reaction of [...agents].sort((left, right) => left.at.localeCompare(right.at))) {
    const found = chip(reaction.face)
    if (!found.agents.includes(reaction.by)) found.agents.push(reaction.by)
    if (reaction.detail) found.detail = reaction.detail
  }
  if (yours) chip(yours).you = true
  return chips
}

/**
 * What a chip says, for its tooltip and its accessible name. The agents' own faces say what they
 * did — "Researcher and Writer worked on this · 4 min", "Writer picked this up" — and a face with
 * you on it says who put it there: "Good: you and Writer".
 */
export function chipWords(chip: Chip, name: (id: string) => string): string {
  const says = AGENT_SAYS[chip.face]
  if (!chip.you && says && chip.agents.length > 0) return `${listNames(chip.agents.map(name))} ${says}${chip.detail ? ` · ${chip.detail}` : ''}`
  return `${faceLabel(chip.face)}: ${listNames([...(chip.you ? ['you'] : []), ...chip.agents.map(name)])}`
}

/** Whether an id is you: your reserved id, or a review step, which is you. */
function youOf(operators: ReadonlySet<string>) {
  return (id: string | null | undefined) => !id || id === OPERATOR_ID || operators.has(id)
}

/**
 * The faces a check step put on the work it checked: `met` on what it was handed, the round it
 * found everything met. Its first round checks the handover it was given; a later round checks the
 * revised work, which is the reply to its round before. Keyed by the bubble each sits on.
 */
export function checkReactions(messages: readonly TeamMessage[]): Map<string, AgentReaction[]> {
  const out = new Map<string, AgentReaction[]>()
  const add = (key: string, reaction: AgentReaction) => out.set(key, [...(out.get(key) ?? []), reaction])
  messages.forEach((message, index) => {
    if (message.kind !== 'check' || !message.check || !message.from || !allMet(message.check)) return
    const checker = message.from
    const before = messages.slice(0, index).reverse()
    const earlier = message.check.round > 1 ? before.find((candidate) => candidate.kind === 'check' && candidate.from === checker && candidate.reply) : undefined
    if (earlier) {
      add(`${earlier.id}:reply`, { face: 'met', by: checker, at: message.ts })
      return
    }
    const handed = before.find((candidate) => candidate.kind === 'handover' && candidate.to === checker && !candidate.carried)
    if (handed) add(`${handed.id}:said`, { face: 'met', by: checker, at: message.ts })
  })
  return out
}

/**
 * The faces the agents put on one line of their talk: whoever was handed something looks up at it
 * (`seen`), and a check step's `met` (from `checkReactions`). Only what reached an agent counts: a
 * message still being sent, or one that failed, has no face on it; neither does anything handed
 * to you, whose face is yours to give.
 */
export function talkReactions(bubble: Bubble, operators: ReadonlySet<string>, checks: ReadonlyMap<string, readonly AgentReaction[]>): AgentReaction[] {
  const isYou = youOf(operators)
  const { message } = bubble.item.line
  const out: AgentReaction[] = []
  const seen = (by: string | null | undefined, at: string) => {
    if (!isYou(by) && !out.some((reaction) => reaction.face === 'seen' && reaction.by === by)) out.push({ face: 'seen', by: by as string, at })
  }
  if (bubble.part === 'said') {
    const reached = message.state === 'delivered' || message.state === 'answered'
    if (reached && (message.kind === 'handover' || message.kind === 'direction' || message.kind === 'dispatch' || message.kind === 'handoff')) {
      for (const to of bubble.to) seen(to, message.ts)
    }
  } else if (bubble.part === 'reply' && message.reply && isYou(message.reply.from)) {
    // Your answer reaches whoever asked, or wherever you sent the work on or back.
    for (const to of bubble.to) seen(to, message.reply.ts)
  }
  return [...out, ...(checks.get(bubble.key) ?? [])]
}
