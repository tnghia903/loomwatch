import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { filePathFrom, filePathFromLink } from '../../lib/files/fileRefs'
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
 * code is left alone: a path inside a code block is code. A link to a file named from somewhere this
 * page cannot know (`./guide.html`) reads as its words: opened here it would only load LoomWatch
 * again, in a new tab.
 *
 * Research answers mark each claim and cite it: "[Sourced] … [Paper](https://…)". The mark reads
 * as a small tag and the links after the claim as its sources, not as bracketed text and a run of
 * underlined titles.
 */
export default function MarkdownRenderer({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} skipHtml components={COMPONENTS}>
      {children}
    </ReactMarkdown>
  )
}

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [() => markClaimsAndSources]

type HastElement = NonNullable<ExtraProps['node']>
type HastChild = HastElement['children'][number]

// The marks writers put before a claim, in two kinds: backed by a source, or the writer's own
// reasoning. Only these words: a paragraph opening with "[Your name]" is a placeholder, not a mark.
const BACKED = ['sourced', 'cited', 'verified', 'confirmed', 'fact']
const REASONED = ['inference', 'inferred', 'assumption', 'assumed', 'estimate', 'estimated', 'speculation', 'hypothesis', 'opinion', 'unverified']
const CLAIM_MARK = new RegExp(`^\\s*\\[\\s*(${[...BACKED, ...REASONED].join('|')})\\s*\\]\\s*`, 'i')
const CLAIM_SAYS = {
  backed: 'The writer marked this as backed by a source',
  reasoned: 'The writer marked this as their own reasoning, not taken from a source',
}
// Between and after the links that close a claim: spaces and the punctuation that separates them.
const BETWEEN_SOURCES = /^[\s.,;·|]*$/

function markClaimsAndSources(tree: { children: HastChild[] }) {
  const visit = (nodes: HastChild[]) => {
    for (const node of nodes) {
      if (node.type !== 'element') continue
      if (node.tagName === 'p' || node.tagName === 'li') {
        markClaim(node)
        markSources(node)
      }
      if (node.tagName !== 'pre' && node.tagName !== 'code') visit(node.children)
    }
  }
  visit(tree.children)
}

function markClaim(block: HastElement) {
  const first = block.children[0]
  if (!first) return
  // "[Sourced] text", or the mark alone in bold or italics: "**[Sourced]** text".
  const inner = first.type === 'element' && (first.tagName === 'strong' || first.tagName === 'em') && first.children.length === 1 ? first.children[0] : null
  const text = first.type === 'text' ? first : inner?.type === 'text' ? inner : null
  const found = text ? CLAIM_MARK.exec(text.value) : null
  if (!text || !found || (text !== first && found[0].length !== text.value.length)) return
  const word = found[1].toLowerCase()
  const kind = BACKED.includes(word) ? 'backed' : 'reasoned'
  const tag: HastElement = {
    type: 'element',
    tagName: 'span',
    properties: { className: ['md-claim', `md-claim-${kind}`], title: CLAIM_SAYS[kind] },
    children: [{ type: 'text', value: word[0].toUpperCase() + word.slice(1) }],
  }
  if (text === first) text.value = text.value.slice(found[0].length)
  else block.children.shift()
  block.children.unshift(tag, { type: 'text', value: ' ' })
}

function markSources(block: HastElement) {
  const kids = block.children
  let start = kids.length
  while (start > 0) {
    const node = kids[start - 1]
    const isWebLink = node.type === 'element' && node.tagName === 'a' && /^https?:\/\//i.test(String(node.properties.href ?? ''))
    if (!isWebLink && !(node.type === 'text' && BETWEEN_SOURCES.test(node.value))) break
    start -= 1
  }
  const links = kids.slice(start).filter((node): node is HastElement => node.type === 'element')
  // Links alone (a list of references) stay links: a source is the one a claim cites.
  const claim = kids.slice(0, start).some((node) => node.type !== 'text' || node.value.trim() !== '')
  if (links.length === 0 || !claim) return
  for (const link of links) link.properties.className = ['md-source']
  block.children = [...kids.slice(0, start), ...links.flatMap((link) => [{ type: 'text' as const, value: ' ' }, link])]
}

function hostOf(href: string | undefined): string | undefined {
  try {
    return href ? new URL(href).host.replace(/^www\./, '') : undefined
  } catch {
    return undefined
  }
}

// Module-level on purpose: react-markdown renders each override as a component type, so a map
// rebuilt per render remounts every override on every parent render — losing a FileChip's state
// and asking the daemon about its file again each time.
const COMPONENTS: Components = {
  a: ({ children: label, href, className }) => {
    const path = filePathFromLink(href)
    if (path) return <FileChip path={path} />
    if (href && !/^([a-z][a-z0-9+.-]*:|#)/i.test(href)) return <span className="md-unlinked">{label}</span>
    if (className === 'md-source') {
      return (
        <a className="md-source" href={href} target="_blank" rel="noreferrer" title={hostOf(href)}>
          <span className="md-source-label">{label}</span>
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2h5v5M8 2 2.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </a>
      )
    }
    return <a href={href} target="_blank" rel="noreferrer">{label}</a>
  },
  code: ({ children: text, className }) => {
    // A fenced block's text ends in a newline (and usually carries a language class).
    const inline = typeof text === 'string' && !className && !text.includes('\n')
    const path = inline ? filePathFrom(text) : null
    return path ? <FileChip path={path} /> : <code className={className}>{text}</code>
  },
  img: ({ alt }) => <span className="delivery-image-reference">[Image: {alt || 'reference'}]</span>,
}
