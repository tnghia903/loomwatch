import { CornerUpLeft } from 'lucide-react'

import type { ReplyTo } from '../../lib/chat/client'
import { replyWhat } from '../../lib/chat/reply'
import { InlineMarkdown } from '../ui/Markdown'

/**
 * What one of your messages replied to, above its words (ADR 0051): who said it, what it was, and
 * its first words. A click shows the message itself where it was said, when the chat has it.
 */
export function ReplyQuote({ reply, name, onShow }: { reply: ReplyTo; name: (id: string) => string; onShow?: () => void }) {
  return <Quote what={replyWhat(reply, name)} text={reply.text} onShow={onShow} />
}

/**
 * A reply's quote, yours or an agent's: `what` names the message it answers ("Writer’s question"),
 * and its first words follow, so every reply in the chat reads the same way. They show their
 * Markdown, with links as words: the quote is cut by its line, and a click shows the message.
 */
export function Quote({ what, text, onShow }: { what: string; text: string; onShow?: () => void }) {
  const words = (
    <>
      <b><CornerUpLeft size={11} aria-hidden="true" />{what.charAt(0).toUpperCase() + what.slice(1)}</b>
      <span><InlineMarkdown clickable={false}>{text}</InlineMarkdown></span>
    </>
  )
  return onShow
    ? <button type="button" className="chat-quote tc-reply-quote" onClick={onShow} aria-label={`Replying to ${what}. Show it`}>{words}</button>
    : <blockquote className="chat-quote tc-reply-quote" aria-label={`Replying to ${what}`}>{words}</blockquote>
}
