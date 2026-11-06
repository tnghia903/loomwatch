import { renderHook } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it } from 'vitest'

// A test that leaves its components mounted leaves their timers and fetches running past the
// end of its file, and one landing after jsdom is gone fails the run with "window is not
// defined" though every test passed. The setup unmounts them after each test, even in a file
// that doesn't ask.
let unmounted = false

describe('the test setup', () => {
  it('renders a component that notes when it is unmounted', () => {
    renderHook(() => useEffect(() => () => { unmounted = true }, []))
    expect(unmounted).toBe(false)
  })

  it('has unmounted it once that test ended', () => {
    expect(unmounted).toBe(true)
  })
})
