import { describe, expect, it } from 'vitest'

import { settleAfterRun } from './settle'

describe('settleAfterRun', () => {
  it('leaves a live run exactly as recorded', () => {
    expect(settleAfterRun('running', { phase: 'running', operator: false, laterStageStarted: false })).toBeNull()
    expect(settleAfterRun('waiting', { phase: 'running', operator: true, laterStageStarted: false })).toBeNull()
  })

  it('leaves finished states alone', () => {
    expect(settleAfterRun('succeeded', { phase: 'cancelled', operator: false, laterStageStarted: false })).toBeNull()
    expect(settleAfterRun('failed', { phase: 'failed', operator: false, laterStageStarted: false })).toBeNull()
  })

  // A run stopped at a review step: the researcher was kept alive after handing over, the review
  // waited. Neither is "running" or "waiting" once the run is over.
  it('credits a stage that handed over before the run was stopped', () => {
    expect(settleAfterRun('running', { phase: 'cancelled', operator: false, laterStageStarted: true })).toMatchObject({ status: 'succeeded', task: 'Handed over' })
  })

  it('marks a review step that was never answered', () => {
    expect(settleAfterRun('waiting', { phase: 'cancelled', operator: true, laterStageStarted: false })).toMatchObject({ status: 'stopped', task: 'Not answered — you stopped the run' })
  })

  it('marks a stage that was mid-task when the run ended', () => {
    expect(settleAfterRun('running', { phase: 'failed', operator: false, laterStageStarted: false })).toMatchObject({ status: 'stopped', task: 'Stopped when the run ended' })
  })
})
