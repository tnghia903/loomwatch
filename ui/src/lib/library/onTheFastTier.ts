import type { ModelTier } from '../ai/modelIds'
import { ROLE_PRESETS } from './roles'

/**
 * For tests: runs `check` with the Researcher's job on the fast tier, then puts it back. No built-in
 * job is on the fast tier while quality comes first (schemas/model-tiers.json), so tests of what a
 * gatherer is suggested once the table moves it there move it themselves while they run.
 */
export function onTheFastTier<T>(check: () => T): () => T {
  return () => {
    const job = ROLE_PRESETS.find((candidate) => candidate.id === 'researcher') as { tier?: ModelTier }
    const tier = job.tier
    const restore = () => { job.tier = tier }
    job.tier = 'fast'
    let result: T
    try {
      result = check()
    } catch (error) {
      restore()
      throw error
    }
    if (result instanceof Promise) return result.finally(restore) as T
    restore()
    return result
  }
}
