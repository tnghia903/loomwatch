import { memo, Suspense } from 'react'

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
