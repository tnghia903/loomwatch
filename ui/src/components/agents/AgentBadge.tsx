import { Check, Pin } from '../ui/icon'

import { modelNameFromId } from '../../lib/ai/modelIds'
import type { AgentDraft } from '../../lib/library/draft'
import { figureWords, type FigureChoice } from '../../lib/library/figures'
import { FigureStill } from './FigureStill'
import { ALLOW_SWITCHES } from '../../lib/team-file/allow'
import { AgentMark } from '../ui/AgentMark'
import { InlineMarkdown } from '../ui/Markdown'
import { SWITCH_ICONS } from './switchIcons'

export interface AgentBadgeProps {
  /** Stable id for the woven mark: the saved agent's id, else its name. */
  markId: string
  /** The figure it wears in Your agents: its portrait leads the card. Without one, its woven mark does. */
  figure?: FigureChoice
  draft: AgentDraft
  /** The model's name to show; the id when no name is known. */
  modelName?: string
  /** Its thinking effort's name, when it has one other than the model's default. */
  effortName?: string
  /** Teams that use it, and how many of those run on a schedule. */
  usedIn?: { teams: number; scheduled: number }
  /** The page lists the teams that use it right under the card, so the card doesn't count them too. */
  usesListed?: boolean
  /** Kept at the notch of a Mac, to message from the top of the screen (ADR 0083). */
  pinned?: boolean
  compact?: boolean
}

/**
 * The agent's ID card: who it is, what it runs on, what it may do — with what each switch means
 * right now — what it carries, and where it is used. It is the staff badge of the design notes:
 * an access card with an "after hours" rule, because a scheduled team has nobody to answer.
 */
export function AgentBadge({ markId, figure, draft, modelName, effortName, usedIn, usesListed = false, pinned = false, compact = false }: AgentBadgeProps) {
  const scheduled = (usedIn?.scheduled ?? 0) > 0
  const asks = ALLOW_SWITCHES.filter(({ key }) => !draft.allow[key])
  const name = draft.name.trim() || 'New agent'
  return (
    <div className={`agent-badge${compact ? ' compact' : ''}`}>
      <div className="agent-badge-head">
        {figure
          ? <FigureStill className="agent-badge-figure" figure={figure} alt={`${name}, a ${figureWords(figure)}`} width={compact ? 84 : 92} height={compact ? 84 : 92} loading="lazy" decoding="async" />
          : <AgentMark id={markId} name={name} size={compact ? 26 : 34} animate={false} />}
        <div className="agent-badge-who">
          <strong>{name}{pinned && <Pin className="agent-badge-pin" size={13} role="img" aria-label="pinned to the notch"><title>Pinned to the notch</title></Pin>}</strong>
          {draft.does.trim() && <span className="agent-badge-does"><InlineMarkdown clickable={false}>{draft.does.trim()}</InlineMarkdown></span>}
          <span className="agent-badge-app t-mono-sm">{modelName || modelNameFromId(draft.model)}{effortName ? ` · ${effortName.toLowerCase()} effort` : ''}</span>
        </div>
      </div>
      <div className="agent-badge-row">
        <span className="agent-badge-label">Access</span>
        <span className="agent-badge-tiles">
          {ALLOW_SWITCHES.map(({ key, short, label }) => {
            const on = draft.allow[key] === true
            const state = on ? 'on' : 'asks'
            const Icon = SWITCH_ICONS[key]
            const word = on ? 'Allowed' : 'Asks you'
            return <span key={key} className={`agent-badge-tile ${state}`} title={`${label}: ${word}`}>{on && <Check size={10} strokeWidth={3} aria-hidden="true" />}<Icon size={13} aria-hidden="true" /><span>{short}</span><em>{word}</em></span>
          })}
        </span>
      </div>
      {!compact && asks.length > 0 && (
        <div className="agent-badge-row">
          <span className="agent-badge-label">After hours</span>
          <span className={`agent-badge-after${scheduled ? ' live' : ''}`}>
            {scheduled
              ? <>In {usedIn!.scheduled} scheduled team{usedIn!.scheduled === 1 ? '' : 's'}, nobody is there to answer: {asks.map((item) => item.short.toLowerCase()).join(', ')} {asks.length === 1 ? 'is' : 'are'} declined.</>
              : <>On a schedule, anything it would ask you is declined: {asks.map((item) => item.short.toLowerCase()).join(', ')}.</>}
          </span>
        </div>
      )}
      <div className="agent-badge-row">
        <span className="agent-badge-label">Carries</span>
        <span>{draft.skills.length ? `${draft.skills.length} skill${draft.skills.length === 1 ? '' : 's'}` : 'No skills'}{!compact && draft.skills.length > 0 ? `: ${draft.skills.join(', ')}` : ''}</span>
      </div>
      {usedIn && !usesListed && (
        <div className="agent-badge-row">
          <span className="agent-badge-label">Used in</span>
          <span>{usedIn.teams === 0 ? 'No team yet' : `${usedIn.teams} team${usedIn.teams === 1 ? '' : 's'}`}</span>
        </div>
      )}
    </div>
  )
}
