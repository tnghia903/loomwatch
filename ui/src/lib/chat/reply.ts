import type { ReplyKind, ReplyTo } from './client'

/**
 * Replying to something said in a team's work (ADR 0051): a handover, a question or a question
 * back, an answer. A reply goes where its @ sends it, as any message does — the box puts the @ of
 * whoever said it in front — so an agent at work takes it as a note and an agent that is free starts
 * on it. What a reply adds is the quote: kept with your message, shown above it in the chat, and
 * handed to the agent with it, so the agent knows which part of the work you mean.
 */

/** The most of a quoted message a reply sends: what the daemon keeps (`chat::QUOTE_KEPT_CHARS`). */
export const QUOTE_SENT_CHARS = 24_000

/** A reply as it is sent: its words cut in the middle past what the daemon keeps, as it would cut them. */
export function replyOf(reply: ReplyTo): ReplyTo {
  const text = reply.text.trim()
  const chars = [...text]
  if (chars.length <= QUOTE_SENT_CHARS) return { ...reply, text }
  const half = QUOTE_SENT_CHARS / 2
  return { ...reply, text: `${chars.slice(0, half).join('')}\n\n[… cut …]\n\n${chars.slice(-half).join('')}` }
}

const SAID: Record<ReplyKind, string> = {
  handover: 'handover',
  question: 'question',
  question_back: 'question back',
  answer: 'answer',
  task: 'task',
  check: 'check',
  message: 'message',
}

/**
 * "Researcher's handover to Writer": the message a reply answers, by the team's names, the way the
 * daemon names it to the agent (`chat::ReplyTo::described`).
 */
export function replyWhat(reply: Pick<ReplyTo, 'from' | 'to' | 'kind'>, name: (id: string) => string): string {
  const from = name(reply.from)
  const to = reply.to ? name(reply.to) : null
  if (reply.kind === 'task') return `the task ${from} sent${to ? ` to ${to}` : ''}`
  if (reply.kind === 'check') return `${from}'s check${to ? ` of ${to}'s work` : ''}`
  return `${from}'s ${SAID[reply.kind]}${to ? ` to ${to}` : ''}`
}

/** The quote in one line: Markdown marks off, whitespace run together. CSS cuts it to fit. */
export function quoteLine(text: string): string {
  return text.replace(/^#+\s*/gm, '').replace(/[*_`>]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * What an answer that asks back asks: the words under its "Question back" heading or label, which
 * the Team Bus asks for (`team_bus::framing`); the whole answer when it has neither.
 */
export function questionBackOf(text: string): string {
  const marker = /^\s*(?:#+\s*|\*\*)?question back\b[:*\s]*/im.exec(text)
  if (!marker) return text
  const rest = text.slice(marker.index + marker[0].length).trim()
  return rest || text
}
