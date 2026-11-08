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
    call('c1', 'list_models'),
    meta('ask_proposal', { proposalId: 'p1', file: 'brief.yaml', name: 'Brief', isNew: true, summary: 'Gathers, checks, writes.', yaml: TEAM }),
    done('c1', { models: [] }),
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

  it('names each tool call in plain words, and a refused draft it then fixed reads as fixed', () => {
    const turn = projectAskThread(proposeTurn()).items[1] as AssistantTurn
    expect(turn.steps.map((step) => [step.label, step.status])).toEqual([
      ['Checked the models', 'done'],
      ['Fixed a problem in its draft', 'done'],
      ['Drafted the team', 'done'],
    ])
    // The tool server's words were for the app; the person has nothing to do about them.
    expect(turn.steps[1].detail).toBeNull()
  })

  it('names the steps of building from what the person has, a job by its name and a search by its words', () => {
    seq = 0
    const turn = projectAskThread([
      status('starting'), status('ready'), status('working'),
      meta('ask_message', { text: 'A team for my client notes', context: { view: 'home', teamPath: null, runId: null } }),
      call('c1', 'list_my_agents'), done('c1'),
      call('c2', 'list_jobs'), done('c2'),
      call('c3', 'read_job', { job: 'deck' }), done('c3'),
      call('c4', 'read_job', { job: 'astronaut' }), done('c4'),
      call('c5', 'list_skills'), done('c5'),
      call('c6', 'list_tools'), done('c6'),
      call('c7', 'find_files', { name: 'Client notes' }), done('c7'),
      call('c8', 'find_files', { name: 'Client notes' }), failed('c8', 'Give a folder or file’s name.'),
      call('c9', 'find_files', { name: 'Client notes' }),
      call('c10', 'read_job', { job: 'deck' }), failed('c10', 'LoomWatch has no job called deck.'),
      call('c11', 'find_files', { name: 'Tax returns' }), failed('c11', 'That is too long for a folder or file’s name.'),
      event('turn_end', { stopReason: 'end_turn' }),
    ]).items[1] as AssistantTurn
    expect(turn.steps.map((step) => step.label)).toEqual([
      'Looked at My agents',
      'Looked at LoomWatch’s jobs',
      'Read the Presentation maker job',
      'Read a job',
      'Looked at your skills',
      'Looked at your tools',
      'Looked for “Client notes”',
      // Tried again, so it reads as done, still saying what it looked for: the person has nothing
      // to do about it.
      'Looked for “Client notes”',
      expect.stringMatching(/^Look(ing|ed) for “Client notes”$/),
      'Couldn’t read the job',
      'Couldn’t look for “Tax returns”',
    ])
  })

  it('keeps the names the daemon read for each agent, so a card names one from My agents', () => {
    seq = 0
    const thread = projectAskThread([
      status('ready'), status('working'),
      meta('ask_message', { text: 'A review team', context: { view: 'home', teamPath: null, runId: null } }),
      meta('ask_proposal', { proposalId: 'p1', file: 'review.yaml', name: 'Review', isNew: true, summary: '', yaml: TEAM, agentNames: { researcher: 'Researcher', odd: 3, blank: ' ' } }),
      meta('ask_proposal', { proposalId: 'p2', file: 'other.yaml', name: 'Other', isNew: true, summary: '', yaml: TEAM }),
    ])
    const cards = (thread.items[1] as AssistantTurn).cards
    expect(cards.map((card) => card.kind === 'proposal' && card.agentNames)).toEqual([{ researcher: 'Researcher' }, {}])
  })

  // ADR 0097: a recorded proposal keeps its project, so one shown after a restart still makes it.
  it('keeps the project a proposal names, and the Brief it carries', () => {
    seq = 0
    const thread = projectAskThread([
      status('ready'), status('working'),
      meta('ask_message', { text: 'My SUTD project', context: { view: 'home', teamPath: null, runId: null } }),
      meta('ask_proposal', { proposalId: 'p1', file: 'gate.yaml', name: 'Gate', isNew: true, summary: '', yaml: TEAM, brief: 'Colin picked B.', project: { id: 'sutd', name: 'SUTD final project', isNew: true, about: 'Colin’s gate.', folders: [{ name: 'SUTD', path: '/Users/colin/SUTD' }, { name: 'none' }] } }),
      meta('ask_proposal', { proposalId: 'p2', file: 'other.yaml', name: 'Other', isNew: true, summary: '', yaml: TEAM, project: { id: '', name: 'Nameless' } }),
    ])
    const [first, second] = (thread.items[1] as AssistantTurn).cards
    expect(first).toMatchObject({ brief: 'Colin picked B.', project: { id: 'sutd', name: 'SUTD final project', isNew: true, about: 'Colin’s gate.', folders: [{ name: 'SUTD', path: '/Users/colin/SUTD' }] } })
    expect(second).not.toHaveProperty('project')
  })

  it('keeps a failure the app never fixed, in the words it was told', () => {
    const events = proposeTurn()
    const lastDraft = events.map((event) => event.payload?.title).lastIndexOf('mcp__loomwatch__propose_team')
    const turn = projectAskThread(events.filter((_, index) => index !== lastDraft)).items[1] as AssistantTurn
    const failed = turn.steps.find((step) => step.status === 'failed')
    expect(failed?.label).toBe('Found a problem in the draft')
    expect(failed?.detail).toContain('entrypoint agent "nobody" does not exist')
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
      meta('ask_run_request', { requestId: 'r1', file: 'brief.yaml', name: 'Brief', request: 'Today', steps: 3 }),
      event('turn_end', {}),
    ]
    const asked = projectAskThread(base).items[1] as AssistantTurn
    expect(asked.cards[0]).toMatchObject({ kind: 'run-request', decision: null, steps: 3 })
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

// ADR 0119: an agent Ask proposed on its own is a card of its own, settled by what the person did
// with it on the agent's page, and replaced by a later draft of the same agent.
describe('an agent Ask proposed', () => {
  const spec = { name: 'Writer', instructions: 'Write a short draft.\nGive it a title.', doneWhen: ['Has a title'] }
  function agentTurn(): RunEvent[] {
    seq = 0
    return [
      status('ready'), status('working'),
      meta('ask_message', { text: 'Make my Writer give each draft a title', context: { view: 'home' } }),
      call('c1', 'read_my_agent', { agent: 'writer' }), done('c1', {}),
      meta('ask_agent_proposal', { proposalId: 'a1', agent: 'writer', name: 'Writer', isNew: false, summary: 'Gives each draft a title.', spec, baseVersion: 2, inTeams: ['Blog'] }),
      call('c2', 'propose_agent', { change: { agent: 'writer' } }), done('c2', { proposalId: 'a1' }),
      meta('ask_agent_proposal', { proposalId: 'a2', agent: 'writer', name: 'Writer', isNew: false, summary: 'Gives each draft a short title.', spec, baseVersion: 2, inTeams: ['Blog'] }),
      meta('ask_agent_proposal', { proposalId: 'a3', name: 'Email helper', isNew: true, summary: 'Drafts replies.', spec: { name: 'Email helper', instructions: 'Draft replies.' } }),
      meta('ask_proposal_outcome', { proposalId: 'a2', agent: 'writer', name: 'Writer', outcome: 'applied' }),
      say('Done.', 'm1'), event('turn_end', { stopReason: 'end_turn' }), status('ready'),
    ]
  }

  it('is a card with what it changes, against the version it changed', () => {
    const turn = projectAskThread(agentTurn()).items[1] as AssistantTurn
    expect(turn.steps.map((step) => step.label)).toEqual(['Looked at your agent', 'Drafted the agent'])
    expect(turn.cards).toEqual([
      expect.objectContaining({ kind: 'agent-proposal', id: 'a1', agent: 'writer', isNew: false, baseVersion: 2, inTeams: ['Blog'], spec, outcome: null, superseded: true }),
      expect.objectContaining({ kind: 'agent-proposal', id: 'a2', agent: 'writer', outcome: 'applied', superseded: false }),
      expect.objectContaining({ kind: 'agent-proposal', id: 'a3', agent: null, name: 'Email helper', isNew: true, baseVersion: null, inTeams: [], outcome: null, superseded: false }),
    ])
  })

  it('replaces an earlier draft of a new agent by its name, whatever its case, and no other', () => {
    seq = 0
    const draft = (proposalId: string, name: string) => meta('ask_agent_proposal', { proposalId, name, isNew: true, summary: '', spec: { name, instructions: 'Draft replies.' } })
    const turn = projectAskThread([status('ready'), meta('ask_message', { text: 'x' }), draft('n1', 'Email helper'), draft('n2', 'Notes helper'), draft('n3', 'email helper'), say('Done.', 'm1')]).items[1] as AssistantTurn
    expect(turn.cards.map((card) => [card.id, card.kind === 'agent-proposal' && card.superseded])).toEqual([['n1', true], ['n2', false], ['n3', false]])
  })

  it('leaves out a record with no agent in it', () => {
    seq = 0
    const turn = projectAskThread([status('ready'), meta('ask_message', { text: 'x' }), meta('ask_agent_proposal', { proposalId: 'a9', name: 'Broken' }), say('Hm.', 'm1')]).items[1] as AssistantTurn
    expect(turn.cards).toEqual([])
  })
})

// ADR 0121: a skill Ask proposed is a card of its own, settled by what the person did with it on
// the Skills page's sheet, and replaced by a later draft of the same skill.
describe('a skill Ask proposed', () => {
  function skillTurn(): RunEvent[] {
    seq = 0
    const change = (proposalId: string, summary: string) => meta('ask_skill_proposal', {
      proposalId, skill: 'weekly-update', isNew: false, summary, description: 'Writes the weekly update.',
      instructions: '1. Read the notes.\n2. Write three bullets.', base: 'base-1', givenTo: ['Writer', 7],
    })
    return [
      status('ready'), status('working'),
      meta('ask_message', { text: 'Make my weekly update skill three bullets', context: { view: 'home' } }),
      call('c1', 'read_skill', { skill: 'weekly-update' }), done('c1', {}),
      change('s1', 'Three bullets.'),
      call('c2', 'propose_skill', { change: { skill: 'weekly-update' } }), done('c2', { proposalId: 's1' }),
      change('s2', 'Three bullets, not five.'),
      meta('ask_skill_proposal', { proposalId: 's3', skill: 'client-letters', title: 'Client letters', isNew: true, summary: 'Letters.', description: 'Writes letters to clients.', instructions: 'Be warm.' }),
      meta('ask_skill_proposal', { proposalId: 's9', skill: 'broken', isNew: true, summary: 'No words.', description: 'x' }),
      meta('ask_proposal_outcome', { proposalId: 's2', skill: 'weekly-update', outcome: 'applied' }),
      say('Done.', 'm1'), event('turn_end', { stopReason: 'end_turn' }), status('ready'),
    ]
  }

  it('is a card with the whole skill, the words it changed and who it is given to', () => {
    const turn = projectAskThread(skillTurn()).items[1] as AssistantTurn
    expect(turn.steps.map((step) => step.label)).toEqual(['Looked at your skill', 'Drafted the skill'])
    expect(turn.cards).toEqual([
      expect.objectContaining({ kind: 'skill-proposal', id: 's1', skill: 'weekly-update', title: null, isNew: false, base: 'base-1', givenTo: ['Writer'], outcome: null, superseded: true }),
      expect.objectContaining({ kind: 'skill-proposal', id: 's2', summary: 'Three bullets, not five.', description: 'Writes the weekly update.', instructions: '1. Read the notes.\n2. Write three bullets.', outcome: 'applied', superseded: false }),
      expect.objectContaining({ kind: 'skill-proposal', id: 's3', skill: 'client-letters', title: 'Client letters', isNew: true, base: null, givenTo: [], outcome: null, superseded: false }),
    ])
  })
})
