import type { CSSProperties, ReactNode } from 'react'

import { figureStill, wornBy } from '../../lib/library/figures'
import type { MarkState } from '../../lib/story/mark'
import { AgentMark } from '../ui/AgentMark'
import { WornOverlay } from './AccessoryArt'
import { FigureStill } from './FigureStill'
import { useTeamFigure } from './figureContext'

/**
 * An agent's round avatar in the chat and in Details: its figure's head and shoulders on the disc of
 * its chat colour, so it looks as it does on Home and on the canvas. You, and a helper the team file
 * doesn't list, have no figure and keep the initials.
 */
export function AvatarFace({ id, hue, size, fontSize, text, title, className = '', hidden = true, children }: {
  id: string
  hue: number
  size: number
  fontSize?: number
  /** What it shows with no figure: initials, or "You". */
  text: ReactNode
  title?: string
  className?: string
  /** `false` where the avatar is the only thing naming the agent, so it keeps its title. */
  hidden?: boolean
  children?: ReactNode
}) {
  const figure = useTeamFigure(id)
  const style: CSSProperties = { width: size, height: size, ...(fontSize ? { fontSize } : {}), ...(figure ? { backgroundImage: `url(${figureStill(figure)})` } : {}) }
  return (
    <i className={`chat-avatar hue-${hue}${figure ? ' has-figure' : ''}${className ? ` ${className}` : ''}`} style={style} title={title} aria-hidden={hidden ? true : undefined}>
      {figure ? <WornOverlay kind={figure.kind} wear={wornBy(figure)} headOnly className="chat-avatar-worn" /> : text}
      {children}
    </i>
  )
}

/**
 * An agent beside its name in Details (the stage cards, the timeline): its figure, as everywhere
 * else. You keep the ring, and an agent the team doesn't list keeps its woven mark.
 */
export function AgentPortrait({ id, name, size, operator = false, state, events, animate }: { id: string; name?: string; size: number; operator?: boolean; state?: MarkState; events?: number; animate?: boolean }) {
  const figure = useTeamFigure(id)
  if (operator || !figure) return <AgentMark id={id} name={name} size={size} operator={operator} state={state} events={events} animate={animate} />
  return <FigureStill className="agent-portrait" figure={figure} alt="" width={size} height={size} />
}

