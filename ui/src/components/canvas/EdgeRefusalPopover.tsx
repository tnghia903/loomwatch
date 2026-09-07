import type { EdgeRefusal } from '../../lib/team-file/edgeRules'

// docs/CANVAS_SPEC.md §6.6 refusal table. The spec anchors this at the cursor; without
// pointer tracking in useTeamDocument this renders bottom-center instead — same content,
// same 4s auto-dismiss (handled by the hook), same click-to-promote action.
export interface EdgeRefusalPopoverProps {
  refusal: EdgeRefusal
  onPromote: (agentId: string) => void
  onDismiss: () => void
}

export function EdgeRefusalPopover({ refusal, onPromote, onDismiss }: EdgeRefusalPopoverProps) {
  return (
    <div
      role="alert"
      className="pointer-events-auto flex items-center gap-3 rounded-md border border-hairline/10 bg-surface-solid px-3 py-2 text-[13px] text-ink shadow-[0_2px_4px_rgb(0_0_0/.06),0_16px_40px_rgb(0_0_0/.14)]"
    >
      <span>{refusal.message}</span>
      {refusal.promote && (
        <button
          type="button"
          onClick={() => onPromote(refusal.promote!)}
          className="shrink-0 rounded-md bg-iris/10 px-2 py-1 text-[12px] font-medium text-iris hover:bg-iris/20"
        >
          Make <span className="font-mono">{refusal.promote}</span> the entrypoint
        </button>
      )}
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 text-ink-3 hover:text-ink">
        ×
      </button>
    </div>
  )
}
