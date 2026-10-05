import { describe, expect, it } from 'vitest'

import { keys } from './platform'

// Shortcuts are written the Mac way once; a Windows or Linux browser shows the keys it presses.
describe('keys', () => {
  it('leaves a shortcut alone on a Mac', () => {
    expect(keys('⌥⌘L', true)).toBe('⌥⌘L')
  })

  it('writes it with Ctrl, Alt and Shift elsewhere, in that order', () => {
    expect(keys('⌘S', false)).toBe('Ctrl+S')
    expect(keys('⌥⌘L', false)).toBe('Ctrl+Alt+L')
    expect(keys('⌘⇧L', false)).toBe('Ctrl+Shift+L')
    expect(keys('⌘↵', false)).toBe('Ctrl+Enter')
    expect(keys('⌘−', false)).toBe('Ctrl+-')
    expect(keys('⌘\\', false)).toBe('Ctrl+\\')
    expect(keys('⇧F8', false)).toBe('Shift+F8')
  })

  it('leaves a key with no modifier alone', () => {
    expect(keys('F8', false)).toBe('F8')
    expect(keys('Esc', false)).toBe('Esc')
  })
})
