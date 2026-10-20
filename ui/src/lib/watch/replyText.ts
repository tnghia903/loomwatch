/**
 * An agent's reply, assembled from the message chunks it streamed — the daemon's `ReplyText`
 * (`crates/loomwatch-backend/src/engine/recorder.rs`) applied to the archive.
 *
 * Chunks of one message join verbatim: they are tokens of the same sentence. Separate messages sit
 * a paragraph apart, so the notes an agent writes between tool calls do not run together into one
 * line. ACP's `messageId` names a chunk's message and is authoritative when both sides carry one;
 * a harness that sends none is read at tool, plan and permission activity, the only boundary it
 * gives. A message the harness marks as commentary (`commentaryOf`) asked for tool calls, or came
 * before a web search the provider ran part way through a message (the harness records each side
 * of the search as a message of its own), so its words were said on the way, not the answer:
 * `text` leaves them out, unless they are all the agent said. The two implementations must agree,
 * or a saved reply stops matching its archived turn.
 */
export class ReplyText {
  /** Everything the agent said, the words on the way included. */
  said = ''
  /** The finished messages not said on the way, a paragraph apart. */
  private answer = ''
  /** The message being written, until the next one shows it wasn't said on the way. */
  private current = ''
  private setAsideAny = false
  private messageId: string | null = null
  private boundary = false

  push(chunk: string, messageId: string | null): void {
    if (!chunk) return
    const newMessage = this.messageId !== null && messageId !== null ? this.messageId !== messageId : this.boundary
    if (newMessage && this.said) {
      this.said += '\n'.repeat(Math.max(0, 2 - trailingNewlines(this.said) - leadingNewlines(chunk)))
      this.answer = paragraph(this.answer, this.current)
      this.current = ''
    }
    this.said += chunk
    this.current += chunk
    this.messageId = messageId
    this.boundary = false
  }

  /** The agent did something other than talk, so whatever it says next is a new message. */
  noteActivity(): void {
    this.boundary = true
  }

  /** The message `messageId` asked for tool calls: its words were said on the way. */
  setAside(messageId: string): void {
    if (this.messageId !== messageId) return
    this.current = ''
    this.setAsideAny = true
  }

  /** A turn ended: the next chunk starts a new message even if its harness reuses the ID. */
  endMessage(): void {
    this.messageId = null
    this.boundary = true
  }

  /** The reply: what the agent said but its words on the way, or those too when they are all. */
  get text(): string {
    if (!this.setAsideAny) return this.said
    const answer = paragraph(this.answer, this.current)
    return answer.trim() ? answer : this.said
  }
}

/** The archived event kinds that mark the agent doing something other than talking. */
export const ACTIVITY_KINDS: ReadonlySet<string> = new Set(['tool_call', 'tool_update', 'plan', 'permission'])

/**
 * The message a `commentary` note names: one the agent wrote alongside tool calls, archived as a
 * `session_meta` event (the daemon's `commentary`).
 */
export function commentaryOf(kind: string, payload: Record<string, unknown>): string | null {
  if (kind !== 'session_meta' || payload.sessionUpdate !== 'agent_message_phase' || payload.phase !== 'commentary') return null
  return typeof payload.messageId === 'string' ? payload.messageId : null
}

/** `next` after `text`, a paragraph apart. */
function paragraph(text: string, next: string): string {
  if (!next) return text
  if (!text) return next
  return text + '\n'.repeat(Math.max(0, 2 - trailingNewlines(text) - leadingNewlines(next))) + next
}

function trailingNewlines(text: string): number {
  let count = 0
  while (count < text.length && text[text.length - 1 - count] === '\n') count += 1
  return count
}

function leadingNewlines(text: string): number {
  let count = 0
  while (count < text.length && text[count] === '\n') count += 1
  return count
}
