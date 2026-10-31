import JSZip from 'jszip'

export const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
export const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/package/2006/relationships'
const NOTES_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide'
const SLIDE_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/**
 * A deck's speaker notes, read and changed in their own part of the file (ADR 0107): each slide's
 * notes slide, its body's paragraphs. The reader draws the notes from these paragraphs while you
 * change them, and a paragraph changed goes back into the same paragraph, keeping how its first
 * words were formatted. Nothing else in the deck changes.
 */

/**
 * The slides' parts in the order the reader draws them: those the deck lists as slides, by the
 * number in their names, as `pptxtojson` takes them; a deck that lists none, by its files' names.
 */
export async function slidePaths(zip: JSZip): Promise<string[]> {
  const number = (path: string) => Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0)
  const types = zip.file('[Content_Types].xml')
  const doc = types ? new DOMParser().parseFromString(await types.async('string'), 'application/xml') : null
  const listed = doc
    ? Array.from(doc.getElementsByTagName('Override')).filter((each) => each.getAttribute('ContentType') === SLIDE_TYPE).map((each) => (each.getAttribute('PartName') ?? '').replace(/^\//, ''))
    : []
  const paths = listed.length ? listed.filter((path) => zip.file(path)) : Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
  return paths.sort((a, b) => number(a) - number(b))
}

/** The notes slide a slide's relationships name, as a path in the deck. */
async function notesPath(zip: JSZip, slide: string): Promise<string | null> {
  const folder = slide.slice(0, slide.lastIndexOf('/') + 1)
  const rels = zip.file(`${folder}_rels/${slide.slice(folder.length)}.rels`)
  if (!rels) return null
  const doc = new DOMParser().parseFromString(await rels.async('string'), 'application/xml')
  const target = Array.from(doc.getElementsByTagNameNS(R, 'Relationship')).find((each) => each.getAttribute('Type') === NOTES_SLIDE)?.getAttribute('Target')
  if (!target) return null
  const parts = folder.split('/').filter(Boolean)
  for (const part of target.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}

/** The paragraphs of a notes slide's body: the placeholder the notes are typed in. */
function bodyParagraphs(notes: Document): Element[] {
  const body = Array.from(notes.getElementsByTagNameNS(P, 'sp')).find((shape) =>
    Array.from(shape.getElementsByTagNameNS(P, 'ph')).some((placeholder) => placeholder.getAttribute('type') === 'body'))
  const text = body?.getElementsByTagNameNS(P, 'txBody')[0]
  return text ? textParagraphs(text) : []
}

/** The paragraphs of a shape's words (`p:txBody`), in order. */
export function textParagraphs(body: Element): Element[] {
  return Array.from(body.children).filter((child) => child.namespaceURI === A && child.localName === 'p')
}

/** A paragraph's words, a line break in it as a new line. */
export function paragraphWords(paragraph: Element): string {
  return Array.from(paragraph.children).map((child) => {
    if (child.namespaceURI !== A) return ''
    if (child.localName === 'br') return '\n'
    if (child.localName === 'r' || child.localName === 'fld') return Array.from(child.getElementsByTagNameNS(A, 't')).map((t) => t.textContent ?? '').join('')
    return ''
  }).join('')
}

/**
 * Words as typed, without the no-break spaces a browser puts in typed words so their spaces show
 * (markdownEdits.ts does the same): a space is a space in the file, unless the words there had a
 * no-break space of their own. Characters a file can't hold are left out, and a new line is `\n`.
 */
export function asTyped(words: string, was: string): string {
  // eslint-disable-next-line no-control-regex
  const held = words.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  return was.includes(' ') ? held : held.replace(/ /g, ' ')
}

export async function readXml(zip: JSZip, path: string): Promise<{ doc: Document; text: string } | null> {
  const file = zip.file(path)
  if (!file) return null
  const text = await file.async('string')
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  return doc.getElementsByTagName('parsererror').length ? null : { doc, text }
}

/** A part written back as XML, under the declaration it had (a standard one if it had none). */
export function serialized(doc: Document, was: string): string {
  const xml = new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^>]*\?>\s*/, '')
  const declaration = /^﻿?(<\?xml[^>]*\?>)(\r?\n)?/.exec(was)
  return declaration ? `${declaration[1]}${declaration[2] ?? ''}${xml}` : DECLARATION + xml
}

/**
 * A slide paragraph (`a:p`) made to say `words`, a new line in them a line break: its own settings
 * and end kept, and how its first words were formatted given to every line, one run each.
 */
export function writeParagraph(doc: Document, target: Element, words: string): void {
  const prefix = target.prefix ? `${target.prefix}:` : ''
  const looks = Array.from(target.getElementsByTagNameNS(A, 'rPr'))[0]
  for (const child of Array.from(target.children)) {
    if (child.namespaceURI === A && ['r', 'fld', 'br'].includes(child.localName)) child.remove()
  }
  const end = Array.from(target.children).find((child) => child.namespaceURI === A && child.localName === 'endParaRPr') ?? null
  words.split('\n').forEach((line, index) => {
    if (index > 0) target.insertBefore(doc.createElementNS(A, `${prefix}br`), end)
    if (!line) return
    const run = doc.createElementNS(A, `${prefix}r`)
    if (looks) run.appendChild(looks.cloneNode(true))
    const text = doc.createElementNS(A, `${prefix}t`)
    text.textContent = line
    run.appendChild(text)
    target.insertBefore(run, end)
  })
}

/** Each slide's notes, in the order the slides are drawn: its paragraphs' words; `null` for a slide with none to change. */
export async function deckNotes(bytes: ArrayBuffer | Uint8Array): Promise<Array<string[] | null>> {
  const zip = await JSZip.loadAsync(bytes)
  return Promise.all((await slidePaths(zip)).map(async (slide) => {
    const path = await notesPath(zip, slide)
    const notes = path ? await readXml(zip, path) : null
    const paragraphs = notes ? bodyParagraphs(notes.doc) : []
    return paragraphs.length ? paragraphs.map(paragraphWords) : null
  }))
}

/**
 * The deck with paragraph `paragraph` of slide `slide`'s notes (both from 0) saying `words`, a new
 * line in them a line break; `null` when it says that already, or there is no such paragraph. The
 * paragraph keeps its own settings and how its first words were formatted.
 */
export async function withNote(bytes: ArrayBuffer | Uint8Array, slide: number, paragraph: number, words: string): Promise<Uint8Array | null> {
  const zip = await JSZip.loadAsync(bytes)
  const slidePath = (await slidePaths(zip))[slide]
  const path = slidePath ? await notesPath(zip, slidePath) : null
  const notes = path ? await readXml(zip, path) : null
  const target = notes ? bodyParagraphs(notes.doc)[paragraph] : undefined
  if (!path || !notes || !target) return null
  const was = paragraphWords(target)
  const said = asTyped(words, was)
  if (said === was) return null
  writeParagraph(notes.doc, target, said)
  zip.file(path, serialized(notes.doc, notes.text))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
