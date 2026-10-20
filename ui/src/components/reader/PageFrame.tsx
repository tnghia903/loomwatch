import { useEffect, useRef, useState } from 'react'

import { PAGE_SANDBOX, pageDocument, pageMessage } from '../../lib/files/pageFrame'

export interface Marked {
  text: string
  /** Where the marked words are on screen. */
  rect: { top: number; bottom: number; left: number; right: number }
}

interface PageFrameProps {
  path: string
  name: string
  html: string
  /** The parts asked about, the one in the message box, and the one a face is pointing at. */
  marks: { asked: readonly string[]; asking: string | null; focus: string | null }
  onMarked: (marked: Marked | null) => void
  /** Changes when the marked words have been asked about, so the page lets go of them. */
  cleared: number
}

/**
 * A web page an agent made, running in its own sandbox inside the reader (lib/files/pageFrame.ts).
 * What is marked in it reaches the reader through the page's script, by message, in the reader's own
 * coordinates; the parts asked about go back the same way.
 */
export function PageFrame({ path, name, html, marks, onMarked, cleared }: PageFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [doc, setDoc] = useState<{ html: string; ready: string } | null>(null)
  const [ready, setReady] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void pageDocument(html, path, controller.signal).then((ready) => { if (!controller.signal.aborted) setDoc({ html, ready }) }, () => undefined)
    return () => controller.abort()
  }, [html, path])

  const marked = useRef(onMarked)
  useEffect(() => { marked.current = onMarked }, [onMarked])
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const element = frame.current
      if (!element || event.source !== element.contentWindow) return
      const message = pageMessage(event.data)
      if (!message) return
      if (message.type === 'ready') { setReady((count) => count + 1); return }
      const box = element.getBoundingClientRect()
      const rect = message.rect
      // Words scrolled out of the frame's view have nothing to point at.
      if (!message.text.trim() || !rect || rect.bottom < 0 || rect.top > box.height) { marked.current(null); return }
      marked.current({ text: message.text, rect: { top: box.top + rect.top, bottom: box.top + rect.bottom, left: box.left + rect.left, right: box.left + rect.right } })
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [])

  const { asked, asking, focus } = marks
  useEffect(() => {
    if (ready === 0) return
    frame.current?.contentWindow?.postMessage({ lw: 'reader', type: 'marks', asked, asking, focus }, '*')
  }, [ready, asked, asking, focus])
  useEffect(() => {
    if (cleared > 0) frame.current?.contentWindow?.postMessage({ lw: 'reader', type: 'clear' }, '*')
  }, [cleared])

  const shown = doc?.html === html ? doc.ready : null
  return shown === null
    ? <p className="rd-loading" role="status">Setting up the page…</p>
    : <iframe ref={frame} className="rd-frame" title={`The page ${name}`} sandbox={PAGE_SANDBOX} srcDoc={shown} referrerPolicy="no-referrer" />
}
