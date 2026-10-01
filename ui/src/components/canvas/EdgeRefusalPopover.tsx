import type { EdgeRefusal } from '../../lib/team-file/edgeRules'

// docs/CANVAS_SPEC.md §6.6 refusal table: non-destructive, names the rule, offers the fix.
export function EdgeRefusalPopover({ refusal, onPromote, onDismiss }: { refusal: EdgeRefusal; onPromote: (agentId: string) => void; onDismiss: () => void }) {
  return (
    <div role="alert" className="e2 pop-inline t-body" style={{ pointerEvents: 'auto', borderRadius: 'var(--r-md)' }}>
      <span>{refusal.message}</span>
      {refusal.promote && (
        <button type="button" className="btn" onClick={() => onPromote(refusal.promote!)}>
          Start the team with <span className="t-mono-sm">{refusal.promote}</span> instead
        </button>
      )}
      <button type="button" className="iconbtn" style={{ width: 24, height: 24 }} onClick={onDismiss} aria-label="Dismiss">×</button>
    </div>
  )
}
