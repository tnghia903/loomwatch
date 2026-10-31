import JSZip from 'jszip'

import { A, asTyped, P, paragraphWords, readXml, serialized, slidePaths, textParagraphs, withNote, writeParagraph } from './deckNotes'

/**
 * Changing the words of a deck or a Word document where the reader draws it (ADR 0107): a part
 * typed into is named by what it is in the file (`EditPart`), and its words go back into that one
 * paragraph, keeping its settings and how its first words were formatted. Nothing else in the file
 * changes: the other paragraphs, the pictures, the other parts of the zip.
 *
 * A paragraph is offered to type into only when its words are all there is to it: words, line
 * breaks and tabs. One holding a link, a field (a slide number, a date), a picture, a footnote or a
 * tracked change would lose it when written again, so it is drawn as it is and left alone.
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const XML = 'http://www.w3.org/XML/1998/namespace'
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const DOCUMENT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'

/**
 * A part of a deck or a Word document typed into, as the drawn page names it (`data-lw-edit`):
 * `note:<slide>:<paragraph>` a paragraph of a slide's speaker notes; `shape:<slide>:<shape id>:<paragraph>`
 * a paragraph of a box of words on a slide, the box by its id in the slide (`p:cNvPr id`);
 * `para:<paragraph>` a paragraph of a Word document's body (`documentParagraphs`). All from 0 but
 * the shape's id.
 */
export type EditPart =
  | { kind: 'note'; slide: number; paragraph: number }
  | { kind: 'shape'; slide: number; shape: string; paragraph: number }
  | { kind: 'para'; paragraph: number }

/** The part a page's `data-lw-edit` names; `null` for anything else. */
export function editPart(part: string): EditPart | null {
  let match = /^note:(\d{1,6}):(\d{1,6})$/.exec(part)
  if (match) return { kind: 'note', slide: Number(match[1]), paragraph: Number(match[2]) }
  match = /^shape:(\d{1,6}):(\d{1,12}):(\d{1,6})$/.exec(part)
  if (match) return { kind: 'shape', slide: Number(match[1]), shape: match[2], paragraph: Number(match[3]) }
  match = /^para:(\d{1,7})$/.exec(part)
  return match ? { kind: 'para', paragraph: Number(match[1]) } : null
}

/**
 * The file changed by what was typed into `part`: a deck's (`slides`) or a Word document's
 * (`document`) bytes, or `null` when nothing changed or the file has no such part to change.
 */
export async function officeEdit(kind: 'slides' | 'document', bytes: ArrayBuffer | Uint8Array, part: string, words: string): Promise<Uint8Array | null> {
  return kind === 'slides' ? deckEdit(bytes, part, words) : documentEdit(bytes, part, words)
}

// ——— Decks ———

/** A slide's own boxes of words (`p:sp`), each once: a box whose id another shares is no one box. */
function slideShapes(slide: Document): Map<string, Element> {
  const found = new Map<string, Element | null>()
  for (const shape of Array.from(slide.getElementsByTagNameNS(P, 'sp'))) {
    const id = Array.from(shape.getElementsByTagNameNS(P, 'cNvPr'))[0]?.getAttribute('id')
    if (!id) continue
    found.set(id, found.has(id) ? null : shape)
  }
  return new Map([...found].flatMap(([id, shape]) => (shape ? [[id, shape] as [string, Element]] : [])))
}

/** A box's paragraphs: those of its own words (`p:txBody`), not a table's or a group's. */
function shapeParagraphs(shape: Element): Element[] {
  const body = Array.from(shape.children).find((child) => child.namespaceURI === P && child.localName === 'txBody')
  return body ? textParagraphs(body) : []
}

/** Whether a slide paragraph is words alone: runs and line breaks, no field and no link. */
function plainSlideParagraph(paragraph: Element): boolean {
  return Array.from(paragraph.children).every((child) => child.namespaceURI === A && (
    ['pPr', 'endParaRPr', 'br'].includes(child.localName)
    || (child.localName === 'r' && !child.getElementsByTagNameNS(A, 'hlinkClick').length && !child.getElementsByTagNameNS(A, 'hlinkMouseOver').length)))
}

/**
 * The words of each slide's boxes, in the order the slides are drawn, by each box's id: its
 * paragraphs' words, or `null` for a paragraph that is more than words (`plainSlideParagraph`).
 */
export async function deckShapes(bytes: ArrayBuffer | Uint8Array): Promise<Array<Map<string, Array<string | null>>>> {
  const zip = await JSZip.loadAsync(bytes)
  return Promise.all((await slidePaths(zip)).map(async (path) => {
    const slide = await readXml(zip, path)
    const shapes = new Map<string, Array<string | null>>()
    if (!slide) return shapes
    for (const [id, shape] of slideShapes(slide.doc)) {
      const paragraphs = shapeParagraphs(shape)
      if (paragraphs.length) shapes.set(id, paragraphs.map((paragraph) => (plainSlideParagraph(paragraph) ? paragraphWords(paragraph) : null)))
    }
    return shapes
  }))
}

/**
 * The deck with a part of a slide saying `words`: a paragraph of its notes (`withNote`), or of one
 * of its boxes of words, the box found by its id in the slide; `null` when it says that already, or
 * the deck has no such paragraph to change.
 */
export async function deckEdit(bytes: ArrayBuffer | Uint8Array, part: string, words: string): Promise<Uint8Array | null> {
  const at = editPart(part)
  if (at?.kind === 'note') return withNote(bytes, at.slide, at.paragraph, words)
  if (at?.kind !== 'shape') return null
  const zip = await JSZip.loadAsync(bytes)
  const path = (await slidePaths(zip))[at.slide]
  const slide = path ? await readXml(zip, path) : null
  const shape = slide ? slideShapes(slide.doc).get(at.shape) : undefined
  const target = shape ? shapeParagraphs(shape)[at.paragraph] : undefined
  if (!path || !slide || !target || !plainSlideParagraph(target)) return null
  const was = paragraphWords(target)
  const said = asTyped(words, was)
  if (said === was) return null
  writeParagraph(slide.doc, target, said)
  zip.file(path, serialized(slide.doc, slide.text))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

// ——— Word documents ———

/** Where a Word document keeps its body: the part its package names, `word/document.xml` as a rule. */
async function documentPath(zip: JSZip): Promise<string> {
  const rels = await readXml(zip, '_rels/.rels')
  const target = rels ? Array.from(rels.doc.getElementsByTagNameNS(RELS, 'Relationship')).find((each) => each.getAttribute('Type') === DOCUMENT)?.getAttribute('Target') : null
  const path = target?.replace(/^\//, '')
  return path && zip.file(path) ? path : 'word/document.xml'
}

const inW = (node: Element, name: string) => node.namespaceURI === W && node.localName === name

/**
 * A Word document's paragraphs, as the reader numbers them (`para:<n>`): every paragraph of its
 * body in the order it reads, those in tables and content controls included, those in a text box
 * not (they belong to a drawing). Headers, footers and footnotes are parts of their own: never
 * among them.
 */
function bodyParagraphs(doc: Document): Element[] {
  const body = Array.from(doc.getElementsByTagNameNS(W, 'body'))[0]
  if (!body) return []
  return Array.from(body.getElementsByTagNameNS(W, 'p')).filter((paragraph) => {
    for (let at = paragraph.parentElement; at && at !== body; at = at.parentElement) if (inW(at, 'txbxContent')) return false
    return true
  })
}

/** What a run of words may hold to be words alone: its look, words, tabs, line breaks, and where Word last broke the page. */
const PLAIN_RUN = new Set(['rPr', 't', 'tab', 'br', 'lastRenderedPageBreak'])
/** And a paragraph: its settings, runs, and marks that hold nothing (a spelling mark, a bookmark). */
const PLAIN_PARAGRAPH = new Set(['pPr', 'r', 'proofErr', 'bookmarkStart', 'bookmarkEnd'])

/** Whether a Word paragraph is words alone, so that writing its words again loses nothing. */
function plainWordParagraph(paragraph: Element): boolean {
  return Array.from(paragraph.children).every((child) => child.namespaceURI === W && PLAIN_PARAGRAPH.has(child.localName) && (
    child.localName !== 'r' || Array.from(child.children).every((inside) => inside.namespaceURI === W && PLAIN_RUN.has(inside.localName)
      // A page or column break starts a page: it is more than a line.
      && (inside.localName !== 'br' || !['page', 'column'].includes(inside.getAttributeNS(W, 'type') ?? inside.getAttribute('w:type') ?? '')))))
}

/** A Word paragraph's words: a tab as a tab, a line break as a new line. */
function wordParagraphWords(paragraph: Element): string {
  return Array.from(paragraph.children).filter((child) => inW(child, 'r')).map((run) => Array.from(run.children).map((inside) => {
    if (inW(inside, 't')) return inside.textContent ?? ''
    if (inW(inside, 'tab')) return '\t'
    if (inW(inside, 'br')) return '\n'
    return ''
  }).join('')).join('')
}

/** Each of a Word document's paragraphs' words (`bodyParagraphs`), or `null` for one that is more than words. */
export async function documentParagraphs(bytes: ArrayBuffer | Uint8Array): Promise<Array<string | null>> {
  const zip = await JSZip.loadAsync(bytes)
  const document = await readXml(zip, await documentPath(zip))
  return document ? bodyParagraphs(document.doc).map((paragraph) => (plainWordParagraph(paragraph) ? wordParagraphWords(paragraph) : null)) : []
}

/** The name of the mark a paragraph is drawn with, for the drawn page to find it by (`withParagraphMarks`). */
export const PARAGRAPH_MARK = '_lw_para_'

/**
 * A copy of a Word document to draw for typing into, and each paragraph's words: a bookmark named
 * for its number (`PARAGRAPH_MARK`) at the start of each paragraph that is words alone, which
 * `docx-preview` draws as an empty `span` with that id inside the paragraph, wherever it lays it
 * out (a table cell, a list, a page of its own). The copy is drawn and never written.
 */
export async function withParagraphMarks(bytes: ArrayBuffer | Uint8Array): Promise<{ bytes: Uint8Array; words: Array<string | null> }> {
  const zip = await JSZip.loadAsync(bytes)
  const path = await documentPath(zip)
  const document = await readXml(zip, path)
  if (!document) return { bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), words: [] }
  const words = bodyParagraphs(document.doc).map((paragraph, index) => {
    if (!plainWordParagraph(paragraph)) return null
    const prefix = paragraph.prefix ? `${paragraph.prefix}:` : ''
    const mark = document.doc.createElementNS(W, `${prefix}bookmarkStart`)
    mark.setAttributeNS(W, `${prefix}id`, String(900_000_000 + index))
    mark.setAttributeNS(W, `${prefix}name`, `${PARAGRAPH_MARK}${index}`)
    const settings = Array.from(paragraph.children).find((child) => inW(child, 'pPr'))
    paragraph.insertBefore(mark, settings ? settings.nextSibling : paragraph.firstChild)
    return wordParagraphWords(paragraph)
  })
  zip.file(path, serialized(document.doc, document.text))
  return { bytes: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), words }
}

/**
 * The Word document with paragraph `para:<n>` of its body saying `words`: its settings kept, its
 * runs said again as one run in the look of its first, a tab as a tab and a new line as a line
 * break; its bookmarks kept where they were. `null` when it says that already, or the document has
 * no such paragraph that is words alone.
 */
export async function documentEdit(bytes: ArrayBuffer | Uint8Array, part: string, words: string): Promise<Uint8Array | null> {
  const at = editPart(part)
  if (at?.kind !== 'para') return null
  const zip = await JSZip.loadAsync(bytes)
  const path = await documentPath(zip)
  const document = await readXml(zip, path)
  const target = document ? bodyParagraphs(document.doc)[at.paragraph] : undefined
  if (!document || !target || !plainWordParagraph(target)) return null
  const was = wordParagraphWords(target)
  const said = asTyped(words, was)
  if (said === was) return null
  const doc = document.doc
  const prefix = target.prefix ? `${target.prefix}:` : ''
  const make = (name: string) => doc.createElementNS(W, `${prefix}${name}`)
  const runs = Array.from(target.children).filter((child) => inW(child, 'r') || inW(child, 'proofErr'))
  const looks = runs.flatMap((run) => Array.from(run.children).filter((inside) => inW(inside, 'rPr')))[0]
  // The new words go where the first of the old ones were: a bookmark round them stays round them.
  const place = runs.find((child) => inW(child, 'r')) ?? null
  const run = make('r')
  if (looks) run.appendChild(looks.cloneNode(true))
  said.split('\n').forEach((line, index) => {
    if (index > 0) run.appendChild(make('br'))
    line.split('\t').forEach((piece, count) => {
      if (count > 0) run.appendChild(make('tab'))
      if (!piece) return
      const text = make('t')
      text.setAttributeNS(XML, 'xml:space', 'preserve')
      text.textContent = piece
      run.appendChild(text)
    })
  })
  if (said) target.insertBefore(run, place)
  for (const old of runs) old.remove()
  zip.file(path, serialized(doc, document.text))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
