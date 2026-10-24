import { Plus, Search } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'

import { PRESENCE_WORDS, type Presence } from '../../lib/rail/presence'

/** One agent or team in the rail. */
export interface RailItem {
  key: string
  href: string
  name: string
  /** Under its name in the find list, and searched with it: what an agent does, a team's agents. */
  detail?: string
  presence: Presence
  /** It is the one this page is about. */
  current: boolean
  /** Its figure, or a team's figures. */
  art: ReactNode
}

/** Changes on this page that leaving would lose, and how to keep or drop them first. */
export interface LeaveGuard {
  /** Saves; true once saved. */
  save: () => Promise<boolean>
  /** Why it can't be saved as it is, if it can't. */
  problem: string | null
  /** Drops the changes, when that takes more than leaving. */
  discard?: () => Promise<void>
}

export interface CrewRailProps {
  /** The rail's name for screen readers: "My agents", "My team". */
  label: string
  items: readonly RailItem[] | null
  /** The find button's words and the find box's: "Find an agent". */
  find: string
  /** What the find box says with nothing to find yet: "No agents yet." */
  none: string
  /** The last place: a new one. `current` while that is the page. */
  add: { label: string; current?: boolean } & ({ href: string; onAdd?: never } | { onAdd: () => void; href?: never })
  /** Go to an item's page. */
  go: (href: string) => void
  /** Read as an item is picked: changes leaving would lose, if there are any. */
  leave?: () => LeaveGuard | null
  className?: string
}

const sayName = (item: RailItem) => (PRESENCE_WORDS[item.presence] ? `${item.name}, ${PRESENCE_WORDS[item.presence]}` : item.name)

/**
 * Where a floating part goes: beside the rail while it stands down the side, under it while it lies
 * along the top. A name is centred on its figure; a box starts level with it.
 */
function placeBeside(anchor: Element, rail: Element | null, centred = false, size = { width: 0, height: 0 }) {
  const box = anchor.getBoundingClientRect()
  const along = rail ? rail.getBoundingClientRect() : box
  const lying = along.width > along.height
  // Kept inside the window: a figure at the far end of a phone's row, or low in the column, opens
  // its box where all of it can be read and pressed.
  const inside = (value: number, extent: number, room: number) => Math.max(8, Math.min(value, room - extent - 8))
  return lying
    ? { top: along.bottom + 6, left: inside(box.left, size.width, window.innerWidth), lying }
    : { top: centred ? box.top + box.height / 2 : inside(box.top, size.height, window.innerHeight), left: along.right + 8, lying }
}
/** About as big as each floating box gets, to keep it on screen before it is drawn. */
const LEAVE_BOX = { width: 360, height: 120 }
const FIND_BOX = { width: 360, height: 480 }

/**
 * The crew rail: every agent you have, or every team, as its figures in a slim column down the side
 * of its page (along the top on a phone). One click is that one's page, on the same tab; the one
 * this page is about has the gold line. Each glows what it is doing, as in the team chat, so work
 * finishing elsewhere is seen from here. Names show on hover, and the find button at the top finds
 * one by name or by what it does.
 */
export function CrewRail({ label, items, find, none, add, go, leave, className = '' }: CrewRailProps) {
  const rail = useRef<HTMLElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const findButton = useRef<HTMLButtonElement>(null)
  const ids = useId()
  const [tip, setTip] = useState<{ text: string; top: number; left: number; lying: boolean } | null>(null)
  const [pending, setPending] = useState<{ href: string; guard: LeaveGuard; top: number; left: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [finding, setFinding] = useState<{ top: number; left: number } | null>(null)

  // The gold line slides to the one this page is about.
  const currentKey = items?.find((item) => item.current)?.key ?? (add.current ? '+' : null)
  const [mark, setMark] = useState<{ top: number; left: number; height: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const target = currentKey ? [...scroller.current?.querySelectorAll<HTMLElement>('[data-rail-key]') ?? []].find((element) => element.dataset.railKey === currentKey) : null
      setMark(target ? { top: target.offsetTop, left: target.offsetLeft, height: target.offsetHeight, width: target.offsetWidth } : null)
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [currentKey, items])

  const pick = (href: string, anchor: Element) => {
    setTip(null)
    const guard = leave?.() ?? null
    if (!guard) { go(href); return }
    setFinding(null)
    setPending({ href, guard, ...placeBeside(anchor, rail.current, false, LEAVE_BOX) })
  }
  // A plain click moves here; a click that asks for a new tab or window gets one.
  const follow = (event: MouseEvent<HTMLAnchorElement>, href: string, current: boolean) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    if (!current) pick(href, event.currentTarget)
  }
  const showTip = (text: string, anchor: Element) => { if (!pending && !finding) setTip({ text, ...placeBeside(anchor, rail.current, true) }) }

  const closeLeave = () => { setPending(null); setSaving(false) }
  // Its box goes as the page moves; the keyboard goes to the one picked, which a page moved in place keeps.
  const goFromBox = (href: string) => {
    setPending(null)
    go(href)
    const picked = [...scroller.current?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? []].find((link) => link.getAttribute('href') === href)
    picked?.focus()
  }
  const keep = async () => {
    if (!pending) return
    setSaving(true)
    const saved = await pending.guard.save().catch(() => false)
    setSaving(false)
    if (saved) goFromBox(pending.href)
  }
  const drop = async () => {
    if (!pending) return
    await pending.guard.discard?.()
    goFromBox(pending.href)
  }

  const leaveRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (pending) leaveRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, [pending])
  useEffect(() => {
    if (!pending && !finding) return
    const away = (event: PointerEvent) => {
      const target = event.target as Node
      if (rail.current?.contains(target) || document.getElementById(`${ids}-float`)?.contains(target)) return
      setPending(null); setFinding(null)
    }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [pending, finding, ids])

  return (
    <>
      <nav ref={rail} className={`crew-rail ${className}`.trim()} aria-label={label} onPointerLeave={() => setTip(null)}>
        <button ref={findButton} type="button" className="crew-rail-find" aria-label={find} aria-expanded={Boolean(finding)} aria-controls={finding ? `${ids}-float` : undefined}
          onClick={(event) => { const place = placeBeside(event.currentTarget, rail.current, false, FIND_BOX); setTip(null); setPending(null); setFinding((open) => (open ? null : place)) }}
          onPointerEnter={(event) => showTip(find, event.currentTarget)} onFocus={(event) => showTip(find, event.currentTarget)} onBlur={() => setTip(null)}>
          <Search size={17} aria-hidden="true" />
        </button>
        <div ref={scroller} className="crew-rail-scroll">
          {mark && <span className="crew-rail-mark" aria-hidden="true" style={{ top: mark.top, left: mark.left, height: mark.height, width: mark.width }} />}
          <ul className="crew-rail-list">
            {(items ?? []).map((item) => (
              <li key={item.key}>
                <a className={`crew-rail-who ${item.presence}`} href={item.href} data-rail-key={item.key} aria-current={item.current ? 'page' : undefined} aria-label={sayName(item)}
                  onClick={(event) => follow(event, item.href, item.current)}
                  onPointerEnter={(event) => showTip(PRESENCE_WORDS[item.presence] ? `${item.name} · ${PRESENCE_WORDS[item.presence]}` : item.name, event.currentTarget)}
                  onFocus={(event) => showTip(PRESENCE_WORDS[item.presence] ? `${item.name} · ${PRESENCE_WORDS[item.presence]}` : item.name, event.currentTarget)} onBlur={() => setTip(null)}>
                  <span className="crew-rail-art">{item.art}</span>
                </a>
              </li>
            ))}
            <li>
              {add.onAdd
                ? <button type="button" className="crew-rail-add" data-rail-key="+" aria-label={add.label} onClick={() => { setTip(null); add.onAdd() }}
                    onPointerEnter={(event) => showTip(add.label, event.currentTarget)} onFocus={(event) => showTip(add.label, event.currentTarget)} onBlur={() => setTip(null)}><Plus size={18} aria-hidden="true" /></button>
                : <a className="crew-rail-add" href={add.href} data-rail-key="+" aria-label={add.label} aria-current={add.current ? 'page' : undefined} onClick={(event) => follow(event, add.href!, Boolean(add.current))}
                    onPointerEnter={(event) => showTip(add.label, event.currentTarget)} onFocus={(event) => showTip(add.label, event.currentTarget)} onBlur={() => setTip(null)}><Plus size={18} aria-hidden="true" /></a>}
            </li>
          </ul>
        </div>
      </nav>

      {tip && !pending && !finding && <div className={`crew-rail-tip${tip.lying ? '' : ' beside'}`} aria-hidden="true" style={{ top: tip.top, left: tip.left }}>{tip.text}</div>}

      {pending && (
        <div id={`${ids}-float`} ref={leaveRef} className="crew-rail-float crew-rail-leave pop-inline t-meta" role="alertdialog" aria-label="Unsaved changes" style={{ top: pending.top, left: pending.left }}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); closeLeave() } }}>
          <span>Unsaved changes.{pending.guard.problem ? ` ${pending.guard.problem}` : ''}</span>
          <button type="button" className="btn crew-rail-keep" onClick={() => void keep()} disabled={saving || Boolean(pending.guard.problem)} title={pending.guard.problem ?? undefined}>{saving ? 'Saving…' : 'Save first'}</button>
          <button type="button" className="btn btn-danger" onClick={() => void drop()} disabled={saving}>Discard</button>
          <button type="button" className="btn" onClick={closeLeave}>Cancel</button>
        </div>
      )}

      {finding && (
        <FindBox id={`${ids}-float`} label={find} none={none} items={items ?? []} place={finding}
          onPick={(item) => { setFinding(null); if (!item.current) pick(item.href, findButton.current ?? rail.current!) }}
          onClose={() => { setFinding(null); findButton.current?.focus() }} />
      )}
    </>
  )
}

/** The find box beside the rail: type part of a name or what it does, then pick one. */
function FindBox({ id, label, none, items, place, onPick, onClose }: { id: string; label: string; none: string; items: readonly RailItem[]; place: { top: number; left: number }; onPick: (item: RailItem) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? items.filter((item) => item.name.toLowerCase().includes(needle) || (item.detail ?? '').toLowerCase().includes(needle)) : [...items]
  }, [items, query])
  const shown = Math.min(active, Math.max(0, matches.length - 1))
  const list = `${id}-list`
  return (
    <div id={id} className="crew-rail-float crew-rail-findbox pop e2" role="dialog" aria-label={label} style={{ top: place.top, left: place.left }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose() }
        else if (event.key === 'ArrowDown') { event.preventDefault(); setActive(Math.min(shown + 1, matches.length - 1)) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(Math.max(shown - 1, 0)) }
        else if (event.key === 'Enter' && matches[shown] && !event.nativeEvent.isComposing) { event.preventDefault(); onPick(matches[shown]) }
      }}>
      <div className="pop-search">
        <Search size={15} aria-hidden="true" />
        <input autoFocus placeholder={label} aria-label={label} value={query} role="combobox" aria-expanded="true" aria-controls={list} aria-activedescendant={matches[shown] ? `${id}-${matches[shown].key}` : undefined}
          onChange={(event) => { setQuery(event.target.value); setActive(0) }} />
      </div>
      <ul id={list} className="crew-rail-found" role="listbox" aria-label={label}>
        {matches.length === 0 && <li className="pop-empty t-meta" role="presentation">{query.trim() ? `Nothing matches “${query.trim()}”.` : none}</li>}
        {matches.map((item, index) => (
          <li key={item.key} id={`${id}-${item.key}`} role="option" aria-selected={index === shown} aria-current={item.current ? 'page' : undefined} className={`crew-rail-hit ${item.presence}${index === shown ? ' active' : ''}`}
            onPointerMove={() => setActive(index)} onClick={() => onPick(item)}>
            <span className="crew-rail-art">{item.art}</span>
            <span className="crew-rail-hit-text"><b>{item.name}</b>{item.detail && <em>{item.detail}</em>}</span>
            {PRESENCE_WORDS[item.presence] && <span className="crew-rail-hit-state">{PRESENCE_WORDS[item.presence]}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
