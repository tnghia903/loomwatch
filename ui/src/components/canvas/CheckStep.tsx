export interface CheckStepProps {
  /** The agent whose work this one checks; absent while nothing is connected into it. */
  checkedName?: string
  /** That agent has a Done when list; without one the check is against the request. */
  checkedHasDoneWhen: boolean
  sendBackOnce: boolean
  readOnly?: boolean
  onSendBackOnce: (on: boolean) => void
}

/**
 * CHECKS, on a check step (ADR 0062): whose work it checks and against what, as state, and the one
 * choice it has — whether a missed check goes back to that agent once before the answer is shown.
 */
export function CheckStep({ checkedName, checkedHasDoneWhen, sendBackOnce, readOnly = false, onSendBackOnce }: CheckStepProps) {
  return (
    <div className="done-when check-step" role="group" aria-label="Checks">
      <div className="done-when-head">
        <span className="t-micro">Checks</span>
        <span className="t-meta">
          {!checkedName
            ? 'Connect the agent whose work it should check.'
            : checkedHasDoneWhen
              ? `${checkedName}’s work, against its Done when. What it finds shows on the answer.`
              : `${checkedName}’s work, against the request: ${checkedName} has no Done when.`}
        </span>
      </div>
      {checkedName && (
        <label className="check-step-switch">
          <input type="checkbox" checked={sendBackOnce} disabled={readOnly} onChange={(event) => onSendBackOnce(event.target.checked)} />
          <span>Send the work back once when a check is not met</span>
        </label>
      )}
    </div>
  )
}
