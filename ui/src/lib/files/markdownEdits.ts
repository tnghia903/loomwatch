/**
 * Changing a Markdown file where it is drawn (ADR 0107): a paragraph, a heading or a list item is
 * typed into in place, and the change goes back into the file's own words, nothing else touched.
 *
 * The file is drawn from its own text for this, with [`sourceSpans`] in the drawing: each run of
 * words the file spells out as it is drawn sits in a `span` that says where it is in the text
 * (`data-lw-src="start-end"`), and each block that can be typed into says where its words are
 * (`data-lw-block`). When a block is left, [`blockChange`] compares it with the copy taken when it
 * was entered ([`blockShape`]): words changed inside those runs go back into their own places,
 * escaped so they read as words; a block whose shape changed (a run deleted whole, words typed
 * between them) is written out again as Markdown in its words' place, so its markers stay.
 */

/** A change to the file's text: the characters `start` to `end` become `text`. */
export interface SourceEdit {
  start: number
  end: number
  text: string
}

/** Blocks typed into: one line of words each, as the file has them. */
const EDITABLE_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'])
/** What a list item that is typed into holds: words, not a list or paragraphs of its own. */
const INLINE = new Set(['strong', 'em', 'code', 'a', 'del', 'br', 'span', 'b', 'i', 's'])

interface Position { start?: { offset?: number }; end?: { offset?: number } }
interface HastText { type: 'text'; value: string; position?: Position }
interface HastElement { type: 'element'; tagName: string; properties?: Record<string, unknown>; children: HastNode[]; position?: Position }
type HastNode = HastText | HastElement | { type: string; position?: Position; children?: HastNode[] }

function offsets(node: { position?: Position }): [number, number] | null {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  return typeof start === 'number' && typeof end === 'number' ? [start, end] : null
}

/**
 * A rehype plugin for drawing `source` to be typed into: runs of words in their own spans, and the
 * blocks that can be typed into marked with where their words are. Code is left as it is.
 */
export function sourceSpans(source: string) {
  return () => (tree: { children: HastNode[] }) => {
    const visit = (parent: { children?: HastNode[] }, inCode: boolean) => {
      parent.children = (parent.children ?? []).map((node) => {
        if (node.type === 'text' && !inCode) {
          const at = offsets(node)
          const value = (node as HastText).value
          if (!at || source.slice(at[0], at[1]) !== value || value.trim() === '') return node
          return { type: 'element', tagName: 'span', properties: { dataLwSrc: `${at[0]}-${at[1]}` }, children: [node] }
        }
        if (node.type !== 'element') return node
        const element = node as HastElement
        visit(element, inCode || element.tagName === 'code' || element.tagName === 'pre')
        const range = EDITABLE_BLOCKS.has(element.tagName) && !inCode ? wordsRange(element) : null
        if (range) element.properties = { ...element.properties, dataLwBlock: `${range[0]}-${range[1]}` }
        return element
      })
    }
    visit(tree, false)
  }
}

/** Where a block's words are in the file: from its first word to its last, all of them placed. */
function wordsRange(block: HastElement): [number, number] | null {
  const children = block.children.filter((child) => !(child.type === 'text' && (child as HastText).value.trim() === ''))
  if (!children.length) return null
  if (block.tagName === 'li' && children.some((child) => child.type === 'element' && !INLINE.has((child as HastElement).tagName))) return null
  const placed = children.map((child) => (child.type === 'element' && (child as HastElement).tagName === 'span' && (child as HastElement).properties?.dataLwSrc
    ? offsets((child as HastElement).children[0]) : offsets(child)))
  if (placed.some((at) => at === null)) return null
  const all = placed as Array<[number, number]>
  return [Math.min(...all.map(([start]) => start)), Math.max(...all.map(([, end]) => end))]
}

/** Words as Markdown reads them: its marks escaped, so they stay words. */
export function asWords(text: string): string {
  return text.replace(/[\\*_`[\]<]/g, (mark) => `\\${mark}`)
}

/** A block's shape: its HTML with the words of each run taken out. */
export function blockShape(block: Element): string {
  const copy = block.cloneNode(true) as Element
  for (const run of copy.querySelectorAll('[data-lw-src]')) run.textContent = ''
  return copy.innerHTML
}

/**
 * What leaving `block` changes in `source`, given its shape when it was entered; `null` when its
 * words are as they were, or when it can't say where they go.
 */
export function blockChange(block: Element, shapeBefore: string, source: string): SourceEdit[] | null {
  const runs = [...block.querySelectorAll<HTMLElement>('[data-lw-src]')]
  if (blockShape(block) === shapeBefore) {
    const edits = runs.flatMap((run) => {
      const at = rangeOf(run.dataset.lwSrc)
      if (!at) return []
      const was = source.slice(at[0], at[1])
      const words = asTyped(run.textContent ?? '', was)
      return was !== words ? [{ start: at[0], end: at[1], text: asWords(words) }] : []
    })
    return edits.length ? edits : null
  }
  const at = rangeOf((block as HTMLElement).dataset?.lwBlock)
  if (!at) return null
  const was = source.slice(at[0], at[1])
  const text = asTyped(inlineMarkdown(block).replace(/\s*\n\s*/g, ' ').trim(), was)
  return text === was ? null : [{ start: at[0], end: at[1], text }]
}

/**
 * Words as typed, without the no-break spaces a browser puts in typed words so their spaces show
 * while they are typed into (a space at the end, or beside a part taken out): a space is a space in
 * the file, unless the words there had a no-break space of their own.
 */
function asTyped(words: string, was: string): string {
  return was.includes('\u00a0') ? words : words.replace(/\u00a0/g, ' ')
}

function rangeOf(value: string | undefined): [number, number] | null {
  const match = /^(\d+)-(\d+)$/.exec(value ?? '')
  return match ? [Number(match[1]), Number(match[2])] : null
}

/** A block's words written out as Markdown: bold, slanted, code, links and struck words kept. */
export function inlineMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return asWords(node.textContent ?? '')
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const element = node as Element
  const inner = () => [...element.childNodes].map(inlineMarkdown).join('')
  switch (element.tagName.toLowerCase()) {
    case 'strong': case 'b': return wrapped('**', inner())
    case 'em': case 'i': return wrapped('*', inner())
    case 'del': case 's': return wrapped('~~', inner())
    case 'code': return codeSpan(element.textContent ?? '')
    case 'a': {
      const href = element.getAttribute('href')
      return href ? `[${inner()}](${href.replace(/[()\s]/g, (mark) => encodeURIComponent(mark))})` : inner()
    }
    case 'br': return ' '
    default: return inner()
  }
}

/** Words between a mark, the spaces at their edges left outside it, as Markdown wants. */
function wrapped(mark: string, words: string): string {
  const match = /^(\s*)(.*?)(\s*)$/s.exec(words)
  if (!match || !match[2]) return words
  return `${match[1]}${mark}${match[2]}${mark}${match[3]}`
}

function codeSpan(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${code}${pad}${fence}`
}

/** `source` with `edits` made, which never overlap. */
export function applyEdits(source: string, edits: readonly SourceEdit[]): string {
  return [...edits].sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)
}
