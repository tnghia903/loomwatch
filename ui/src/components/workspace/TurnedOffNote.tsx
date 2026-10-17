export interface TurnedOffNoteState {
  /** What was turned off: skill and tool names. */
  names: string[]
  /** The agents it was turned off for. */
  agents: string[]
  /** Whether that is every agent in the team. */
  everyone: boolean
}

export interface TurnedOffNoteProps {
  note: TurnedOffNoteState
  names: ReadonlyMap<string, string>
  onDismiss: () => void
}

const list = (items: readonly string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

/**
 * Over the canvas after a skill or tool is taken off it (ADR 0060): what is now turned off, and for
 * whom. Each agent's panel lists it to turn back on.
 */
export function TurnedOffNote({ note, names, onDismiss }: TurnedOffNoteProps) {
  const one = note.agents.length === 1
  const who = one ? names.get(note.agents[0]) ?? note.agents[0] : note.everyone ? 'every agent in this team' : `${note.agents.length} agents`
  const things = note.names.length === 1 ? 'it' : 'them'
  return <div className="instruction-update-bar turned-off-note" role="status">
    <span>
      Turned off <b className="instructions-source">{list(note.names)}</b> for {who}. {one ? 'It' : 'They'} won't use {things} on later runs, even from LoomWatch’s library. Each agent's panel can turn {things} back on.
    </span>
    <button type="button" className="btn" onClick={onDismiss}>OK</button>
  </div>
}
