import { AtSign } from 'lucide-react'
import { useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { useAgentFaces, type AgentFacts } from '../../lib/chat/faces'
import { AGENT_CARD_WIDTH, useAgentCard, type CardPlace } from '../../lib/chat/useAgentCard'
import { AvatarFace } from '../agents/AvatarFace'


/**
 * An agent's avatar in the team's chat. Resting on it shows a card of who the agent is and what it
 * works with; clicking it puts `@name` in the message box. Outside a team's chat, or for someone
 * who is not one of the team's agents (you), it is the avatar alone. `doing`: what the face says
 * it is doing, when the face has grown to say it ("Writer is asking Researcher").
 */
export function AgentFace({ id, className = '', doing, children }: { id: string; className?: string; doing?: string; children: ReactNode }) {
  const faces = useAgentFaces()
  const facts = faces?.facts(id) ?? null
  if (!faces || !facts) return <>{children}</>
  return <Face facts={facts} mention={faces.mention} className={className} doing={doing}>{children}</Face>
}

/** An agent's card, floating where `useAgentCard` placed it; `hint` takes the place of its last line. */
export function AgentCardPopup({ id, facts, place, leaving, hint }: { id: string; facts: AgentFacts; place: CardPlace; leaving: boolean; hint?: ReactNode }) {
  return createPortal(
    <div id={id} role="tooltip" className={`tc-agent-card e2${leaving ? ' leaving' : ''}${place.bottom !== undefined ? ' above' : ''}`} style={{ width: AGENT_CARD_WIDTH, ...place }}>
      <AgentCard facts={facts} hint={hint} />
    </div>,
    document.body,
  )
}

function Face({ facts, mention, className, doing, children }: { facts: AgentFacts; mention: (id: string) => void; className: string; doing?: string; children: ReactNode }) {
  const button = useRef<HTMLButtonElement>(null)
  const cardId = useId()
  const doingId = useId()
  const card = useAgentCard()
  // Each click presses the face in once.
  const [pressed, setPressed] = useState(0)
  // A face focused by a press is about to be clicked; one reached with the keyboard shows its card.
  const pressing = useRef(false)
  const faceBox = () => button.current?.getBoundingClientRect()

  const shown = card.shown
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`tc-face${className ? ` ${className}` : ''}`}
        aria-label={`${facts.name}: mention in your message`}
        aria-describedby={[shown && cardId, doing && doingId].filter(Boolean).join(' ') || undefined}
        onClick={() => {
          card.shut()
          setPressed((count) => count + 1)
          mention(facts.id)
        }}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'mouse') return
          card.rest(faceBox)
        }}
        onPointerLeave={card.close}
        onPointerDown={() => { pressing.current = true }}
        onFocus={() => {
          const box = faceBox()
          if (!pressing.current && box) card.open(box)
          pressing.current = false
        }}
        onBlur={card.close}
        onKeyDown={(event) => { if (event.key === 'Escape' && card.phase === 'open') { event.stopPropagation(); card.close() } }}
      >
        <span key={pressed} className={pressed > 0 ? 'tc-face-press' : undefined}>{children}</span>
      </button>
      {doing && <span id={doingId} hidden>{doing}</span>}
      {shown && card.place && <AgentCardPopup id={cardId} facts={facts} place={card.place} leaving={card.phase === 'leaving'} />}
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

/** The card itself: rough details, never the whole team file. Its last line says a click mentions the agent, unless `hint` says otherwise. */
export function AgentCard({ facts, hint }: { facts: AgentFacts; hint?: ReactNode }) {
  const works = [
    facts.skills > 0 && plural(facts.skills, 'skill', 'skills'),
    facts.tools > 0 && plural(facts.tools, 'tool', 'tools'),
    facts.knowledge > 0 && plural(facts.knowledge, 'source', 'sources'),
  ].filter(Boolean).join(' · ')
  return (
    <>
      <div className="tc-agent-card-head">
        <span className={`tc-member ${facts.state}`}><AvatarFace id={facts.id} hue={facts.hue} size={32} fontSize={11} text={initials(facts.name)} /></span>
        <span className="tc-agent-card-who">
          <b className={`hue-${facts.hue}`}>{facts.name}</b>
          <span className={`tc-agent-card-state ${facts.state}`}>{facts.stateWords}{facts.step && ` · step ${facts.step.at} of ${facts.step.of}`}</span>
        </span>
      </div>
      {facts.model && <p className="tc-agent-card-app">{facts.model}</p>}
      {facts.role && <p className="tc-agent-card-role">{facts.role}</p>}
      {works && <p className="tc-agent-card-works">{works}</p>}
      {hint === undefined ? <p className="tc-agent-card-hint"><AtSign size={12} aria-hidden="true" />Click to mention {facts.name}</p> : hint}
    </>
  )
}
