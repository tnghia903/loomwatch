import { describe, expect, it } from 'vitest'

import { workCount } from '../story/reads'
import { cardActivity, linkedIn, trayOf, webFinds } from './cardActivity'
import { projectRun, type RunEvent } from './events'

const start = Date.UTC(2026, 9, 21, 13, 20, 0)
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString()
let seq = 0
const event = (seconds: number, kind: RunEvent['kind'], payload: RunEvent['payload'], agentId = 'tutor'): RunEvent =>
  ({ id: `event-${seq}`, sessionId: 'run-1', agentId, seq: seq++, ts: at(seconds), kind, payload })
const call = (seconds: number, callId: string, title: string, toolKind: string, rawInput: unknown, result: string, status = 'completed') => [
  event(seconds, 'tool_call', { callId, title, toolKind, status: 'in_progress', rawInput }),
  event(seconds, 'tool_update', { callId, status, content: [{ type: 'content', content: { type: 'text', text: result } }] }),
]

/**
 * The tutor of the run of 2026-10-21 (First-principles school), as an older daemon recorded it:
 * code it ran at Anthropic titled as a search, pages read from that code titled "Read a page" with
 * the address only in their result, two reads that failed, and four searches whose words were not
 * kept. The receipt read that as 24 sources.
 */
function olderTutor(): RunEvent[] {
  seq = 0
  return [
    event(0, 'message', { role: 'user', content: { type: 'text', text: 'Teach transformers in recommenders.' } }),
    { ...event(1, 'session_meta', { phase: 'skill_opened', skill: 'explain-like-im-5', sha256: 'sha256:5f1c', path: '.agents/skills/explain-like-im-5/SKILL.md' }), raw: { source: 'loomwatch', phase: 'skill_opened' } },
    ...call(2, 'c1', 'Search the web: the web', 'fetch', { code: 'qs=["Attention Is All You Need arxiv"]' }, ''),
    ...call(3, 'p0', 'Read a page', 'fetch', {}, 'Failed: url_not_in_prior_context'),
    ...call(4, 's1', 'Search the web: the web', 'fetch', {}, '[1706.03762] Attention Is All You Need https://arxiv.org/abs/1706.03762\n(PDF) Attention https://www.academia.edu/1'),
    ...call(5, 'p1', 'Read a page', 'fetch', {}, 'Read https://arxiv.org/abs/1706.03762'),
    ...call(6, 'p2', 'Read a page', 'fetch', {}, 'Read https://arxiv.org/pdf/1808.09781'),
    ...call(7, 'p3', 'Read a page', 'fetch', {}, 'Read https://arxiv.org/abs/1706.03762'),
    ...call(8, 'c2', 'Search the web: the web', 'fetch', { code: 'show(s, "Abstract")' }, ''),
    ...call(9, 'r1', 'Run: python3 - <<\'EOF\'…', 'execute', { command: "cd lessons && python3 - <<'EOF'\nprint(1)\nEOF" }, '1'),
  ]
}

describe('what a stage card shows of an older run', () => {
  const projection = projectRun(olderTutor())
  const evidence = projection.evidence.filter((item) => item.agentId === 'tutor')

  it('counts code, searches and pages apart, not as one pile of sources', () => {
    expect(trayOf(evidence).map((mark) => [mark.kind, mark.labels.length])).toEqual([['skill', 1], ['web', 1], ['page', 4], ['code', 2], ['command', 1]])
  })

  it('names each page by the address its result read, once, with how often', () => {
    const web = webFinds(evidence, linkedIn('See https://arxiv.org/abs/1706.03762/ for the paper.'))
    expect(web.sites).toEqual([{ site: 'arxiv.org', pages: [
      { url: 'https://arxiv.org/abs/1706.03762', times: 2, inAnswer: true },
      { url: 'https://arxiv.org/pdf/1808.09781', times: 1, inAnswer: false },
    ] }])
    expect(web.failedReads).toBe(1)
    expect(web.code).toBe(2)
  })

  // The receipt above the cards said "read 2 web pages" for this tutor: it knew a page by its title.
  it('is counted the same way on the run receipt', () => {
    const { read, searches } = workCount(evidence)
    const pages = webFinds(evidence, new Set()).sites.flatMap((site) => site.pages)
    expect([read.pages, searches]).toEqual([pages.length, webFinds(evidence, new Set()).searches.length])
    expect([read.pages, searches]).toEqual([2, 1])
  })

  it('keeps what a search found, and says nothing of words it never recorded', () => {
    const [search] = webFinds(evidence, new Set()).searches
    expect(search).toEqual({ query: null, found: [
      { title: '[1706.03762] Attention Is All You Need', url: 'https://arxiv.org/abs/1706.03762' },
      { title: '(PDF) Attention', url: 'https://www.academia.edu/1' },
    ] })
  })
})

describe('what a stage card shows of a run the daemon now names', () => {
  seq = 0
  const events = [
    event(0, 'message', { role: 'user', content: { type: 'text', text: 'Check the lesson.' } }, 'checker'),
    ...call(1, 'k1', 'Run code: import json', 'other', { code: 'import json' }, 'Attention Is All You Need'),
    ...call(2, 'k2', 'Search the web: site:arxiv.org 1706.03762', 'fetch', { query: 'site:arxiv.org 1706.03762' }, '').map((item) => ({ ...item, agentId: 'checker' })),
    ...call(3, 'k3', 'Read https://arxiv.org/pdf/1706.03762', 'fetch', { url: 'https://arxiv.org/pdf/1706.03762' }, 'Read https://arxiv.org/pdf/1706.03762').map((item) => ({ ...item, agentId: 'checker' })),
    event(4, 'session_meta', { phase: 'skill_opened', skill: 'none' }, 'nobody'),
  ].map((item) => (item.agentId === 'tutor' ? { ...item, agentId: 'checker' } : item))
  const evidence = projectRun(events).evidence.filter((item) => item.agentId === 'checker')

  it('keeps search words, and the page it read by its own address', () => {
    const web = webFinds(evidence, new Set())
    expect(web.searches.map((search) => search.query)).toEqual(['site:arxiv.org 1706.03762'])
    expect(web.sites.flatMap((site) => site.pages.map((page) => page.url))).toEqual(['https://arxiv.org/pdf/1706.03762'])
    expect(web.code).toBe(1)
  })

  it('names the call it is on while it uses one, and acts out using its computer', () => {
    const now = start + 3500
    const live = cardActivity({ events, evidence, agentId: 'checker', working: true, now, linked: new Set() })
    expect(live.phase).toBe('tools')
    expect(live.doing?.label).toBe('Read arxiv.org/pdf/1706.03762')
    const done = cardActivity({ events, evidence, agentId: 'checker', working: false, now, linked: new Set() })
    expect([done.phase, done.doing]).toEqual([null, null])
  })

  // In a relay a stage stays running until the run ends; once its turn ends it rests, not bobs.
  it('rests once its turn has ended, though its stage is still marked running', () => {
    const ended = [...events, { ...events[0], id: 'end', seq: 99, ts: at(3.4), kind: 'turn_end' as const, payload: {} }]
    expect(cardActivity({ events: ended, evidence, agentId: 'checker', working: true, now: start + 3500, linked: new Set() }).phase).toBeNull()
    const handedMore = [...ended, { ...events[0], id: 'again', seq: 100, ts: at(3.45) }]
    expect(cardActivity({ events: handedMore, evidence, agentId: 'checker', working: true, now: start + 3500, linked: new Set() }).phase).toBe('reading')
  })
})

describe('a notebook entry it read', () => {
  it('is not a failed web page', () => {
    seq = 0
    const events = [...call(1, 'm1', 'memory_read', 'read', { id: 'note-1' }, 'The team prefers short answers.')]
    const evidence = projectRun(events).evidence
    expect(webFinds(evidence, new Set()).failedReads).toBe(0)
    expect(trayOf(evidence).some((mark) => mark.kind === 'page')).toBe(false)
  })
})
