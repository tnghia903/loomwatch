import { modelNameFromId } from '../../lib/ai/modelIds'
import { agentPresence } from '../../lib/rail/presence'
import type { AgentDraft } from '../../lib/library/draft'
import type { FigureChoice } from '../../lib/library/figures'
import type { RunRecord } from '../../lib/runs/client'
import { stateLabel } from '../../lib/state/words'
import { ALLOW_SWITCHES } from '../../lib/team-file/allow'
import { AgentMark } from '../ui/AgentMark'
import { Icon, Pin } from '../ui/icon'
import { FigureStill } from './FigureStill'
import { SWITCH_ICONS } from './switchIcons'

/**
 * One of My agents in the grid (round 3, ADR 0101): its figure, big, lit by what it is doing in
 * its own chat; its name, what it does, and a word when it is not just ready; then one row of
 * marks: its three switches, solid with a check when allowed and dashed when it asks you, its
 * skills and the teams it is in. The words are each mark's tooltip and name, and its model is in
 * the card's, so the card says little and loses nothing.
 */
export function AgentTile({ id, figure, draft, teams, runs, pinned = false }: {
  /** The saved agent's id: its own chat, and its woven mark when it wears no figure. */
  id: string
  figure?: FigureChoice
  draft: AgentDraft
  /** How many teams it is in. */
  teams: number
  /** Every run the shared poll knows: its own chat's say what it is doing. */
  runs: readonly RunRecord[]
  pinned?: boolean
}) {
  const name = draft.name.trim() || 'New agent'
  const presence = agentPresence(runs, id)
  const skills = draft.skills.length
  const does = draft.does.trim()
  const teamsSaid = teams === 0 ? 'In no team yet' : `In ${teams} team${teams === 1 ? '' : 's'}`
  return (
    <div className="agent-tile">
      {/* Its name is right under it, so the figure says nothing more. */}
      <span className="desk-figure agent-tile-figure" data-glow={presence} aria-hidden="true">
        {figure
          ? <FigureStill figure={figure} alt="" width={112} height={112} loading="lazy" decoding="async" />
          : <AgentMark id={id} name={name} size={112} animate={false} />}
      </span>
      <strong className="agent-tile-name">{name}{pinned && <Pin className="agent-badge-pin" size={13} role="img" aria-label="pinned to the notch"><title>Pinned to the notch</title></Pin>}</strong>
      {does && <span className="agent-tile-does">{does}</span>}
      {draft.model && <span className="visually-hidden">on {modelNameFromId(draft.model)}</span>}
      {presence !== 'ready' && <span className={`agent-tile-state ${presence}`}>{stateLabel(presence)}</span>}
      <span className="agent-tile-marks">
        {ALLOW_SWITCHES.map(({ key, label }) => {
          const on = draft.allow[key] === true
          const said = `${label}: ${on ? 'allowed' : 'asks you'}`
          const Mark = SWITCH_ICONS[key]
          return <span key={key} className={`agent-tile-mark ${on ? 'on' : 'asks'}`} role="img" aria-label={said} title={said}><Mark size={14} aria-hidden="true" />{on && <Icon name="check" size={12} strokeWidth={2.5} className="agent-tile-check" aria-hidden="true" />}</span>
        })}
        {skills > 0 && <span className="agent-tile-mark count" role="img" aria-label={`${skills} skill${skills === 1 ? '' : 's'}`} title={`${skills} skill${skills === 1 ? '' : 's'}: ${draft.skills.join(', ')}`}><Icon name="skills" size={14} />{skills}</span>}
        <span className="agent-tile-mark count" role="img" aria-label={teamsSaid} title={teamsSaid}><Icon name="network" size={14} />{teams}</span>
      </span>
    </div>
  )
}
