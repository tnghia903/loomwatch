import { actsWithoutAsking, ALLOW_SWITCHES } from '../../lib/team-file/allow'
import type { AgentConfig, AllowSwitch } from '../../lib/team-file/types'

export interface AgentPermissionsProps {
  agent: AgentConfig
  readOnly?: boolean
  onChange?: (key: AllowSwitch, on: boolean) => void
}

/**
 * ALLOWED WITHOUT ASKING (ADR 0037). LoomWatch cannot ask the operator in the middle of a run, so
 * it answers every permission request the agent's app makes itself: these switches are what it
 * says yes to. Everything defaults to off, and what is connected to the agent (its tools, its
 * folders, the team's own handovers) never needs a switch.
 */
export function AgentPermissions({ agent, readOnly = false, onChange }: AgentPermissionsProps) {
  const app = actsWithoutAsking(agent)
  return (
    <div className="agent-context agent-permissions">
      <div className="t-meta agent-context-note">LoomWatch can’t ask you during a run, so it says no to anything else this agent asks to do.</div>
      {ALLOW_SWITCHES.map(({ key, label, on, off }) => {
        const active = agent.allow?.[key] === true
        return (
          <button key={key} type="button" className={`check ${active ? 'on' : ''}`} disabled={readOnly || !onChange} onClick={() => onChange?.(key, !active)} aria-pressed={active} data-allow={key}>
            <span className="box"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></span>
            <span className="txt"><b className="t-body">{label}</b><span className="t-meta">{active ? on : off}</span></span>
          </button>
        )
      })}
      {app && <div className="t-meta agent-context-note">{app} doesn’t ask before it acts, so these switches can’t hold it back.</div>}
    </div>
  )
}
