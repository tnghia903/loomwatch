import { useId, useRef, useState } from 'react'

import { type Catalog, savePriority, shortName } from '../../lib/ai/client'
import { agentsGet } from '../../lib/ai/agentsGet'
import { DEFAULT_PRIORITY, PRIORITIES, PRIORITY_NAMES, type Priority, modelNameFromId } from '../../lib/ai/modelIds'
import { connectedSources, offeredModels } from '../../lib/ai/sources'
import { announceAiStatus, useAiStatus } from '../../lib/ai/useKeyStatus'
import { useModels } from '../../lib/ai/useModels'

/** A model's name as the model list has it, else from its id. */
function nameOf(catalog: Catalog | null, model: string): string {
  const lists = catalog ? [catalog.chatgpt, catalog.anthropic, catalog.models] : []
  const listed = lists.flatMap((each) => (Array.isArray(each) ? each : [])).find((item) => item.id === model)
  return listed ? shortName(listed) : modelNameFromId(model)
}

/**
 * Saving, Balanced or Highest quality: what your agents' models lean to (ADR 0112). One setting,
 * kept by the daemon, that Ask, the model suggestions, templates and new agents all choose from;
 * agents already made keep their models. The track is a dashed line that tightens toward quality;
 * the line under it says what new agents get at the stop chosen, in short, with each job's model on
 * hover and for a screen reader. A stop shows at once and is kept in the background; if keeping it
 * fails it goes back and says so. A stop's name chooses it too. `compact` is the Ask panel's, set
 * tighter under its composer; `labelled` hides the label where a heading already names it.
 */
export function PrioritySlider({ compact = false, labelled = false }: { compact?: boolean; labelled?: boolean }) {
  const id = useId()
  const ai = useAiStatus()
  const { catalog } = useModels()
  const [choosing, setChoosing] = useState<Priority | null>(null)
  const [problem, setProblem] = useState('')
  // Only the latest choice's answer counts: a quick drag sends one per stop.
  const latest = useRef(0)
  const kept = ai?.priority ?? DEFAULT_PRIORITY
  const priority = choosing ?? kept
  const at = PRIORITIES.indexOf(priority)
  const last = PRIORITIES.length - 1
  const sources = ai ? connectedSources(ai) : undefined
  const offers = ai ? offeredModels(ai) : undefined
  const gets = agentsGet(priority, (model) => nameOf(catalog, model), sources, offers)

  async function choose(next: Priority) {
    if (next === priority) return
    const turn = ++latest.current
    const before = kept
    setProblem('')
    setChoosing(next)
    try {
      const saved = await savePriority(next)
      if (turn === latest.current) announceAiStatus({ priority: saved })
    } catch {
      if (turn === latest.current) setProblem(`LoomWatch couldn’t save ${PRIORITY_NAMES[next]}, so it’s still on ${PRIORITY_NAMES[before]}. Try again, or restart LoomWatch.`)
    } finally {
      if (turn === latest.current) setChoosing(null)
    }
  }

  return (
    <div className={`priority-field ${compact ? 'compact' : ''}`}>
      <label className={labelled ? 'visually-hidden' : 't-meta priority-label'} htmlFor={id}>Your agents’ models</label>
      <span className="priority-track">
        <span className="priority-line" aria-hidden="true">
          {PRIORITIES.slice(1).map((stop, index) => <i key={stop} className={`priority-segment segment-${index + 1} ${index + 1 <= at ? 'on' : ''}`} />)}
          {PRIORITIES.map((stop, index) => <b key={stop} className={index <= at ? 'on' : ''} style={{ left: `${(index / last) * 100}%` }} />)}
        </span>
        <input
          id={id}
          className="priority-slider"
          type="range"
          min={0}
          max={last}
          step={1}
          value={at}
          aria-valuetext={PRIORITY_NAMES[priority]}
          aria-describedby={`${id}-gets`}
          onChange={(event) => void choose(PRIORITIES[Number(event.target.value)])}
          // In Ask's form, Enter would send the draft.
          onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }}
        />
      </span>
      {/* A pointer can pick a stop by its name; the slider itself is what a keyboard and a screen reader use. */}
      <span className="priority-scale t-meta" aria-hidden="true">
        {PRIORITIES.map((stop) => <span key={stop} className={stop === priority ? 'on' : ''} onClick={() => void choose(stop)}>{PRIORITY_NAMES[stop]}</span>)}
      </span>
      <span className="t-meta priority-gets" title={gets.all} aria-hidden="true">{gets.short}</span>
      <span className="visually-hidden" id={`${id}-gets`}>{gets.all}</span>
      {problem && <span role="alert" className="t-meta inline-error">{problem}</span>}
    </div>
  )
}
