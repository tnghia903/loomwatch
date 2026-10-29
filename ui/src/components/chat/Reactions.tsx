import { SmilePlus } from '../ui/icon'
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'

import { useAppear } from '../../lib/chat/appear'
import { chipsOf, chipWords, faceTells, PALETTE, TRAY_SAYS, type AgentReaction, type Chip, type Face } from '../../lib/chat/reactions'
import { LOOMWATCH_CHECK_ID } from '../../lib/chat/helpers'
import { AvatarFace } from '../agents/AvatarFace'
import { LoomFace } from '../ui/glyphs'

/**
 * The crew's face, the one LoomWatch's mark wears — two warp-thread eyes and a weft stitch for a
 * mouth — pulling a face big enough to read without a word: happy eyes, heart eyes, a raised brow
 * and a tilt, a frown under knitted brows, eyes looking over, a check stitched for a mouth. Drawn
 * in the text colour, so it turns gold only where gold means you. Its word is its name and title.
 */
export function CrewFace({ face, size = 18 }: { face: Face; size?: number }) {
  return (
    <svg className={`tc-crew-face face-${face}`} width={size} height={size} viewBox="2.5 2.2 15 15" aria-hidden="true" fill="currentColor" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      {FACE_DRAWN[face]}
    </svg>
  )
}

const stitch = { fill: 'none', strokeWidth: 1.9 } as const
const PILL = (x: number, y = 4.8, height = 6.2) => <rect x={x} y={y} width="3" height={height} rx="1.5" stroke="none" />
const HAPPY_EYES = <g className="tc-face-eyes"><path d="M5 9.2Q7 6.4 9 9.2M11 9.2Q13 6.4 15 9.2" {...stitch} /></g>
const CHECK_MOUTH = <path className="tc-face-mouth" pathLength={1} d="M6.8 13.6 9.2 15.9 13.6 11.6" {...stitch} />

const FACE_DRAWN: Record<Face, ReactNode> = {
  // Good: eyes shut in two happy arcs, and a wide smile.
  glad: <>{HAPPY_EYES}<path className="tc-face-mouth" d="M6.2 13Q10 17.2 13.8 13" {...stitch} /></>,
  // Love it: two hearts for eyes.
  love: <><g className="tc-face-eyes" stroke="none"><path d="M7 11.2 4.6 8.8a1.6 1.6 0 0 1 2.4-2.2 1.6 1.6 0 0 1 2.4 2.2Z" /><path d="M13 11.2 10.6 8.8a1.6 1.6 0 0 1 2.4-2.2 1.6 1.6 0 0 1 2.4 2.2Z" /></g><path className="tc-face-mouth" d="M7 14Q10 16.6 13 14" {...stitch} /></>,
  // Not sure: one brow up, one eye narrowed, the stitch gone wavy, the head tilted.
  hmm: <g className="tc-face-tilt" transform="rotate(-9 10 10)"><path d="M4.8 4.2Q7 2.8 9.2 4" {...stitch} strokeWidth="1.5" /><g className="tc-face-eyes">{PILL(5.5, 5.4, 5.8)}<rect x="11.5" y="7.2" width="3" height="2.4" rx="1.2" stroke="none" /></g><path className="tc-face-mouth" d="M6.6 14.2Q8.3 12.9 10 14.2T13.4 14.2" {...stitch} /></g>,
  // Wrong: brows knitted down over short eyes, and the stitch turned down.
  off: <><path d="M4.8 4.6 8.8 6.2M15.2 4.6 11.2 6.2" {...stitch} strokeWidth="1.5" /><g className="tc-face-eyes">{PILL(5.5, 7, 3.8)}{PILL(11.5, 7, 3.8)}</g><path className="tc-face-mouth" d="M6.8 15.8Q10 12.6 13.2 15.8" {...stitch} /></>,
  // Seen: eyes open, looking over at what was handed in.
  seen: <><g className="tc-face-eyes" fill="none" strokeWidth="1.4"><rect x="4.6" y="3.8" width="4.2" height="7.6" rx="2.1" /><rect x="11.2" y="3.8" width="4.2" height="7.6" rx="2.1" /></g><g className="tc-face-pupils" stroke="none"><circle cx="7.6" cy="8.7" r="1.35" /><circle cx="14.2" cy="8.7" r="1.35" /></g><path className="tc-face-mouth" d="M8.4 14.8H11.6" {...stitch} /></>,
  // All met: content, with a check stitched where the mouth goes.
  met: <>{HAPPY_EYES}{CHECK_MOUTH}</>,
  // Done: eyes eased shut after the work, and a check for a mouth.
  done: <><g className="tc-face-eyes"><path d="M5.2 8.6H8.8M11.2 8.6H14.8" {...stitch} /></g>{CHECK_MOUTH}</>,
}

interface ReactionsProps {
  /** Your face on it, if any. */
  yours: Face | null
  /** The faces the agents put on it, read from the run's record. */
  agents?: readonly AgentReaction[]
  /** What it is, for the buttons' names: "Researcher's handover", "your request". */
  about: string
  name: (id: string) => string
  hue: (id: string) => number
  /** Your message: the row sits on the right, and the tray opens from there. */
  mine?: boolean
  /** Your own words, wherever they sit: a face on them says what you think of them. Yours by default. */
  own?: boolean
  /** Absent where your reactions cannot be kept: the agents' faces still show. */
  onReact?: (face: Face | null) => Promise<void>
  children: ReactNode
}

/**
 * Something said, with its reactions under it: a chip for each face, the agents who put it there
 * peeking up from it as their figures, and a gold ring where it is yours. No words on the chips:
 * the face says it, and its name is in its title. Hovering the message shows a button that opens
 * the tray. With no reactions yet, the button rests on the message's lower corner and takes no room.
 */
export function Reactions({ yours, agents = [], about, name, hue, mine = false, own = mine, onReact, children }: ReactionsProps) {
  const chips = chipsOf(yours, agents)
  // Open, the tray says which way it opens: up, or down near the top of the chat; and from the
  // button's left, or back from its right, toward the middle of the chat.
  const [open, setOpen] = useState<Placement | null>(null)
  // The reaction you just put on: it is sewn on, once.
  const [fresh, setFresh] = useState<Face | null>(null)
  const [error, setError] = useState<string | null>(null)
  const add = useRef<HTMLButtonElement>(null)

  const pick = (face: Face | null) => {
    setOpen(null)
    setError(null)
    if (!onReact || face === yours) return
    setFresh(face)
    onReact(face).catch((caught: unknown) => {
      setFresh(null)
      setError(caught instanceof Error ? caught.message : String(caught))
    })
  }
  useEffect(() => {
    if (!error) return
    const timer = window.setTimeout(() => setError(null), 4000)
    return () => window.clearTimeout(timer)
  }, [error])
  // Sewing on takes under a second; after it the chip is just yours.
  useEffect(() => {
    if (!fresh) return
    const timer = window.setTimeout(() => setFresh(null), 1400)
    return () => window.clearTimeout(timer)
  }, [fresh])
  const toggle = () => setOpen(open ? null : placeTray(add.current, mine))

  const empty = chips.length === 0
  const adder = onReact && (
    <span className="tc-react-add-wrap">
      <button ref={add} type="button" className="tc-react-add" aria-label={`React to ${about}`} aria-haspopup="true" aria-expanded={Boolean(open)} title="React" onClick={toggle}>
        <SmilePlus size={14} strokeWidth={1.6} aria-hidden="true" />
      </button>
      {open && <Tray yours={yours} own={own} placement={open} anchor={add} onPick={pick} onClose={() => { setOpen(null); add.current?.focus() }} />}
    </span>
  )
  const failed = error && <span className="tc-react-error" role="alert">Not saved: {error}</span>
  // The faces sit against the message's edge, its right on yours, its left on the agents'. The
  // button keeps its room while hidden, so it goes on the far side of them, and so does an error.
  // With no faces the button rests on the corner, and an error runs on from it.
  return (
    <div className={`tc-reactable${mine ? ' mine' : ''}`}>
      {children}
      {(!empty || onReact) && (
        <div className={`tc-reacts${empty ? ' empty' : ''}${open ? ' open' : ''}`} role="group" aria-label={`Reactions to ${about}`}>
          {mine && !empty && failed}
          {mine && adder}
          {chips.map((chip) => (
            <ReactionChip key={chip.face} chip={chip} fresh={fresh === chip.face} own={own} name={name} hue={hue} disabled={!onReact} onClick={() => pick(chip.you ? null : chip.face)} />
          ))}
          {!mine && adder}
          {(!mine || empty) && failed}
        </div>
      )}
    </div>
  )
}

function ReactionChip({ chip, fresh, own, name, hue, disabled, onClick }: { chip: Chip; fresh: boolean; own: boolean; name: (id: string) => string; hue: (id: string) => number; disabled: boolean; onClick: () => void }) {
  // A chip that comes while you watch arrives; one you just made is sewn on.
  const arrives = useAppear()
  const words = chipWords(chip, name)
  const tells = faceTells(chip.face, own)
  const thread = `tc-stitch-${useId().replace(/[^\w-]/g, '')}`
  // A face only the agents put on (done, all met) is theirs to put on: yours come from the tray.
  return (
    <button
      type="button"
      className={`tc-react${chip.you ? ' you' : ''}${chip.face === 'met' ? ' met' : ''}${fresh ? ' fresh' : ''}${arrives ? ' arrives' : ''}`}
      aria-pressed={chip.you}
      aria-label={chip.you ? `${words}. ${tells}. Take yours off` : disabled || !tells ? words : `${words}. Add yours`}
      title={chip.you && tells ? `${words}\n${tells}` : words}
      disabled={(disabled || !tells) && !chip.you}
      onClick={onClick}
    >
      <CrewFace face={chip.face} />
      {chip.agents.length > 0 && (
        <span className="tc-react-heads">
          {chip.agents.map((id) => <Head key={id} id={id} hue={hue(id)} name={name(id)} />)}
        </span>
      )}
      {chip.detail && <span className="tc-react-detail">{chip.detail}</span>}
      {fresh && (
        <svg className="tc-react-stitch" aria-hidden="true">
          <mask id={thread}><rect className="tc-react-stitch-run" pathLength={1} /></mask>
          <rect className="tc-react-stitch-thread" mask={`url(#${thread})`} />
        </svg>
      )}
    </button>
  )
}

/** An agent on a chip: its figure's head, popping up from behind the chip when it comes while you watch. */
function Head({ id, hue, name }: { id: string; hue: number; name: string }) {
  const peeks = useAppear()
  return (
    <span className={`tc-react-head${peeks ? ' peeks' : ''}`}>
      {/* LoomWatch's own check (ADR 0098) wears LoomWatch's face, not initials on a disc. */}
      {id === LOOMWATCH_CHECK_ID ? <LoomFace size={16} /> : <AvatarFace id={id} hue={hue} size={16} fontSize={7} text={initials(name)} />}
    </span>
  )
}

/** Where the tray opens from its button. */
interface Placement {
  /** Down from the button: near the top of the chat there is no room above it. */
  below: boolean
  /** Back from the button's right edge: toward the middle of the chat on yours, or where it has no room to the right. */
  end: boolean
  /** In a chat too narrow for either way, how far the tray slides back toward the button to stay in it. */
  shift: number
}

/** The tray's width: room for what a face tells the team under its row of faces. */
const TRAY_WIDTH = 248

function placeTray(button: HTMLElement | null, mine: boolean): Placement {
  const at = button?.getBoundingClientRect()
  // The chat's column inside its padding, and the part of it on screen.
  const log = button?.closest('[role="log"]')
  const column = log?.getBoundingClientRect()
  const view = button?.closest('.tc-scroll')?.getBoundingClientRect()
  if (!at || !log || !column || !view) return { below: false, end: mine, shift: 0 }
  const style = getComputedStyle(log)
  const left = column.left + (parseFloat(style.paddingLeft) || 0)
  const right = column.right - (parseFloat(style.paddingRight) || 0)
  const fitsRight = at.left - 6 + TRAY_WIDTH <= right
  const fitsLeft = at.right + 6 - TRAY_WIDTH >= left
  const end = mine ? fitsLeft || !fitsRight : !fitsRight && fitsLeft
  const shift = end ? left - (at.right + 6 - TRAY_WIDTH) : at.left - 6 + TRAY_WIDTH - right
  return { below: at.top - view.top < 96, end, shift: Math.max(0, Math.round(shift)) }
}

/**
 * The reactions to pick from, in a row above the button (below it, near the top of the chat). Each
 * says what it tells the team: of what an agent said, or of your own words.
 */
function Tray({ yours, own, placement, anchor, onPick, onClose }: { yours: Face | null; own: boolean; placement: Placement; anchor: { current: HTMLElement | null }; onPick: (face: Face | null) => void; onClose: () => void }) {
  const tray = useRef<HTMLDivElement>(null)
  // The reaction you point at, or move to with the keys, says what it would tell the team. The
  // focus the tray takes on opening is not a choice, so the tray says what reactions do until you move.
  const [pointed, setPointed] = useState<Face | null>(null)
  const moved = useRef(false)
  const says = PALETTE.find((entry) => entry.face === pointed)
  // The chat redraws as it polls; the tray keeps its focus and its listener through that.
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose })
  useEffect(() => {
    const picked = tray.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? tray.current?.querySelector<HTMLButtonElement>('button')
    picked?.focus({ preventScroll: true })
    const away = (event: PointerEvent) => {
      if (!tray.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) close.current()
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [anchor])
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    moved.current = true
    // The workspace closes things on Escape too; this one is the tray's.
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const buttons = [...(tray.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }
  return (
    <div ref={tray} className={`tc-react-tray${placement.end ? ' end' : ''}${placement.below ? ' below' : ''}`} style={{ '--tray-shift': `${placement.shift}px` } as CSSProperties} role="toolbar" aria-label="Pick a reaction" aria-description={TRAY_SAYS} onKeyDown={keys} onPointerLeave={() => setPointed(null)}>
      <div className="tc-react-faces">
        {PALETTE.map(({ face, label, tells, yours: onYours }, index) => (
          <button
            key={face}
            type="button"
            className="tc-react-pick"
            style={{ '--i': index } as CSSProperties}
            aria-pressed={yours === face}
            aria-label={yours === face ? `${label}, yours. Take it off` : label}
            aria-description={own ? onYours : tells}
            onPointerEnter={() => setPointed(face)}
            onFocus={() => { if (moved.current) setPointed(face) }}
            onClick={() => onPick(yours === face ? null : face)}
          >
            <CrewFace face={face} size={24} />
          </button>
        ))}
      </div>
      <p className="tc-react-says" aria-hidden="true">
        {says ? <><b>{says.label}</b> · {own ? says.yours : says.tells}</> : TRAY_SAYS}
      </p>
    </div>
  )
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toUpperCase()
}
