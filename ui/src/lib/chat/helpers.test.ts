import { describe, expect, it } from 'vitest'

import { bubbles, converse, fold } from '../story/conversation'
import { projectRun, type RunEvent } from '../watch/events'
import { helperOf, helpersLine, helpersOf, nameWithHelpers, took, wearerOf, whoWorks } from './helpers'

const T0 = Date.parse('2026-10-20T09:00:00Z')
let seq = 0
const event = (seconds: number, agentId: string, kind: RunEvent['kind'], payload: RunEvent['payload']): RunEvent => {
  const at = seq++
  return { id: `e${at}`, sessionId: 'run', agentId, seq: at, ts: new Date(T0 + seconds * 1000).toISOString(), kind, payload }
}
const start = (seconds: number, callId: string, title: string, task: string) =>
  event(seconds, 'ada', 'tool_call', { callId, title: 'Team Bus: start_helper', name: 'start_helper', toolKind: 'other', status: 'in_progress', rawInput: { title, task, send_back: 'One line with the rent.' } })
const started = (seconds: number, callId: string, agent: string) =>
  event(seconds, 'ada', 'tool_update', { callId, status: 'completed', rawOutput: { accepted: true, agent, name: `Ada's helper ${agent.slice(-1)}`, mode: 'helper' } })
const search = (seconds: number, agentId: string, callId: string, query: string) =>
  event(seconds, agentId, 'tool_call', { callId, title: `Web search: ${query}`, name: 'web_search', toolKind: 'fetch', status: 'completed', rawInput: { query } })
const cameBack = (seconds: number, agentId: string, outcome: { reply: string } | { error: string }) =>
  event(seconds, agentId, 'session_meta', { phase: 'delegated_result', mode: 'helper', for: 'ada', task: 'the full brief', title: 'from the bus', ...('reply' in outcome ? { status: 'succeeded', reply: outcome.reply } : { status: 'failed', error: outcome.error }) })

describe('helpers (ADR 0079)', () => {
  it('tells a helper from an agent by its id alone', () => {
    expect(helperOf('ada~2')).toEqual({ lead: 'ada', number: 2 })
    expect(helperOf('my.agent-1~12')).toEqual({ lead: 'my.agent-1', number: 12 })
    for (const plain of ['ada', 'ada~', '~2', 'ada~0', 'ada~x', 'ada~2b', 'ada-2', 'operator']) expect(helperOf(plain), plain).toBeNull()
    expect(wearerOf('ada~2')).toBe('ada')
    expect(wearerOf('ada')).toBe('ada')
  })

  it('names a helper after the agent it helps', () => {
    const names = new Map([['ada', 'Ada']])
    expect(nameWithHelpers(names, 'ada')).toBe('Ada')
    expect(nameWithHelpers(names, 'ada~3')).toBe('Ada’s helper 3')
    expect(nameWithHelpers(names, 'bob~1')).toBe('bob’s helper 1')
    expect(nameWithHelpers(names, 'bob')).toBeNull()
  })

  it('reads each helper off the record: its part, its brief, its steps, and what it sent back or why it could not', () => {
    const events = [
      start(0, 'c1', 'Rent in Hanoi', 'Find the studio rent in Hanoi.'),
      start(0, 'c2', 'Rent in Da Nang', 'Find the studio rent in Da Nang.'),
      start(0, 'c3', 'A third part', 'Refused by the bus.'),
      started(1, 'c1', 'ada~1'),
      started(1, 'c2', 'ada~2'),
      event(1, 'ada', 'tool_update', { callId: 'c3', status: 'failed', rawOutput: { error: 'limit', refused: 'limit' } }),
      search(5, 'ada~1', 's1', 'studio rent Hanoi 2026'),
      search(9, 'ada~1', 's2', 'Hanoi rent Tay Ho'),
      search(6, 'ada~2', 's3', 'studio rent Da Nang'),
      cameBack(40, 'ada~1', { reply: 'Hanoi: about $400.' }),
    ]
    const evidence = projectRun(events).evidence
    const live = helpersOf(events, evidence)
    expect(live.map((helper) => [helper.id, helper.title, helper.state, helper.steps])).toEqual([
      ['ada~1', 'Rent in Hanoi', 'done', 2],
      ['ada~2', 'Rent in Da Nang', 'working', 1],
    ])
    expect(live[0]).toMatchObject({ reply: 'Hanoi: about $400.', brief: 'the full brief', now: null, lead: 'ada', number: 1, messageId: 'ada:c1' })
    expect(live[1].brief).toBe('Find the studio rent in Da Nang.\n\n## What to send back\nOne line with the rent.')
    expect(live[1].now).toContain('studio rent Da Nang')
    expect(helpersLine(live)).toBe('2 helpers · 1 working')
    expect(took(live[0].startedAt, live[0].finishedAt)).toBe('40s')

    const failed = helpersOf([...events, cameBack(130, 'ada~2', { error: 'the provider is down' })], evidence)
    expect(failed[1]).toMatchObject({ state: 'failed', error: 'the provider is down', now: null })
    expect(helpersLine(failed)).toBe('2 helpers · 1 couldn’t finish')
    expect(took(failed[1].startedAt, failed[1].finishedAt)).toBe('2m 10s')
    expect(helpersLine(helpersOf([...events, cameBack(50, 'ada~2', { reply: 'Da Nang: $350.' })], evidence))).toBe('2 helpers · done')
    const stopped = { ...cameBack(50, 'ada~2', { reply: 'Da Nang so far.' }), payload: { ...cameBack(50, 'ada~2', { reply: 'Da Nang so far.' }).payload, stopped: true } }
    expect(helpersOf([...events, stopped], evidence)[1].state).toBe('stopped')
    expect(helpersLine(helpersOf([...events, stopped], evidence))).toBe('2 helpers · 1 stopped')
  })

  it('says a step on a file or folder by its name, not where it is on the disk', () => {
    const events = [
      start(0, 'c1', 'Read the notes', 'Read the notes.'),
      started(1, 'c1', 'ada~1'),
      event(2, 'ada~1', 'tool_call', { callId: 'f1', title: 'List files', name: 'list_files', toolKind: 'read', status: 'in_progress', rawInput: { path: '/Users/me/LoomWatch/teams/notes/' }, locations: [{ path: '/Users/me/LoomWatch/teams/notes/' }] }),
    ]
    const [helper] = helpersOf(events, projectRun(events).evidence)
    expect(helper.now).toMatch(/notes$/)
    expect(helper.now).not.toContain('/Users/me')
  })

  it('takes nothing else for a helper: a dispatch to a teammate, or a call the harness only echoed', () => {
    const events = [
      event(0, 'lead', 'tool_call', { callId: 'd1', title: 'Team Bus: dispatch', name: 'dispatch', toolKind: 'other', status: 'in_progress', rawInput: { agent: 'worker', task: 'x' } }),
      event(1, 'lead', 'tool_update', { callId: 'd1', status: 'completed', rawOutput: { accepted: true, agent: 'worker', mode: 'dispatch' } }),
      event(0, 'ada', 'tool_call', { callId: 'h1', title: 'start_helper', name: 'mcp__bus__start_helper', toolKind: 'other', status: 'in_progress', rawInput: { title: 'echo', task: 'x' } }),
      event(2, 'worker', 'session_meta', { phase: 'delegated_result', mode: 'dispatch', for: 'lead', task: 'x', status: 'succeeded', reply: 'y' }),
    ]
    expect(helpersOf(events)).toEqual([])
  })

  it('puts each brief in the talk as a task to its helper, and what it sent back as its reply', () => {
    const loomwatch = (event: RunEvent): RunEvent => ({ ...event, raw: { source: 'loomwatch', phase: event.payload.phase } })
    const events = [
      start(0, 'c1', 'Rent in Hanoi', 'Find the studio rent in Hanoi.'),
      start(0, 'c2', 'Rent in Da Nang', 'Find the studio rent in Da Nang.'),
      start(0, 'c3', 'Rent in Hue', 'Find the studio rent in Hue.'),
      start(0, 'c4', 'Rent in Vinh', 'Find the studio rent in Vinh.'),
      started(1, 'c1', 'ada~1'),
      started(1, 'c2', 'ada~2'),
      started(1, 'c3', 'ada~3'),
      started(1, 'c4', 'ada~4'),
      loomwatch(cameBack(40, 'ada~1', { reply: 'Hanoi: about $400.' })),
      loomwatch({ ...cameBack(41, 'ada~2', { reply: '(The person stopped this helper before it finished. Below is what it had so far, if anything: do the rest of this part yourself.)\n\nDa Nang: $350 so far.' }), payload: { ...cameBack(41, 'ada~2', { reply: '' }).payload, stopped: true, reply: '(The person stopped this helper before it finished. Below is what it had so far, if anything: do the rest of this part yourself.)\n\nDa Nang: $350 so far.' } }),
      loomwatch(cameBack(42, 'ada~3', { error: 'the provider is down' })),
    ]
    const messages = projectRun(events).messages.filter((message) => message.kind === 'helper')
    expect(messages.map((message) => [message.from, message.to, message.state])).toEqual([
      ['ada', 'ada~1', 'answered'], ['ada', 'ada~2', 'answered'], ['ada', 'ada~3', 'answered'], ['ada', 'ada~4', 'pending'],
    ])
    expect(messages[0].text).toBe('Find the studio rent in Hanoi.\n\n**Send back:** One line with the rent.')
    expect(messages[0].reply).toMatchObject({ from: 'ada~1', text: 'Hanoi: about $400.' })
    expect(messages[1].reply).toMatchObject({ text: 'Da Nang: $350 so far.', stopped: true })
    expect(messages[2].reply).toMatchObject({ text: 'the provider is down', failed: true })

    const order = [{ id: 'ada', name: 'Ada', operator: false }]
    const conversation = converse(messages, order)
    expect(conversation.lanes.map((lane) => lane.name)).toEqual(['Ada', 'Ada’s helper 1', 'Ada’s helper 2', 'Ada’s helper 3', 'Ada’s helper 4'])
    const said = bubbles(fold(conversation.lines, conversation.lanes), conversation.lanes, true, 'Approved.')
    expect(said.map((bubble) => [bubble.from.join(), bubble.part, bubble.word])).toEqual([
      ['ada', 'said', 'task'], ['ada~1', 'reply', 'done'],
      ['ada', 'said', 'task'], ['ada~2', 'reply', 'stopped'],
      ['ada', 'said', 'task'], ['ada~3', 'reply', 'couldn’t finish'],
      ['ada', 'said', 'task'], ['ada~4', 'waiting', 'working…'],
    ])
  })

  it('says who works with an agent’s helpers counted, not listed', () => {
    expect(whoWorks(['ada', 'ada~1', 'ada~2'])).toEqual([{ agent: 'ada', text: 'ada' }, { text: '2 helpers' }])
    expect(whoWorks(['ada~3'])).toEqual([{ agent: 'ada', text: '1 helper', helpers: true }])
    expect(whoWorks(['ada'])).toEqual([{ agent: 'ada', text: 'ada' }])
  })
})
