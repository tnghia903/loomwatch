import { describe, expect, it } from 'vitest'

import type { RunEvent } from '../watch/events'
import { currentActivity, projectAskThread, toolOf, type AssistantTurn } from './thread'

let seq = 0
function event(kind: RunEvent['kind'], payload: Record<string, unknown>): RunEvent {
  seq += 1
  return { id: `e${seq}`, sessionId: 'ask-1', agentId: 'ask', seq, ts: `2026-10-02T09:00:${String(seq).padStart(2, '0')}.000Z`, kind, payload }
}
const meta = (phase: string, fields: Record<string, unknown> = {}) => event('session_meta', { phase, ...fields })
const status = (state: string, extra: Record<string, unknown> = {}) => meta('ask_status', { state, app: { id: 'claude', name: 'Claude' }, ...extra })
const say = (text: string, messageId: string) => event('message', { role: 'agent', content: { type: 'text', text }, messageId })
const call = (callId: string, title: string, rawInput: unknown = {}) => event('tool_call', { callId, title, status: 'pending', rawInput })
const done = (callId: string, rawOutput: unknown = {}) => event('tool_update', { callId, status: 'completed', rawOutput })
const failed = (callId: string, rawOutput: unknown) => event('tool_update', { callId, status: 'failed', rawOutput })

const TEAM = 'schemaVersion: 1\nid: brief\nname: Brief\nentrypoint: a\nagents: []\nedges: []\n'

/** The order the daemon really archived one turn in (see the scratch dump in ADR 0033's tests): the
    tool server recorded the proposal before the app's own report of the call that made it. */
function proposeTurn(): RunEvent[] {
  seq = 0
  return [
    status('starting'), event('process', { phase: 'spawned' }), status('ready'), status('working'),
    meta('ask_message', { text: 'Make me a news brief team', context: { view: 'home', teamPath: null, runId: null } }),
    event('message', { role: 'user', content: { type: 'text', text: 'You are Ask LoomWatch… (instructions)' } }),
    call('c1', 'mcp__loomwatch__list_apps'),
    meta('ask_proposal', { proposalId: 'p1', file: 'brief.yaml', name: 'Brief', isNew: true, summary: 'Gathers, checks, writes.', yaml: TEAM }),
    done('c1', { apps: [] }),
    call('c2', 'mcp__loomwatch__propose_team', { file: 'brief.yaml' }),
    failed('c2', 'The team file has a problem: entrypoint agent "nobody" does not exist. Fix it and propose again.'),
    say('My first draft named a starting agent that doesn’t exist, so I fixed it. ', 'm1'),
    call('c3', 'mcp__loomwatch__propose_team', { file: 'brief.yaml' }),
    done('c3', { proposalId: 'p1' }),
    say('Here is a team for that.', 'm2'),
    event('turn_end', { stopReason: 'end_turn' }),
    status('ready'),
  ]
}

describe('projectAskThread', () => {
  it('shows the person’s own words, never the prompt the app was sent', () => {
    const thread = projectAskThread(proposeTurn())
    const people = thread.items.filter((item) => item.kind === 'person')
    expect(people).toEqual([{ kind: 'person', id: expect.any(String), text: 'Make me a news brief team' }])
    expect(JSON.stringify(thread)).not.toContain('instructions')
  })

  it('names each tool call in plain words, with the failure the app was told about', () => {
    const turn = projectAskThread(proposeTurn()).items[1] as AssistantTurn
    expect(turn.steps.map((step) => [step.label, step.status])).toEqual([
      ['Checked your AI apps', 'done'],
      ['Found a problem in the draft', 'failed'],
      ['Drafted the team', 'done'],
    ])
    expect(turn.steps[1].detail).toContain('entrypoint agent "nobody" does not exist')
  })

  it('keeps separate messages apart and puts the proposal with the turn that made it', () => {
    const thread = projectAskThread(proposeTurn())
    expect(thread.items.map((item) => item.kind)).toEqual(['person', 'assistant'])
    const turn = thread.items[1] as AssistantTurn
    expect(turn.text).toBe('My first draft named a starting agent that doesn’t exist, so I fixed it. \n\nHere is a team for that.')
    expect(turn.cards).toEqual([expect.objectContaining({ kind: 'proposal', id: 'p1', file: 'brief.yaml', isNew: true, outcome: null, superseded: false })])
    expect(turn.done).toBe(true)
    expect(thread.state).toBe('ready')
    expect(thread.appName).toBe('Claude')
    expect(thread.appId).toBe('claude')
    expect(thread.model).toBeNull()
  })

  it('says which model the person chose for the conversation', () => {
    const thread = projectAskThread([status('starting', { app: { id: 'codex', name: 'Codex', model: 'gpt-5.5' } })])
    expect([thread.appName, thread.appId, thread.model]).toEqual(['Codex', 'codex', 'gpt-5.5'])
  })

  it('records what the person did with a proposal, and marks an earlier draft of the same file replaced', () => {
    const events = [
      ...proposeTurn(),
      meta('ask_proposal_outcome', { proposalId: 'p1', file: 'brief.yaml', outcome: 'applied' }),
      meta('ask_message', { text: 'Add an editor', context: {} }),
      meta('ask_proposal', { proposalId: 'p2', file: 'brief.yaml', name: 'Brief', isNew: false, summary: 'Adds an editor.', yaml: TEAM }),
      event('turn_end', { stopReason: 'end_turn' }),
    ]
    const cards = projectAskThread(events).items.flatMap((item) => (item.kind === 'assistant' ? item.cards : []))
    expect(cards).toEqual([
      expect.objectContaining({ id: 'p1', outcome: 'applied', superseded: true }),
      expect.objectContaining({ id: 'p2', outcome: null, superseded: false }),
    ])
  })

  it('turns a run request into started or declined once the person answers it', () => {
    seq = 0
    const base = [
      meta('ask_message', { text: 'run it', context: {} }),
      meta('ask_run_request', { requestId: 'r1', file: 'brief.yaml', name: 'Brief', request: 'Today', apps: ['Claude'], steps: 3 }),
      event('turn_end', {}),
    ]
    const asked = projectAskThread(base).items[1] as AssistantTurn
    expect(asked.cards[0]).toMatchObject({ kind: 'run-request', decision: null, apps: ['Claude'], steps: 3 })
    const started = projectAskThread([...base, meta('ask_run_started', { requestId: 'r1', runId: 'run-9', file: 'brief.yaml' })]).items[1] as AssistantTurn
    expect(started.cards[0]).toMatchObject({ decision: 'started', runId: 'run-9' })
    const declined = projectAskThread([...base, meta('ask_run_declined', { requestId: 'r1', file: 'brief.yaml' })]).items[1] as AssistantTurn
    expect(declined.cards[0]).toMatchObject({ decision: 'declined' })
  })

  it('shows a run the app started without asking, and a drafted review note', () => {
    seq = 0
    const turn = projectAskThread([
      meta('ask_message', { text: 'go', context: {} }),
      meta('ask_run_started', { runId: 'run-1', file: 'brief.yaml', request: 'Today' }),
      meta('ask_review_note', { runId: 'run-1', file: 'brief.yaml', node: 'review', name: 'You', question: 'Approve?', text: 'Approved.' }),
    ]).items[1] as AssistantTurn
    expect(turn.cards.map((card) => card.kind)).toEqual(['run-started', 'review-note'])
    expect(turn.cards[1]).toMatchObject({ runId: 'run-1', question: 'Approve?', text: 'Approved.' })
  })

  it('says why a conversation failed', () => {
    seq = 0
    const thread = projectAskThread([status('starting'), status('failed', { error: 'Claude could not start: not signed in.' })])
    expect(thread.state).toBe('failed')
    expect(thread.error).toBe('Claude could not start: not signed in.')
  })
})

describe('currentActivity', () => {
  it('follows the assistant from reading to the step it is on to writing', () => {
    seq = 0
    const start = [status('working'), meta('ask_message', { text: 'hi', context: {} })]
    expect(currentActivity(projectAskThread(start))).toBe('Reading your message')
    const calling = [...start, call('c1', 'loomwatch.read_team', { file: 'brief.yaml' })]
    expect(currentActivity(projectAskThread(calling))).toBe('Reading brief.yaml')
    const writing = [...calling, done('c1'), say('Here', 'm1')]
    expect(currentActivity(projectAskThread(writing))).toBe('Writing')
    expect(currentActivity(projectAskThread([...writing, event('turn_end', {}), status('ready')]))).toBeNull()
  })
})

describe('toolOf', () => {
  it('finds LoomWatch’s tool however an app spells the call', () => {
    expect(toolOf('mcp__loomwatch__list_teams')).toBe('list_teams')
    expect(toolOf('loomwatch.propose_team')).toBe('propose_team')
    expect(toolOf('start_run (loomwatch MCP server)')).toBe('start_run')
    expect(toolOf('Run shell command', 'mcp__loomwatch__get_run')).toBe('get_run')
    expect(toolOf('mcp__other__list_teams_clone')).toBeNull()
    expect(toolOf('Write README.md')).toBeNull()
  })
})
