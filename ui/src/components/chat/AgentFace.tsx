import { AtSign } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { useAgentFaces, type AgentFacts } from '../../lib/chat/faces'

/** How long the pointer rests on a face before its card opens, so passing over the team opens nothing. */
const HOVER_DELAY_MS = 280
/** How long the card takes to leave (--t-quick); where motion is reduced it simply goes. */
const LEAVE_MS = 160
const CARD_WIDTH = 264

/**
 * An agent's avatar in the team's chat. Resting on it shows a card of who the agent is and what it
 * works with; clicking it puts `@name` in the message box. Outside a team's chat, or for someone
 * who is not one of the team's agents (you), it is the avatar alone.
 */
export function AgentFace({ id, className = '', children }: { id: string; className?: string; children: ReactNode }) {
  const faces = useAgentFaces()
  const facts = faces?.facts(id) ?? null
  if (!faces || !facts) return <>{children}</>
  return <Face facts={facts} mention={faces.mention} className={className}>{children}</Face>
}

type Phase = 'closed' | 'open' | 'leaving'

function Face({ facts, mention, className, children }: { facts: AgentFacts; mention: (id: string) => void; className: string; children: ReactNode }) {
  const button = useRef<HTMLButtonElement>(null)
  const cardId = useId()
  const [phase, setPhase] = useState<Phase>('closed')
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  // Each click presses the face in once.
  const [pressed, setPressed] = useState(0)
  const timer = useRef<number | undefined>(undefined)
  // A face focused by a press is about to be clicked; one reached with the keyboard shows its card.
  const pressing = useRef(false)

  const clear = () => window.clearTimeout(timer.current)
  const open = useCallback(() => {
    const at = button.current?.getBoundingClientRect()
    if (!at) return
    const left = Math.max(8, Math.min(at.left, window.innerWidth - CARD_WIDTH - 8))
    // Below the face, unless that is the bottom of the window: then above it.
    setPlace(at.bottom > window.innerHeight * 0.6 ? { left, bottom: window.innerHeight - at.top + 8 } : { left, top: at.bottom + 8 })
    setPhase('open')
  }, [])
  const close = useCallback(() => {
    clear()
    setPhase((now) => (now === 'open' ? 'leaving' : now))
    timer.current = window.setTimeout(() => setPhase((now) => (now === 'leaving' ? 'closed' : now)), LEAVE_MS)
  }, [])

  // The card belongs to where the face was: scrolling the chat or the page takes it away.
  useEffect(() => {
    if (phase !== 'open') return
    const away = () => close()
    window.addEventListener('scroll', away, true)
    window.addEventListener('resize', away)
    return () => {
      window.removeEventListener('scroll', away, true)
      window.removeEventListener('resize', away)
    }
  }, [phase, close])
  useEffect(() => clear, [])

  const shown = phase !== 'closed' && place !== null
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`tc-face${className ? ` ${className}` : ''}`}
        aria-label={`${facts.name}: mention in your message`}
        aria-describedby={shown ? cardId : undefined}
        onClick={() => {
          clear()
          setPhase('closed')
          setPressed((count) => count + 1)
          mention(facts.id)
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'mouse') return
          clear()
          timer.current = window.setTimeout(open, HOVER_DELAY_MS)
        }}
        onPointerLeave={close}
        onPointerDown={() => { pressing.current = true }}
        onFocus={() => {
          if (!pressing.current) open()
          pressing.current = false
        }}
        onBlur={close}
        onKeyDown={(event) => { if (event.key === 'Escape' && phase === 'open') { event.stopPropagation(); close() } }}
      >
        <span key={pressed} className={pressed > 0 ? 'tc-face-press' : undefined}>{children}</span>
      </button>
      {shown && createPortal(
        <div id={cardId} role="tooltip" className={`tc-agent-card e2${phase === 'leaving' ? ' leaving' : ''}${place.bottom !== undefined ? ' above' : ''}`} style={{ width: CARD_WIDTH, ...place }}>
          <AgentCard facts={facts} />
        </div>,
        document.body,
      )}
    </>
  )
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  return (words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[1][0]}`).toUpperCase()
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** The card itself: rough details, never the whole team file. */
export function AgentCard({ facts }: { facts: AgentFacts }) {
  const works = [
    facts.skills > 0 && plural(facts.skills, 'skill', 'skills'),
    facts.tools > 0 && plural(facts.tools, 'tool', 'tools'),
    facts.knowledge > 0 && plural(facts.knowledge, 'source', 'sources'),
  ].filter(Boolean).join(' · ')
  return (
    <>
      <div className="tc-agent-card-head">
        <span className={`tc-member ${facts.state}`}><i className={`chat-avatar hue-${facts.hue}`} style={{ width: 32, height: 32, fontSize: 11 }} aria-hidden="true">{initials(facts.name)}</i></span>
        <span className="tc-agent-card-who">
          <b className={`hue-${facts.hue}`}>{facts.name}</b>
          <span className={`tc-agent-card-state ${facts.state}`}>{facts.stateWords}{facts.step && ` · step ${facts.step.at} of ${facts.step.of}`}</span>
        </span>
      </div>
      {(facts.app || facts.model) && <p className="tc-agent-card-app">{[facts.app, facts.model].filter(Boolean).join(' · ')}</p>}
      {facts.role && <p className="tc-agent-card-role">{facts.role}</p>}
      {works && <p className="tc-agent-card-works">{works}</p>}
      <p className="tc-agent-card-hint"><AtSign size={12} aria-hidden="true" />Click to mention {facts.name}</p>
    </>
  )
}
