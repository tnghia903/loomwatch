import { Box, BookOpen, Puzzle, Wrench, X } from 'lucide-react'

import type { AgentPlace } from '../../lib/team-file/agentPlace'
import type { AgentConfig, CapabilityRef } from '../../lib/team-file/types'

export interface AgentContextProps {
  agent: AgentConfig
  place?: AgentPlace
  pipeline?: boolean
  /** How many Brief entries this team supplies, so the zone never promises what does not exist. */
  briefCount?: number
  /** Other teams' memory and imported packs this agent is supplied, by display name. */
  inheritedMemory?: readonly string[]
  readOnly?: boolean
  onPromoteEntrypoint?: () => void
  onAllowRecruitingChange?: (allow: boolean) => void
  onMemoryBriefChange?: (readsBrief: boolean) => void
  onRemoveCapability?: (capability: CapabilityRef) => void
}

const KIND: Record<CapabilityRef['kind'], { Icon: typeof Puzzle; label: string }> = {
  skill: { Icon: Puzzle, label: 'Skill · its instructions are supplied' },
  knowledge: { Icon: Box, label: 'Knowledge · supplied as source material' },
  tool: { Icon: Wrench, label: 'Tool · available while it works' },
}

/**
 * CONTEXT — what one agent is given when it starts: its place in the team, the team Brief, and
 * everything connected to it. It replaced the BEHAVIOUR zone (ADR 0034), whose five switches
 * either repeated the canvas, did nothing in team mode, or asked an operator to choose a
 * delivery channel by its implementation name.
 *
 * The copy keeps docs/TEAM_MEMORY.md's rule: things are *supplied*; the agent is never said to
 * know, remember or have read them.
 */
export function AgentContext({ agent, place, pipeline = false, briefCount = 0, inheritedMemory = [], readOnly = false, onPromoteEntrypoint, onAllowRecruitingChange, onMemoryBriefChange, onRemoveCapability }: AgentContextProps) {
  const capabilities = agent.capabilities ?? []
  // A team with no Brief supplies nothing, so the switch may not read as "on".
  const readsBrief = agent.memory?.brief !== false && briefCount > 0
  const nothingConnected = capabilities.length === 0 && inheritedMemory.length === 0

  return (
    <div className="agent-context">
      {place && (
        <div className="agent-context-place">
          <div className="t-body">{place.summary}</div>
          <div className="t-meta agent-context-note">The agent is told this at the start of every run.</div>
          {place.canStart && onPromoteEntrypoint && !readOnly && (
            <button type="button" className="link t-meta" onClick={onPromoteEntrypoint}>Make this the starting agent</button>
          )}
        </div>
      )}

      {pipeline && onAllowRecruitingChange && (
        <button type="button" className={`check ${agent.allowRecruiting !== false ? 'on' : ''}`} disabled={readOnly} onClick={() => onAllowRecruitingChange(agent.allowRecruiting === false)} aria-pressed={agent.allowRecruiting !== false}>
          <span className="box"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></span>
          <span className="txt"><b className="t-body">Can bring in helpers</b><span className="t-meta">Can ask agents outside the steps to help with its step. It can always ask the step before it.</span></span>
        </button>
      )}

      {onMemoryBriefChange && (briefCount > 0
        ? (
          <button type="button" className={`check ${readsBrief ? 'on' : ''}`} disabled={readOnly} onClick={() => onMemoryBriefChange(agent.memory?.brief === false)} aria-pressed={readsBrief}>
            <span className="box"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></span>
            <span className="txt"><b className="t-body">Team Brief</b><span className="t-meta">{readsBrief ? `${briefCount} ${briefCount === 1 ? 'entry' : 'entries'} supplied at the start of every session` : `Not supplied — ${briefCount} ${briefCount === 1 ? 'entry' : 'entries'} left out`}</span></span>
          </button>
        )
        : <div className="t-meta agent-context-empty">No team Brief yet. Notes you add in Memory are supplied to every agent.</div>)}

      {nothingConnected
        ? <div className="t-meta agent-context-empty">Nothing connected. Drag a skill, knowledge source or tool from the Library onto this agent.</div>
        : (
          <ul className="agent-context-list" aria-label="Connected to this agent">
            {capabilities.map((capability) => {
              const { Icon, label } = KIND[capability.kind]
              return (
                <li key={`${capability.kind}:${capability.name}`}>
                  <Icon size={14} aria-hidden="true" />
                  <span className="agent-context-name"><b className="t-body">{capability.name}</b><span className="t-meta">{label}</span></span>
                  {onRemoveCapability && !readOnly && (
                    <button type="button" className="iconbtn" aria-label={`Disconnect ${capability.name}`} title="Disconnect" onClick={() => onRemoveCapability(capability)}><X size={13} aria-hidden="true" /></button>
                  )}
                </li>
              )
            })}
            {inheritedMemory.map((name) => (
              <li key={`memory:${name}`}>
                <BookOpen size={14} aria-hidden="true" />
                <span className="agent-context-name"><b className="t-body">{name}</b><span className="t-meta">Memory · supplied from another team</span></span>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}
