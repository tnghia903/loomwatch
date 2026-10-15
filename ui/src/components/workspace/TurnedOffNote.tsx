export interface TurnedOffNoteState {
  /** What was turned off: skill and tool names. */
  names: string[]
  /** The agents it was turned off for. */
  agents: string[]
  /** Whether a tool was among them: Codex can't turn off a tool from its own settings. */
  tools: boolean
  /** Whether that is every agent in the team that runs an app. */
  everyone: boolean
}

export interface TurnedOffNoteProps {
  note: TurnedOffNoteState
  names: ReadonlyMap<string, string>
  /** Apps whose agents can still use their own copy of something turned off (ADR 0060). */
  stillOwn: readonly string[]
  onDismiss: () => void
}

const list = (items: readonly string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

/**
 * Over the canvas after a skill or tool is taken off it (ADR 0060): what is now turned off, and for
 * whom, including the copy their app has of its own. Each agent's panel lists it to turn back on.
 */
export function TurnedOffNote({ note, names, stillOwn, onDismiss }: TurnedOffNoteProps) {
  const one = note.agents.length === 1
  const who = one ? names.get(note.agents[0]) ?? note.agents[0] : note.everyone ? 'every agent in this team' : `${note.agents.length} agents`
  const things = note.names.length === 1 ? 'it' : 'them'
  return <div className="instruction-update-bar turned-off-note" role="status">
    <span>
      Turned off <b className="instructions-source">{list(note.names)}</b> for {who}. {stillOwn.length === 0 ? `${one ? 'It' : 'They'} won't use ${things} on later runs, even from ${one ? 'its' : 'their'} own app.` : `LoomWatch stops giving ${things}, but ${list(stillOwn)} can still use ${one && note.names.length === 1 ? 'its' : 'their'} own copy.`} Each agent's panel can turn {things} back on.
    </span>
    <button type="button" className="btn" onClick={onDismiss}>OK</button>
  </div>
}

export interface NotionOfferProps {
  /** The Claude agents that can still reach Notion through the operator's claude.ai account. */
  agents: readonly string[]
  readOnly?: boolean
  onTurnOff: () => void
  onKeep: () => void
}

/**
 * After the team's last Notion page card is taken off (ADR 0060): a page card is not the Notion
 * connector, so Claude agents can still reach Notion through the operator's claude.ai account.
 * Turning that off too is offered, not done: the operator may only have meant the page.
 */
export function NotionOffer({ agents, readOnly = false, onTurnOff, onKeep }: NotionOfferProps) {
  return <div className="instruction-update-bar" role="status">
    <span>{agents.length === 1 ? 'Your Claude agent' : `Your ${agents.length} Claude agents`} can still reach Notion through your claude.ai account.</span>
    {!readOnly && <button type="button" className="btn btn-primary" onClick={onTurnOff}>Turn off Notion for this team</button>}
    <button type="button" className="btn" onClick={onKeep}>Keep it</button>
  </div>
}
