import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { away, directions, facts, website, type MapsApp } from '../../../lib/widgets/map'
import type { WidgetPlace, WidgetSpec } from '../../../lib/widgets/types'
import { Icon } from '../../ui/icon'
import { placeIcon } from './placeGlyphs'

type MapSpec = Extract<WidgetSpec, { kind: 'map' }>

const WidgetMapCanvas = lazy(() => import('./WidgetMapCanvas'))

/** The cards along the bottom of the small map: the map keeps its pins clear of them. */
const CARDS_ROOM = 104
/** The place's panel beside the large map, on a window wide enough for it. */
const PANEL_ROOM = 384

/**
 * A map (ADR 0114, amended 10 November): the places the agent found, each a pin marked by what
 * sort of place it is, and a card for each along the map's bottom, as a maps app shows them.
 * Scrolling the cards or tapping a pin brings that place into focus; opening a card, or the map's
 * corner button, shows the map across the window with the place's card beside it: its rating,
 * price and sort, how far it is from where you start, its website, and Directions, which asks
 * which maps app to open. Nothing is kept: it is for finding your way.
 */
export function WidgetMap({ spec }: { spec: MapSpec }) {
  const [picked, setPicked] = useState(0)
  const [open, setOpen] = useState(false)
  const row = useRef<HTMLDivElement>(null)
  const scrolling = useRef(0)

  // A pin tapped: its card comes into view.
  const pickPin = (at: number) => {
    setPicked(at)
    const card = row.current?.children[at] as HTMLElement | undefined
    card?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }

  // The cards scrolled: the one most in view is the place in focus.
  const onScroll = () => {
    cancelAnimationFrame(scrolling.current)
    scrolling.current = requestAnimationFrame(() => {
      const cards = row.current
      const first = cards?.children[0] as HTMLElement | undefined
      if (!cards || !first) return
      const step = first.offsetWidth + 10
      const at = Math.max(0, Math.min(spec.places.length - 1, Math.round(cards.scrollLeft / step)))
      setPicked(at)
    })
  }
  useEffect(() => () => cancelAnimationFrame(scrolling.current), [])

  return (
    <section className="wg wg-map" aria-label={spec.title}>
      <p className="wg-title">{spec.title}</p>
      <div className="wg-map-stage">
        <Suspense fallback={<div className="wg-map-canvas" />}>
          <WidgetMapCanvas places={spec.places} from={spec.from} picked={picked} onPick={pickPin} room={{ top: 0, right: 0, bottom: CARDS_ROOM, left: 0 }} small credit="top-left" />
        </Suspense>
        <button type="button" className="wg-map-round wg-map-grow" aria-label="Show the map larger" onClick={() => setOpen(true)}>
          <Icon name="expand" size={16} />
        </button>
        <div ref={row} className="wg-map-cards" role="list" aria-label="Places" onScroll={onScroll}>
          {spec.places.map((place, at) => (
            <div role="listitem" key={at} className="wg-map-card-slot">
              <button type="button" className={`wg-map-card${at === picked ? ' picked' : ''}`} onClick={() => { setPicked(at); setOpen(true) }}>
                <PlaceMark place={place} />
                <span className="wg-map-card-words">
                  <b>{place.name}</b>
                  <Facts place={place} />
                  {(away(place, spec.from) ?? place.note) && <span className="wg-map-card-more">{away(place, spec.from) ?? place.note}</span>}
                </span>
              </button>
            </div>
          ))}
        </div>
      </div>
      {open && <MapView spec={spec} picked={picked} onPick={setPicked} onClose={() => setOpen(false)} />}
    </section>
  )
}

/** A place's mark in its sort's colour, as on its pin. */
function PlaceMark({ place, big = false }: { place: WidgetPlace; big?: boolean }) {
  const category = place.category ?? 'other'
  return (
    <span className={`wg-place-mark cat-${category}${big ? ' big' : ''}`} aria-hidden="true">
      <Icon name={placeIcon(category)} strokeWidth={2} />
    </span>
  )
}

/** "★ 4.8 · $$ · Café", or nothing when the agent found none of them. */
function Facts({ place }: { place: WidgetPlace }) {
  const { rating, rest } = facts(place)
  if (!rating && rest.length === 0) return null
  const parts: ReactNode[] = []
  if (rating) parts.push(<span key="rating" className="wg-place-rating" aria-label={`Rated ${rating} out of 5`}><i aria-hidden="true">★</i> {rating}</span>)
  rest.forEach((part) => parts.push(<span key={part}>{part}</span>))
  return <span className="wg-place-facts">{parts.flatMap((part, at) => (at === 0 ? [part] : [<span key={`dot${at}`} aria-hidden="true"> · </span>, part]))}</span>
}

/**
 * The map across the window, with the place in focus in a card beside it (below it, in a narrow
 * window). Escape closes what is on top: the maps apps' question, then the map.
 */
function MapView({ spec, picked, onPick, onClose }: { spec: MapSpec; picked: number; onPick: (at: number) => void; onClose: () => void }) {
  const [asking, setAsking] = useState(false)
  const close = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const place = spec.places[picked] ?? spec.places[0]
  const wide = typeof window === 'undefined' || window.innerWidth >= 760
  const site = website(place)
  const distance = away(place, spec.from)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    close.current?.focus()
    return () => before?.focus?.()
  }, [])

  return createPortal(
    <div
      className="wg-mapview"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        if (asking) setAsking(false)
        else onClose()
      }}
    >
      <h2 id={titleId} className="visually-hidden">{spec.title}</h2>
      <Suspense fallback={<div className="wg-map-canvas" />}>
        <WidgetMapCanvas
          places={spec.places}
          from={spec.from}
          picked={picked}
          onPick={onPick}
          room={wide ? { top: 0, right: 0, bottom: 0, left: PANEL_ROOM } : { top: 24, right: 0, bottom: Math.round(window.innerHeight * 0.55), left: 0 }}
          credit={wide ? 'bottom-right' : 'top-left'}
        />
      </Suspense>
      <button ref={close} type="button" className="wg-map-round wg-mapview-close" aria-label="Close the map" onClick={onClose}>
        <Icon name="close" size={18} strokeWidth={2} />
      </button>
      <aside className="wg-mapview-place" aria-label={place.name}>
        <div className="wg-mapview-head">
          <PlaceMark place={place} big />
          <div>
            <h3>{place.name}</h3>
            <Facts place={place} />
          </div>
        </div>
        <div className="wg-mapview-acts">
          {site && <a className="wg-mapview-act primary" href={site} target="_blank" rel="noopener noreferrer">Website</a>}
          <button type="button" className={`wg-mapview-act${site ? '' : ' primary'}`} onClick={() => setAsking(true)}>Directions</button>
        </div>
        {place.note && <p className="wg-mapview-note">{place.note}</p>}
        {(distance || place.address) && (
          <dl className="wg-mapview-where">
            {distance && <><dt>Distance</dt><dd>{distance}, as the crow flies</dd></>}
            {place.address && <><dt>Address</dt><dd>{place.address}</dd></>}
          </dl>
        )}
        {spec.places.length > 1 && (
          <nav className="wg-mapview-others" aria-label="Places on this map">
            <p>On this map</p>
            {spec.places.map((other, at) => (
              <button type="button" key={at} className={at === picked ? 'picked' : ''} aria-current={at === picked ? 'true' : undefined} onClick={() => onPick(at)}>
                <PlaceMark place={other} />
                <span>{other.name}</span>
                {away(other, spec.from) && <small>{away(other, spec.from)?.split(' from ')[0]}</small>}
              </button>
            ))}
          </nav>
        )}
      </aside>
      {asking && <OpenIn place={place} onClose={() => setAsking(false)} />}
    </div>,
    document.body,
  )
}

const APPS: { app: MapsApp; name: string }[] = [
  { app: 'apple', name: 'Apple Maps' },
  { app: 'google', name: 'Google Maps' },
]

/** Directions' question: which maps app to open the way there in. */
function OpenIn({ place, onClose }: { place: WidgetPlace; onClose: () => void }) {
  const first = useRef<HTMLAnchorElement>(null)
  const titleId = useId()
  useEffect(() => { first.current?.focus() }, [])
  return (
    <div className="wg-openin-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="wg-openin" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <p id={titleId}>Open in</p>
        {APPS.map(({ app, name }, at) => (
          <a key={app} ref={at === 0 ? first : undefined} href={directions(place, app)} target="_blank" rel="noopener noreferrer" onClick={onClose}>{name}</a>
        ))}
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}
