import { type CSSProperties, useId } from 'react'

import { type Catalog, type Model, price, shortName } from '../../lib/ai/client'
import { effortWord, modelEfforts, placeEffort } from '../../lib/ai/efforts'
import { parseModelRef } from '../../lib/ai/modelIds'
import { useAiStatus } from '../../lib/ai/useKeyStatus'
import { useModels } from '../../lib/ai/useModels'

/**
 * What a stop means, said for someone choosing it: what it is good for, and how fast and costly it
 * is next to the model's others. `top` says it is the model's highest, so "the slowest" is true;
 * `plan` says it runs on the ChatGPT plan, where more thinking uses more of the plan, not money.
 */
function says(effort: string, top: boolean, plan: boolean): string {
  const most = plan ? 'uses the most of your plan' : 'costs the most'
  switch (effort) {
    case '': return 'Left to the model. Some think a little before they answer, some not at all.'
    case 'none': return 'No thinking: it answers straight away. The fastest, for simple replies.'
    case 'low': return `A quick think: ${plan ? 'the fastest, and it uses the least of your plan' : 'the fastest and cheapest'}. Enough for sorting, short replies and simple look-ups.`
    case 'medium': return `A steady think at a middle speed ${plan ? 'and share of your plan' : 'and price'}. Right for most work: writing, research and plans.`
    case 'high': return top
      ? `A long think: the slowest, and it ${most}. For hard problems, tricky reasoning and careful checks.`
      : `A long think: slower, and it ${plan ? 'uses more of your plan' : 'costs more'}. For hard problems, tricky reasoning and careful checks. Enough for almost any job.`
    case 'xhigh': return top
      ? `An extra long think: the slowest, and it ${most}. Only for the hardest problems, when high isn’t enough.`
      : `An extra long think: slower than high, and it ${plan ? 'uses more of your plan' : 'costs more'}. Only for the hardest problems, when high isn’t enough.`
    case 'max': return top
      ? `As long as this model will think: the slowest, and it ${most}. It often overthinks, so keep it for the very hardest work.`
      : `A very long think: slower than extra high, and it ${plan ? 'uses more of your plan' : 'costs more'}. It often overthinks, so keep it for the very hardest work.`
    case 'ultra': return `The longest think this model has: the slowest, and it ${most}. It often overthinks, so keep it for the very hardest work.`
    default: return `${effortWord(effort)}: a very short think before it answers. ${plan ? 'The fastest, and it uses the least of your plan' : 'The fastest and cheapest'}.`
  }
}

/** The model as its own source lists it, for its name and price. */
function listing(catalog: Catalog | null, model: string): Model | undefined {
  if (!catalog) return undefined
  return [...(catalog.chatgpt ?? []), ...(catalog.anthropic ?? []), ...catalog.models].find((item) => item.id === model)
}

/** What thinking costs on this model: the plan's allowance, the Claude credit's price, or OpenRouter's. */
function costLine(model: string, listed: Model | undefined): string {
  const source = parseModelRef(model).source
  if (source === 'chatgpt') return 'Thinking uses your ChatGPT plan’s allowance, not money: more effort uses more of it.'
  const credit = source === 'anthropic' ? ', from your Claude API credit' : ''
  if (listed?.free) return 'Thinking is free on this model, within its daily limit.'
  if (listed && listed.outputPrice > 0) return `Thinking is paid for like writing: ${price(listed.outputPrice)} per million tokens on ${shortName(listed)}${credit}.`
  return `Thinking is paid for like writing${credit}, so more effort costs more.`
}

/** `count` pips, `filled` of them lit. Its words are in the line beside it. */
function Meter({ label, filled, count }: { label: string; filled: number; count: number }) {
  return (
    <span className="thinking-meter" aria-hidden="true">
      {label}
      <span className="thinking-pips">{Array.from({ length: count }, (_, pip) => <i key={pip} className={pip < filled ? 'on' : ''} />)}</span>
    </span>
  )
}

/**
 * How hard the agent's model thinks before it answers. The stops are the model's own: the efforts
 * its ChatGPT plan or Claude key lists for it (Extra high, Max, Ultra where it has them), else low,
 * medium and high, the three every OpenRouter reasoning model takes. Every stop is named under the
 * track, and the line below says what the chosen one is good for, how fast and costly it is next to
 * the model's others, and what thinking costs on this model. A model with no effort setting has no
 * slider; an effort the model doesn't take shows at the stop it runs at, and says so.
 */
export function EffortSlider({ model, value = '', onChange, disabled = false, className = 'field thinking-field' }: { model: string; value?: string; onChange?: (effort: string | undefined) => void; disabled?: boolean; className?: string }) {
  const id = useId()
  const { catalog } = useModels()
  const ai = useAiStatus()
  const efforts = modelEfforts(model, ai, catalog)
  const reasons = efforts.levels.length > 0
  const stops = ['', ...efforts.levels]
  const place = placeEffort(value, efforts)
  const at = stops.indexOf(place.stop)
  const last = stops.length - 1
  const plan = parseModelRef(model).source === 'chatgpt'
  // Said as what it runs at, which is what the daemon sends.
  const shown = place.runs
  const about = place.moved === 'nearest'
    ? `This model doesn’t offer ${effortWord(value)}, so ${place.runs ? `it thinks at ${effortWord(place.runs)}` : 'it’s left to the model'}.`
    : place.moved === 'above'
      ? `${effortWord(place.runs)} is beyond what most work needs, and it ${plan ? 'uses the most of your plan' : 'costs the most'}.`
      : says(place.runs, at === last, plan)
  // The track fills up to the thumb's middle, which travels half a thumb in from each end.
  const fill = { '--thinking-fill': `calc(var(--thinking-thumb) / 2 + (100% - var(--thinking-thumb)) * ${last > 0 ? at / last : 0})` } as CSSProperties
  return (
    <div className={className}>
      <span className="thinking-label"><label className="t-meta" htmlFor={id}>Thinking effort</label><output className="t-body-m" htmlFor={id}>{reasons ? effortWord(shown) : 'Model default'}</output></span>
      {reasons && <>
        <span className="thinking-track" style={fill}>
          <span className="thinking-stops" aria-hidden="true">
            {stops.map((level, index) => <i key={level} className={index <= at ? 'on' : ''} style={{ left: `${(index / last) * 100}%` }} />)}
          </span>
          <input
            id={id}
            className="thinking-slider"
            type="range"
            min={0}
            max={last}
            step={1}
            value={at}
            disabled={disabled || !onChange}
            aria-label="Thinking effort"
            aria-valuetext={effortWord(shown)}
            aria-describedby={`${id}-about`}
            onChange={(event) => onChange?.(stops[Number(event.target.value)] || undefined)}
          />
        </span>
        <span className={`thinking-scale t-meta ${stops.length > 5 ? 'many' : ''}`} aria-hidden="true">
          {stops.map((level, index) => <span key={level} className={index === at ? 'on' : ''} style={{ left: `${(index / last) * 100}%` }}>{level ? effortWord(level) : 'Default'}</span>)}
        </span>
        <span className="thinking-about" id={`${id}-about`}>
          <span className="t-meta">{about}</span>
          {at > 0 && !place.moved && <span className="thinking-meters t-micro">
            <Meter label="Speed" filled={last - at + 1} count={last} />
            <Meter label={plan ? 'Plan use' : 'Cost'} filled={at} count={last} />
          </span>}
        </span>
      </>}
      <span className="hint t-meta">{reasons ? costLine(model, listing(catalog, model)) : 'This model doesn’t reason separately, so it has no effort setting.'}</span>
    </div>
  )
}
