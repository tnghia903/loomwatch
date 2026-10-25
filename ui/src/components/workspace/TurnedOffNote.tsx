export interface TurnedOffNoteState {
  /** What was turned off: skill and tool names; or, with `ownRead`, the reads taken off the agent. */
  names: string[]
  /** The agents it was turned off for. */
  agents: string[]
  /** Whether that is every agent in the team. */
  everyone: boolean
  /** What came off was one of the agent's own reads: knowledge isn't turned off for one team, so it
      came off the agent, in every team it's in (ADR 0094). */
  ownRead?: boolean
}

export interface TurnedOffNoteProps {
  note: TurnedOffNoteState
  names: ReadonlyMap<string, string>
  onDismiss: () => void
}

const list = (items: readonly string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

/**
 * Over the canvas after something is taken off it: a skill or tool turned off in this team (ADR
 * 0060), and for whom, or one of an agent's own reads taken off the agent itself.
 */
export function TurnedOffNote({ note, names, onDismiss }: TurnedOffNoteProps) {
  const one = note.agents.length === 1
  const name = names.get(note.agents[0]) ?? note.agents[0]
  const things = note.names.length === 1 ? 'it' : 'them'
  const what = <b className="instructions-source">{list(note.names)}</b>
  const whose = one ? 'its' : 'their'
  return <div className="instruction-update-bar turned-off-note" role="status">
    <span>
      {note.ownRead
        ? <>Took {what} off {one ? name : list(note.agents.map((id) => names.get(id) ?? id))} in every team {one ? 'it’s' : 'they’re'} in, since {note.names.length === 1 ? `it’s one of ${whose} own reads` : `they’re ${whose} own reads`}. To give {things} back, open Agents.</>
        // Only in this team: the agent's own skills and tools stay its own in every other (ADR 0094).
        : one
          ? <>Turned off {what} for {name} in this team only. Select {name} to turn {things} back on, or change its skills and tools in Agents for every team.</>
          : <>Turned off {what} for {note.everyone ? 'every agent' : `${note.agents.length} agents`} in this team. Select an agent to turn {things} back on.</>}
    </span>
    <button type="button" className="btn" onClick={onDismiss}>OK</button>
  </div>
}
