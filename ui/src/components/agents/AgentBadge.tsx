import { Check, FilePen, Globe, SquareTerminal } from 'lucide-react'

import type { DetectedHarness } from '../../lib/harnesses'
import type { AgentDraft } from '../../lib/library/draft'
import { agentFromDraft } from '../../lib/library/draft'
import { actsWithoutAsking, ALLOW_SWITCHES } from '../../lib/team-file/allow'
import type { AllowSwitch } from '../../lib/team-file/types'
import { AgentMark } from '../ui/AgentMark'

const ICONS: Record<AllowSwitch, typeof Globe> = { web: Globe, edits: FilePen, commands: SquareTerminal }

export interface AgentBadgeProps {
  /** Stable id for the woven mark: the saved agent's id, else its name. */
  markId: string
  draft: AgentDraft
  harness: DetectedHarness | null
  /** The model's name to show; the id when no name is known. */
  modelName?: string
  version?: number | null
  /** Teams that use it, and how many of those run on a schedule. */
  usedIn?: { teams: number; scheduled: number; behind: number }
  compact?: boolean
}

/**
 * The agent's ID card: who it is, what it runs on, what it may do — with what each switch means
 * right now — what it carries, and where it is used. It is the staff badge of the design notes:
 * an access card with an "after hours" rule, because a scheduled team has nobody to answer.
 */
export function AgentBadge({ markId, draft, harness, modelName, version, usedIn, compact = false }: AgentBadgeProps) {
  const agent = agentFromDraft(draft, harness)
  const wild = actsWithoutAsking(agent)
  const scheduled = (usedIn?.scheduled ?? 0) > 0
  const asks = ALLOW_SWITCHES.filter(({ key }) => !draft.allow[key])
  const name = draft.name.trim() || 'New agent'
  return (
    <div className={`agent-badge${compact ? ' compact' : ''}`}>
      <div className="agent-badge-head">
        <AgentMark id={markId} name={name} size={compact ? 26 : 34} animate={false} />
        <div className="agent-badge-who">
          <strong>{name}</strong>
          {draft.does.trim() && <span className="agent-badge-does">{draft.does.trim()}</span>}
          <span className="agent-badge-app t-mono-sm">{harness ? harness.name : 'No app chosen'}{harness ? ` · ${modelName || draft.model || 'its current model'}` : ''}</span>
        </div>
        {version != null && <span className="agent-badge-version" title={`Version ${version}`}>v{version}</span>}
      </div>
      <div className="agent-badge-row">
        <span className="agent-badge-label">Access</span>
        <span className="agent-badge-tiles">
          {ALLOW_SWITCHES.map(({ key, short, label }) => {
            const on = draft.allow[key] === true
            const state = wild ? 'wild' : on ? 'on' : 'asks'
            const Icon = ICONS[key]
            const word = wild ? 'Doesn’t ask' : on ? 'Allowed' : 'Asks you'
            return <span key={key} className={`agent-badge-tile ${state}`} title={`${label}: ${word}`}>{on && !wild && <Check size={10} strokeWidth={3} aria-hidden="true" />}<Icon size={13} aria-hidden="true" /><span>{short}</span><em>{word}</em></span>
          })}
        </span>
      </div>
      {wild && <p className="agent-badge-warn">{wild} doesn’t ask before it acts, so these switches can’t hold it back.</p>}
      {!wild && !compact && asks.length > 0 && (
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
      {usedIn && (
        <div className="agent-badge-row">
          <span className="agent-badge-label">Used in</span>
          <span>{usedIn.teams === 0 ? 'No team yet' : `${usedIn.teams} team${usedIn.teams === 1 ? '' : 's'}`}{usedIn.behind > 0 ? <em className="agent-badge-behind"> · {usedIn.behind} on an older version</em> : null}</span>
        </div>
      )}
    </div>
  )
}
