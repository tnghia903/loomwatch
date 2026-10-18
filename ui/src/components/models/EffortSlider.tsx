import { type CSSProperties, useId } from 'react'

import { price, shortName } from '../../lib/ai/client'
import { EFFORTS } from '../../lib/ai/modelIds'
import { useModels } from '../../lib/ai/useModels'

/** The slider's stops: the model's own default, then low, medium and high. */
const LEVELS = ['', ...EFFORTS] as const

const word = (effort: string) => (effort ? `${effort.charAt(0).toUpperCase()}${effort.slice(1)}` : 'Model default')

/**
 * What each stop means, said for someone choosing it: what it is good for, and how fast and costly
 * it is next to the others, out of three. The model's own default has no meters, because it
 * differs from model to model.
 */
const ABOUT: Record<string, { says: string; speed?: number; cost?: number }> = {
  '': { says: 'Left to the model. Some think a little before they answer, some not at all.' },
  low: { says: 'A quick think: the fastest and cheapest. Enough for sorting, short replies and simple look-ups.', speed: 3, cost: 1 },
  medium: { says: 'A steady think at a middle speed and price. Right for most work: writing, research and plans.', speed: 2, cost: 2 },
  high: { says: 'A long think: the slowest, and it costs the most. For hard problems, tricky reasoning and careful checks.', speed: 1, cost: 3 },
}

/** Where an effort the slider has no stop for sits on it: `minimal` by low, `xhigh` and `max` at the top. */
function stop(effort: string): number {
  const exact = LEVELS.indexOf(effort as (typeof LEVELS)[number])
  if (exact >= 0) return exact
  return effort === 'minimal' || effort === 'none' ? 1 : LEVELS.length - 1
}

/** Three pips, `filled` of them lit. Its words are in the line beside it. */
function Meter({ label, filled }: { label: string; filled: number }) {
  return (
    <span className="thinking-meter" aria-hidden="true">
      {label}
      <span className="thinking-pips">{[1, 2, 3].map((pip) => <i key={pip} className={pip <= filled ? 'on' : ''} />)}</span>
    </span>
  )
}

/**
 * How hard the agent's model thinks before it answers. Every stop is named under the track, and
 * the line below says what the chosen one is good for, how fast and costly it is, and what thinking
 * costs on this model. A model OpenRouter lists as not reasoning has no setting; one the list
 * hasn't arrived for yet keeps the slider, and an effort it doesn't take is left to the model.
 */
export function EffortSlider({ model, value = '', onChange, disabled = false, className = 'field thinking-field' }: { model: string; value?: string; onChange?: (effort: string | undefined) => void; disabled?: boolean; className?: string }) {
  const id = useId()
  const { catalog } = useModels()
  const listed = catalog?.models.find((item) => item.id === model)
  const reasons = listed ? listed.reasoning : true
  const offScale = Boolean(value) && !LEVELS.includes(value as (typeof LEVELS)[number])
  const at = stop(value)
  const about = ABOUT[LEVELS[at]]
  // The track fills up to the thumb's middle, which travels half a thumb in from each end.
  const fill = { '--thinking-fill': `calc(var(--thinking-thumb) / 2 + (100% - var(--thinking-thumb)) * ${at / (LEVELS.length - 1)})` } as CSSProperties
  const cost = listed && !listed.free
    ? `Thinking is paid for like writing: ${price(listed.outputPrice)} per million tokens on ${shortName(listed)}.`
    : listed?.free
      ? 'Thinking is free on this model, within its daily limit.'
      : 'Thinking is paid for like writing, so more effort costs more.'
  return (
    <div className={className}>
      <span className="thinking-label"><label className="t-meta" htmlFor={id}>Thinking effort</label><output className="t-body-m" htmlFor={id}>{reasons ? word(value) : 'Model default'}</output></span>
      {reasons && <>
        <span className="thinking-track" style={fill}>
          <span className="thinking-stops" aria-hidden="true">
            {LEVELS.map((level, index) => <i key={level} className={index <= at ? 'on' : ''} style={{ left: `${(index / (LEVELS.length - 1)) * 100}%` }} />)}
          </span>
          <input
            id={id}
            className="thinking-slider"
            type="range"
            min={0}
            max={LEVELS.length - 1}
            step={1}
            value={at}
            disabled={disabled || !onChange}
            aria-label="Thinking effort"
            aria-valuetext={word(value)}
            aria-describedby={`${id}-about`}
            onChange={(event) => onChange?.(LEVELS[Number(event.target.value)] || undefined)}
          />
        </span>
        <span className="thinking-scale t-meta" aria-hidden="true">
          {LEVELS.map((level, index) => <span key={level} className={index === at ? 'on' : ''} style={{ left: `${(index / (LEVELS.length - 1)) * 100}%` }}>{level ? word(level) : 'Default'}</span>)}
        </span>
        <span className="thinking-about" id={`${id}-about`}>
          <span className="t-meta">{offScale ? `${word(value)} is beyond what most work needs, and costs the most.` : about.says}</span>
          {about.speed !== undefined && about.cost !== undefined && <span className="thinking-meters t-micro">
            <Meter label="Speed" filled={about.speed} />
            <Meter label="Cost" filled={about.cost} />
          </span>}
        </span>
      </>}
      <span className="hint t-meta">{reasons ? cost : 'This model doesn’t reason separately, so it has no effort setting.'}</span>
    </div>
  )
}
