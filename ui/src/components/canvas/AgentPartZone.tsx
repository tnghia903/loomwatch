import { PART_CHARS, tidyPart } from '../../lib/team-file/part'
import type { AgentPart } from '../../lib/team-file/types'
import { SectionHead } from '../ui/SectionHead'
import { DoneWhen } from './DoneWhen'

export interface AgentPartZoneProps {
  part: AgentPart | undefined
  readOnly?: boolean
  /** The part as it now is, or `undefined` once it says nothing. */
  onChange: (part: AgentPart | undefined) => void
  headClassName?: string
}

/**
 * What this team needs from the agent (ADR 0097), under its own instructions: the team's, kept in
 * the team file, so one of My agents fits any team and each team says here what it needs. The text
 * is written when the field is left, as a Done when item is.
 */
export function AgentPartZone({ part, readOnly = false, onChange, headClassName }: AgentPartZoneProps) {
  const text = part?.text ?? ''
  const write = (next: AgentPart) => onChange(tidyPart(next))
  return (
    <div className="agent-part" role="group" aria-label="Its part in this team">
      <SectionHead
        title="Its part in this team"
        className={headClassName}
        explain="What this team needs from this agent. It reads this beside its instructions in this team only, and checks its result against these items as well as its own Done when."
      />
      <textarea
        // A new part from elsewhere (Ask, Undo) replaces what the field shows.
        key={text}
        className="input"
        defaultValue={text}
        maxLength={PART_CHARS}
        rows={Math.max(2, Math.ceil(text.length / 44))}
        readOnly={readOnly}
        placeholder="What this team needs from it."
        aria-label="What this team needs from it"
        onBlur={(event) => { if (event.target.value.trim() !== text) write({ ...part, text: event.target.value }) }}
      />
      <DoneWhen label="Done when in this team" items={part?.doneWhen ?? []} readOnly={readOnly} onChange={(items) => write({ ...part, doneWhen: items })} />
    </div>
  )
}
