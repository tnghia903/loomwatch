import { CornerUpLeft } from 'lucide-react'

import type { ReplyTo } from '../../lib/chat/client'
import { quoteLine, replyWhat } from '../../lib/chat/reply'

/**
 * What one of your messages replied to, above its words (ADR 0051): who said it, what it was, and
 * its first words. A click shows the message itself where it was said, when the chat has it.
 */
export function ReplyQuote({ reply, name, onShow }: { reply: ReplyTo; name: (id: string) => string; onShow?: () => void }) {
  const what = replyWhat(reply, name)
  const words = (
    <>
      <b><CornerUpLeft size={11} aria-hidden="true" />{what.charAt(0).toUpperCase() + what.slice(1)}</b>
      <span>{quoteLine(reply.text)}</span>
    </>
  )
  return onShow
    ? <button type="button" className="chat-quote tc-reply-quote" onClick={onShow} aria-label={`Replying to ${what}. Show it`}>{words}</button>
    : <blockquote className="chat-quote tc-reply-quote" aria-label={`Replying to ${what}`}>{words}</blockquote>
}
