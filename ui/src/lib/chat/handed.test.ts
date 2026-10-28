import { describe, expect, it } from 'vitest'

import { handedBy } from './handed'

const wrote = (agentId: string, path: string, ts: string, more: Partial<{ status: 'succeeded' | 'failed'; declined: 'denied'; toolKind: string }> = {}) => ({
  agentId, toolKind: 'edit', status: 'succeeded' as const, ts, locations: [{ path }], ...more,
})

describe('handedBy', () => {
  it('hands each file over from the agent that wrote it last, in the order they finished', () => {
    const evidence = [
      wrote('researcher', '/teams/.loomwatch/news/writer/digest.md', '2026-10-06T02:01:00.000Z'),
      wrote('editor', '/teams/.loomwatch/news/editor/notes.md', '2026-10-06T02:02:00.000Z'),
      wrote('writer', '/teams/.loomwatch/news/writer/digest.md', '2026-10-06T02:03:00.000Z'),
    ]
    expect(handedBy(['/teams/.loomwatch/news/writer/digest.md', '/teams/.loomwatch/news/editor/notes.md'], evidence, 'lead')).toEqual([
      { agent: 'editor', files: ['/teams/.loomwatch/news/editor/notes.md'], at: '2026-10-06T02:02:00.000Z' },
      { agent: 'writer', files: ['/teams/.loomwatch/news/writer/digest.md'], at: '2026-10-06T02:03:00.000Z' },
    ])
  })

  it('finds a file the answer names from an agent’s folder, or the Windows way', () => {
    const evidence = [
      wrote('writer', '/Users/ana/LoomWatch/teams/.loomwatch/news/writer/digest.md', '2026-10-06T02:03:00.000Z'),
      wrote('designer', 'C:\\Users\\ana\\LoomWatch\\teams\\.loomwatch\\news\\designer\\page.html', '2026-10-06T02:04:00.000Z'),
    ]
    expect(handedBy(['digest.md', 'designer/page.html'], evidence, 'lead').map(({ agent, files }) => [agent, files])).toEqual([
      ['writer', ['digest.md']],
      ['designer', ['designer/page.html']],
    ])
    // A name is matched whole: a file whose name only ends the same way is another file.
    expect(handedBy(['est.md'], evidence, 'lead')).toEqual([])
  })

  it('leaves with the answer what its own agent wrote, a helper wrote, or nobody wrote', () => {
    const evidence = [
      wrote('lead', '/t/lead/report.md', '2026-10-06T02:01:00.000Z'),
      wrote('lead~1', '/t/lead/part.md', '2026-10-06T02:02:00.000Z'),
      wrote('writer', '/t/writer/draft.md', '2026-10-06T02:03:00.000Z', { status: 'failed' }),
      wrote('writer', '/t/writer/denied.md', '2026-10-06T02:03:00.000Z', { declined: 'denied' }),
      wrote('writer', '/t/writer/read.md', '2026-10-06T02:03:00.000Z', { toolKind: 'read' }),
    ]
    expect(handedBy(['/t/lead/report.md', '/t/lead/part.md', '/t/writer/draft.md', '/t/writer/denied.md', '/t/writer/read.md', '/t/own.md'], evidence, 'lead')).toEqual([])
  })
})
