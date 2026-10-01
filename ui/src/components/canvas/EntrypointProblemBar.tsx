import type { EntrypointProblem } from '../../lib/team-file/useTeamDocument'

// docs/CANVAS_SPEC.md §5.4: each remaining agent is a one-click promotion.
export function EntrypointProblemBar({ problem, onPromote }: { problem: EntrypointProblem; onPromote: (agentId: string) => void }) {
  return (
    <div role="alert" className="lw-notice t-meta" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--sp-2)', pointerEvents: 'auto' }}>
      <span>{problem.message}</span>
      {problem.candidates.map((candidate) => (
        <button key={candidate.id} type="button" className="btn" style={{ height: 24 }} onClick={() => onPromote(candidate.id)}>
          Make <span className="t-mono-sm">{candidate.name}</span> the entry point
        </button>
      ))}
    </div>
  )
}
