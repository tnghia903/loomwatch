import { useEffect, useRef, useState } from 'react'

import type { PartAt } from '../../lib/chat/client'
import { PAGE_SANDBOX, pageDocument, pageFile, pageMessage, type PageMark, type PagePart } from '../../lib/files/pageFrame'

export interface Marked {
  /** The marked words, or what a part that isn't words is called ("The top right of the picture"). */
  text: string
  /** Where the marked part is on screen. */
  rect: { top: number; bottom: number; left: number; right: number }
  /** Where a part that isn't words is in its file (ADR 0091). */
  at?: PartAt
  /** A part of a web page as it was shown, drawn by the page, sent with the question. */
  picture?: File
}

interface PageFrameProps {
  path: string
  name: string
  html: string
  /** The asks about parts of the page, marked in it with their bubbles, and the part in the message box. */
  marks: { parts: readonly PageMark[]; asking: string | null }
  /** The Pick switch is on: a click on the page marks the part under it (ADR 0091). */
  picking: boolean
  /** Counts each time picking was turned on from the keyboard: the page takes the keys, for its arrows to walk its parts, and outlines where they start. */
  pickKeys: number
  onMarked: (marked: Marked | null) => void
  /** Where the parts asked about are, line by line on screen, as the page scrolls. */
  onParts?: (parts: PagePart[], frame: Marked['rect']) => void
  /** An ask's bubble, or the words it is about, was clicked: its answer opens, by its key. */
  onOpen?: (key: string) => void
  /** Escape was pressed in the page with nothing marked in it. */
  onEscape?: () => void
  /** An ask's bubble was pointed at, where it is on screen (`now`: reached with the keyboard), or no longer is (`key` null). */
  onHover?: (key: string | null, at: Marked['rect'] | null, now: boolean) => void
  /** Changes when the marked words have been asked about, so the page lets go of them. */
  cleared: number
  /** While picking, the arrow keys reached a part of the page: what it is called. */
  onPointing?: (text: string) => void
}

/**
 * A web page an agent made, running in its own sandbox inside the reader (lib/files/pageFrame.ts).
 * What is marked in it reaches the reader through the page's script, by message, in the reader's own
 * coordinates; the parts asked about go back the same way, and so do the files beside it that the
 * page asks for as it runs, read inside its own folder.
 */
export function PageFrame({ path, name, html, marks, picking, pickKeys, onMarked, onParts, onOpen, onEscape, onHover, cleared, onPointing }: PageFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const page = useRef(path)
  useEffect(() => { page.current = path }, [path])
  // The picture of the thing marked now: the page sends it once, and only where the thing is as it moves.
  const thing = useRef<{ path: string; picture: File | undefined } | null>(null)
  const [doc, setDoc] = useState<{ html: string; ready: string } | null>(null)
  const [ready, setReady] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void pageDocument(html, path, controller.signal).then((ready) => { if (!controller.signal.aborted) setDoc({ html, ready }) }, () => undefined)
    return () => controller.abort()
  }, [html, path])

  const marked = useRef(onMarked)
  const placed = useRef(onParts)
  const opened = useRef(onOpen)
  const escaped = useRef(onEscape)
  const hovered = useRef(onHover)
  const pointed = useRef(onPointing)
  useEffect(() => {
    marked.current = onMarked
    placed.current = onParts
    opened.current = onOpen
    escaped.current = onEscape
    hovered.current = onHover
    pointed.current = onPointing
  }, [onMarked, onParts, onOpen, onEscape, onHover, onPointing])
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const element = frame.current
      if (!element || event.source !== element.contentWindow) return
      const message = pageMessage(event.data)
      if (!message) return
      if (message.type === 'ready') { setReady((count) => count + 1); return }
      if (message.type === 'open') { opened.current?.(message.key); return }
      if (message.type === 'escape') { escaped.current?.(); return }
      if (message.type === 'pointing') { pointed.current?.(message.text); return }
      if (message.type === 'load') {
        const asking = element.contentWindow
        void pageFile(page.current, message.url).then((file) => {
          asking?.postMessage({ lw: 'reader', type: 'loaded', id: message.id, ...file }, '*', file.body ? [file.body] : [])
        })
        return
      }
      const box = element.getBoundingClientRect()
      const onScreen = (rect: Marked['rect']) => ({ top: box.top + rect.top, bottom: box.top + rect.bottom, left: box.left + rect.left, right: box.left + rect.right })
      if (message.type === 'hover') {
        hovered.current?.(message.key, message.key && message.rect ? onScreen(message.rect) : null, message.now)
        return
      }
      if (message.type === 'parts') {
        placed.current?.(message.parts.map((part) => ({ ...part, rects: part.rects.map(onScreen) })), { top: box.top, bottom: box.bottom, left: box.left, right: box.right })
        return
      }
      const rect = message.rect
      const inView = Boolean(rect && rect.bottom >= 0 && rect.top <= box.height)
      if (message.type === 'thing') {
        const stem = page.current.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'page'
        if (message.picture || thing.current?.path !== message.path) {
          thing.current = { path: message.path, picture: message.picture ? new File([message.picture], `${stem} ${message.what}.png`, { type: 'image/png' }) : undefined }
        }
        const picture = thing.current.picture
        marked.current(inView ? { text: message.text, rect: onScreen(message.rect), at: { kind: 'element', what: message.what, path: message.path }, ...(picture ? { picture } : {}) } : null)
        return
      }
      thing.current = null
      // Words scrolled out of the frame's view have nothing to point at.
      marked.current(message.text.trim() && inView ? { text: message.text, rect: onScreen(rect!) } : null)
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [])

  // Picking first, so a page that has just loaded is told its marks last.
  useEffect(() => {
    if (ready > 0) frame.current?.contentWindow?.postMessage({ lw: 'reader', type: 'pick', on: picking }, '*')
  }, [ready, picking])
  useEffect(() => {
    if (ready === 0) return
    frame.current?.contentWindow?.postMessage({ lw: 'reader', type: 'marks', ...marks }, '*')
  }, [ready, marks])
  useEffect(() => {
    if (cleared > 0) frame.current?.contentWindow?.postMessage({ lw: 'reader', type: 'clear' }, '*')
  }, [cleared])
  useEffect(() => {
    if (pickKeys === 0) return
    frame.current?.focus()
    frame.current?.contentWindow?.postMessage({ lw: 'reader', type: 'pick', on: true, keys: true }, '*')
  }, [pickKeys])

  const shown = doc?.html === html ? doc.ready : null
  return shown === null
    ? <p className="rd-loading" role="status">Setting up the page…</p>
    : <iframe ref={frame} className="rd-frame" title={`The page ${name}`} sandbox={PAGE_SANDBOX} srcDoc={shown} referrerPolicy="no-referrer" />
}
