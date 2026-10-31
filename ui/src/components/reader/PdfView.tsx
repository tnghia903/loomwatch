import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'

import type { BoxAt } from '../../lib/chat/client'
import { holdSelections, MOST_PAGES, openPdf, type PdfFile } from '../../lib/files/pdf'
import { boxBetween, boxLabel, boxOnScreen, boxStyle, WHOLE, wholeBox, type Point } from '../../lib/files/parts'
import type { Marked } from './PageFrame'

/** How far a finger may move and still be a tap: the whole page, or a box's answer. */
const CLICK_PX = 6
/** The smallest box a drag on a page marks, each way; a smaller slip of the hand is a click. */
const BOX_MIN_PX = 12
/** How far outside the view a page is drawn ahead of being scrolled to. */
const AHEAD = '600px'
/** How far from the view a page's drawing is kept; past that it is let go of (its words are kept). */
const FAR = '3000px'
/** How long a PDF may take to open before its words are shown instead. */
const OPEN_LIMIT_MS = 30_000
/** How near a line of words a press may be and still mark words, not draw a box: beside it, or between lines. */
const NEAR_WORDS_PX = { across: 16, down: 6 }
/** How many words make a line of words, rather than a label in a chart ("200", "North", "Q3"). */
const LINE_WORDS = 3

/** A box asked about on a page, by its part's id, with how its asks look. */
export interface PdfBox {
  id: string
  at: BoxAt
  look: string
}

interface PdfViewProps {
  src: string
  /** The file's name, said while it opens. */
  name: string
  askable: boolean
  boxes: readonly PdfBox[]
  /** The parts of words asked about, by their words: each one's page is found and laid out. */
  wanted?: readonly string[]
  /** The box marked now and not yet asked about. */
  marking: BoxAt | null
  asking: string | null
  /** The part whose answer is open, by its id: it is scrolled to, or its page while it isn't laid out. */
  open: string | null
  onMarked: (marked: Marked | null) => void
  onOpen: (id: string) => void
  /** Pages were drawn or laid out again: the marks are measured again. */
  onDrawn?: () => void
  /** PDF.js could not open it: the reader shows its words instead. */
  onFailed: () => void
  /** How many pages it has, once it is open. */
  onPages?: (count: number) => void
  /** The page each of `wanted` is on, once looked for; `null` when it is on none. */
  onWanted?: (pages: ReadonlyMap<string, number | null>) => void
  /** Once it is open: how a box on one of its pages is drawn again, sharp, to send with a question. */
  onPictures?: (take: ((at: BoxAt & { page: number }) => Promise<Blob | null>) | null) => void
  /** A page drawn shows a picture or a chart: something a box can be drawn over. */
  onPictured?: () => void
}

const isWhole = (at: BoxAt) => at.x === 0 && at.y === 0 && at.w === WHOLE && at.h === WHOLE
const NO_WANTED: readonly string[] = []

/**
 * A PDF an agent made, drawn as its pages (ADR 0091). Its words lie over each page where they are,
 * so marking them is marking words, as in any file; a drag on a page where there are no words marks
 * a box on that page. On a page with a picture or a chart, Enter or a tap marks all of it, as on a
 * picture (a finger otherwise scrolls). Each box asked about stays drawn on its page, the smaller
 * over the larger, with the bubble of every agent asked at its corner, which opens the answer.
 */
export function PdfView({ src, name, askable, boxes, wanted = NO_WANTED, marking, asking, open, onMarked, onOpen, onDrawn, onFailed, onPages, onWanted, onPictures, onPictured }: PdfViewProps) {
  const view = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<{ src: string; file: PdfFile; ratios: number[] } | null>(null)
  const [width, setWidth] = useState(0)
  // The pages that show a picture or a chart, found as each is drawn.
  const [pictured, setPictured] = useState<ReadonlySet<number>>(new Set())
  const told = useRef({ onFailed, onDrawn, onPictured, onPages, onWanted })
  useEffect(() => { told.current = { onFailed, onDrawn, onPictured, onPages, onWanted } }, [onFailed, onDrawn, onPictured, onPages, onWanted])
  useEffect(() => {
    if (!pdf) return
    onPictures?.((at) => pdf.file.picture(at))
    return () => onPictures?.(null)
  }, [pdf, onPictures])

  // Open it, and lay every page out at the shape of the first until each is drawn.
  useEffect(() => {
    let live = true
    let opened: PdfFile | null = null
    // One that never opens shows its words, rather than "Reading" for good.
    const late = window.setTimeout(() => { if (live) { live = false; told.current.onFailed() } }, OPEN_LIMIT_MS)
    openPdf(src).then(async (file) => {
      opened = file
      if (!live) { file.close(); return }
      const first = await file.page(1)
      if (!live) return
      window.clearTimeout(late)
      setPictured(new Set())
      setPdf({ src, file, ratios: Array.from({ length: Math.min(file.pages, MOST_PAGES) }, () => first.height / first.width) })
      told.current.onPages?.(file.pages)
    }).catch(() => { if (live) { window.clearTimeout(late); told.current.onFailed() } })
    return () => { live = false; window.clearTimeout(late); opened?.close() }
  }, [src])

  // The pages fill the view's width; drawn again when it changes. Measured at once, not at the next
  // frame, which a tab in the background never draws.
  useLayoutEffect(() => {
    const element = view.current
    if (!element) return
    const measure = () => setWidth(Math.floor(element.getBoundingClientRect().width))
    measure()
    const watching = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    watching?.observe(element)
    return () => watching?.disconnect()
  }, [pdf])

  // A drag over words keeps to the words as it crosses blank paper.
  useEffect(() => (pdf && view.current ? holdSelections(view.current) : undefined), [pdf])

  // Each page is drawn as it comes near the view, at the view's width, with its words over it, and
  // its drawing let go of once it is far (a canvas holds its memory, and Safari draws no more past a
  // limit); its words stay. A drawing still going when the width changes is stopped, and the page
  // drawn again at the new one.
  const drawnAt = useRef(new Map<number, number>())
  const wordedAt = useRef(new Map<number, number>())
  const looked = useRef(new Set<number>())
  const laying = useRef<{ words: (holder: HTMLElement) => Promise<void> } | null>(null)
  useEffect(() => { looked.current = new Set() }, [pdf])
  useEffect(() => {
    const element = view.current
    if (!pdf || !element || !width) return
    drawnAt.current.clear()
    wordedAt.current.clear()
    const stop = new AbortController()
    // At the view's width: the page's shape and scale, for its drawing and its words.
    const sized = async (holder: HTMLElement) => {
      const page = await pdf.file.page(Number(holder.dataset.page))
      const scale = width / page.width
      holder.style.setProperty('--total-scale-factor', String(scale))
      holder.style.aspectRatio = `${page.width} / ${page.height}`
      return { page, scale }
    }
    const draw = async (holder: HTMLElement) => {
      const number = Number(holder.dataset.page)
      if (drawnAt.current.get(number) === width) return
      drawnAt.current.set(number, width)
      // Its words are laid out once at a width, by whichever of drawing it and finding a part on it
      // comes first.
      const wordsToo = wordedAt.current.get(number) !== width
      if (wordsToo) wordedAt.current.set(number, width)
      try {
        const { page, scale } = await sized(holder)
        if (stop.signal.aborted) return
        const canvas = holder.querySelector('canvas')
        const words = holder.querySelector<HTMLElement>('.rd-pdf-text')
        if (canvas) await page.draw(canvas, scale, stop.signal)
        if (words && wordsToo && !stop.signal.aborted) await page.words(words, scale, stop.signal)
        if (stop.signal.aborted) return
        told.current.onDrawn?.()
        if (looked.current.has(number)) return
        looked.current.add(number)
        if (await page.pictures().catch(() => false) && !stop.signal.aborted) {
          setPictured((now) => new Set([...now, number]))
          told.current.onPictured?.()
        }
      } catch {
        drawnAt.current.delete(number)
        wordedAt.current.delete(number)
      }
    }
    // A page's words alone, for a part asked about on a page not drawn yet.
    const words = async (holder: HTMLElement) => {
      const number = Number(holder.dataset.page)
      const container = holder.querySelector<HTMLElement>('.rd-pdf-text')
      if (!container || wordedAt.current.get(number) === width) return
      wordedAt.current.set(number, width)
      try {
        const { page, scale } = await sized(holder)
        if (stop.signal.aborted) return
        await page.words(container, scale, stop.signal)
        if (!stop.signal.aborted) told.current.onDrawn?.()
      } catch {
        wordedAt.current.delete(number)
      }
    }
    const letGo = (holder: HTMLElement) => {
      const number = Number(holder.dataset.page)
      if (!drawnAt.current.delete(number)) return
      const canvas = holder.querySelector('canvas')
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
      void pdf.file.page(number).then((page) => page.release(), () => undefined)
    }
    laying.current = { words }
    const pages = [...element.querySelectorAll<HTMLElement>('.rd-pdf-page')]
    if (typeof IntersectionObserver === 'undefined') {
      pages.forEach((holder) => void draw(holder))
      return () => { stop.abort(); laying.current = null }
    }
    // Near the reader's own view, which scrolls, not the window's.
    const root = element.closest('.rd-scroll')
    const near = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) void draw(entry.target as HTMLElement) }), { root, rootMargin: AHEAD })
    const far = new IntersectionObserver((entries) => entries.forEach((entry) => { if (!entry.isIntersecting) letGo(entry.target as HTMLElement) }), { root, rootMargin: FAR })
    pages.forEach((holder) => { near.observe(holder); far.observe(holder) })
    return () => { stop.abort(); near.disconnect(); far.disconnect(); laying.current = null }
  }, [pdf, width])

  // The page each part of words asked about is on, found in the PDF's own words, as the reader finds
  // words (`findPassage`: without spaces, by their start, which may run on to the next page). Its
  // page's words are laid out, so the part is found and marked even far from the view, and a part
  // on no page is one the file no longer has, not one not laid out yet.
  const [pagesOf, setPagesOf] = useState<ReadonlyMap<string, number | null>>(new Map())
  const texts = useRef(new Map<number, Promise<string>>())
  useEffect(() => { texts.current = new Map() }, [pdf])
  const wantedKey = wanted.join('\u0000')
  useEffect(() => {
    if (!pdf) return
    let live = true
    const parts = wantedKey ? wantedKey.split('\u0000') : []
    const textOf = (number: number) => {
      if (!texts.current.has(number)) texts.current.set(number, pdf.file.text(number).then((words) => words.replace(/\s/g, ''), () => ''))
      return texts.current.get(number)!
    }
    void (async () => {
      const found = new Map<string, number | null>()
      for (const part of parts) {
        const start = part.replace(/…$/, '').replace(/\s/g, '').slice(0, 60)
        let on: number | null = null
        let before = ''
        for (let number = 1; number <= pdf.ratios.length && on === null; number++) {
          const words = await textOf(number)
          if (!live) return
          if (words.includes(start)) on = number
          else if (`${before}${words}`.includes(start)) on = number - 1
          before = words
        }
        found.set(part, on)
      }
      setPagesOf(found)
      told.current.onWanted?.(found)
    })()
    return () => { live = false }
  }, [pdf, wantedKey])
  useEffect(() => {
    const element = view.current
    if (!element || !laying.current) return
    const pages = new Set([...pagesOf.values()].flatMap((number) => (number === null ? [] : [number, number + 1])))
    for (const number of pages) {
      const holder = element.querySelector<HTMLElement>(`.rd-pdf-page[data-page="${number}"]`)
      if (holder) void laying.current.words(holder)
    }
  }, [pagesOf, pdf, width])

  // The answer opened: its part comes into view, or its page while the part isn't laid out yet.
  const openPage = open ? boxes.find((each) => each.id === open)?.at.page ?? pagesOf.get(open) ?? null : null
  useEffect(() => {
    const element = view.current
    if (!open || !element) return
    const part = [...element.querySelectorAll<HTMLElement>('.rd-box[data-part], .rd-mark[data-part]')].find((each) => each.dataset.part === open)
    if (part) part.scrollIntoView?.({ block: 'nearest' })
    else if (openPage !== null) element.querySelector(`.rd-pdf-page[data-page="${openPage}"]`)?.scrollIntoView?.({ block: 'start' })
  }, [open, openPage])

  // A drag on a page where there are no words: a box on that page.
  const [drawing, setDrawing] = useState<{ page: number; from: Point; to: Point; pointer: number; touch: boolean } | null>(null)
  const pointIn = (event: PointerEvent<HTMLElement>, holder: Element): Point => {
    const box = holder.getBoundingClientRect()
    if (!box.width || !box.height) return { x: 0, y: 0 }
    return { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) }
  }
  const markWhole = (holder: HTMLElement) => {
    const page = Number(holder.dataset.page)
    const at: BoxAt = { ...wholeBox(), page }
    onMarked({ text: boxLabel(at, `page ${page}`), at, rect: boxOnScreen(at, holder.getBoundingClientRect()) })
  }
  const down = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target as Element
    if (!askable || event.button !== 0) return
    // On words, a drag marks words, as anywhere; a bubble is pressed. Over a box asked about, a
    // drag draws a new box and a click opens its answer, as on a picture.
    if (target.closest('.rd-pdf-text span, .rd-slot')) return
    const holder = event.currentTarget
    // A finger may be starting to scroll: only a tap that doesn't move marks, once it lifts.
    if (event.pointerType === 'touch') {
      const point = pointIn(event, holder)
      setDrawing({ page: Number(holder.dataset.page), from: point, to: point, pointer: event.pointerId, touch: true })
      return
    }
    // A press just beside a line of words, or between lines, starts marking words, as in any
    // document; beside a label in a chart, it starts a box, as a drag over a chart starts at its edge.
    const nearWords = [...holder.querySelectorAll('.rd-pdf-text span')].some((span) => {
      if ((span.textContent ?? '').trim().split(/\s+/).length < LINE_WORDS) return false
      const box = span.getBoundingClientRect()
      return event.clientX >= box.left - NEAR_WORDS_PX.across && event.clientX <= box.right + NEAR_WORDS_PX.across
        && event.clientY >= box.top - NEAR_WORDS_PX.down && event.clientY <= box.bottom + NEAR_WORDS_PX.down
    })
    if (nearWords) return
    // Kept from selecting words, the press would also keep words selected before it, which the
    // reader would then take for what is marked.
    event.preventDefault()
    document.getSelection()?.removeAllRanges()
    holder.setPointerCapture?.(event.pointerId)
    const point = pointIn(event, holder)
    setDrawing({ page: Number(holder.dataset.page), from: point, to: point, pointer: event.pointerId, touch: false })
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drawing?.pointer === event.pointerId && !drawing.touch) setDrawing({ ...drawing, to: pointIn(event, event.currentTarget) })
  }
  // The box asked about at a point on a page, the smallest where boxes overlap, as it is drawn over
  // the larger. Presses go through boxes to the words under them, so a box is found by where it is.
  const boxAt = (page: number, point: Point) => boxes
    .filter(({ at }) => at.page === page && point.x * WHOLE >= at.x && point.x * WHOLE <= at.x + at.w && point.y * WHOLE >= at.y && point.y * WHOLE <= at.y + at.h)
    .sort((a, b) => a.at.w * a.at.h - b.at.w * b.at.h)[0]?.id
  const up = (event: PointerEvent<HTMLDivElement>) => {
    // Another button (a right click for the menu) is not a press here.
    if (event.button !== 0) return
    const holder = event.currentTarget
    const to = pointIn(event, holder)
    if (!drawing) {
      // A click on a box asked about opens its answer; a drag over words that ends on one doesn't.
      const asked = (event.target as Element).closest('.rd-slot') || document.getSelection()?.isCollapsed === false ? undefined : boxAt(Number(holder.dataset.page), to)
      if (asked) onOpen(asked)
      return
    }
    if (drawing.pointer !== event.pointerId) return
    setDrawing(null)
    const box = holder.getBoundingClientRect()
    const across = Math.abs(to.x - drawing.from.x) * box.width
    const down = Math.abs(to.y - drawing.from.y) * box.height
    const asked = boxAt(drawing.page, to)
    if (drawing.touch) {
      if (Math.max(across, down) >= CLICK_PX) return
      if (asked) onOpen(asked)
      else if (pictured.has(drawing.page)) markWhole(holder)
      return
    }
    if (across < BOX_MIN_PX || down < BOX_MIN_PX) {
      if (asked) onOpen(asked)
      return
    }
    const at: BoxAt = { ...boxBetween(drawing.from, to), page: drawing.page }
    onMarked({ text: boxLabel(at, `page ${drawing.page}`), at, rect: boxOnScreen(at, box) })
  }
  const key = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    const holder = event.currentTarget.closest<HTMLElement>('.rd-pdf-page')
    if (holder) markWhole(holder)
  }

  // Said as the reader says it while it reads the file, so the wait reads as one.
  if (!pdf || pdf.src !== src) return <p className="rd-loading" role="status">Reading {name}…</p>
  const live = drawing && !drawing.touch ? { ...boxBetween(drawing.from, drawing.to), page: drawing.page } : null
  // The larger drawn first, so a smaller box and its bubbles sit over a larger one.
  const drawn = [...boxes].sort((a, b) => b.at.w * b.at.h - a.at.w * a.at.h)
  return (
    <div ref={view} className="rd-pdf">
      {pdf.ratios.map((ratio, index) => {
        const number = index + 1
        return (
          <div key={number} className={`rd-pdf-page${askable ? ' askable' : ''}`} data-page={number} style={{ aspectRatio: `1 / ${ratio}` } as CSSProperties}
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrawing(null)} aria-label={`Page ${number}`} role="group">
            <canvas aria-hidden="true" />
            {/* A page with a picture or a chart can be asked about from the keyboard, as a picture can. */}
            {askable && pictured.has(number) && <span className="rd-pdf-target" role="button" tabIndex={0} aria-label={`Ask about page ${number}`} onKeyDown={key} />}
            <div className="rd-pdf-text" />
            {drawn.filter((each) => each.at.page === number).map((each) => (
              <div key={each.id} className={`rd-box ${each.look}${each.id === asking ? ' asking' : ''}${isWhole(each.at) ? ' whole' : ''}`} data-part={each.id} style={boxStyle(each.at)}>
                <span className="rd-slot" data-reader-chrome data-part={each.id} contentEditable={false} />
              </div>
            ))}
            {marking?.page === number && !live && <div className={`rd-box marking${isWhole(marking) ? ' whole' : ''}`} style={boxStyle(marking)} aria-hidden="true" />}
            {live?.page === number && <div className="rd-box drawing" style={boxStyle(live)} aria-hidden="true" />}
            {/* The bubbles after words marked on this page (`placeSlotOnPage`); React leaves it to them. */}
            <div className="rd-pdf-slots" />
            <span className="rd-pdf-number" aria-hidden="true">{number}</span>
          </div>
        )
      })}
    </div>
  )
}
