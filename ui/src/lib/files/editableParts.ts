import type { Element as DeckElement } from 'pptxtojson'

import { PARAGRAPH_MARK } from './officeEdits'
import { DARK_LOOK, lookOf, type PageLook } from './pageLook'
import type { ParsedDeck } from './slidesPage'

/**
 * A deck or a Word document drawn to be typed into (ADR 0107, "Make changes"): each paragraph whose
 * words can go back into the file is typed into where it is drawn (`contenteditable`), named by
 * what it is in the file (`data-lw-edit`, officeEdits.ts `EditPart`). The page's own script
 * (pageFrame.ts `PAGE_BRIDGE`) says what changed when a part is left. A paragraph is offered only
 * when its words, as drawn, are its words in the file, so what is typed is what is written: one
 * drawn otherwise (a deck's tab or line break, which `pptxtojson` draws as spaces) is drawn again
 * from the file's words in its first words' look, and one that still differs is left alone.
 */

/** Marks the whole page as drawn for typing into: the page's script then keeps the Pick switch off. */
export const EDITING_ATTRIBUTE = 'data-lw-editing'

/**
 * The words of a part as the page reads them when it is left (pageFrame.ts `PAGE_BRIDGE`, `wordsOf`;
 * keep the two alike): its text, a line break as a new line, a tab drawn as one (`data-lw-tab`) as a
 * tab; the reader's own bubbles in it left out. A line break the part ends on is the browser's own,
 * which it adds so an empty last line shows, and is not one of the words.
 */
export function wordsIn(part: Element): string {
  let words = ''
  let last: Node | null = null
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) { words += (child as Text).data; if ((child as Text).data) last = child; continue }
      if (child.nodeType !== 1) continue
      const element = child as Element
      if (element.classList.contains('lw-slot')) continue
      if (element.localName === 'br') { words += '\n'; last = element; continue }
      if (element.hasAttribute('data-lw-tab')) { words += '\t'; last = element; continue }
      walk(element)
    }
  }
  walk(part)
  return last && (last as Element).localName === 'br' ? words.slice(0, -1) : words
}

/**
 * How the parts that can be typed into look (in the page's own colours, as the page has none of the
 * reader's): a faint line round one pointed at, and round the one typed in a gold edge on a tint of
 * gold, drawn outside its words so nothing moves. On a slide, whatever its size on screen, the line
 * keeps its width; on a dark slide, the gold that shows on it.
 */
export function editingStyle(look: PageLook): string {
  const shown = lookOf(look)
  const edge = (width: number) => `calc(${width}px / var(--lw-k, 1))`
  return [
    '[data-lw-edit]{outline:1px solid transparent;outline-offset:3px;border-radius:2px;cursor:text}',
    '@media (prefers-reduced-motion:no-preference){[data-lw-edit]{transition:outline-color .09s ease,background-color .09s ease}}',
    // On the paper of a slide or a page: dark lines, the paper's gold.
    '[data-lw-edit]:hover{outline-color:rgba(0,0,0,.28)}',
    `[data-lw-edit]:focus{outline:2px solid ${shown.paperAccent};background-color:color-mix(in srgb,${shown.paperAccent} 9%,transparent)}`,
    `.lw-canvas [data-lw-edit]{outline-width:${edge(1)};outline-offset:${edge(3)}}`,
    `.lw-canvas [data-lw-edit]:focus{outline-width:${edge(2)}}`,
    '.lw-canvas.lw-dark-slide [data-lw-edit]:hover{outline-color:rgba(255,255,255,.45)}',
    `.lw-canvas.lw-dark-slide [data-lw-edit]:focus{outline-color:${DARK_LOOK.accent};background-color:color-mix(in srgb,${DARK_LOOK.accent} 12%,transparent)}`,
    // A paragraph with no words yet keeps a line's room, to be typed into.
    '.lw-blank{min-height:1.2em}',
    // The notes, on the reader's own ground: its words and its gold.
    '.lw-note-lines{display:flex;flex-direction:column;gap:6px}',
    `.lw-note{margin:0;padding:2px 4px;min-height:1.55em;white-space:pre-wrap;overflow-wrap:anywhere;color:${shown.ink}}`,
    `.lw-note:hover{outline-color:color-mix(in srgb,${shown.ink} 28%,transparent)}`,
    `.lw-note:focus{outline-color:${shown.accent};background-color:color-mix(in srgb,${shown.accent} 8%,transparent)}`,
  ].join('')
}

/** The part of a slide a drawn part's key names (slidesPage.ts `partsOf`): its place among the slide's parts, a group's by its place in the group. */
function elementAt(elements: readonly DeckElement[], key: string): DeckElement | null {
  let found: DeckElement | null = null
  let list: readonly DeckElement[] = elements
  for (const step of key.split('.')) {
    found = list[Number(step)] ?? null
    if (!found || !/^\d+$/.test(step)) return null
    list = found.type === 'group' || found.type === 'diagram' ? found.elements : []
  }
  return found
}

/** A paragraph drawn again from the file's words, in the look of its first words. */
function sayAgain(paragraph: Element, words: string): void {
  const doc = paragraph.ownerDocument
  const look = paragraph.querySelector('span')?.getAttribute('style')
  const span = doc.createElement('span')
  if (look) span.setAttribute('style', look)
  words.split('\n').forEach((line, index) => {
    if (index > 0) span.appendChild(doc.createElement('br'))
    if (line) span.appendChild(doc.createTextNode(line))
  })
  if (words.endsWith('\n')) span.appendChild(doc.createElement('br'))
  paragraph.replaceChildren(span)
}

function offer(paragraph: Element, part: string, words: string): void {
  paragraph.setAttribute('contenteditable', 'true')
  paragraph.setAttribute('data-lw-edit', part)
  if (!words) paragraph.classList.add('lw-blank')
}

/** The page drawn for typing into: its look for the parts that can be, and the whole page marked as such. */
function editingPage(doc: Document, look: PageLook): void {
  doc.documentElement.setAttribute(EDITING_ATTRIBUTE, '')
  const style = doc.createElement('style')
  style.textContent = editingStyle(look)
  doc.head.appendChild(style)
}

/**
 * A drawn deck (slidesPage.ts) made to be typed into: each paragraph of each box of words on a
 * slide, by the box's id (`shapes`, officeEdits.ts `deckShapes`). A box whose paragraphs the
 * drawing doesn't have one for one, or whose id is on more than one box, is left as it is; so are
 * tables, charts and pictures, and what a slide takes from its layout.
 */
export function editableDeck(html: string, deck: ParsedDeck, shapes: ReadonlyArray<ReadonlyMap<string, ReadonlyArray<string | null>>>, look: PageLook): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('section.lw-slide').forEach((section, index) => {
    const slide = deck.slides[index]
    const file = shapes[index]
    if (!slide || !file) return
    const boxes = new Map<string, Element[]>()
    for (const drawn of Array.from(section.querySelectorAll('.lw-canvas div[data-lw-part]'))) {
      const element = elementAt(slide.elements ?? [], drawn.getAttribute('data-lw-part') ?? '')
      if (!element || (element.type !== 'text' && element.type !== 'shape') || !/^\d+$/.test(String(element.id ?? ''))) continue
      boxes.set(element.id, [...(boxes.get(element.id) ?? []), drawn])
    }
    for (const [id, drawn] of boxes) {
      const said = file.get(id)
      const paragraphs = drawn.length === 1 ? Array.from(drawn[0].querySelectorAll('p')) : []
      if (!said || paragraphs.length !== said.length) continue
      paragraphs.forEach((paragraph, at) => {
        const words = said[at]
        if (words === null || words === undefined) return
        if (wordsIn(paragraph).replace(/ /g, ' ') !== words) sayAgain(paragraph, words)
        if (wordsIn(paragraph) === words) offer(paragraph, `shape:${index}:${id}:${at}`, words)
      })
    }
  })
  editingPage(doc, look)
  return `<!doctype html>\n${doc.documentElement.outerHTML}`
}

/** A tab as `docx-preview` draws it: a wide space in a span of its own, in its run's. */
function isTab(span: Element): boolean {
  return span.attributes.length === 0 && span.childNodes.length === 1 && span.firstChild?.nodeType === 3 && span.textContent === ' ' && span.parentElement?.localName === 'span'
}

/**
 * A Word document drawn by `docx-preview` from a copy with each paragraph's mark in it
 * (officeEdits.ts `withParagraphMarks`), made to be typed into where its words (`words`) are drawn
 * as they are: each paragraph by its number, its tabs kept whole. The marks are taken out. A
 * paragraph drawn in two pieces (a page break inside it) is left as it is.
 */
export function editableDocument(root: Element, words: ReadonlyArray<string | null>): void {
  const found = new Map<number, Element[]>()
  for (const mark of Array.from(root.querySelectorAll(`span[id^="${PARAGRAPH_MARK}"]`))) {
    const index = Number(mark.id.slice(PARAGRAPH_MARK.length))
    const paragraph = mark.closest('p')
    mark.remove()
    if (paragraph && Number.isSafeInteger(index)) found.set(index, [...(found.get(index) ?? []), paragraph])
  }
  for (const [index, paragraphs] of found) {
    const said = words[index]
    if (paragraphs.length !== 1 || said === null || said === undefined) continue
    const paragraph = paragraphs[0]
    const tabs = Array.from(paragraph.querySelectorAll('span')).filter(isTab)
    for (const tab of tabs) { tab.setAttribute('data-lw-tab', ''); tab.setAttribute('contenteditable', 'false') }
    if (wordsIn(paragraph) === said) offer(paragraph, `para:${index}`, said)
    else for (const tab of tabs) { tab.removeAttribute('data-lw-tab'); tab.removeAttribute('contenteditable') }
  }
}
