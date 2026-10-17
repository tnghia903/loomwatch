import { useId } from 'react'

import { EFFORTS } from '../../lib/ai/modelIds'
import { useModels } from '../../lib/ai/useModels'

/** The slider's stops: the model's own default, then low, medium and high. */
const LEVELS = ['', ...EFFORTS] as const

const word = (effort: string) => (effort ? `${effort.charAt(0).toUpperCase()}${effort.slice(1)}` : 'Model default')

/** Where an effort the slider has no stop for sits on it: `minimal` by low, `xhigh` and `max` at the top. */
function stop(effort: string): number {
  const exact = LEVELS.indexOf(effort as (typeof LEVELS)[number])
  if (exact >= 0) return exact
  return effort === 'minimal' || effort === 'none' ? 1 : LEVELS.length - 1
}

/**
 * How hard the agent's model thinks before it answers. A model OpenRouter lists as not reasoning
 * has no setting; one the list hasn't arrived for yet keeps the slider, and an effort it doesn't
 * take is left to the model.
 */
export function EffortSlider({ model, value = '', onChange, disabled = false, className = 'field thinking-field' }: { model: string; value?: string; onChange?: (effort: string | undefined) => void; disabled?: boolean; className?: string }) {
  const id = useId()
  const { catalog } = useModels()
  const listed = catalog?.models.find((item) => item.id === model)
  const reasons = listed ? listed.reasoning : true
  const offScale = Boolean(value) && !LEVELS.includes(value as (typeof LEVELS)[number])
  return (
    <div className={className}>
      <span className="thinking-label"><label className="t-meta" htmlFor={id}>Thinking effort</label><output className="t-body-m" htmlFor={id}>{reasons ? word(value) : 'Model default'}</output></span>
      {reasons && <input
        id={id}
        className="thinking-slider"
        type="range"
        min={0}
        max={LEVELS.length - 1}
        step={1}
        value={stop(value)}
        disabled={disabled || !onChange}
        aria-label="Thinking effort"
        aria-valuetext={word(value)}
        onChange={(event) => onChange?.(LEVELS[Number(event.target.value)] || undefined)}
      />}
      {reasons && <span className="thinking-scale t-micro"><span>Its default</span><span>High</span></span>}
      <span className="hint t-meta">{!reasons
        ? 'This model doesn’t reason separately, so it has no effort setting.'
        : offScale
          ? `${word(value)} is beyond what most work needs, and thinking is paid for like writing.`
          : 'How much it reasons before it answers. Thinking is paid for like writing, so more effort costs more.'}</span>
    </div>
  )
}
