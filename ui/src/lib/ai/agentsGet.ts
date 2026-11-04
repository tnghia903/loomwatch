// What new agents get at each stop of the Your agents' models slider (ADR 0112), said from the same
// table Ask and the model suggestions choose from, so the line under the slider is what they pick.

import { ROLE_PRESETS } from '../library/roles'
import { type ModelSource, type Offers, type Priority, jobTier, modelForJobId } from './modelIds'

function list(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * What new agents get at `priority`, on the ways of paying connected: each built-in job's model,
 * grouped by model, most jobs first. `all` names every job off the main model; `short` names the
 * main model, and the checks' when only they differ.
 */
export function agentsGet(priority: Priority, name: (model: string) => string, sources?: readonly ModelSource[], offers?: Offers): { all: string; short: string } {
  const byModel = new Map<string, string[]>()
  for (const job of ROLE_PRESETS) {
    const model = modelForJobId(job.id, jobTier(job.id, job.tier, priority), sources, offers, priority)
    byModel.set(model, [...(byModel.get(model) ?? []), job.label])
  }
  const [[main], ...rest] = [...byModel].sort((a, b) => b[1].length - a[1].length)
  if (rest.length === 0) return { all: `Every new agent on ${name(main)}.`, short: `Every new agent on ${name(main)}.` }
  const all = [`Most new agents on ${name(main)}.`, ...rest.map(([model, jobs]) => `${list(jobs)} on ${name(model)}.`)].join(' ')
  const checks = rest.length === 1 && rest[0][1].length === 1 && rest[0][1][0] === 'Checker'
  const short = checks ? `Most new agents on ${name(main)}; checks on ${name(rest[0][0])}.` : `Most new agents on ${name(main)}, others for some jobs.`
  return { all, short }
}
