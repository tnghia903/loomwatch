import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { endTour, goToStep, readTourState, resetTourForTests, startTour } from './store'

beforeEach(() => {
  resetTourForTests()
  window.history.replaceState({}, '', '/')
})
afterEach(() => vi.restoreAllMocks())

// The guide no longer opens by itself: a newcomer starts on the first run (ADR 0075), and the
// guide is a link on Home and in the menu.
describe('getting-started guide progress', () => {
  it('starts at the welcome, and stays closed or finished once it is', () => {
    startTour()
    expect(readTourState()).toEqual({ status: 'active', step: 'welcome', runAtStepStart: null })
    endTour('dismissed')
    expect(readTourState()).toMatchObject({ status: 'dismissed' })
    startTour()
    endTour('finished')
    expect(readTourState()).toMatchObject({ status: 'finished' })
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

  it('keeps a closed guide closed after its steps change', () => {
    localStorage.setItem('loomwatch:tour', JSON.stringify({ status: 'dismissed', step: 'a-step-that-was-removed' }))
    expect(readTourState()).toEqual({ status: 'dismissed', step: 'welcome' })
  })

  it('still works for the page when storage refuses writes', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    startTour()
    expect(readTourState()).toMatchObject({ status: 'active', step: 'welcome' })
  })
})
