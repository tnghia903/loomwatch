import type { AgentNode } from '../../lib/library/nodeFromDrop'

interface BuildOutcomeProps {
  responder: string | null
  agents: readonly AgentNode[]
  pipeline: boolean
  /** Only a pipeline names its responder; in team mode the entrypoint answers. */
  canChooseResponder: boolean
  onPromoteResponder: (id: string) => void
  onPreview: () => void
}

/** Build's "Team output" card: who delivers the result of the next run. */
export function BuildOutcome({ responder, agents, pipeline, canChooseResponder, onPromoteResponder, onPreview }: BuildOutcomeProps) {
  return (
    <aside className="build-outcome" aria-label="Expected team output">
      <span className="delivery-eyebrow">Team output</span>
      <h2>Choose who delivers the result.</h2>
      <label>Final response by
        <select aria-label="Final response owner" value={responder ?? ''} disabled={!canChooseResponder} onChange={(event) => onPromoteResponder(event.target.value)}>
          {!responder && <option value="" disabled>Choose an agent</option>}
          {agents.map((node) => <option key={node.id} value={node.id}>{node.data.agent.name}</option>)}
        </select>
      </label>
      <p>{pipeline ? 'This agent’s answer becomes the team output. Each stage keeps its own work and evidence.' : 'The lead agent delivers the team’s final response.'}</p>
      <button className="btn btn-primary" onClick={onPreview}>Preview next run</button>
    </aside>
  )
}
