import { describe, expect, it } from 'vitest'

import { WORKING_WINDOW_MS } from '../library/figure'
import type { RunEvent } from './events'
import { benchUses, FETCH_WITHIN_MS, READING_MS, THOUGHT_CHARS, thoughtLine, workPhase, type BenchKit } from './workPhase'

const NOW = Date.parse('2026-10-19T14:10:00.000Z')
let seq = 0
/** An event `ago` milliseconds before NOW, from `agent`. */
const at = (ago: number, kind: RunEvent['kind'], payload: Record<string, unknown> = {}, agent = 'coby'): RunEvent => ({ id: `e${seq}`, sessionId: 's', agentId: agent, seq: seq++, ts: new Date(NOW - ago).toISOString(), kind, payload })
const prompt = (ago: number) => at(ago, 'message', { role: 'user', content: { text: 'explain transformers' } })

describe('what an agent is at, from its run’s events', () => {
  it('reads the message it was given, then thinks while its model is quiet', () => {
    expect(workPhase([], 'coby', NOW)).toBe('reading')
    expect(workPhase([at(500, 'process', { phase: 'spawned' }), at(400, 'session_meta', {})], 'coby', NOW)).toBe('reading')
    expect(workPhase([prompt(1000), at(900, 'usage', {})], 'coby', NOW)).toBe('reading')
    expect(workPhase([prompt(READING_MS + 1)], 'coby', NOW)).toBe('thinking')
  })

  it('thinks while it reasons or updates its plan', () => {
    expect(workPhase([prompt(5000), at(100, 'thought', { role: 'thought' })], 'coby', NOW)).toBe('thinking')
    expect(workPhase([prompt(5000), at(100, 'tool_call', { callId: 'p', title: 'Update the plan', toolKind: 'think', status: 'in_progress' }), at(100, 'plan', {})], 'coby', NOW)).toBe('thinking')
  })

  it('uses the computer while a tool runs, and thinks once it is back and quiet', () => {
    const search = at(1000, 'tool_call', { callId: 'w', title: 'Search the web: attention is all you need', toolKind: 'fetch', status: 'in_progress' })
    expect(workPhase([prompt(9000), search], 'coby', NOW)).toBe('tools')
    // Still open well after it started: a slow search keeps it at the computer.
    expect(workPhase([prompt(30_000), { ...search, ts: new Date(NOW - 20_000).toISOString() }], 'coby', NOW)).toBe('tools')
    // Back just now (an app that reports a call once it is done sends both together).
    const back = at(1000, 'tool_update', { callId: 'w', status: 'completed' })
    expect(workPhase([prompt(9000), search, back], 'coby', NOW)).toBe('tools')
    expect(workPhase([prompt(9000), search, back], 'coby', NOW + WORKING_WINDOW_MS)).toBe('thinking')
    // A command and a file it writes are tools too.
    expect(workPhase([at(200, 'tool_call', { callId: 'c', title: 'Run: npm test', toolKind: 'execute', status: 'in_progress' })], 'coby', NOW)).toBe('tools')
    expect(workPhase([at(200, 'tool_call', { callId: 'f', title: 'Write guide.html', toolKind: 'edit', status: 'completed' })], 'coby', NOW)).toBe('tools')
  })

  it('types while its own words come in, and thinks once they stop', () => {
    const words = [prompt(9000), at(1000, 'message', { role: 'agent' }), at(500, 'message', { role: 'agent' }), at(400, 'usage', {})]
    expect(workPhase(words, 'coby', NOW)).toBe('typing')
    expect(workPhase(words, 'coby', NOW + WORKING_WINDOW_MS)).toBe('thinking')
  })

  it('goes by the newest event that says, and by its own agent’s events in a team', () => {
    const run = [prompt(9000), at(3000, 'thought', {}), at(200, 'message', { role: 'agent' }, 'writer'), at(100, 'turn_end', {})]
    expect(workPhase(run, 'coby', NOW)).toBe('thinking')
    expect(workPhase(run, 'writer', NOW)).toBe('typing')
    expect(workPhase(run, null, NOW)).toBe('typing')
    // A note you sent while it works: it reads that.
    expect(workPhase([...run, at(50, 'message', { role: 'user' })], 'coby', NOW)).toBe('reading')
  })
})

describe('what on its bench it just used, for its figure to go and get', () => {
  const kit: BenchKit = {
    skills: ['explain-like-im-5', 'claude-design'],
    reads: [{ kind: 'folder', name: 'research', where: '/Users/me/research' }, { kind: 'page', name: 'Roadmap', where: 'Notion page · read when each run starts' }],
    tools: ['DeepWiki'],
  }
  const call = (ago: number, payload: Record<string, unknown>, agent = 'coby') => at(ago, 'tool_call', { status: 'in_progress', ...payload }, agent)

  it('finds a skill it opened, by its folder or a skill tool naming it', () => {
    expect(benchUses([call(500, { title: 'Read .agents/skills/explain-like-im-5/SKILL.md', toolKind: 'read' })], 'coby', NOW, kit)).toMatchObject([{ kind: 'skill', name: 'explain-like-im-5' }])
    expect(benchUses([call(500, { name: 'open_skill', title: 'open_skill', rawInput: { name: 'claude-design' } })], 'coby', NOW, kit)).toMatchObject([{ kind: 'skill', name: 'claude-design' }])
  })

  it('finds a tool by its calls’ names, however the app spells them', () => {
    expect(benchUses([call(500, { name: 'mcp__deepwiki__ask_question', title: 'ask_question' })], 'coby', NOW, kit)).toMatchObject([{ kind: 'tool', name: 'DeepWiki' }])
    expect(benchUses([call(500, { name: 'deepwiki__read_wiki_structure' })], 'coby', NOW, kit)).toMatchObject([{ kind: 'tool', name: 'DeepWiki' }])
  })

  it('finds a folder it was given when a call reads inside it; a page is read before the run starts', () => {
    expect(benchUses([call(500, { name: 'read_file', rawInput: { path: '/Users/me/research/notes.md' } })], 'coby', NOW, kit)).toMatchObject([{ kind: 'read', name: 'research' }])
    expect(benchUses([call(500, { title: 'Read notes.md', locations: [{ path: '/Users/me/research/notes.md' }] })], 'coby', NOW, kit)).toMatchObject([{ kind: 'read', name: 'research' }])
    expect(benchUses([call(500, { name: 'notion-fetch', title: 'Roadmap' })], 'coby', NOW, kit)).toEqual([])
  })

  it('leaves what is not on the bench to the laptop: a web search, a command, its own folder', () => {
    const elsewhere = [
      call(900, { title: 'Search the web: attention is all you need', toolKind: 'fetch' }),
      call(800, { title: 'Run: npm test', toolKind: 'execute' }),
      call(700, { name: 'read_file', rawInput: { path: '/Users/me/elsewhere/notes.md' } }),
    ]
    expect(benchUses(elsewhere, 'coby', NOW, kit)).toEqual([])
  })

  it('names each use by its event, oldest first, only its own agent’s, and only the last few seconds’', () => {
    const skill = call(2000, { title: 'Read .agents/skills/claude-design/SKILL.md' })
    const tool = call(1000, { name: 'mcp__deepwiki__ask_question' })
    const theirs = call(500, { name: 'mcp__deepwiki__ask_question' }, 'writer')
    expect(benchUses([skill, tool, theirs], 'coby', NOW, kit)).toEqual([{ kind: 'skill', name: 'claude-design', id: skill.id }, { kind: 'tool', name: 'DeepWiki', id: tool.id }])
    expect(benchUses([call(FETCH_WITHIN_MS + 1, { name: 'mcp__deepwiki__ask_question' })], 'coby', NOW, kit)).toEqual([])
  })
})

describe('what its model is thinking about, for the bubble over its head', () => {
  const thought = (ago: number, text: string, agent = 'coby') => at(ago, 'thought', { role: 'thought', content: { type: 'text', text } }, agent)

  it('says the heading of its latest reasoning, as its summaries give one', () => {
    const run = [prompt(9000), thought(5000, '**Reading the request**\n\nThe user wants'), thought(4000, ' a guide.\n\n**Comparing'), thought(3900, ' transformer recommenders**\n\nSASRec and')]
    expect(thoughtLine(run, 'coby')).toBe('Comparing transformer recommenders')
  })

  it('without a heading, says how its reasoning ends so far, from a whole word', () => {
    expect(thoughtLine([thought(500, 'Clicks are the words here.')], 'coby')).toBe('Clicks are the words here.')
    const long = 'A transformer reads every word at once and lets each word look at the others, so for recommendations the clicks are the words.'
    const line = thoughtLine([thought(500, long)], 'coby')!
    expect(line.startsWith('…')).toBe(true)
    expect(line.length).toBeLessThanOrEqual(THOUGHT_CHARS + 1)
    expect(long.endsWith(line.slice(1))).toBe(true)
    expect(line.slice(1, 2)).not.toBe(' ')
  })

  it('says nothing once it has moved on from its reasoning, and only its own agent’s', () => {
    expect(thoughtLine([thought(3000, '**Planning**'), at(100, 'tool_call', { title: 'Run: npm test', toolKind: 'execute' })], 'coby')).toBeNull()
    expect(thoughtLine([prompt(500)], 'coby')).toBeNull()
    expect(thoughtLine([thought(500, '**Theirs**', 'writer'), thought(400, '**Mine**'), at(300, 'usage', {})], 'coby')).toBe('Mine')
  })
})
