import { NEW_SEND_BACK, SEND_BACK_ROUNDS, type SendBackSetting } from '../../lib/team-file/sendBack'

export interface CheckStepProps {
  /** The agent whose work this one checks; absent while nothing is connected into it. */
  checkedName?: string
  /** That agent has a Done when list; without one the check is against the request. */
  checkedHasDoneWhen: boolean
  /** How the work goes back when a check is not met (`sendBackOf`); `null`: it never does. */
  sendBack: SendBackSetting | null
  readOnly?: boolean
  onSendBack: (setting: SendBackSetting | null) => void
}

/**
 * CHECKS, on a check step (ADR 0062): whose work it checks and against what, as state, and its one
 * choice in plain words: whether what is not met goes back to that agent, how many times, and what
 * happens when the checks are still not met after that.
 */
export function CheckStep({ checkedName, checkedHasDoneWhen, sendBack, readOnly = false, onSendBack }: CheckStepProps) {
  return (
    <div className="done-when check-step" role="group" aria-label="Checks">
      <div className="done-when-head">
        <span className="t-micro">Checks</span>
        <span className="t-meta">
          {!checkedName
            ? 'Connect the agent whose work it should check.'
            : checkedHasDoneWhen
              ? `${checkedName}’s work, against its Done when. What it finds shows on the answer.`
              : `${checkedName}’s work, against the request only: ${checkedName} has no Done when, and its Done when is what “checks met” means.`}
        </span>
      </div>
      {checkedName && (
        <>
          <label className="check-step-switch">
            <input type="checkbox" checked={Boolean(sendBack)} disabled={readOnly} onChange={(event) => onSendBack(event.target.checked ? { ...NEW_SEND_BACK } : null)} />
            <span>Send the work back to {checkedName} when a check isn’t met</span>
          </label>
          {sendBack && (
            <div className="check-step-loop">
              <div className="check-step-rounds" role="radiogroup" aria-label="How many times the work may go back">
                <span>Up to</span>
                {SEND_BACK_ROUNDS.map((rounds) => (
                  <label key={rounds} className="check-step-choice">
                    <input type="radio" name="check-step-rounds" checked={sendBack.rounds === rounds} disabled={readOnly} onChange={() => onSendBack({ ...sendBack, rounds })} />
                    <span>{rounds}</span>
                  </label>
                ))}
                <span>{sendBack.rounds === 1 ? 'time' : 'times'}</span>
              </div>
              <div className="check-step-exit" role="radiogroup" aria-label="If checks still aren’t met">
                <span>If checks still aren’t met:</span>
                <label className="check-step-choice">
                  <input type="radio" name="check-step-exit" checked={sendBack.whenStillNotMet === 'ask'} disabled={readOnly} onChange={() => onSendBack({ ...sendBack, whenStillNotMet: 'ask' })} />
                  <span>Ask me first <span className="t-meta">· the run waits for you, a scheduled one too</span></span>
                </label>
                <label className="check-step-choice">
                  <input type="radio" name="check-step-exit" checked={sendBack.whenStillNotMet === 'answer'} disabled={readOnly} onChange={() => onSendBack({ ...sendBack, whenStillNotMet: 'answer' })} />
                  <span>Show the answer anyway <span className="t-meta">· with what wasn’t met marked</span></span>
                </label>
              </div>
            </div>
          )}
          <p className="t-meta check-step-tip">Checks catch more on a model from another maker than {checkedName}’s, or a stronger one: a model tends to pass its own work.</p>
        </>
      )}
    </div>
  )
}
