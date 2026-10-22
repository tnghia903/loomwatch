import { useEffect, useRef, useState } from 'react'

import { PAGE_SANDBOX, pageDocument, pageMessage, type PageMark, type PagePart } from '../../lib/files/pageFrame'

export interface Marked {
  text: string
  /** Where the marked words are on screen. */
  rect: { top: number; bottom: number; left: number; right: number }
}

interface PageFrameProps {
  path: string
  name: string
  html: string
  /** The parts asked about, marked in the page with their bubbles, and the one in the message box. */
  marks: { parts: readonly PageMark[]; asking: string | null }
  onMarked: (marked: Marked | null) => void
  /** Where the parts asked about are, line by line on screen, as the page scrolls. */
  onParts?: (parts: PagePart[], frame: Marked['rect']) => void
  /** A part asked about was clicked: its answer opens. */
  onOpen?: (text: string) => void
  /** Escape was pressed in the page with nothing marked in it. */
  onEscape?: () => void
  /** Changes when the marked words have been asked about, so the page lets go of them. */
  cleared: number
}

/**
 * A web page an agent made, running in its own sandbox inside the reader (lib/files/pageFrame.ts).
 * What is marked in it reaches the reader through the page's script, by message, in the reader's own
 * coordinates; the parts asked about go back the same way.
 */
export function PageFrame({ path, name, html, marks, onMarked, onParts, onOpen, onEscape, cleared }: PageFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null)
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
  useEffect(() => {
    marked.current = onMarked
    placed.current = onParts
    opened.current = onOpen
    escaped.current = onEscape
  }, [onMarked, onParts, onOpen, onEscape])
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const element = frame.current
      if (!element || event.source !== element.contentWindow) return
      const message = pageMessage(event.data)
      if (!message) return
      if (message.type === 'ready') { setReady((count) => count + 1); return }
      if (message.type === 'open') { opened.current?.(message.text); return }
      if (message.type === 'escape') { escaped.current?.(); return }
      const box = element.getBoundingClientRect()
      const onScreen = (rect: Marked['rect']) => ({ top: box.top + rect.top, bottom: box.top + rect.bottom, left: box.left + rect.left, right: box.left + rect.right })
      if (message.type === 'parts') {
        placed.current?.(message.parts.map((part) => ({ ...part, rects: part.rects.map(onScreen) })), { top: box.top, bottom: box.bottom, left: box.left, right: box.right })
        return
      }
      const rect = message.rect
      // Words scrolled out of the frame's view have nothing to point at.
      marked.current(message.text.trim() && rect && rect.bottom >= 0 && rect.top <= box.height ? { text: message.text, rect: onScreen(rect) } : null)
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [])

  useEffect(() => {
    if (ready === 0) return
    frame.current?.contentWindow?.postMessage({ lw: 'reader', type: 'marks', ...marks }, '*')
  }, [ready, marks])
  useEffect(() => {
    if (cleared > 0) frame.current?.contentWindow?.postMessage({ lw: 'reader', type: 'clear' }, '*')
  }, [cleared])

  const shown = doc?.html === html ? doc.ready : null
  return shown === null
    ? <p className="rd-loading" role="status">Setting up the page…</p>
    : <iframe ref={frame} className="rd-frame" title={`The page ${name}`} sandbox={PAGE_SANDBOX} srcDoc={shown} referrerPolicy="no-referrer" />
}
