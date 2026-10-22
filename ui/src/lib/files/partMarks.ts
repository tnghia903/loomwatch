/**
 * Parts of a page asked about, marked in place (ADR 0077): the words of each part wrapped in a mark
 * the reader styles as a marker stroke, and after the last word an empty slot the agent's bubble is
 * drawn in, so the line makes room for the bubble rather than the bubble covering words.
 *
 * The page may be one React draws. Every change is undone exactly by `undo`, last first: each text
 * node split is joined again and each one moved is put back, with its own words, so React finds its
 * nodes as it left them. A page React draws again with new words must be drawn afresh (FileReader
 * keys it by its changes), never updated around the marks.
 *
 * The web page's script (pageFrame.ts PAGE_BRIDGE) does the same inside the page, as plain script.
 */

export interface PartToMark {
  key: string
  range: Range
}

export interface MarkedPart {
  /** The marks round the part's words, in order: one for each piece of text it spans. */
  marks: HTMLElement[]
  /** The empty slot after its last word. */
  slot: HTMLElement
}

/** The marks put on a page, and how to take them off. */
export interface PartMarks {
  parts: Map<string, MarkedPart>
  undo: () => void
}

/**
 * Marks `parts`, oldest first, on the page their ranges are in. Where two overlap, the newer is
 * marked; a part with no words is not. `mark` and `slot` are the class names of marks and slots.
 */
export function markParts(parts: readonly PartToMark[], names: { mark: string; slot: string }): PartMarks {
  const undo: (() => void)[] = []
  const marked = new Map<string, MarkedPart>()
  const kept: PartToMark[] = []
  for (const part of [...parts].reverse()) {
    if (!part.range.collapsed && !kept.some((other) => overlaps(other.range, part.range))) kept.push(part)
  }
  // Last in the page first, so a part marked never moves the boundaries of one still to mark.
  kept.sort((a, b) => b.range.compareBoundaryPoints(Range.START_TO_START, a.range))
  for (const { key, range } of kept) {
    const pieces = textIn(range)
    if (pieces.length === 0) continue
    const doc = range.startContainer.ownerDocument ?? document
    const marks: HTMLElement[] = []
    // Last piece first, for the same reason.
    for (const { node, start, end } of pieces.reverse()) {
      const data = node.data
      let target = node
      const added: Text[] = []
      if (end < node.length) added.push(node.splitText(end))
      if (start > 0) {
        target = node.splitText(start)
        added.push(target)
      }
      const mark = doc.createElement('span')
      mark.className = names.mark
      mark.dataset.part = key
      target.before(mark)
      mark.append(target)
      marks.unshift(mark)
      undo.push(() => {
        if (target === node) mark.before(node)
        mark.remove()
        for (const piece of added) piece.remove()
        node.data = data
      })
    }
    const slot = doc.createElement('span')
    slot.className = names.slot
    slot.dataset.part = key
    slot.dataset.readerChrome = ''
    slot.setAttribute('contenteditable', 'false')
    marks.at(-1)!.after(slot)
    undo.push(() => slot.remove())
    marked.set(key, { marks, slot })
  }
  return { parts: marked, undo: () => { for (const step of undo.reverse()) step() } }
}

/** The pieces of text a range spans, in order, leaving out pieces that are only spaces. */
function textIn(range: Range): { node: Text; start: number; end: number }[] {
  const root = range.commonAncestorContainer
  const doc = root.ownerDocument ?? document
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const pieces: { node: Text; start: number; end: number }[] = []
  for (let node = root.nodeType === Node.TEXT_NODE ? root as Text : walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    // A bubble's own words are not the page's.
    if (!range.intersectsNode(node) || node.parentElement?.closest('[data-reader-chrome]')) continue
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : node.length
    if (end > start && node.data.slice(start, end).trim()) pieces.push({ node, start, end })
    if (node === root) break
  }
  return pieces
}

function overlaps(a: Range, b: Range): boolean {
  return a.compareBoundaryPoints(Range.END_TO_START, b) < 0 && a.compareBoundaryPoints(Range.START_TO_END, b) > 0
}
