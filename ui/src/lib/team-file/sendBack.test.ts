import { describe, expect, it } from 'vitest'

import { NEW_SEND_BACK, sendBackFields, sendBackOf } from './sendBack'

// ADR 0062: a check step's `sendBack`, as the editor reads and writes it. The daemon reads the
// same file, so what the panel shows must be what a run does.
describe('sendBackOf', () => {
  it('reads sendBack, and the older sendBackOnce as one round that shows the answer', () => {
    expect(sendBackOf({})).toBeNull()
    expect(sendBackOf({ sendBackOnce: false })).toBeNull()
    expect(sendBackOf({ sendBackOnce: true })).toEqual({ rounds: 1, whenStillNotMet: 'answer' })
    expect(sendBackOf({ sendBack: {} })).toEqual({ rounds: 1, whenStillNotMet: 'answer' })
    expect(sendBackOf({ sendBack: { rounds: 3, whenStillNotMet: 'ask' } })).toEqual({ rounds: 3, whenStillNotMet: 'ask' })
  })

  it('keeps a hand-written figure within what the daemon takes', () => {
    expect(sendBackOf({ sendBack: { rounds: 9 } })?.rounds).toBe(3)
    expect(sendBackOf({ sendBack: { rounds: 0 } })?.rounds).toBe(1)
  })
})

describe('sendBackFields', () => {
  it('writes sendBack and takes the older field out, or takes both out when it is off', () => {
    expect(sendBackFields({ rounds: 2, whenStillNotMet: 'ask' })).toEqual({ sendBack: { rounds: 2, whenStillNotMet: 'ask' }, sendBackOnce: undefined })
    expect(sendBackFields(null)).toEqual({ sendBack: undefined, sendBackOnce: undefined })
  })

  it('starts a new check step on two rounds, then asking you', () => {
    expect(NEW_SEND_BACK).toEqual({ rounds: 2, whenStillNotMet: 'ask' })
  })
})
