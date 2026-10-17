import { afterEach, describe, expect, it, vi } from 'vitest'

import { credentialStore, keyStore, keys } from './platform'

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

  it('names the Mac’s own key symbols when they stand alone', () => {
    expect(keys('↵', true)).toBe('↵')
    expect(keys('↵', false)).toBe('Enter')
    expect(keys('⌫', false)).toBe('Backspace')
  })
})

// The browser runs on the computer LoomWatch runs on, so it names that computer's own store.
describe('keyStore', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('names Windows Credential Manager on Windows and the Keychain elsewhere', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    expect(keyStore()).toBe('Windows Credential Manager')
    expect(credentialStore()).toBe('Windows Credential Manager')
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)' })
    expect(keyStore()).toBe('this Mac’s Keychain')
  })
})
