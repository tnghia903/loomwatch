/**
 * Which computer the browser runs on, for the few things people read differently there. The page is
 * always opened on the computer LoomWatch runs on, so the browser's platform is LoomWatch's too.
 *
 * Shortcuts are written once, the Mac way (`⌘S`, `⌥⌘L`, `⌘⇧L`, `⌘↵`), and {@link keys} writes them
 * the way Windows and Linux do (`Ctrl+S`, `Ctrl+Alt+L`, `Ctrl+Shift+L`, `Ctrl+Enter`). The key
 * handlers already accept Ctrl wherever they accept ⌘.
 */

type NavigatorWithHints = Navigator & { userAgentData?: { platform?: string } }

/** Whether this is a Mac (or an iPad), where shortcuts use ⌘ and ⌥. */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return true
  const hints = navigator as NavigatorWithHints
  const platform = hints.userAgentData?.platform || navigator.platform || navigator.userAgent || ''
  return /mac|iphone|ipad|ipod|darwin/i.test(platform)
}

/** Whether this is a Windows PC. */
export function isWindows(): boolean {
  if (typeof navigator === 'undefined') return false
  const hints = navigator as NavigatorWithHints
  return /\bwin/i.test(hints.userAgentData?.platform || navigator.platform || navigator.userAgent || '')
}

const MODIFIERS: Record<string, string> = { '⌃': 'Ctrl', '⌘': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' }
const ORDER = ['Ctrl', 'Alt', 'Shift']
const KEYS: Record<string, string> = { '↵': 'Enter', '⌫': 'Backspace', '−': '-', '⎋': 'Esc' }

/** A shortcut written the Mac way, as this computer writes it: unchanged on a Mac. */
export function keys(mac: string, onMac = isMac()): string {
  if (onMac) return mac
  const held = new Set<string>()
  let rest = mac
  while (rest && MODIFIERS[rest[0]]) {
    held.add(MODIFIERS[rest[0]])
    rest = rest.slice(1)
  }
  if (held.size === 0) return mac
  return [...ORDER.filter((name) => held.has(name)), KEYS[rest] ?? rest].join('+')
}

/** Where macOS keeps a secret, or Windows: the name a person knows it by. */
export function credentialStore(): string {
  return isWindows() ? 'Windows Credential Manager' : 'macOS Keychain'
}
