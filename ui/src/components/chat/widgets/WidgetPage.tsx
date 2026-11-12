import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { FRAME_SANDBOX, frameDocument, randomToken } from '../../../lib/widgets/page/document'
import { lookOf, pageFonts } from '../../../lib/widgets/page/style'
import { checkedValue, pageValues } from '../../../lib/widgets/page/values'
import type { KeptWidget, WidgetSpec, WidgetState } from '../../../lib/widgets/types'
import { useHeldState } from '../../../lib/widgets/useHeldState'
import { Pause, Play } from '../../ui/icon'

type Page = Extract<WidgetSpec, { kind: 'page' }>

/** The tallest a page's frame stands in the chat; a taller page scrolls inside it. */
const MOST_HEIGHT = 640
/** How long a page's frame has to say it started. */
export const START_MS = 5000
/** The event a page's words for the message box travel up the chat in (`TeamChat` puts them
    there). Only after a tap in the page, and never sent by itself. */
export const DRAFT_EVENT = 'loomwatch:draft'

export interface WidgetPageProps {
  kept: KeptWidget
  onChange: (n: number, state: WidgetState) => Promise<KeptWidget>
  /** The answer is still being written: what the page sets shows, and isn't kept yet. */
  live?: boolean
  /** Who made it, as the chat names them. */
  by?: string
}

/**
 * A widget the agent wrote itself (ADR 0125): its page, drawn in a frame that reaches nothing,
 * under a line saying who drew it. LoomWatch works out the figures the page declares and sends
 * them in; the page can ask back for only four things: an input set, its height, words for the
 * message box, and to say it broke. Each is checked here before anything happens.
 */
export function WidgetPage({ kept, onChange, live = false, by }: WidgetPageProps) {
  const spec = kept.spec as Page
  const held = useHeldState(kept, onChange)
  const frame = useRef<HTMLIFrameElement>(null)
  const [token] = useState(() => randomToken())
  const [nonce] = useState(() => randomToken())
  // The theme at the start only: a later change reaches the page as its look, without drawing it again.
  const [theme] = useState(() => lookOf(document.documentElement).theme)
  const srcDoc = useMemo(() => frameDocument({ html: spec.html, script: spec.script }, token, nonce, theme), [spec.html, spec.script, token, nonce, theme])
  const [height, setHeight] = useState(120)
  const [broke, setBroke] = useState(false)
  const [moving, setMoving] = useState(false)
  const [paused, setPaused] = useState(false)
  const [ready, setReady] = useState(false)

  const inputs = useMemo(() => spec.inputs ?? [], [spec.inputs])
  const values = useMemo(() => pageValues(spec, held.state), [spec, held.state])
  const set = held.state && 'values' in held.state ? held.state.values : {}

  const post = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ ...message, lw: token }, '*')
  }, [token])

  // The latest of what a message may need, without the listener changing as you type.
  const latest = useRef({ values, set, live, held, kept, onChange, inputs, spec, by })
  useLayoutEffect(() => {
    latest.current = { values, set, live, held, kept, onChange, inputs, spec, by }
  })

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as Record<string, unknown> | null
      if (!frame.current || event.source !== frame.current.contentWindow || !message || message.lw !== token) return
      const now = latest.current
      switch (message.t) {
        case 'ready':
          setReady(true)
          // With the chat's own fonts, read once and sent as data: the frame loads nothing.
          void pageFonts().then((fonts) => {
            const look = lookOf(document.documentElement)
            post({ t: 'init', look: { ...look, css: look.css + fonts }, values: latest.current.values })
          })
          break
        case 'height': {
          const px = Number(message.px)
          if (Number.isFinite(px)) setHeight(Math.min(MOST_HEIGHT, Math.max(24, Math.ceil(px))))
          break
        }
        case 'set': {
          const input = now.inputs.find((each) => each.id === message.id)
          if (!input) return
          const value = checkedValue(input, message.value)
          if (value === null) return
          const next: WidgetState = { values: { ...now.set, [input.id]: value } }
          // Kept only when the person set it, by a tap or a key, and the answer is written.
          if (message.keep === true && message.gesture === true && !now.live) now.held.keep(next)
          else now.held.show(next)
          break
        }
        case 'preset': {
          const preset = (now.spec.presets ?? [])[Number(message.at)]
          if (!preset) return
          const next: WidgetState = { values: { ...preset.values } }
          if (message.gesture === true && !now.live) now.held.keep(next)
          else now.held.show(next)
          break
        }
        case 'draft':
          if (typeof message.text === 'string' && message.text.trim()) {
            frame.current.dispatchEvent(new CustomEvent(DRAFT_EVENT, { bubbles: true, detail: { text: message.text.slice(0, 2000), by: now.by } }))
          }
          break
        case 'moving':
          setMoving(message.on === true)
          break
        case 'broke':
          setBroke(true)
          if (!now.live) {
            const why = String(message.why ?? '').slice(0, 200)
            const state: WidgetState = 'values' in (now.held.state ?? {}) ? { values: now.set, broke: why } : { broke: why }
            now.onChange(now.kept.n, state).catch(() => {})
          }
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [token, post])

  // A frame that never starts, as when a browser won't run its renderer, says so instead of
  // standing empty.
  useEffect(() => {
    if (ready || broke) return
    const wait = window.setTimeout(() => {
      setBroke(true)
      const now = latest.current
      if (!now.live) now.onChange(now.kept.n, { broke: 'it never started' }).catch(() => {})
    }, START_MS)
    return () => window.clearTimeout(wait)
  }, [ready, broke])
  // Figures the person changes reach the page; so does the theme.
  useEffect(() => {
    if (ready) post({ t: 'values', values })
  }, [ready, values, post])
  useEffect(() => {
    if (!ready) return
    const root = document.documentElement
    const send = () => void pageFonts().then((fonts) => {
      const look = lookOf(root)
      post({ t: 'look', look: { ...look, css: look.css + fonts } })
    })
    const watcher = new MutationObserver(send)
    watcher.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)')
    dark?.addEventListener?.('change', send)
    return () => {
      watcher.disconnect()
      dark?.removeEventListener?.('change', send)
    }
  }, [ready, post])
  // A page out of sight stops moving.
  useEffect(() => {
    const element = frame.current
    if (!ready || !element || typeof IntersectionObserver === 'undefined') return
    const seen = new IntersectionObserver(([entry]) => post({ t: 'seen', on: entry?.isIntersecting ?? true }))
    seen.observe(element)
    return () => seen.disconnect()
  }, [ready, post])

  const togglePause = () => {
    const next = !paused
    setPaused(next)
    post({ t: 'pause', on: next })
  }

  return (
    <section className="wg wg-page" aria-label={spec.title}>
      <div className="wg-page-head">
        <div className="wg-page-name">
          <p className="wg-title">{spec.title}</p>
          {by && <p className="wg-page-by">Drawn by {by}</p>}
        </div>
        {moving && !broke && (
          <button type="button" className="wg-play" aria-label={paused ? 'Play' : 'Pause'} title={paused ? 'Play' : 'Pause'} onClick={togglePause}>
            {paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
          </button>
        )}
      </div>
      {broke
        ? <p className="wg-unshown">This drawing didn’t work. The words still answer it; reply if you want {by ? `${by} to try again` : 'it tried again'}.</p>
        : <iframe ref={frame} className="wg-page-frame" title={spec.title} sandbox={FRAME_SANDBOX} srcDoc={srcDoc} referrerPolicy="no-referrer" style={{ height }} />}
      {held.error && <p className="chat-failed" role="alert">{held.error}</p>}
    </section>
  )
}
