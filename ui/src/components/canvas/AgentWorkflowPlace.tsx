import { ChevronRight, FileText, MessageSquareText } from '../ui/icon'

import type { FigureChoice } from '../../lib/library/figures'
import type { AgentPlace, PlaceLink } from '../../lib/team-file/agentPlace'
import { FigureStill } from '../agents/FigureStill'
import { AgentMark } from '../ui/AgentMark'

export interface AgentWorkflowPlaceProps {
  agentId: string
  name: string
  place: AgentPlace
  figures?: ReadonlyMap<string, FigureChoice>
  /** Select another card and bring it into view, so its lines light up in turn. */
  onFocus?: (id: string) => void
  onPromoteEntrypoint?: () => void
  readOnly?: boolean
}

/**
 * IN THE WORKFLOW — the selected agent's lines on the canvas, said as a short thread: who hands it
 * work, the agent, and who it hands work to. Each neighbour is a way there: choosing one selects it
 * and lights its lines, so a crowded workflow can be walked one card at a time. Everything about the
 * agent itself is on its workbench; this is only what this team makes of it.
 */
export function AgentWorkflowPlace({ agentId, name, place, figures, onFocus, onPromoteEntrypoint, readOnly = false }: AgentWorkflowPlaceProps) {
  const flow = place.flow
  const neighbour = (link: PlaceLink) => {
    const figure = link.you ? undefined : figures?.get(link.id)
    const face = figure ? <FigureStill className="thread-figure" figure={figure} headOnly alt="" /> : <AgentMark id={link.id} size={18} operator={link.you} animate={false} />
    const label = link.you ? 'You, the review step' : link.name
    return onFocus
      ? <button type="button" className={`thread-node ${link.you ? 'you' : ''}`} onClick={() => onFocus(link.id)} aria-label={`${label}: show it`}>{face}<span className="thread-name">{link.you ? 'Your review' : link.name}</span><ChevronRight size={13} aria-hidden="true" /></button>
      : <span className={`thread-node ${link.you ? 'you' : ''}`}>{face}<span className="thread-name">{link.you ? 'Your review' : link.name}</span></span>
  }
  const self = figures?.get(agentId)
  return (
    <section className="workflow-place" aria-label="In the team">
      <div className="workflow-place-head">
        <span className="t-micro">In the team</span>
        {flow && <span className="t-meta">Step {flow.step} of {flow.of}</span>}
      </div>
      <span className="visually-hidden">{place.summary}</span>
      {flow ? (
        <ol className="workflow-thread">
          <li className="thread-group">
            <span className="thread-label">Takes work from</span>
            <ul>
              {flow.from.length > 0
                ? flow.from.map((link) => <li key={link.id}>{neighbour(link)}</li>)
                : <li><span className="thread-node request"><MessageSquareText size={14} aria-hidden="true" /><span className="thread-name">Your request</span></span></li>}
            </ul>
          </li>
          <li className="thread-self">
            <i className="thread-knot" aria-hidden="true" />
            {self ? <FigureStill className="thread-figure" figure={self} headOnly alt="" /> : <AgentMark id={agentId} size={18} animate={false} />}
            <span className="thread-name">{name}</span>
          </li>
          <li className="thread-group">
            <span className="thread-label">Hands work to</span>
            <ul>
              {flow.to.map((link) => <li key={link.id}>{neighbour(link)}</li>)}
              {place.final && <li><span className="thread-node output"><FileText size={14} aria-hidden="true" /><span className="thread-name">The team’s answer</span></span></li>}
              {flow.to.length === 0 && !place.final && <li className="thread-empty t-meta">No one yet. Drag from its right dot to the next card.</li>}
            </ul>
          </li>
        </ol>
      ) : <p className="workflow-place-summary t-body">{place.summary}</p>}
      {place.canStart && onPromoteEntrypoint && !readOnly && <button type="button" className="link t-meta" onClick={onPromoteEntrypoint}>Make this the starting agent</button>}
    </section>
  )
}
