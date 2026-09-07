import type { EntrypointProblem } from '../../lib/team-file/useTeamDocument'

// docs/CANVAS_SPEC.md §5.4: "the problems popover carries [the message] with each remaining
// agent as a one-click promotion." Only rendered when there is something to promote — the
// last-agent case (§10.2) has no candidates, and its reason already shows on the chip itself.
export interface EntrypointProblemBarProps {
  problem: EntrypointProblem
  onPromote: (agentId: string) => void
}

export function EntrypointProblemBar({ problem, onPromote }: EntrypointProblemBarProps) {
  return (
    <div
      role="alert"
      className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-md border border-copper/30 bg-surface-solid px-3 py-2 text-[13px] text-ink shadow-[0_2px_4px_rgb(0_0_0/.06),0_16px_40px_rgb(0_0_0/.14)]"
    >
      <span>{problem.message}</span>
      {problem.candidates.map((candidate) => (
        <button
          key={candidate.id}
          type="button"
          onClick={() => onPromote(candidate.id)}
          className="shrink-0 rounded-md bg-iris/10 px-2 py-1 text-[12px] font-medium text-iris hover:bg-iris/20"
        >
          Make <span className="font-mono">{candidate.name}</span> the entrypoint
        </button>
      ))}
    </div>
  )
}
