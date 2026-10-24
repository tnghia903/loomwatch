import { memo, Suspense } from 'react'

import { plainWords } from '../../lib/chat/findWords'
import { MarkdownRenderer } from './markdownCode'

/**
 * Markdown, code-split. Until the renderer arrives the text shows as-is (wrapped, selectable), so a
 * slow chunk never hides the answer — it only delays the formatting.
 *
 * Kept while its text is the same: parsing is the costly part, and a live run re-renders the chat
 * with every batch of events while only the message being written has changed.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <Suspense fallback={<div className="markdown-fallback">{children}</div>}>
      <MarkdownRenderer>{children}</MarkdownRenderer>
    </Suspense>
  )
})

/**
 * Markdown an agent wrote, shown inside a line of the app's own: a check's evidence, a note taken
 * off an answer. Its bold, code and links are shown; a heading or list reads as its words, and so
 * does the whole line until the renderer arrives. `clickable={false}` shows a link as its words too.
 */
export const InlineMarkdown = memo(function InlineMarkdown({ children, clickable = true }: { children: string; clickable?: boolean }) {
  return (
    <span className="md-inline">
      <Suspense fallback={plainWords(children)}>
        <MarkdownRenderer inline clickable={clickable}>{children}</MarkdownRenderer>
      </Suspense>
    </span>
  )
})
