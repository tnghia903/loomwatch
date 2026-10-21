import { LANGUAGE, LENGTH, WORK, type QuickChoice, type QuickField } from '../../lib/firstrun/quickAbout'

const OPTIONS: { [F in QuickField]: readonly QuickChoice<F>[] } = { work: WORK, language: LANGUAGE, length: LENGTH }

/** The questions "Tell my agents about me" asks, in order, on the first run and the About you page. */
export const QUESTIONS: readonly { field: QuickField; label: string }[] = [
  { field: 'work', label: 'What do you do?' },
  { field: 'language', label: 'Answer in' },
  { field: 'length', label: 'How long?' },
]

/** One question's choices, each a toggle: a tap picks it, a second tap takes it back. */
export function QuickChoices<F extends QuickField>({ field, label, picked, onPick }: {
  field: F
  label: string
  picked: QuickChoice<F> | null
  onPick: (choice: QuickChoice<F> | null) => void
}) {
  const options: readonly QuickChoice<F>[] = OPTIONS[field]
  return (
    <div className="field you-choices" role="group" aria-label={label}>
      <span className="t-meta">{label}</span>
      <div className="you-chips">
        {options.map((choice) => (
          <button key={choice} type="button" className="you-chip" aria-pressed={picked === choice} onClick={() => onPick(picked === choice ? null : choice)}>{choice}</button>
        ))}
      </div>
    </div>
  )
}
