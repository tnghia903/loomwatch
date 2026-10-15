import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent, type ReactNode } from 'react'

import type { FigurePart } from '../../lib/library/figure'
import type { AllowSwitch } from '../../lib/team-file/types'
import { placeFace, WorkbenchScene, type BenchAnchor, type BenchAnchors, type BenchFace, type BenchFaces, type BenchView } from './workbenchScene'

export interface BenchLabel {
  anchor: BenchAnchor
  part: FigurePart
  /** What the label says, always in words, so the bench needs no legend. */
  text?: ReactNode
  /** The same in a word or two, for a narrow stage. */
  short?: ReactNode
  /** Its accessible name: what it is and what it is set to. */
  label: string
  /** A plate that already says it in the picture gets only a focusable hit area. */
  place: 'above' | 'below' | 'right' | 'plate'
}

export interface AgentFigureProps {
  view: BenchView
  labels: readonly BenchLabel[]
  open: FigurePart | null
  onPart: (part: FigurePart) => void
  onKey: (key: AllowSwitch, given: boolean) => void
  onSkillDrop: (name: string) => void
  skillMime: string
  /** The bench could not be drawn here: the page falls back to plain controls. */
  onFail: (message: string) => void
}

const SCENE_URL = '/agent/workbench.glb'

/**
 * The workbench, drawn live (workbenchScene.ts), with its labels laid over it. Each label is a
 * button for its part and follows its object every frame, so the words stay on the things they
 * name. The words on the nameplate, the job sheet and the laptop's lid are page text too, laid
 * over their faces: painted into the picture they blurred, because the bench is drawn small.
 * Loaded only when Build by hand opens, because it brings three.js with it.
 */
export default function AgentFigure({ view, labels, open, onPart, onKey, onSkillDrop, skillMime, onFail }: AgentFigureProps) {
  const stage = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLCanvasElement>(null)
  const scene = useRef<WorkbenchScene | null>(null)
  const tags = useRef(new Map<BenchAnchor, HTMLElement>())
  const faces = useRef(new Map<BenchFace, HTMLElement>())
  const width = useRef(0)
  const latest = useRef({ view, onPart, onKey, onFail })
  useLayoutEffect(() => { latest.current = { view, onPart, onKey, onFail } })
  const [ready, setReady] = useState(false)
  const [cursor, setCursor] = useState<'default' | 'pointer' | 'grab' | 'grabbing'>('default')

  useEffect(() => {
    const canvas = surface.current
    const box = stage.current
    if (!canvas || !box) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    // The words on each face, and each label, follow their object; a label is kept inside the
    // stage so none runs off its edge.
    const place = (anchors: BenchAnchors, quads: BenchFaces) => {
      for (const [face, element] of faces.current) placeFace(element, quads[face])
      for (const [anchor, element] of tags.current) {
        const at = anchors[anchor]
        const wide = (element.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0
        const right = element.classList.contains('right')
        const x = !wide || !width.current ? at.x
          : right ? Math.min(at.x, width.current - wide - 14)
          : Math.min(Math.max(at.x, wide / 2 + 4), width.current - wide / 2 - 4)
        element.style.transform = `translate(${x.toFixed(1)}px, ${at.y.toFixed(1)}px)`
      }
    }
    let made: WorkbenchScene
    try {
      made = new WorkbenchScene(canvas, {
        onPart: (part) => latest.current.onPart(part),
        onKey: (key, given) => latest.current.onKey(key, given),
        onHover: (part, grab) => setCursor((current) => (current === 'grabbing' ? current : grab ? 'grab' : part ? 'pointer' : 'default')),
        onFrame: place,
      }, reduced)
    } catch (failed) {
      latest.current.onFail(failed instanceof Error ? failed.message : String(failed))
      return
    }
    scene.current = made
    made.set(latest.current.view)
    let cancelled = false
    made.load(SCENE_URL).then(() => { if (!cancelled) setReady(true) }, (failed: unknown) => { if (!cancelled) latest.current.onFail(failed instanceof Error ? failed.message : String(failed)) })

    const resize = new ResizeObserver(([entry]) => { if (entry) { width.current = entry.contentRect.width; made.resize(entry.contentRect.width, entry.contentRect.height) } })
    resize.observe(box)
    // Draw only while it can be seen.
    let seen = true
    const sync = () => { if (seen && document.visibilityState === 'visible') made.start(); else made.stop() }
    const watch = new IntersectionObserver(([entry]) => { seen = entry?.isIntersecting ?? true; sync() })
    watch.observe(box)
    document.addEventListener('visibilitychange', sync)
    sync()
    return () => {
      cancelled = true
      resize.disconnect()
      watch.disconnect()
      document.removeEventListener('visibilitychange', sync)
      made.dispose()
      scene.current = null
    }
  }, [])

  useEffect(() => { scene.current?.set(view) }, [view])

  const face = (which: BenchFace) => (element: HTMLDivElement | null) => { if (element) faces.current.set(which, element); else faces.current.delete(which) }
  const name = view.look.name.trim() || 'New agent'
  const does = view.does.trim()
  const instructions = view.look.instructions.trim()
  const appWord = view.appName || 'No app yet'

  const at = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return [event.clientX - rect.left, event.clientY - rect.top] as const
  }
  const dragOver = (event: DragEvent) => {
    if (event.dataTransfer.types.includes(skillMime)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }
  }
  const drop = (event: DragEvent) => {
    const name = event.dataTransfer.getData(skillMime)
    if (!name) return
    event.preventDefault()
    onSkillDrop(name)
  }

  return (
    <div ref={stage} className={`bench-stage${ready ? ' ready' : ''}`} onDragOver={dragOver} onDrop={drop}>
      <canvas
        ref={surface}
        className="bench-canvas"
        style={{ cursor }}
        aria-hidden="true"
        onPointerMove={(event) => { const [x, y] = at(event); scene.current?.pointerMove(x, y) }}
        onPointerDown={(event) => {
          const [x, y] = at(event)
          if (scene.current?.pointerDown(x, y)) { event.currentTarget.setPointerCapture(event.pointerId); setCursor('grabbing') }
        }}
        onPointerUp={(event) => { const [x, y] = at(event); scene.current?.pointerUp(x, y); setCursor('default'); scene.current?.pointerMove(x, y) }}
        onPointerCancel={() => { scene.current?.pointerLeave(); setCursor('default') }}
        onPointerLeave={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) scene.current?.pointerLeave() }}
      />
      {!ready && <p className="bench-loading t-meta">Setting up the bench…</p>}
      <div className="bench-faces" aria-hidden="true">
        <div ref={face('name')} className="bench-face bench-face-name"><p><b>{name}</b>{does && <span>{does}</span>}</p></div>
        <div ref={face('job')} className={`bench-face bench-face-job${instructions ? '' : ' empty'}`}><p>{instructions || 'Nothing written yet.'}</p></div>
        <div ref={face('app')} className={`bench-face bench-face-app${view.appName ? '' : ' empty'}`} style={{ '--chars': appWord.length } as CSSProperties}><p>{appWord}</p></div>
      </div>
      {labels.map((tag) => (
        <button
          key={tag.anchor}
          ref={(element) => { if (element) tags.current.set(tag.anchor, element); else tags.current.delete(tag.anchor) }}
          type="button"
          className={`bench-tag ${tag.place}${open === tag.part ? ' open' : ''}`}
          hidden={!ready}
          aria-label={tag.label}
          aria-expanded={open === tag.part}
          title={tag.place === 'plate' ? tag.label : undefined}
          onClick={() => onPart(tag.part)}
        >
          {tag.place !== 'plate' && <span><span className="bench-long">{tag.text}</span><span className="bench-short">{tag.short ?? tag.text}</span></span>}
        </button>
      ))}
    </div>
  )
}
