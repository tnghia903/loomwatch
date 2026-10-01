import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * The real Markdown renderer. Loaded on demand by [`Markdown`](./Markdown.tsx): the unified /
 * micromark stack is the largest dependency in the app and nothing needs it until a run has an
 * answer to show.
 *
 * Raw HTML is skipped and images are never fetched — a report is untrusted model output, and an
 * embedded `<img src>` is a tracking pixel the operator never agreed to load.
 */
export default function MarkdownRenderer({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ children: label, href }) => <a href={href} target="_blank" rel="noreferrer">{label}</a>,
        img: ({ alt }) => <span className="delivery-image-reference">[Image: {alt || 'reference'}]</span>,
      }}
    >
      {children}
    </ReactMarkdown>
  )
}
