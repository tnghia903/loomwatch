import { describe, expect, it } from 'vitest'

import { effortFor, jobEffort } from './effort'
import { ROLE_PRESETS } from './roles'

const efforts = (...ids: string[]) => ({ thinkingEfforts: ids.map((id) => ({ id, name: id })) })
// As the apps list them on 2026-10-15: Claude (every model), a Codex model, and one with none.
const CLAUDE = efforts('default', 'low', 'medium', 'high', 'xhigh', 'max')
const CODEX = efforts('low', 'medium', 'high', 'xhigh', 'max')
const NONE = efforts()

describe('effort tiers', () => {
  it('turns each tier into an effort the model lists, and keeps the app default otherwise', () => {
    expect([effortFor('light', CLAUDE), effortFor('standard', CLAUDE), effortFor('deep', CLAUDE)]).toEqual(['low', 'medium', 'high'])
    expect(effortFor('light', CODEX)).toBe('low')
    expect(effortFor('light', efforts('minimal', 'medium'))).toBe('minimal')
    expect(effortFor('deep', NONE)).toBeUndefined()
    expect(effortFor('standard', null)).toBeUndefined()
  })

  it('never picks the most expensive settings for a job', () => {
    for (const tier of ['light', 'standard', 'deep'] as const) expect(['xhigh', 'max', 'ultra']).not.toContain(effortFor(tier, CLAUDE))
  })

  it('gives every built-in job a tier, and finds it only from the job’s own text', () => {
    for (const job of ROLE_PRESETS) expect(job.effort, job.id).toBeDefined()
    const editor = ROLE_PRESETS.find((job) => job.id === 'editor')
    expect(jobEffort(editor?.role ?? '', CLAUDE)).toBe('low')
    expect(jobEffort(`${editor?.role ?? ''}\nAlso translate it.`, CLAUDE)).toBeUndefined()
    expect(jobEffort('Write a poem.', CLAUDE)).toBeUndefined()
  })
})
