import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { endTour, goToStep, offerTourIfFirstRun, readTourState, resetTourForTests, startTour } from './store'

beforeEach(() => {
  resetTourForTests()
  window.history.replaceState({}, '', '/')
})
afterEach(() => vi.restoreAllMocks())

describe('getting-started guide progress', () => {
  it('is offered to someone who has never run a team, even with the demo team in place', async () => {
    await offerTourIfFirstRun(1, async () => [])
    expect(readTourState()).toEqual({ status: 'active', step: 'welcome', runAtStepStart: null })
  })

  it('is not offered to someone who has run a team', async () => {
    await offerTourIfFirstRun(0, async () => [{ runId: 'run-1' }])
    expect(readTourState()).toBeNull()
  })

  it('falls back to an empty teams folder when run history cannot be read', async () => {
    const unreadable = async () => { throw new Error('daemon unreachable') }
    await offerTourIfFirstRun(2, unreadable)
    expect(readTourState()).toBeNull()
    await offerTourIfFirstRun(0, unreadable)
    expect(readTourState()).toMatchObject({ status: 'active', step: 'welcome' })
  })

  it('is not offered again once closed or finished, and never asks for runs then', async () => {
    const listRuns = vi.fn(async () => [])
    startTour()
    endTour('dismissed')
    await offerTourIfFirstRun(0, listRuns)
    expect(readTourState()).toMatchObject({ status: 'dismissed' })
    startTour()
    endTour('finished')
    await offerTourIfFirstRun(0, listRuns)
    expect(readTourState()).toMatchObject({ status: 'finished' })
    expect(listRuns).not.toHaveBeenCalled()
  })

  it('remembers the run on screen when a step begins', () => {
    window.history.replaceState({}, '', '/?path=a.yaml&run=run-1')
    goToStep('ask')
    expect(readTourState()).toEqual({ status: 'active', step: 'ask', runAtStepStart: 'run-1' })
  })

  it('survives a reload: the state is read back from storage', () => {
    goToStep('watch')
    const stored = localStorage.getItem('loomwatch:tour')
    resetTourForTests()
    localStorage.setItem('loomwatch:tour', stored ?? '')
    expect(readTourState()).toMatchObject({ status: 'active', step: 'watch' })
  })

  it('treats an unreadable or unknown value as no state at all', () => {
    localStorage.setItem('loomwatch:tour', '{not json')
    expect(readTourState()).toBeNull()
    localStorage.setItem('loomwatch:tour', JSON.stringify({ status: 'active', step: 'a-step-that-was-removed' }))
    expect(readTourState()).toBeNull()
  })

  it('still works for the page when storage refuses writes', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    startTour()
    expect(readTourState()).toMatchObject({ status: 'active', step: 'welcome' })
  })
})
