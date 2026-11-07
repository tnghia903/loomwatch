import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'

import { between, dialReading, parsed, plays, stretches, whereIn, type Play as Played } from '../../../lib/widgets/picturePlay'
import type { WidgetLabel, WidgetShape, WidgetSpec } from '../../../lib/widgets/types'
import { ChevronLeft, ChevronRight, Pause, Play } from '../../ui/icon'

/** How far a finger moves across the line of steps before it drags; a swipe up or down scrolls. */
const TOUCH_SLOP = 6

type Picture = Extract<WidgetSpec, { kind: 'picture' }>

/** The tallest a picture stands; a tall one is narrower instead. */
const MOST_HEIGHT = 440
/** What the daemon writes for a shape (ADR 0117); anything else isn't drawn. */
const PATH_DATA = /^[MLCZ0-9 .-]+$/

/**
 * A picture the agent drew (ADR 0117), in LoomWatch's own lines: every shape outlined in ink, a
 * filled one shaded, what belongs to no part fainter and finer, and the agent's words set on it in
 * our type. When the agent drew something again at each stage, the picture plays (`PlayingPicture`);
 * otherwise it is still, its parts numbered on it to tap or step through. Nothing is kept: it is for
 * reading.
 */
export function WidgetPicture({ spec, fresh = false }: { spec: Picture; fresh?: boolean }) {
  const plays = (spec.moves?.length ?? 0) > 0 && (spec.parts?.length ?? 0) >= 2
  return plays ? <PlayingPicture spec={spec} fresh={fresh} /> : <StillPicture spec={spec} />
}

function shapeClass(shape: WidgetShape, ...more: (string | false | undefined)[]): string {
  return [
    'wg-shape',
    shape.part === undefined ? 'loose' : '',
    shape.fill === 'dark' ? 'dark' : shape.fill ? 'light' : '',
    shape.dashed ? 'dashed' : '',
    ...more,
  ].filter(Boolean).join(' ')
}

/** The figure's frame: as wide as the chat allows, no taller than `MOST_HEIGHT`. */
function room(spec: Picture): CSSProperties {
  return { '--wg-picture-width': `${(MOST_HEIGHT * spec.width) / spec.height}px`, aspectRatio: `${spec.width} / ${spec.height}` } as CSSProperties
}

/** Words on the picture, as plain text where the agent put them; `n` is its part's number beside it. */
function Label({ label, spec, at, className, n }: { label: WidgetLabel; spec: Picture; at?: readonly number[]; className?: string; n?: number }) {
  const [x, y] = at ?? label.at
  return (
    <span className={['wg-label', label.anchor ?? 'start', className].filter(Boolean).join(' ')} style={{ left: `${(x / spec.width) * 100}%`, top: `${(y / spec.height) * 100}%` }}>
      {n !== undefined && <span className="wg-label-n" aria-hidden="true">{n}</span>}
      {label.text}
    </span>
  )
}

/** Words near the picture's edge are moved in, so they are read whole and never spill out of the
    chat: after each drawing, all are measured, then the ones out of bounds are moved. */
function useWordsInside(figureRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const figure = figureRef.current
    if (!figure) return
    const words = [...figure.querySelectorAll<HTMLElement>('.wg-label')]
    for (const word of words) word.style.translate = ''
    const box = figure.getBoundingClientRect()
    const moves = words.map((word) => {
      const at = word.getBoundingClientRect()
      return at.left < box.left ? box.left - at.left : at.right > box.right ? box.right - at.right : 0
    })
    words.forEach((word, which) => { if (moves[which]) word.style.translate = `${moves[which]}px 0` })
  })
}

function StillPicture({ spec }: { spec: Picture }) {
  const parts = spec.parts ?? []
  const figureRef = useRef<HTMLDivElement>(null)
  useWordsInside(figureRef)
  const [at, setAt] = useState(0)
  const count = parts.length
  const picked = count > 0 ? Math.min(at, count - 1) : -1
  const part = parts[picked]
  const step = (by: number) => setAt((picked + by + count) % count)
  return (
    <section className="wg wg-picture" aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      <div className="wg-figure" style={room(spec)} ref={figureRef}>
        <svg viewBox={`0 0 ${spec.width} ${spec.height}`} aria-hidden="true" focusable="false">
          {spec.shapes.filter((shape) => PATH_DATA.test(shape.d)).map((shape, which) => (
            <path key={which} d={shape.d} className={shapeClass(shape, shape.part !== undefined && shape.part === picked + 1 && 'on')} />
          ))}
        </svg>
        {(spec.labels ?? []).map((label, which) => (
          <Label key={which} label={label} spec={spec} className={label.part !== undefined && label.part === picked + 1 ? 'on' : undefined} />
        ))}
        {parts.map((one, which) => (
          <button
            key={which}
            type="button"
            className={`wg-part-n${which === picked ? ' on' : ''}`}
            style={{ left: `${(one.at[0] / spec.width) * 100}%`, top: `${(one.at[1] / spec.height) * 100}%`, '--k': which } as CSSProperties}
            aria-pressed={which === picked}
            aria-label={`Part ${which + 1}: ${one.label}`}
            title={one.label}
            onClick={() => setAt(which)}
          >
            <span aria-hidden="true">{which + 1}</span>
          </button>
        ))}
      </div>
      {part && (
        <div className="wg-step-text wg-picture-part" aria-live="polite">
          <div className="wg-picture-head">
            {count > 1 && <button type="button" className="iconbtn wg-picture-by" aria-label="Part before" onClick={() => step(-1)}><ChevronLeft size={16} aria-hidden="true" /></button>}
            <p className="wg-step-head">{picked + 1} of {count} · {part.label}</p>
            {count > 1 && <button type="button" className="iconbtn wg-picture-by" aria-label="Next part" onClick={() => step(1)}><ChevronRight size={16} aria-hidden="true" /></button>}
          </div>
          <p className="wg-step-body">{part.text}</p>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------
// A picture that plays
// ---------------------------------------------------------------------------------------------

const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * A picture that plays (ADR 0117, amended 7 November): what the agent drew at each stage is one
 * thing in motion. When the answer arrives it plays once, as its controls come into view: it shows
 * one step at a time, the thing named before it moves, rests on each step long enough to read its
 * words, moves one change at a time with the moving thing gold while it moves, and leaves a dotted
 * copy of the step it just left. At rest it is the last step and the one before, which is what
 * history, a copy and reduced motion show. A handle on the line of steps drags it back and forth,
 * and play runs it again. The
 * first time it plays it may stop before the step whose outcome surprises, to ask the agent's
 * question. The play belongs to the picture (`plays`), so the kept picture that takes the place of
 * the one drawn while the answer was written carries on where it was.
 */
function PlayingPicture({ spec, fresh }: { spec: Picture; fresh: boolean }) {
  const parts = spec.parts ?? []
  const count = parts.length
  const guess = spec.guess
  const key = useMemo(() => JSON.stringify(spec), [spec])
  const plan = useMemo(() => stretches(spec.parts ?? [], spec.guess), [spec])

  // Each stage's copy of a moving thing (which thing, which stage); the moves drawn point by point.
  const { copyOf, copyWords, moves } = useMemo(() => {
    const copyOf = new Map<number, { thing: number; stage: number }>()
    const copyWords = new Set<number>()
    const moves = (spec.moves ?? []).flatMap((move) => {
      const stages = [...move.stages].sort((a, b) => a.part - b.part)
      if (stages.length < 2) return []
      const drawable = stages.every((stage) => stage.shapes.every((shape) => spec.shapes[shape] && PATH_DATA.test(spec.shapes[shape].d)))
      return [{ stages, paths: drawable ? stages.map((stage) => stage.shapes.map((shape) => parsed(spec.shapes[shape].d))) : null }]
    })
    moves.forEach((move, thing) => move.stages.forEach((stage, at) => {
      for (const shape of stage.shapes) copyOf.set(shape, { thing, stage: at })
      for (const label of stage.labels ?? []) copyWords.add(label)
    }))
    return { copyOf, copyWords, moves }
  }, [spec])
  // A part's number stands beside its first word on the picture that stays put.
  const leads = useMemo(() => {
    const out = new Map<number, number>()
    const named = new Set<number>()
    ;(spec.labels ?? []).forEach((label, which) => {
      if (label.part !== undefined && !named.has(label.part) && !copyWords.has(which)) {
        named.add(label.part)
        out.set(which, label.part)
      }
    })
    return out
  }, [spec, copyWords])

  // Where the picture is, in steps (0 is the first), and the step whose words show (-1: at rest,
  // the last step with no step's words).
  const [t, setT] = useState(count - 1)
  const [shown, setShown] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [played, setPlayed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const pressed = useRef<{ x: number; y: number; touch: boolean } | null>(null)
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const frame = useRef(0)
  const asked = useRef(!(fresh && guess))
  const resumeAt = useRef(0)
  const controls = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const figureRef = useRef<HTMLDivElement>(null)
  useWordsInside(figureRef)

  const keep = useCallback((change: Partial<Played>) => {
    const was = plays.get(key) ?? { start: 0, asked: asked.current, waiting: null, note: null, done: false }
    plays.set(key, { ...was, ...change })
  }, [key])

  const halt = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
    setPlaying(false)
    keep({ done: true, waiting: null })
  }, [keep])

  const ask = useCallback((waiting: { ms: number; step: number }) => {
    asked.current = true
    resumeAt.current = waiting.ms
    setPlaying(false)
    setT(waiting.step)
    setShown(waiting.step)
    setAsking(true)
    keep({ asked: true, waiting })
  }, [keep])

  const run = useCallback((fromMs: number) => {
    cancelAnimationFrame(frame.current)
    setAsking(false)
    setPlaying(true)
    setPlayed(true)
    const start = performance.now() - fromMs
    keep({ start, asked: asked.current, waiting: null, done: false })
    const tick = (now: number) => {
      const ms = now - start
      const stretch = plan.find((one) => ms < one.start + one.ms)
      if (!stretch) {
        frame.current = 0
        setPlaying(false)
        setT(count - 1)
        setShown(-1)
        keep({ done: true })
        return
      }
      if (!asked.current && guess && stretch.to !== stretch.from && stretch.to === guess.before - 1) {
        frame.current = 0
        ask({ ms: stretch.start, step: stretch.from })
        return
      }
      setT(stretch.from + (stretch.to - stretch.from) * ((ms - stretch.start) / stretch.ms))
      setShown(stretch.to)
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }, [plan, count, guess, keep, ask])

  // A play under way carries on, here where this picture is drawn again. Otherwise, when it arrives
  // as news, it plays once as its controls come into view; never with reduced motion.
  useEffect(() => {
    const was = plays.get(key)
    if (was && !was.done) {
      asked.current = was.asked
      const soon = requestAnimationFrame(() => {
        setNote(was.note)
        if (was.waiting) ask(was.waiting)
        else run(performance.now() - was.start)
      })
      return () => cancelAnimationFrame(soon)
    }
    if (was || !fresh || reducedMotion()) return
    let started = false
    const go = () => { if (!started) { started = true; run(0) } }
    const node = controls.current
    if (typeof IntersectionObserver === 'undefined' || !node) {
      const soon = requestAnimationFrame(go)
      return () => cancelAnimationFrame(soon)
    }
    const watch = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { watch.disconnect(); go() }
    }, { threshold: [1] })
    watch.observe(node)
    return () => watch.disconnect()
  }, [key, fresh, run, ask])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const resting = shown < 0
  const moving = playing && Math.abs(t - Math.round(t)) > 1e-3
  const ended = played && resting && !playing
  const stepping = reducedMotion()

  const go = (to: number) => {
    halt()
    if (asking) { setAsking(false); asked.current = true }
    setT(to)
    setShown(Math.round(to))
  }
  const seek = (clientX: number) => {
    const box = track.current?.getBoundingClientRect()
    if (!box) return 0
    return Math.min(count - 1, Math.max(0, ((clientX - box.left - 12) / Math.max(1, box.width - 24)) * (count - 1)))
  }
  // A mouse or pen drags at once; a finger drags once it moves across, or taps, so a swipe up or
  // down the chat still scrolls it. Let go and it settles on the nearest step.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    pressed.current = { x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch' }
    if (pressed.current.touch) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragging(true)
    go(seek(event.clientX))
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const press = pressed.current
    if (dragging) { go(seek(event.clientX)); return }
    if (!press?.touch) return
    const across = Math.abs(event.clientX - press.x)
    if (across > TOUCH_SLOP && across > Math.abs(event.clientY - press.y)) {
      event.currentTarget.setPointerCapture?.(event.pointerId)
      setDragging(true)
      go(seek(event.clientX))
    }
  }
  const letGo = (event: PointerEvent<HTMLDivElement>) => {
    const press = pressed.current
    pressed.current = null
    if (dragging) { setDragging(false); go(Math.round(seek(event.clientX))); return }
    if (press?.touch && Math.hypot(event.clientX - press.x, event.clientY - press.y) <= TOUCH_SLOP) go(Math.round(seek(event.clientX)))
  }
  const onPointerCancel = () => { pressed.current = null; setDragging(false) }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = resting ? count - 1 : t
    const to = ({
      ArrowRight: Math.min(count - 1, Math.floor(at + 1e-6) + 1),
      ArrowUp: Math.min(count - 1, Math.floor(at + 1e-6) + 1),
      ArrowLeft: Math.max(0, Math.ceil(at - 1e-6) - 1),
      ArrowDown: Math.max(0, Math.ceil(at - 1e-6) - 1),
      Home: 0,
      End: count - 1,
    } as Record<string, number>)[event.key]
    if (to === undefined) return
    event.preventDefault()
    go(to)
  }
  const atEnd = resting || t >= count - 1 - 1e-6
  const onPlay = () => {
    if (playing) { halt(); return }
    if (stepping) { go(atEnd ? 0 : Math.min(count - 1, Math.floor(t + 1e-6) + 1)); return }
    if (atEnd) { setNote(null); keep({ note: null }); run(0); return }
    const step = Math.floor(t + 1e-6)
    run(plan.find((one) => one.from === step && one.to === step)?.start ?? 0)
  }
  const answer = (choice: number | null) => {
    const said = choice === null || !guess ? null
      : choice === guess.answer ? 'You guessed right.'
      : `You guessed “${guess.choices[choice]}”. It’s “${guess.choices[guess.answer]}”.`
    setNote(said)
    keep({ note: said })
    run(resumeAt.current)
  }
  const playName = playing ? 'Pause' : stepping ? (!resting && atEnd ? 'Back to step 1' : 'Next step') : ended ? 'Play again' : 'Play'

  // Only the step it is on is drawn (the owner's choice, 7 November, after three planes crowded a
  // phone): a moving thing where it is now, the stage it just left as a dotted outline with no
  // words, and nothing still to come. What builds up (a part with no copies) stays once drawn. At
  // rest it is the last step and the one before, with no step's words and nothing gold.
  const view = resting ? count - 1 : t
  const traces = moves.map((move) => {
    const { at: from, u } = whereIn(move.stages, view)
    return u > 0.15 ? from : from - 1
  })
  const shapeState = (shape: WidgetShape, which: number): string | undefined => {
    const copy = copyOf.get(which)
    if (copy) return copy.stage === traces[copy.thing] ? 'trace' : 'gone'
    if (shape.part === undefined) return undefined
    if (view < shape.part - 1.25) return 'gone'
    return !resting && shape.part === shown + 1 ? 'on' : undefined
  }
  const labelState = (label: WidgetLabel, which: number): string | undefined => {
    if (copyWords.has(which)) return 'gone'
    if (label.part === undefined) return undefined
    if (view < label.part - 1.25) return 'gone'
    return !resting && label.part === shown + 1 ? 'on' : undefined
  }
  const at = view
  // The handle says the step whose words show.
  const step = resting ? count - 1 : shown
  const part = parts[shown]
  // A dial (ADR 0117, amended 7 November): the steps are values of a cause the person turns, read
  // between them as the drawing moves.
  const dial = spec.dial
  const reading = dial ? dialReading(parts, at) : null

  return (
    <section className={`wg wg-picture plays${resting ? ' resting' : ''}`} aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      <div className="wg-figure" style={room(spec)} ref={figureRef}>
        <svg viewBox={`0 0 ${spec.width} ${spec.height}`} aria-hidden="true" focusable="false">
          {spec.shapes.map((shape, which) => PATH_DATA.test(shape.d) && (
            <path key={which} d={shape.d} className={shapeClass(shape, shapeState(shape, which))} />
          ))}
          {moves.map((move, m) => {
            if (!move.paths) return null
            const { at: from, u } = whereIn(move.stages, view)
            return move.stages[from].shapes.map((shape, j) => (
              <path key={`${m}-${j}`} d={between(move.paths![from][j], move.paths![from + 1][j], u)} className={shapeClass(spec.shapes[shape], moving && 'on')} />
            ))
          })}
        </svg>
        {(spec.labels ?? []).map((label, which) => (
          <Label key={which} label={label} spec={spec} className={labelState(label, which)} n={leads.get(which)} />
        ))}
        {moves.map((move, m) => {
          const { at: from, u } = whereIn(move.stages, view)
          const here = move.stages[from].labels ?? []
          const there = move.stages[from + 1].labels ?? []
          return here.map((label, j) => {
            const a = spec.labels?.[label]
            const b = spec.labels?.[there[j]]
            if (!a || !b) return null
            const point = [a.at[0] + (b.at[0] - a.at[0]) * u, a.at[1] + (b.at[1] - a.at[1]) * u]
            return <Label key={`${m}-${j}`} label={u < 0.5 ? a : b} spec={spec} at={point} className={moving ? 'on' : undefined} />
          })
        })}
      </div>
      <div className="wg-player" ref={controls}>
        <button type="button" className="wg-play" aria-label={playName} title={playName} onClick={onPlay}>
          {playing ? <Pause size={16} aria-hidden="true" /> : stepping ? <ChevronRight size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        </button>
        <div
          ref={track}
          className={`wg-scrub${dial ? ' dial' : ''}`}
          role="slider"
          tabIndex={0}
          aria-label={dial ?? 'Step'}
          aria-valuemin={1}
          aria-valuemax={count}
          aria-valuenow={step + 1}
          aria-valuetext={dial ? `${dial}: ${reading}` : `${step + 1} of ${count}: ${parts[step].label}`}
          style={{ '--run': at / (count - 1) } as CSSProperties}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={letGo}
          onPointerCancel={onPointerCancel}
          onKeyDown={onKeyDown}
        >
          <span className="wg-scrub-line" />
          <span className="wg-scrub-run" />
          {parts.map((_, which) => (
            <span key={which} className={`wg-scrub-stop${!resting && at >= which - 1e-6 ? ' done' : ''}`} style={{ '--at': which / (count - 1) } as CSSProperties} aria-hidden="true">{dial ? null : which + 1}</span>
          ))}
          <span className="wg-scrub-knob" aria-hidden="true">{dial ? null : step + 1}</span>
        </div>
      </div>
      {dial && (
        <div className="wg-dial-ends" aria-hidden="true"><span>{parts[0].label}</span><span>{parts[count - 1].label}</span></div>
      )}
      {/* One place a screen reader hears: the step's words, or the question waiting on you. */}
      <div aria-live="polite">
        {asking && guess && (
          <div className="wg-ask" role="group" aria-label={guess.question}>
            <p className="wg-ask-question">{guess.question}</p>
            <div className="wg-ask-choices">
              {guess.choices.map((choice, which) => (
                <button key={which} type="button" className="wg-ask-choice" onClick={() => answer(which)}>{choice}</button>
              ))}
              <button type="button" className="wg-ask-skip" onClick={() => answer(null)}>Skip</button>
            </div>
          </div>
        )}
        {!asking && part && (
          <div className="wg-step-text wg-picture-part">
            {/* A dial's reading moves with every frame: seen, but a screen reader hears the step it settles on. */}
            <p className="wg-step-head">{dial ? <><span aria-hidden="true">{dial} · {reading}</span><span className="visually-hidden">{dial} · {part.label}</span></> : `${shown + 1} of ${count} · ${part.label}`}</p>
            {note && guess && shown === guess.before - 1 && <p className="wg-picture-note">{note}</p>}
            <p className="wg-step-body">{part.text}</p>
          </div>
        )}
      </div>
    </section>
  )
}
