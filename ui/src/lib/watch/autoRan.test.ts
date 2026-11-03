import { describe, expect, it } from 'vitest'

import { autoLine } from './autoRan'
import type { AutoRan } from './events'

const name = (id: string) => ({ writer: 'Writer', builder: 'Builder' })[id] ?? id
const ran = (detail: string, kind: AutoRan['kind'], agentId = 'writer'): AutoRan => ({ agentId, title: kind === 'edit' ? `Write ${detail}` : 'Bash', detail, kind, ts: '2026-11-03T00:00:00Z' })

// ADR 0061, ADR 0109: what Auto mode let the agents do in your place, said once while the work runs.
describe('autoLine', () => {
  it('names the one thing Auto mode let an agent do', () => {
    expect(autoLine([ran('draft.md', 'edit')], name)).toBe('Auto mode let Writer change draft.md')
    expect(autoLine([ran('python3 build.py', 'command', 'builder')], name)).toBe('Auto mode let Builder run python3 build.py')
  })

  it('counts several, by what they were, with the latest', () => {
    expect(autoLine([ran('ls', 'command'), ran('python3 build.py', 'command')], name)).toBe('Auto mode ran 2 commands without asking you · latest python3 build.py')
    expect(autoLine([ran('a.md', 'edit'), ran('b.md', 'edit')], name)).toBe('Auto mode let 2 files change without asking you · latest b.md')
    expect(autoLine([ran('ls', 'command'), ran('b.md', 'edit')], name)).toBe('Auto mode went ahead 2 times without asking you · latest b.md')
  })

  it('says nothing when Auto mode did nothing', () => {
    expect(autoLine([], name)).toBeNull()
  })
})
