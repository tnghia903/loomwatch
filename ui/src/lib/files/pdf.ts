/**
 * A PDF drawn as its pages in the reader (ADR 0091), with PDF.js, which is loaded only when a PDF is
 * read. Each page is drawn on a canvas, with its words laid over it where they are, so they can be
 * marked as any file's words are. Nothing in the PDF runs: PDF.js runs no script a PDF holds unless
 * a viewer turns scripting on, which this one doesn't, and its XFA forms are not drawn.
 */

import type { BoxAt } from '../chat/client'
import { PICTURE_MOST, WHOLE } from './parts'

/** A page of a PDF: its size at scale 1, in CSS pixels, and how to draw it and its words. */
export interface PdfPage {
  width: number
  height: number
  /**
   * Draws the page on `canvas` at `scale`, sharp on the screen it is shown on. It is drawn aside and
   * put on the canvas once done, so the page drawn before stays until then; `stop` ends it unfinished.
   */
  draw(canvas: HTMLCanvasElement, scale: number, stop?: AbortSignal): Promise<void>
  /** Lays the page's words out in `container` at `scale`, over where the canvas shows them, likewise. */
  words(container: HTMLElement, scale: number, stop?: AbortSignal): Promise<void>
  /** Whether the page shows a picture, or a drawing of many filled shapes (a chart drawn in the PDF). */
  pictures(): Promise<boolean>
  /** Lets go of what drawing the page kept, once it is far from the view. */
  release(): void
}

/** How many filled shapes on a page make it a drawing, as a chart is, rather than a ruled page of words. */
const DRAWING_FILLS = 12
/** The most pages laid out; a longer PDF shows its start and says so. */
export const MOST_PAGES = 500

export interface PdfFile {
  pages: number
  page(number: number): Promise<PdfPage>
  /** The words of a page, as its words laid over it hold them, without laying them out. */
  text(number: number): Promise<string>
  /**
   * A box on a page drawn again for the agent, sharp: up to four times its size at scale 1 and at
   * most `PICTURE_MOST` on its long side, rather than cut from the page as the screen shows it.
   */
  picture(at: BoxAt & { page: number }): Promise<Blob | null>
  close(): void
}

/**
 * Where PDF.js's own data is served with the app (`vite.config.ts`, `pdfjsData`): the fonts a PDF
 * names but doesn't hold, the character maps some Chinese, Japanese and Korean text needs, the
 * decoders for scanned pictures, and a colour profile. Nothing is fetched from the web.
 */
function pdfjsData(folder: string): string {
  return new URL(`${import.meta.env.BASE_URL}pdfjs/${folder}/`, window.location.href).href
}

/** Opens the PDF at `url` (the reader's `raw` answer, read a part at a time). */
export async function openPdf(url: string): Promise<PdfFile> {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const task = pdfjs.getDocument({
    url,
    enableXfa: false,
    cMapUrl: pdfjsData('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: pdfjsData('standard_fonts'),
    wasmUrl: pdfjsData('wasm'),
    iccUrl: pdfjsData('iccs'),
  })
  const doc = await task.promise
  return {
    pages: doc.numPages,
    async text(number) {
      const content = await (await doc.getPage(number)).getTextContent()
      return content.items.map((item) => ('str' in item ? item.str : '')).join('')
    },
    async page(number) {
      const page = await doc.getPage(number)
      const base = page.getViewport({ scale: 1 })
      return {
        width: base.width,
        height: base.height,
        async draw(canvas, scale, stop) {
          const viewport = page.getViewport({ scale })
          const ratio = window.devicePixelRatio || 1
          const aside = document.createElement('canvas')
          aside.width = Math.max(1, Math.floor(viewport.width * ratio))
          aside.height = Math.max(1, Math.floor(viewport.height * ratio))
          const task = page.render({ canvas: aside, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
          stop?.addEventListener('abort', () => task.cancel(), { once: true })
          try {
            await task.promise
            if (stop?.aborted) return
            canvas.width = aside.width
            canvas.height = aside.height
            canvas.getContext('2d')?.drawImage(aside, 0, 0)
          } finally {
            // A canvas holds its memory until it has no size; Safari draws no more past a limit.
            aside.width = 0
            aside.height = 0
          }
        },
        release() {
          page.cleanup()
        },
        async words(container, scale, stop) {
          const aside = document.createElement('div')
          const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: aside, viewport: page.getViewport({ scale }) })
          stop?.addEventListener('abort', () => layer.cancel(), { once: true })
          await layer.render()
          if (stop?.aborted) return
          // A drag over words that crosses blank paper ends on this, not at the page's start (`holdSelections`).
          const end = document.createElement('div')
          end.className = 'endOfContent'
          aside.append(end)
          container.style.cssText = aside.style.cssText
          container.replaceChildren(...aside.childNodes)
        },
        async pictures() {
          const { OPS } = pdfjs
          const images = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectGroup])
          const fills = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke])
          const list = await page.getOperatorList()
          let filled = 0
          for (const [at, op] of list.fnArray.entries()) {
            if (images.has(op)) return true
            // A path names how it is painted as its first argument.
            const paint = op === OPS.constructPath ? (list.argsArray[at] as unknown[] | undefined)?.[0] : op
            if (typeof paint === 'number' && fills.has(paint) && ++filled >= DRAWING_FILLS) return true
          }
          return false
        },
      }
    },
    async picture(at) {
      const page = await doc.getPage(at.page)
      const base = page.getViewport({ scale: 1 })
      const across = (base.width * at.w) / WHOLE
      const down = (base.height * at.h) / WHOLE
      const scale = Math.min(4, PICTURE_MOST / Math.max(across, down, 1))
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(across * scale))
      canvas.height = Math.max(1, Math.round(down * scale))
      // Only the box is drawn: the page is moved up and left by where the box starts.
      await page.render({ canvas, viewport, transform: [1, 0, 0, 1, -(viewport.width * at.x) / WHOLE, -(viewport.height * at.y) / WHOLE] }).promise
      return new Promise<Blob | null>((resolve) => {
        try { canvas.toBlob(resolve, 'image/png') } catch { resolve(null) }
      })
    },
    close() {
      void task.destroy()
    },
  }
}

/**
 * Keeps a drag over a page's words from jumping to the start or end of the page as it crosses blank
 * paper, as PDF.js's own viewer does (pdfjs-dist web/pdf_viewer.mjs, TextLayerBuilder): while words
 * are selected, the block after them (`.endOfContent`) covers the page, and, where the browser
 * doesn't keep the selection in place itself (Safari), it is moved to just after the word the
 * selection ends at. Watches every page in `view`; gives how to stop.
 */
export function holdSelections(view: HTMLElement): () => void {
  const stop = new AbortController()
  const on = { signal: stop.signal }
  const layers = () => [...view.querySelectorAll<HTMLElement>('.rd-pdf-text')]
  const reset = (layer: HTMLElement) => {
    const end = layer.querySelector<HTMLElement>('.endOfContent')
    if (end) {
      layer.append(end)
      end.style.width = ''
      end.style.height = ''
      end.style.removeProperty('-webkit-user-select')
      end.style.removeProperty('user-select')
    }
    layer.classList.remove('selecting')
  }
  let pressed = false
  let before: Range | null = null
  // Firefox and Chromium from 148 keep a selection in place over blank paper by themselves.
  let keepsItself: boolean | undefined
  view.addEventListener('mousedown', (event) => {
    (event.target as Element).closest<HTMLElement>('.rd-pdf-text')?.classList.add('selecting')
  }, on)
  document.addEventListener('pointerdown', () => { pressed = true }, on)
  document.addEventListener('pointerup', () => { pressed = false; layers().forEach(reset) }, on)
  window.addEventListener('blur', () => { pressed = false; layers().forEach(reset) }, on)
  document.addEventListener('keyup', () => { if (!pressed) layers().forEach(reset) }, on)
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0) { layers().forEach(reset); return }
    const range = selection.getRangeAt(0)
    for (const layer of layers()) {
      if (range.intersectsNode(layer)) layer.classList.add('selecting')
      else reset(layer)
    }
    if (keepsItself === undefined) {
      const chromium = /\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1]
      keepsItself = 'MozAppearance' in document.documentElement.style || (chromium !== undefined && Number(chromium) >= 148)
    }
    if (keepsItself) return
    const fromStart = before !== null && (range.compareBoundaryPoints(Range.END_TO_END, before) === 0 || range.compareBoundaryPoints(Range.START_TO_END, before) === 0)
    let anchor: Node | null = fromStart ? range.startContainer : range.endContainer
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode
    // Words asked about are marked inside their line: the line is the anchor.
    if (anchor instanceof Element && anchor.classList.contains('rd-mark')) anchor = anchor.parentNode
    if (!fromStart && range.endOffset === 0) {
      do {
        while (anchor && !anchor.previousSibling) anchor = anchor.parentNode
        anchor = anchor?.previousSibling ?? null
      } while (anchor && !anchor.childNodes.length)
    }
    const layer = anchor?.parentElement?.closest<HTMLElement>('.rd-pdf-text')
    const end = layer?.querySelector<HTMLElement>('.endOfContent')
    if (anchor?.parentElement && layer && end && view.contains(layer)) {
      end.style.width = layer.style.width
      end.style.height = layer.style.height
      // Safari reads only its own name for it, from a script as from a style sheet.
      end.style.setProperty('-webkit-user-select', 'text')
      end.style.setProperty('user-select', 'text')
      anchor.parentElement.insertBefore(end, fromStart ? anchor : anchor.nextSibling)
    }
    before = range.cloneRange()
  }, on)
  return () => stop.abort()
}

/** A bubble and the room beside it, across: it keeps its size however small the page is drawn. */
const BUBBLE_ACROSS = 36
/** Half a bubble's height and a little: how far above and below its line's middle it covers. */
const BUBBLE_HALF = 13
/** How far past the page's edge a bubble may hang, into the room round the page. */
const PAST_EDGE = 16

/**
 * Where the bubbles after words marked on a page go (`markParts`' `place`): in the page's own layer
 * for them, in the first gap after the last word wide enough for a bubble, along the band the bubble
 * covers. A page's words lie stretched over its drawing to fit it, so a slot in their line would be
 * stretched with them, push the words after it off what they cover, and sit under the next line;
 * and the drawing can't make room, so a bubble right after the word would cover the words drawn
 * after it. On a full line that is the margin; a bubble never hangs more than a little past the
 * page's edge. Bubbles after one line share a row, in the order of their words, rather than lying
 * one over the other. Anywhere but on a page, the slot is left to go after the words.
 */
export function placeSlotOnPage(slot: HTMLElement, last: HTMLElement): boolean {
  const page = last.closest('.rd-pdf-page')
  const layer = page?.querySelector<HTMLElement>(':scope > .rd-pdf-slots')
  if (!page || !layer) return false
  const rects = last.getClientRects()
  const end = rects[rects.length - 1] ?? last.getBoundingClientRect()
  const box = layer.getBoundingClientRect()
  const middle = (end.top + end.bottom) / 2
  const half = Math.max(BUBBLE_HALF, end.height / 2 + 2)
  const along = [...page.querySelectorAll('.rd-pdf-text span')]
    .map((span) => span.getBoundingClientRect())
    .filter((rect) => rect.bottom > middle - half && rect.top < middle + half && rect.right > end.right)
    .sort((a, b) => a.left - b.left)
  let left = end.right
  for (const rect of along) {
    if (rect.left - left >= BUBBLE_ACROSS) break
    left = Math.max(left, rect.right)
  }
  left = Math.min(left, box.right + PAST_EDGE - BUBBLE_ACROSS)
  for (const empty of layer.querySelectorAll(':scope > .rd-pdf-row:empty')) empty.remove()
  // Parts are marked last first (`markParts`): an earlier part's bubble goes before a later one's.
  const middleIn = middle - box.top
  let row = [...layer.querySelectorAll<HTMLElement>(':scope > .rd-pdf-row')].find((each) => Math.abs(Number(each.dataset.middle) - middleIn) < half)
  if (!row) {
    row = document.createElement('span')
    row.className = 'rd-pdf-row'
    row.dataset.middle = String(middleIn)
    if (box.width && box.height) {
      row.style.left = `${((left - box.left) * 100) / box.width}%`
      row.style.top = `${(middleIn * 100) / box.height}%`
    }
    layer.append(row)
  }
  // Away from the words it follows, its point would point at others.
  if (left > end.right + 2) row.classList.add('apart')
  row.prepend(slot)
  return true
}
