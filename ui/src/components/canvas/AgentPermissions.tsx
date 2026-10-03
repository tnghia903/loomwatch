import { Check, FilePen, Globe, SquareTerminal } from 'lucide-react'

import { actsWithoutAsking, ALLOW_SWITCHES } from '../../lib/team-file/allow'
import type { AgentConfig, AllowSwitch } from '../../lib/team-file/types'
import { SectionHead } from '../ui/SectionHead'

export interface AgentPermissionsProps {
  agent: AgentConfig
  readOnly?: boolean
  onChange?: (key: AllowSwitch, on: boolean) => void
  /** The heading's look in the panel that shows it. */
  headClassName?: string
}

const ICONS: Record<AllowSwitch, typeof Globe> = { web: Globe, edits: FilePen, commands: SquareTerminal }

/**
 * ALLOWED WITHOUT ASKING (ADR 0037). LoomWatch answers every permission request the agent's app
 * makes: these switches are what it says yes to by itself, and anything else waits for the
 * operator's answer during the run (ADR 0040). Everything defaults to off, and what is connected to
 * the agent (its tools, its folders, the team's own handovers) never needs a switch.
 *
 * Each switch is a tile that says what happens — "Asks you" or "Allowed" — so the section reads
 * without its explanation; only a switch that is on adds a line, because only then is there a
 * consequence to know about.
 */
export function AgentPermissions({ agent, readOnly = false, onChange, headClassName }: AgentPermissionsProps) {
  const app = actsWithoutAsking(agent)
  const allowed = ALLOW_SWITCHES.filter(({ key }) => agent.allow?.[key] === true)
  return (
    <div className="agent-context agent-permissions">
      <SectionHead title="Allowed without asking" className={headClassName} explain={<>
        <div>Anything else this agent asks to do waits for your answer during a run, and is declined if nobody answers within 10 minutes. Scheduled runs decline it straight away.</div>
        {ALLOW_SWITCHES.map(({ key, label, off }) => <div key={key}><b>{label}</b> off: {off.charAt(0).toLowerCase()}{off.slice(1)}</div>)}
      </>} />
      <div className="allow-tiles">
        {ALLOW_SWITCHES.map(({ key, label, short, on, off }) => {
          const active = agent.allow?.[key] === true
          const Icon = ICONS[key]
          return (
            <button key={key} type="button" className={`allow-tile ${active ? 'on' : ''}`} disabled={readOnly || !onChange} onClick={() => onChange?.(key, !active)} aria-pressed={active} aria-label={label} title={active ? on : off} data-allow={key}>
              {active && <Check className="allow-tile-tick" size={10} strokeWidth={3} aria-hidden="true" />}
              <Icon size={15} aria-hidden="true" />
              <span className="allow-tile-name">{short}</span>
              <span className="allow-tile-state">{active ? 'Allowed' : 'Asks you'}</span>
            </button>
          )
        })}
      </div>
      {allowed.length > 0 && !app && (
        <ul className="allow-consequences t-meta">
          {allowed.map(({ key, on }) => <li key={key}>{on}</li>)}
        </ul>
      )}
      {app && <div className="t-meta agent-context-warning">{app} doesn’t ask before it acts, so these switches can’t hold it back.</div>}
    </div>
  )
}
