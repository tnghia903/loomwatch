import type { AiStatus, Catalog } from './client'
import { EFFORTS, type ModelSource, parseModelRef } from './modelIds'

/** Every effort a team file can name, least first: the order the daemon moves an effort down. */
const ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
const rank = (effort: string) => ORDER.indexOf(effort as (typeof ORDER)[number])

const WORDS: Record<string, string> = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' }

/** An effort as the person reads it: `xhigh` is "Extra high", and none set is the model's default. */
export function effortWord(effort: string | undefined): string {
  if (!effort || effort === 'default') return 'Model default'
  return WORDS[effort] ?? `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`
}

/** The efforts a model takes. */
export interface ModelEfforts {
  /** Least first. Empty for a model with no effort setting. */
  levels: readonly string[]
  /**
   * The model's own source listed them: the ChatGPT plan and the Claude key say each model's
   * efforts. OpenRouter lists none, so its models get the three every reasoning model takes.
   */
  listed: boolean
  /** How the source reads an effort before it looks for the model's nearest: Claude's `none` is `low`. */
  reads: Readonly<Record<string, string>>
  /** Taken though not listed, so it gets no stop: the plan takes `none` on every model. */
  unlisted: readonly string[]
}

/** As each source's `effort_for` reads an effort first (agent/anthropic.rs, chatgpt.rs, openrouter.rs). */
const READS: Record<ModelSource, Record<string, string>> = {
  anthropic: { none: 'low', minimal: 'low', ultra: 'max' },
  chatgpt: { minimal: 'low' },
  openrouter: { ultra: 'max' },
}

const ranked = (efforts: readonly string[]) => ORDER.filter((effort) => efforts.includes(effort))

/**
 * What `model` takes, from what its source says (`ai`, the daemon's `/api/ai`) or, for OpenRouter,
 * whether the catalog lists it as reasoning. Until either has answered it gets low, medium and high,
 * sent as set. A Claude model listed with no efforts has no setting, as the daemon then sends none;
 * a plan model listed with none still gets the effort as set, so it keeps the three.
 */
export function modelEfforts(model: string, ai: AiStatus | null, catalog: Catalog | null): ModelEfforts {
  const ref = parseModelRef(model)
  const unknown: ModelEfforts = {
    levels: EFFORTS,
    listed: false,
    // Sent as set where the model's list isn't known, but the plan has no `ultra` to give it then.
    reads: ref.source === 'chatgpt' ? { ...READS.chatgpt, ultra: 'max' } : READS[ref.source],
    unlisted: ref.source === 'chatgpt' ? ['none'] : [],
  }
  if (ref.source === 'chatgpt') {
    const known = ai?.chatgpt.models?.find((item) => item.slug === ref.id)
    return known?.efforts?.length ? { levels: ranked(known.efforts), listed: true, reads: READS.chatgpt, unlisted: ['none'] } : unknown
  }
  if (ref.source === 'anthropic') {
    const known = ai?.anthropic.models?.find((item) => item.id === ref.id)
    return known ? { levels: ranked(known.efforts ?? []), listed: true, reads: READS.anthropic, unlisted: [] } : unknown
  }
  const listed = catalog?.models.find((item) => item.id === model)
  return listed && !listed.reasoning ? { ...unknown, levels: [] } : unknown
}

/** Where an effort sits on a model's stops, and what is sent. */
export interface EffortPlace {
  /** The slider's stop: one of the model's levels, or '' for the model's default. */
  stop: string
  /** The effort the model is sent, as the daemon sends it; '' when none is. */
  runs: string
  /**
   * `nearest`: the model doesn't take the effort, so `runs` is its nearest at or below, or none.
   * `above` or `below`: it is sent past the stops at that end (OpenRouter's, or the plan's `none`).
   */
  moved?: 'nearest' | 'above' | 'below'
}

/**
 * Where `effort` sits among what the model takes, as the daemon sends it: read as its source reads
 * it, then the model's nearest at or below, else none (`effort_for` in agent/anthropic.rs and
 * agent/chatgpt.rs). A model whose list isn't known is sent it as read. A word no source knows, or
 * a model with no setting, is left to the model.
 */
export function placeEffort(effort: string | undefined, { levels, listed, reads, unlisted }: ModelEfforts): EffortPlace {
  if (!effort || effort === 'default' || levels.length === 0) return { stop: '', runs: '' }
  if (levels.includes(effort)) return { stop: effort, runs: effort }
  const read = reads[effort] ?? effort
  if (rank(read) < 0) return { stop: '', runs: '' }
  if (levels.includes(read)) return { stop: read, runs: read, moved: 'nearest' }
  const lowest = levels[0]
  const highest = levels[levels.length - 1]
  if (!listed || unlisted.includes(read)) {
    return rank(read) < rank(lowest) ? { stop: lowest, runs: read, moved: 'below' } : { stop: highest, runs: read, moved: 'above' }
  }
  const below = [...levels].reverse().find((level) => rank(level) <= rank(read)) ?? ''
  return { stop: below, runs: below, moved: 'nearest' }
}
