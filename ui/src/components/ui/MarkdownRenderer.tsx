import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { filePathFrom } from '../../lib/files/fileRefs'
import { FileChip } from './FileChip'

/**
 * The real Markdown renderer. Loaded on demand by [`Markdown`](./Markdown.tsx): the unified /
 * micromark stack is the largest dependency in the app and nothing needs it until a run has an
 * answer to show.
 *
 * Raw HTML is skipped and images are never fetched — a report is untrusted model output, and an
 * embedded `<img src>` is a tracking pixel the operator never agreed to load.
 *
 * A file the reply names — an absolute path in inline code, a link to one, or a `file://` URL — is
 * shown as a file the operator can open (FileChip, ADR 0026), not as a path to copy by hand. Fenced
 * code is left alone: a path inside a code block is code.
 */
export default function MarkdownRenderer({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} skipHtml components={COMPONENTS}>
      {children}
    </ReactMarkdown>
  )
}

const REMARK_PLUGINS = [remarkGfm]

// Module-level on purpose: react-markdown renders each override as a component type, so a map
// rebuilt per render remounts every override on every parent render — losing a FileChip's state
// and asking the daemon about its file again each time.
const COMPONENTS: Components = {
  a: ({ children: label, href }) => {
    const path = filePathFrom(href)
    return path ? <FileChip path={path} /> : <a href={href} target="_blank" rel="noreferrer">{label}</a>
  },
  code: ({ children: text, className }) => {
    // A fenced block's text ends in a newline (and usually carries a language class).
    const inline = typeof text === 'string' && !className && !text.includes('\n')
    const path = inline ? filePathFrom(text) : null
    return path ? <FileChip path={path} /> : <code className={className}>{text}</code>
  },
  img: ({ alt }) => <span className="delivery-image-reference">[Image: {alt || 'reference'}]</span>,
}
