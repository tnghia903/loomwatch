import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps, type UrlTransform } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'

import { useContext, useMemo, useState, type ComponentProps } from 'react'
import { sourceSpans } from '../../lib/files/markdownEdits'
import { BACKED, CLAIM_MARK } from '../../lib/chat/claims'
import { withoutCitationMarks } from '../../lib/chat/citationMarks'
import { withMathMarks } from '../../lib/chat/mathMarks'
import { segments, useFoundWords, type FindTerm } from '../../lib/chat/findWords'
import { filePathFrom, filePathFromLink } from '../../lib/files/fileRefs'
import { FileChip } from './FileChip'
import { MarkdownPictures } from './markdownPictures'
import { SaidMention, type SaidMarks } from './saidMention'

/**
 * The real Markdown renderer, shown by [`Markdown`](./Markdown.tsx). Its own download
 * (markdownCode.ts), fetched beside the app's first draw: the unified / micromark stack is the
 * largest dependency in the app, and the page draws before it is in.
 *
 * Raw HTML is skipped and pictures on the web are never fetched — a report is untrusted model
 * output, and an embedded `<img src>` is a tracking pixel the operator never agreed to load. A
 * picture on this computer is shown where the screen says where it is ([`MarkdownPictures`]: the
 * reader, for the pictures beside the file it reads), through LoomWatch itself; anywhere else a
 * picture is its words.
 *
 * A file the reply names — an absolute path in inline code, a link to one, or a `file://` URL — is
 * shown as a file the operator can open (FileChip, ADR 0026), not as a path to copy by hand. Fenced
 * code is left alone: a path inside a code block is code. A link to a file named from somewhere this
 * page cannot know (`./guide.html`) reads as its words: opened here it would only load LoomWatch
 * again, in a new tab.
 *
 * Research answers mark each claim and cite it: "[Sourced] … [Paper](https://…)". The mark reads
 * as a small tag and the links after the claim as its sources, not as bracketed text and a run of
 * underlined titles. The private citation marks a ChatGPT model wrote into answers saved before the
 * daemon took them out are dropped ([`withoutCitationMarks`]).
 *
 * `inline` keeps it inside a sentence: bold, code and links are shown, and a paragraph, heading or
 * list is kept as its words. With `clickable={false}` as well, a link is its words and a file path
 * stays code: for a quote cut short, where a hidden link would still take the Tab key.
 *
 * Math is typeset (KaTeX) in whichever of its usual spellings the model wrote it: `$$…$$`,
 * `\[…\]` or `\(…\)` ([`withMathMarks`]). A single `$` is a price, not math: "$1,000 at 5%".
 *
 * `said` is for words a person typed in the chat: a line they broke stays broken, as they see it in
 * the box they typed in, and each @mention `said.find` names in the words is drawn by the
 * [`SaidMention`] around it (the agent's chip).
 */
export default function MarkdownRenderer({ children, inline = false, clickable = true, said = null }: { children: string; inline?: boolean; clickable?: boolean; said?: SaidMarks | null }) {
  // The words a chat search found, while the chat shows where one was said (ADR 0081).
  const found = useFoundWords()
  const rehype = useMemo(() => {
    const plugins = [...(inline ? REHYPE_PLUGINS : REHYPE_MATH_PLUGINS)]
    if (said) plugins.push(() => (tree: { children: HastChild[] }) => markSaid(tree, said))
    if (found) plugins.push(() => (tree: { children: HastChild[] }) => markFound(tree, found))
    return plugins
  }, [found, inline, said])
  return (
    <ReactMarkdown remarkPlugins={inline ? REMARK_PLUGINS : REMARK_MATH_PLUGINS} rehypePlugins={rehype} skipHtml urlTransform={urlTransform} components={clickable ? COMPONENTS : WORDS_ONLY} allowedElements={inline ? (clickable ? INLINE_ELEMENTS : INLINE_WORDS) : undefined} unwrapDisallowed={inline}>
      {inline ? numbersAsWords(withoutCitationMarks(children)) : withMathMarks(withoutCitationMarks(children))}
    </ReactMarkdown>
  )
}

/**
 * A person's words, as they typed them: a line break inside a paragraph is kept, and each @mention
 * becomes a `span` the components draw with [`SaidMention`]. Code is left as it is.
 */
function markSaid(tree: { children: HastChild[] }, said: SaidMarks) {
  const visit = (parent: { children: HastChild[] }) => {
    parent.children = parent.children.flatMap((node): HastChild[] => {
      if (node.type === 'element') {
        if (node.tagName !== 'pre' && node.tagName !== 'code') visit(node)
        return [node]
      }
      // Only words carry a person's line breaks: the line breaks between a paragraph and a list,
      // or between two items, are the renderer's own.
      if (node.type !== 'text' || node.value.trim() === '') return [node]
      return node.value.split('\n').flatMap((line, index, lines): HastChild[] => {
        const parts: HastChild[] = []
        let at = 0
        for (const mention of said.find(line)) {
          const from = Math.max(at, Math.min(mention.from ?? mention.start, mention.start))
          const until = Math.max(mention.end, mention.until ?? mention.end)
          if (from > at) parts.push({ type: 'text', value: line.slice(at, from) })
          const chip: HastChild = { type: 'element', tagName: 'span', properties: { className: ['md-said-mention'], dataAgent: mention.agent ?? '' }, children: [{ type: 'text', value: line.slice(mention.start, mention.end) }] }
          // The words touching a mention stay on its line with it.
          const kept: HastChild[] = [
            ...(from < mention.start ? [{ type: 'text' as const, value: line.slice(from, mention.start) }] : []),
            chip,
            ...(until > mention.end ? [{ type: 'text' as const, value: line.slice(mention.end, until) }] : []),
          ]
          parts.push(kept.length > 1 ? { type: 'element', tagName: 'span', properties: { className: ['md-said-keep'] }, children: kept } : chip)
          at = until
        }
        if (at < line.length) parts.push({ type: 'text', value: line.slice(at) })
        return index < lines.length - 1 ? [...parts, { type: 'element', tagName: 'br', properties: {}, children: [] }] : parts
      })
    })
  }
  visit(tree)
}

/**
 * Inside a sentence a list is kept as its words, and a numbered item's number is no word of its
 * own: "2025." alone would read as nothing. So a number that would start a list stays a number.
 */
function numbersAsWords(text: string): string {
  return text.replace(/^( {0,3})(\d{1,9})([.)])(?=\s|$)/gm, '$1$2\\$3')
}

/** A span, or a person's @mention drawn as [`SaidMention`] says. Typeset math keeps its own style and roles. */
function Span({ children, node, ...rest }: ComponentProps<'span'> & ExtraProps) {
  const { className, title } = rest
  const draw = useContext(SaidMention)
  if (className === 'md-said-mention' && draw) {
    const agent = String(node?.properties.dataAgent ?? '')
    const text = node?.children.map((child) => (child.type === 'text' ? child.value : '')).join('') ?? ''
    return <>{draw(agent || undefined, text)}</>
  }
  if (typeof className === 'string' && className.includes('katex')) return <span {...rest}>{children}</span>
  return <span className={className} title={title}>{children}</span>
}

/**
 * A picture's link reaches [`Picture`] as it was written (`file:///…`, `C:\…`), which only ever
 * hands it to [`MarkdownPictures`]; every other link is made safe as usual.
 */
const urlTransform: UrlTransform = (url, key, node) => (node.tagName === 'img' && key === 'src' ? url : defaultUrlTransform(url))

/** A picture, shown from where [`MarkdownPictures`] says it is; its words where it says none, or it can't be shown. */
function Picture({ src, alt }: { src?: string; alt?: string }) {
  const where = useContext(MarkdownPictures)
  const shown = src && where ? where(src) : null
  const [failed, setFailed] = useState<string | null>(null)
  if (!shown || failed === shown) return <span className="delivery-image-reference">[Image: {alt || 'reference'}]</span>
  return <img className="md-picture" src={shown} alt={alt ?? ''} onError={() => setFailed(shown)} />
}

const REMARK_PLUGINS = [remarkGfm]
const REMARK_MATH_PLUGINS = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]] as NonNullable<ComponentProps<typeof ReactMarkdown>['remarkPlugins']>
const REHYPE_PLUGINS = [() => markClaimsAndSources]
const REHYPE_MATH_PLUGINS = [[rehypeKatex, { throwOnError: false, strict: 'ignore' }], ...REHYPE_PLUGINS] as NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']>
// What stays inside a sentence, the claim tag and found words included: everything else is
// replaced by its words.
const INLINE_ELEMENTS = ['a', 'strong', 'em', 'del', 'code', 'br', 'img', 'span', 'mark']
const INLINE_WORDS = INLINE_ELEMENTS.filter((tag) => tag !== 'a')

type HastElement = NonNullable<ExtraProps['node']>
type HastChild = HastElement['children'][number]

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

/** Every word a search found, in a `<mark>`; code is left as it is. */
function markFound(tree: { children: HastChild[] }, terms: readonly FindTerm[]) {
  const visit = (parent: { children: HastChild[] }) => {
    parent.children = parent.children.flatMap((node): HastChild[] => {
      if (node.type === 'element') {
        // Code is left whole: a path in inline code is shown as a file to open.
        if (node.tagName !== 'pre' && node.tagName !== 'code') visit(node)
        return [node]
      }
      if (node.type !== 'text') return [node]
      const parts = segments(node.value, terms)
      if (!parts.some((part) => part.hit)) return [node]
      return parts.map((part): HastChild => (part.hit
        ? { type: 'element', tagName: 'mark', properties: { className: ['tc-find-hit'] }, children: [{ type: 'text', value: part.text }] }
        : { type: 'text', value: part.text }))
    })
  }
  visit(tree)
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
  img: Picture,
  span: Span,
}
// Nothing to click: inline code stays code, a path in it too.
const WORDS_ONLY: Components = { ...COMPONENTS, code: ({ children: text, className }) => <code className={className}>{text}</code> }

/**
 * A Markdown file drawn from its own words to be typed into in place (ADR 0107;
 * components/reader/Draft.tsx). Each paragraph, heading and list item whose words are placed in the
 * file can be typed into, its runs of words saying where they are in it (lib/files/markdownEdits.ts).
 * A link is its words here, and a path is code: nothing opens while you write. Pictures show as
 * when reading.
 */
export function EditableMarkdown({ source }: { source: string }) {
  const rehype = useMemo(() => [sourceSpans(source)], [source])
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehype} skipHtml urlTransform={urlTransform} components={TYPED_INTO}>
      {source}
    </ReactMarkdown>
  )
}

/** A block that can be typed into when its words are placed in the file (`data-lw-block`). */
function typedInto(tag: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'li') {
  return function TypedInto(props: ExtraProps) {
    const { node, ...rest } = props
    void node
    const placed = 'data-lw-block' in rest
    // Drawn as `tag`, with the props the Markdown gives it.
    const Tag = tag as 'p'
    return <Tag {...(rest as ComponentProps<'p'>)} {...(placed ? { contentEditable: true, suppressContentEditableWarning: true } : {})} />
  }
}

// Module-level, as COMPONENTS is.
const TYPED_INTO: Components = {
  p: typedInto('p'), h1: typedInto('h1'), h2: typedInto('h2'), h3: typedInto('h3'), h4: typedInto('h4'), h5: typedInto('h5'), h6: typedInto('h6'), li: typedInto('li'),
  a: ({ children: label, href }) => <a href={href} onClick={(event) => event.preventDefault()}>{label}</a>,
  img: Picture,
}
