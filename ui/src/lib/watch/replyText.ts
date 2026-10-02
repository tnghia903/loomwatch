/**
 * An agent's reply, assembled from the message chunks it streamed — the daemon's `ReplyText`
 * (`crates/loomwatch-backend/src/acp.rs`) applied to the archive.
 *
 * Chunks of one message join verbatim: they are tokens of the same sentence. Separate messages sit
 * a paragraph apart, so the notes an agent writes between tool calls do not run together into one
 * line. ACP's `messageId` names a chunk's message and is authoritative when both sides carry one;
 * a harness that sends none is read at tool, plan and permission activity, the only boundary it
 * gives. The two implementations must agree, or a saved reply stops matching its archived turn.
 */
export class ReplyText {
  text = ''
  private messageId: string | null = null
  private boundary = false

  push(chunk: string, messageId: string | null): void {
    if (!chunk) return
    const newMessage = this.messageId !== null && messageId !== null ? this.messageId !== messageId : this.boundary
    if (newMessage && this.text) this.text += '\n'.repeat(Math.max(0, 2 - trailingNewlines(this.text) - leadingNewlines(chunk)))
    this.text += chunk
    this.messageId = messageId
    this.boundary = false
  }

  /** The agent did something other than talk, so whatever it says next is a new message. */
  noteActivity(): void {
    this.boundary = true
  }

  /** A turn ended: the next chunk starts a new message even if its harness reuses the ID. */
  endMessage(): void {
    this.messageId = null
    this.boundary = true
  }
}

/** The archived event kinds that mark the agent doing something other than talking. */
export const ACTIVITY_KINDS: ReadonlySet<string> = new Set(['tool_call', 'tool_update', 'plan', 'permission'])

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
