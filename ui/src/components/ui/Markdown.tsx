import { lazy, Suspense } from 'react'

const MarkdownRenderer = lazy(() => import('./MarkdownRenderer'))

/**
 * Markdown, code-split. Until the renderer arrives the text shows as-is (wrapped, selectable), so a
 * slow chunk never hides the answer — it only delays the formatting.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <Suspense fallback={<div className="markdown-fallback">{children}</div>}>
      <MarkdownRenderer>{children}</MarkdownRenderer>
    </Suspense>
  )
}
