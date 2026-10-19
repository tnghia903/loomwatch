// How a check step is set up when it is made (ADR 0062): from a template, or by connecting work
// into a Checker. Its own module so the template and the canvas set one up the same way.

import type { Effort } from '../ai/modelIds'
import { jobFor } from './checkup'
import type { AgentConfig } from './types'

/**
 * How hard a check step thinks, by the job of the agent whose work it checks (`jobFor`); an agent
 * whose job is not known but which may change files or run commands is checked as code is. One row
 * per kind of work, so a cheaper setting is a one-row change once the quality benchmark shows the
 * check still finds what it found at high. Until then every row is high: quality first.
 */
export const CHECK_EFFORT: Readonly<Record<string, Effort>> = {
  researcher: 'high',
  writer: 'high',
  editor: 'high',
  reviewer: 'high',
  checker: 'high',
  coder: 'high',
  designer: 'high',
  lead: 'high',
  analyst: 'high',
}

/** The effort for work of a kind the table has no row for. */
export const CHECK_EFFORT_DEFAULT: Effort = 'high'

/** The kind of work a check step checks: the checked agent's job, else what its switches say. */
export function checkedWork(checked: Pick<AgentConfig, 'name' | 'role' | 'allow'>): string | null {
  return jobFor(checked)?.id ?? (checked.allow?.edits || checked.allow?.commands ? 'coder' : null)
}

/** How hard a check step on `checked`'s work thinks. */
export function checkEffort(checked: Pick<AgentConfig, 'name' | 'role' | 'allow'>): Effort {
  const work = checkedWork(checked)
  return (work ? CHECK_EFFORT[work] : undefined) ?? CHECK_EFFORT_DEFAULT
}

/**
 * What makes `checker` a check step on `checked`'s work. It sends a missed check back once, so what
 * it finds is fixed before the answer is shown: without that, the check costs about half a run and
 * changes nothing. Its effort follows the work, on a model that has an effort setting at all.
 */
export function checkStepFields(checker: Pick<AgentConfig, 'thinkingEffort'>, checked: Pick<AgentConfig, 'id' | 'name' | 'role' | 'allow'>): Pick<AgentConfig, 'checks' | 'sendBackOnce' | 'thinkingEffort'> {
  return { checks: checked.id, sendBackOnce: true, ...(checker.thinkingEffort ? { thinkingEffort: checkEffort(checked) } : {}) }
}
