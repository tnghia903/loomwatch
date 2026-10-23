// An answer of the pinned agent, formatted for another app (ADR 0083, decision 9): what Copy puts
// on the clipboard beside the plain text, so a long answer keeps its headings, lists, bold and
// working links when pasted into Mail, Notes or a document. Loaded once an answer is read whole,
// so the island's own page stays small; it renders with the React already loaded.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * `markdown` as HTML: the plain elements Markdown makes, nothing of LoomWatch's own look. Raw HTML
 * in it stays text and a `javascript:` link loses its address, as in the chat. The charset is said,
 * or an app reading the clipboard may take "Đà Lạt" for other letters. Rendered into a box that is
 * never shown, outside any render of the island's own.
 */
export function answerHtml(markdown: string): string {
  const box = document.createElement('div')
  const root = createRoot(box)
  flushSync(() => root.render(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown)))
  const html = box.innerHTML
  root.unmount()
  return `<meta charset="utf-8">${html}`
}
