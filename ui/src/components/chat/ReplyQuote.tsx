import { CornerUpLeft } from '../ui/icon'

import type { ReplyTo } from '../../lib/chat/client'
import type { SentChange } from '../../lib/files/changes'
import { replyWhat, replyWords } from '../../lib/chat/reply'
import { InlineMarkdown } from '../ui/Markdown'

/**
 * What one of your messages replied to, above its words (ADR 0051): who said it, what it was, and
 * its first words. A click shows the message itself where it was said, when the chat has it.
 */
export function ReplyQuote({ reply, name, onShow }: { reply: ReplyTo; name: (id: string) => string; onShow?: () => void }) {
  return <Quote what={replyWhat(reply, name)} text={replyWords(reply)} onShow={onShow} />
}

/**
 * The changes one of your messages sent an agent (ADR 0107), each its part's quote and what
 * should change there, numbered as the agent was given them. A click on a quote shows the part in
 * its file, as a question's quote does.
 */
export function ChangesQuote({ changes, onShow }: { changes: readonly SentChange[]; onShow?: (part: ReplyTo) => (() => void) | undefined }) {
  return (
    <ol className="tc-changes" aria-label="Your changes">
      {changes.map((change) => {
        // The part's words alone: the message's first line names the file.
        const what = `The part of ${partFile(change.part)}`
        const words = <span><InlineMarkdown clickable={false}>{replyWords(change.part)}</InlineMarkdown></span>
        const show = onShow?.(change.part)
        return (
          <li key={change.id} className="tc-change">
            <span className="tc-change-number" aria-hidden="true">{change.number}</span>
            <div className="tc-change-body">
              {show
                ? <button type="button" className="chat-quote tc-reply-quote" onClick={show} aria-label={`${what}. Show it`}>{words}</button>
                : <blockquote className="chat-quote tc-reply-quote" aria-label={what}>{words}</blockquote>}
              <p className="tc-change-words">{change.words}</p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function partFile(part: ReplyTo): string {
  const name = part.file?.split(/[\\/]/).pop()
  return name || 'the file'
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
