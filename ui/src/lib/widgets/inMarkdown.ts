/**
 * Where a long answer's widgets stand in its document (ADR 0114), once its Markdown is drawn. The
 * document is read as one piece, so its numbered lists keep counting and its footnotes and links
 * written further down still resolve; each widget is put in at the line its words placed it before.
 */

/** A widget and the line of the answer's words it stands before, counted from 0; none: at the end. */
export interface WidgetPlace {
  n: number
  line?: number
}

/** A node of the drawn Markdown (hast), as far as placing a widget reads it. */
interface Drawn {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: Drawn[]
  position?: { start: { line: number } }
}

/** The blocks a widget can stand before. */
const BLOCKS = new Set(['p', 'ul', 'ol', 'blockquote', 'pre', 'table', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'section', 'details', 'figure'])
/** The blocks a widget can stand inside: a list's items and a quote. */
const HOLDERS = new Set(['ul', 'ol', 'li', 'blockquote'])

/** The property a widget's place carries: its number. */
export const WIDGET_PLACE = 'dataAnswerWidget'

/**
 * Line `line` (from 0) of `text` as it is in `changed(text)`: the renderer reads the words after its
 * own changes, and one of them can add lines (`\[x\]` becomes a `$$` block of three).
 */
export function lineAfter(text: string, line: number, changed: (text: string) => string): number {
  if (line <= 0) return 0
  return changed(text.split('\n').slice(0, line).join('\n')).split('\n').length
}

/**
 * Put each widget in `tree` (the drawn Markdown) at the line it stands before, counted from 1 as the
 * Markdown was read (`line`; null at the end): before the first block that starts there or later.
 * One that falls between two items of a list goes at the end of the item above it, under what that
 * item says, and the list stays one list. One no block follows goes at the end, before the
 * footnotes. Widgets at the same place keep their order.
 */
export function placeWidgets(tree: { children: unknown[] }, places: readonly { n: number; line: number | null }[]): void {
  const root = tree as { children: Drawn[] }
  const ordered = [...places].sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity) || a.n - b.n)
  for (const place of ordered) {
    const slot: Drawn = { type: 'element', tagName: 'div', properties: { className: ['md-widget'], [WIDGET_PLACE]: String(place.n) }, children: [] }
    if (place.line === null || !into(root, place.line, slot)) atEnd(root, slot)
  }
}

function into(parent: { children?: Drawn[] }, line: number, slot: Drawn): boolean {
  const kids = parent.children ?? []
  for (let at = 0; at < kids.length; at += 1) {
    const node = kids[at]
    if (node.type !== 'element' || !node.tagName || !(BLOCKS.has(node.tagName) || node.tagName === 'li')) continue
    // A widget already put in has no place in the words.
    const start = node.position?.start.line
    if (start === undefined) continue
    if (start >= line) {
      if (node.tagName !== 'li') {
        kids.splice(at, 0, slot)
        return true
      }
      const above = kids.slice(0, at).reverse().find((kid) => kid.type === 'element' && kid.tagName === 'li')
      if (!above) return false
      above.children = [...(above.children ?? []), slot]
      return true
    }
    if (HOLDERS.has(node.tagName) && into(node, line, slot)) return true
  }
  return false
}

function atEnd(root: { children: Drawn[] }, slot: Drawn): void {
  const last = root.children.findLastIndex((node) => node.type === 'element')
  const notes = last >= 0 && root.children[last].tagName === 'section' && root.children[last].properties?.dataFootnotes !== undefined
  if (notes) root.children.splice(last, 0, slot)
  else root.children.push(slot)
}
