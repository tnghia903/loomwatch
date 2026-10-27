/**
 * The message box's words and what it draws for them (ChipField): plain words as text, and each
 * agent @mentioned as its chip, one piece standing for the words it was typed as. The words are
 * what the box holds and sends; the page only shows them.
 */

/** An agent's @mention in some words: where its `@` is and where its name ends. */
export interface ChipAt {
  start: number
  end: number
  agent: string
}

/** A piece of the box: words as they are, or an agent's chip standing for `words`. */
export type FieldPart =
  | { kind: 'words'; words: string; start: number }
  | { kind: 'chip'; words: string; start: number; agent: string }

/** `text` cut into words and chips, in order. Chips that overlap one before them are left as words. */
export function fieldParts(text: string, chips: readonly ChipAt[]): FieldPart[] {
  const parts: FieldPart[] = []
  let at = 0
  for (const chip of [...chips].sort((left, right) => left.start - right.start)) {
    if (chip.start < at || chip.end <= chip.start || chip.end > text.length) continue
    if (chip.start > at) parts.push({ kind: 'words', words: text.slice(at, chip.start), start: at })
    parts.push({ kind: 'chip', words: text.slice(chip.start, chip.end), start: chip.start, agent: chip.agent })
    at = chip.end
  }
  if (at < text.length) parts.push({ kind: 'words', words: text.slice(at), start: at })
  return parts
}

const BLOCKS = new Set(['DIV', 'P', 'LI'])

/**
 * The words a piece of the box stands for: text as it is, a chip as the words it was typed as
 * (`data-words`), a line break as one. A browser that puts a line in a block of its own starts a
 * line there. `whole` reads the whole box, where a break at the very end only holds an empty last
 * line open and stands for nothing.
 */
export function fieldWords(node: Node, whole = true): string {
  let out = ''
  const walk = (parent: Node) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += (child as Text).data
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const element = child as HTMLElement
      const words = element.dataset.words
      if (words !== undefined) out += words
      else if (element.tagName === 'BR') out += '\n'
      else {
        if (BLOCKS.has(element.tagName) && out !== '' && !out.endsWith('\n')) out += '\n'
        walk(element)
      }
    }
  }
  walk(node)
  return whole && out.endsWith('\n') && endsInBreak(node) ? out.slice(0, -1) : out
}

function endsInBreak(node: Node): boolean {
  let last = node.lastChild
  while (last && last.nodeType === Node.TEXT_NODE && (last as Text).data === '') last = last.previousSibling
  if (!last || last.nodeType !== Node.ELEMENT_NODE) return false
  const element = last as HTMLElement
  if (element.tagName === 'BR') return true
  return element.dataset.words === undefined && endsInBreak(element)
}

/**
 * Whether the box shows exactly `parts`: one run of text per piece of words, each chip where it
 * belongs, and a break at the end only when the words end on an empty line. Anything else a browser
 * left behind (a span it wrapped words in, a stray break) means the box is drawn again.
 */
export function fieldShows(root: Node, parts: readonly FieldPart[], text: string): boolean {
  const nodes = Array.from(root.childNodes).filter((node) => !(node.nodeType === Node.TEXT_NODE && (node as Text).data === ''))
  let index = 0
  for (const part of parts) {
    if (part.kind === 'words') {
      let words = ''
      while (index < nodes.length && nodes[index].nodeType === Node.TEXT_NODE) words += (nodes[index++] as Text).data
      if (words !== part.words) return false
      continue
    }
    const node = nodes[index++]
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false
    const element = node as HTMLElement
    if (element.dataset.words !== part.words || element.dataset.agent !== part.agent) return false
  }
  if (text.endsWith('\n')) {
    const end = nodes[index++]
    if (!end || end.nodeType !== Node.ELEMENT_NODE || (end as HTMLElement).tagName !== 'BR') return false
  }
  return index === nodes.length
}

/**
 * How far into the words a point in the box is. A point inside a chip is at its end: a chip is one
 * piece, never half of one.
 */
export function offsetIn(root: Node, node: Node, offset: number): number {
  if (!root.contains(node)) return 0
  const range = root.ownerDocument!.createRange()
  range.setStart(root, 0)
  range.setEnd(node, offset)
  return Math.min(fieldWords(range.cloneContents(), false).length, fieldWords(root).length)
}

/**
 * The point in a box drawn from `parts` that is `offset` into its words. Between a chip and words,
 * the point is in the words, so what is typed there joins them and never the chip; inside a chip, it
 * is after it.
 */
export function pointAt(root: Node, offset: number): { node: Node; offset: number } {
  let at = 0
  const children = Array.from(root.childNodes)
  for (const [index, child] of children.entries()) {
    if (child.nodeType === Node.TEXT_NODE) {
      const length = (child as Text).data.length
      if (offset <= at + length) return { node: child, offset: Math.max(0, offset - at) }
      at += length
      continue
    }
    const element = child as HTMLElement
    if (element.tagName === 'BR' && index === children.length - 1) return { node: root, offset: index }
    const length = element.dataset?.words !== undefined ? element.dataset.words.length : element.tagName === 'BR' ? 1 : (element.textContent ?? '').length
    if (offset <= at) return { node: root, offset: index }
    if (offset < at + length) return { node: root, offset: index + 1 }
    at += length
  }
  return { node: root, offset: children.length }
}
