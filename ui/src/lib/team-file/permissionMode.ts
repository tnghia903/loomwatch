import { isMac } from '../platform'
import type { PermissionMode } from './types'

/**
 * What a team's mode does (ADR 0061, ADR 0109), in a line: the menu beside the chat's send button,
 * the agent panel and the announcement after a switch all say the same. Auto keeps commands off the
 * web and out of other apps only where there is a sandbox, a Mac; elsewhere it runs only the
 * commands that read or download.
 */
export function modeSays(mode: PermissionMode, onMac = isMac()): string {
  if (mode === 'ask') return 'It waits for your answer.'
  return onMac
    ? 'It goes ahead, changing files only in the folder it works in. Publishing, the web and anything outside that folder still wait for you.'
    : 'It changes files in the folder it works in, and runs commands that only read or download, without asking. Anything else still waits for you.'
}
