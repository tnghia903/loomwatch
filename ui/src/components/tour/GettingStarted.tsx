import { ArrowLeft, ArrowRight, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { placeCard, type Box } from '../../lib/tour/place'
import { FIRST_WORKSPACE_STEP, stepIndex, TOUR_STEPS, type TourContext, type TourStepId, type TourStepView } from '../../lib/tour/steps'
import { endTour, goToStep, useTourState } from '../../lib/tour/store'

/** How often the guide re-reads the page: where its target is, and whether an action happened. */
const TICK_MS = 250
/** A target gone this long is gone, not mid-repaint (a dialog closing, a view switching). */
const MISSING_MS = 700
const CARD_WIDTH = 320
/** Numbered steps: everything between the welcome card and the closing one. */
const NUMBERED = TOUR_STEPS.filter((step) => step.id !== 'welcome' && step.id !== 'done')

type Screen = 'home' | 'workspace'
type Viewport = { width: number; height: number }

interface Snapshot {
  /** The step this was read for; a snapshot from the previous step is never drawn. */
  stepId: TourStepId
  screen: Screen | null
  view: TourStepView | null
  /** The highlighted element, in viewport pixels; null for a centred card. */
  target: Box | null
  viewport: Viewport
  /** A team step while Home is showing: the guide waits for the operator to open a team. */
  resume: boolean
}

function readScreen(): Screen | null {
  if (document.querySelector('[data-tour="workspace"]')) return 'workspace'
  if (document.querySelector('[data-tour="home"]')) return 'home'
  return null
}

function shown(element: Element): boolean {
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  return typeof element.checkVisibility === 'function' ? element.checkVisibility({ visibilityProperty: true }) : true
}

function findTarget(selectors: readonly string[]): { element: Element; box: Box } | null {
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!shown(element)) continue
      const rect = element.getBoundingClientRect()
      return { element, box: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) } }
    }
  }
  return null
}

function outOfView(box: Box, viewport: Viewport): boolean {
  return box.top < 0 || box.left < 0 || box.top + Math.min(box.height, viewport.height) > viewport.height || box.left + Math.min(box.width, viewport.width) > viewport.width
}

function advanceFrom(index: number) {
  const following = TOUR_STEPS[index + 1]
  if (following) goToStep(following.id)
  else endTour('finished')
}

export interface GettingStartedProps {
  readyApps: readonly string[]
  appsLoading: boolean
}

/**
 * The getting-started guide: one card at a time, pointing at the part of the screen it explains.
 *
 * It never blocks the page. The dim and the ring let every click through, because most steps ask
 * the operator to do the real thing (create a team, press Run team, type a request), and the guide
 * moves on when it sees that happen. It reads the page rather than being told, so the screens it
 * explains need nothing but `data-tour` names.
 */
export function GettingStarted({ readyApps, appsLoading }: GettingStartedProps) {
  const state = useTourState()
  const index = state?.status === 'active' ? stepIndex(state.step) : -1
  const step = index >= 0 ? TOUR_STEPS[index] : null
  const runAtStepStart = state?.runAtStepStart ?? null
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const context = useRef<TourContext>({ readyApps, appsLoading })
  useLayoutEffect(() => { context.current = { readyApps, appsLoading } }, [readyApps, appsLoading])

  useEffect(() => {
    if (!step) return
    let missingSince: number | null = null
    // Bring the target into view once per step (the run view, for one, grows as a run starts and
    // pushes its stages below the fold); after that, scrolling is the operator's.
    let scrolled = false
    const tick = () => {
      const screen = readScreen()
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      let next: Snapshot = { stepId: step.id, screen, view: null, target: null, viewport, resume: false }
      if (screen === null) {
        // Between pages ("Opening team…"): say nothing rather than point at what is leaving.
      } else if (step.screen === 'home' && screen === 'workspace') {
        // A team is open, whether just created or picked from the list: carry on inside it.
        goToStep(FIRST_WORKSPACE_STEP)
        return
      } else if (step.screen === 'workspace' && screen === 'home') {
        next = { ...next, resume: true }
      } else {
        const view = step.view(context.current)
        if (view.advance === 'action' && step.done?.({ runAtStepStart })) {
          advanceFrom(index)
          return
        }
        const found = view.target ? findTarget(view.target) : null
        if (view.target && !found) {
          missingSince ??= Date.now()
          if (step.whenMissing && Date.now() - missingSince >= MISSING_MS) {
            goToStep(step.whenMissing)
            return
          }
        } else {
          missingSince = null
        }
        if (found && !scrolled && outOfView(found.box, viewport)) {
          scrolled = true
          // Instant, not smooth: a smooth scroll only advances while the page paints, so a tab in the
          // background would be left with its card pointing below the fold.
          found.element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' })
          return
        }
        next = { ...next, view, target: found?.box ?? null }
      }
      setSnapshot((current) => (current && JSON.stringify(current) === JSON.stringify(next) ? current : next))
    }
    tick()
    const timer = window.setInterval(tick, TICK_MS)
    window.addEventListener('resize', tick)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('resize', tick)
    }
  }, [step, index, runAtStepStart])

  if (!step || !snapshot || snapshot.stepId !== step.id || snapshot.screen === null) return null
  if (snapshot.resume) {
    return (
      <TourCard
        key="resume"
        corner
        eyebrow="Getting started"
        view={{ title: 'Pick up where you left off', body: 'Open one of your teams to carry on with the guide, or start again by creating a new team.', advance: 'next' }}
        target={null}
        viewport={snapshot.viewport}
        actions={<button type="button" className="btn" onClick={() => goToStep('new-team')}>Start again</button>}
      />
    )
  }
  if (!snapshot.view) return null

  const view = snapshot.view
  const numbered = NUMBERED.findIndex((candidate) => candidate.id === step.id)
  const eyebrow = numbered >= 0 ? `Getting started · Step ${numbered + 1} of ${NUMBERED.length}` : 'Getting started'
  const previous = TOUR_STEPS[index - 1]
  // Back only to a card that explains, on the same screen: going back to an action step would ask
  // the operator to do it again.
  const canGoBack = view.advance === 'next' && previous !== undefined && previous.screen === step.screen && previous.view({ readyApps, appsLoading }).advance === 'next'

  let actions: ReactNode
  if (view.advance === 'start') {
    actions = <>
      <button type="button" className="btn" onClick={() => endTour('dismissed')}>Not now</button>
      <button type="button" className="btn btn-primary" data-autofocus onClick={() => advanceFrom(index)}>Start the guide</button>
    </>
  } else if (view.advance === 'finish') {
    actions = <button type="button" className="btn btn-primary" data-autofocus onClick={() => endTour('finished')}>Finish</button>
  } else if (view.advance === 'action') {
    actions = <>
      <span className="tour-waiting t-meta"><i aria-hidden="true" />Waiting for you</span>
      <button type="button" className="link tour-skip" onClick={() => advanceFrom(index)}>Skip this step</button>
    </>
  } else {
    actions = <>
      {canGoBack && <button type="button" className="btn" onClick={() => goToStep(previous.id)}><ArrowLeft size={14} aria-hidden="true" />Back</button>}
      <button type="button" className="btn" onClick={() => advanceFrom(index)}>Next<ArrowRight size={14} aria-hidden="true" /></button>
    </>
  }

  return (
    <TourCard
      key={step.id}
      eyebrow={eyebrow}
      progress={numbered >= 0 ? (numbered + 1) / NUMBERED.length : null}
      view={view}
      target={snapshot.target}
      viewport={snapshot.viewport}
      actions={actions}
    />
  )
}

interface TourCardProps {
  eyebrow: string
  progress?: number | null
  view: TourStepView
  target: Box | null
  viewport: Viewport
  actions: ReactNode
  /** Out of the way in the bottom-right corner, for a card that waits while the operator picks something. */
  corner?: boolean
}

function TourCard({ eyebrow, progress = null, view, target, viewport, actions, corner = false }: TourCardProps) {
  const card = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(180)
  const titleId = useId()
  const bodyId = useId()
  const width = Math.min(CARD_WIDTH, viewport.width - 24)
  // The corner clears Home's footer, which holds the app status on the left.
  const placement = corner
    ? { side: 'center' as const, left: Math.max(12, viewport.width - width - 24), top: Math.max(12, viewport.height - height - 56) }
    : placeCard(target, { width, height }, viewport, view.sides, view.keepClear)
  // The welcome and closing cards are read before anything else happens; nothing else is going on.
  const opening = view.advance === 'start' || view.advance === 'finish'

  // Placement needs the card's real height, which only the browser knows once the text has wrapped.
  useLayoutEffect(() => {
    const element = card.current
    if (!element) return
    const measure = () => { if (element.offsetHeight > 0) setHeight(element.offsetHeight) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // Only those two cards take focus. Every other card leaves it where it is, because the operator
  // is in the middle of doing something on the page.
  useEffect(() => {
    card.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [])

  const pad = 6
  return (
    <div className="lw-tour">
      {opening && <div className="tour-backdrop" aria-hidden="true" />}
      {target && (
        <div
          className={`tour-spot ${view.dim ? 'dim' : ''} ${view.advance === 'action' ? 'act' : ''}`}
          aria-hidden="true"
          style={{ top: target.top - pad, left: target.left - pad, width: target.width + pad * 2, height: target.height + pad * 2 }}
        />
      )}
      <div
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className={`tour-card e2 side-${placement?.side ?? 'none'}`}
        style={{ width, top: placement?.top ?? 0, left: placement?.left ?? 0, visibility: placement ? 'visible' : 'hidden' }}
      >
        {progress !== null && <span className="tour-progress" aria-hidden="true"><i style={{ width: `${Math.round(progress * 100)}%` }} /></span>}
        <div className="tour-head">
          <span className="t-micro tour-eyebrow">{eyebrow}</span>
          <button type="button" className="iconbtn" aria-label="Close the guide" title="Close the guide" onClick={() => endTour('dismissed')}><X size={15} aria-hidden="true" /></button>
        </div>
        <h2 id={titleId}>{view.title}</h2>
        <p id={bodyId}>{view.body}</p>
        {view.example && (
          <button type="button" className="tour-example" onClick={() => window.dispatchEvent(new CustomEvent('loomwatch:compose', { detail: view.example }))}>
            <span className="t-micro">Use this example</span>
            <span>“{view.example}”</span>
          </button>
        )}
        <div className="tour-acts">{actions}</div>
      </div>
      <p className="visually-hidden" aria-live="polite">{`${eyebrow}. ${view.title}.`}</p>
    </div>
  )
}
