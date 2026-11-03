import { describe, expect, it } from 'vitest'

import { modeSays } from './permissionMode'

// ADR 0109: one line per mode, the same in the chat's menu, the agent panel and the announcement.
// Auto keeps commands off the web only where there is a sandbox, so it promises that only on a Mac.
describe('modeSays', () => {
  it('says Ask me waits', () => {
    expect(modeSays('ask', true)).toBe('It waits for your answer.')
    expect(modeSays('ask', false)).toBe('It waits for your answer.')
  })

  it('promises the folder limit on a Mac, and only reading commands elsewhere', () => {
    expect(modeSays('auto', true)).toMatch(/^It goes ahead, changing files only in the folder it works in\./)
    expect(modeSays('auto', false)).toMatch(/runs commands that only read or download, without asking/)
    expect(modeSays('auto', false)).not.toMatch(/goes ahead/)
  })
})
