import { describe, expect, it } from 'vitest'

import { projectRun, type Evidence, type RunEvent } from '../watch/events'
import { failuresOf, readCount, readPhrase, skillName, skillsUsed } from './reads'
import { buildReceipt } from './receipt'
import { answerVerdict } from './verdict'
import { describeEvidence, narrate, weave } from './weft'

const FOLDER = '/Users/Shared/harbor-pine/q3-reports'
const SKILL = '/Users/me/LoomWatch/work/researcher/.claude/skills/house-style/SKILL.md'
const SHA = 'a'.repeat(64)
const EISDIR = 'EISDIR: illegal operation on a directory, read'

type Step = [agentId: string, kind: RunEvent['kind'], payload: RunEvent['payload'], raw?: unknown]

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 3, 4, 0, seconds)).toISOString()
const record = (steps: Step[]): RunEvent[] =>
  steps.map(([agentId, kind, payload, raw], seq) => ({ id: `event-${seq}`, sessionId: 'run-7', agentId, seq, ts: at(seq), kind, payload, ...(raw === undefined ? {} : { raw }) }))

/** Claude Code's Read as claude-agent-acp reports it: the call, a permission ask allowed once, then the result. */
function read(callId: string, path: string, error?: string): Step[] {
  const title = `Read ${path}`
  return [
    ['researcher', 'tool_call', { callId, title, toolKind: 'read', status: 'pending', rawInput: { file_path: path }, locations: [{ path, line: 1 }] }],
    ['researcher', 'permission', { toolCall: { toolCallId: callId, title, kind: 'read' }, options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' }, { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' }] }],
    ['researcher', 'permission', { outcome: { outcome: 'selected', optionId: 'allow_once' } }],
    error
      ? ['researcher', 'tool_update', { callId, status: 'failed', rawOutput: error, content: [{ type: 'content', content: { type: 'text', text: error } }] }]
      : ['researcher', 'tool_update', { callId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '1\t# Q3' } }] }],
  ]
}

/**
 * The market-brief run: Researcher was handed the `q3-reports` folder and the `house-style` skill,
 * opened the skill, then did `reads`; you approved; Writer wrote the brief.
 */
function marketBrief(reads: Step[]): RunEvent[] {
  return record([
    ['researcher', 'process', { phase: 'spawned', pid: 41 }],
    ['researcher', 'session_meta', { phase: 'prompt_sections', sections: [{ kind: 'task', heading: '## Task', text: 'Write the market brief.' }], requiredSkills: [{ name: 'house-style', source: 'LoomWatch', sourcePath: '/Users/me/.claude/skills/house-style', path: SKILL, sha256: SHA, chars: 812 }] }, { source: 'loomwatch', phase: 'prompt_sections' }],
    ['researcher', 'message', { role: 'user', content: { type: 'text', text: 'Write the market brief.' } }],
    // One skill, recorded twice: the agent's own Read of its SKILL.md, and LoomWatch noting that it opened.
    ['researcher', 'tool_call', { callId: 'skill', title: 'Read .claude/skills/house-style/SKILL.md', toolKind: 'read', status: 'pending', rawInput: { file_path: SKILL }, locations: [{ path: SKILL, line: 1 }] }],
    ['researcher', 'tool_update', { callId: 'skill', status: 'completed' }],
    ['researcher', 'session_meta', { phase: 'skill_opened', skill: 'house-style', path: SKILL, sha256: SHA, toolCallId: 'skill' }, { source: 'loomwatch', phase: 'skill_opened' }],
    ...reads,
    ['researcher', 'message', { role: 'agent', content: { type: 'text', text: 'Q3 revenue rose 12%; churn fell to 3.1%.' } }],
    ['researcher', 'turn_end', { stopReason: 'end_turn' }],
    ['researcher', 'process', { phase: 'exited', exitCode: 0 }],
    ['review', 'message', { role: 'user', content: { type: 'text', text: 'The figures check out.' } }, { phase: 'operator_answer', source: 'loomwatch' }],
    ['writer', 'process', { phase: 'spawned', pid: 42 }],
    ['writer', 'message', { role: 'user', content: { type: 'text', text: 'Write the brief for the leadership team.' } }],
    ['writer', 'message', { role: 'agent', content: { type: 'text', text: '# Q3 market brief' } }],
    ['writer', 'turn_end', { stopReason: 'end_turn' }],
    ['writer', 'process', { phase: 'exited', exitCode: 0 }],
  ])
}

const agents = [
  { id: 'researcher', name: 'Researcher', operator: false },
  { id: 'review', name: 'You', operator: true, runtime: { status: 'succeeded' as const } },
  { id: 'writer', name: 'Writer', operator: false },
]

/** The receipt and the verdict exactly as the Run view builds them (DeliveryLane). */
function judge(events: RunEvent[]) {
  const projection = projectRun(events, Infinity, { responder: 'writer', status: 'succeeded', evidenceComplete: true })
  const evidenceByAgent = new Map(agents.map((agent) => [agent.id, projection.evidence.filter((item) => item.agentId === agent.id)]))
  const receipt = buildReceipt({ attempt: 7, prompt: projection.prompt ?? '', phase: projection.phase, elapsed: '1m 10s', agents, projection, evidenceByAgent, harnessLabels: new Map([['researcher', 'Claude Code'], ['writer', 'Claude Code']]), answered: true })
  const read = readCount([...evidenceByAgent.values()].flat())
  const verdict = answerVerdict({ phase: projection.phase, text: '# Q3 market brief', streaming: false, terminal: true, settled: true, reviewed: false, receipt, read })
  return { projection, receipt, verdict }
}

const files = (...names: string[]) => names.flatMap((name) => read(name, `${FOLDER}/${name}`))

describe('a linked folder read as a file, then the files in it', () => {
  // The run that prompted this: the receipt said "✗ Researcher couldn't read q3-reports, and
  // carried on without it", the answer was badged "1 thing to check", the Researcher "used 2
  // skills" with one given, and a clean run "read 1 source" — the operator's own answer.
  const events = marketBrief([...read('folder', FOLDER, EISDIR), ...files('README.md', 'q3-sales.md', 'q3-churn.md')])

  it('does not call the folder unreadable, and counts each skill and file once', () => {
    const { receipt } = judge(events)
    expect(receipt.lines.map((line) => [line.tone, line.text])).toEqual([
      ['ok', 'Researcher finished · used 1 skill, read 3 files'],
      ['ok', 'You gave your decision'],
      ['ok', 'Writer finished'],
    ])
    expect(receipt.checks).toEqual([])
  })

  it('flags nothing on the answer, and says what it rests on', () => {
    expect(judge(events).verdict).toMatchObject({ tone: 'ok', label: 'Nothing flagged', detail: 'Every step finished, reading 3 files, and nothing in the record was flagged.' })
  })

  it('keeps the failed call in the record itself', () => {
    const { projection } = judge(events)
    const folder = projection.evidence.find((item) => item.id === 'researcher:folder')
    expect(folder).toMatchObject({ kind: 'file', relation: 'read file', status: 'failed' })
    expect(weave(projection, agents).stitches.find((stitch) => stitch.evidenceId === 'researcher:folder')).toMatchObject({ bad: true, sentence: 'Researcher couldn’t read q3-reports.' })
  })

  it('tells the same run as a story with the receipt’s counts and no failure', () => {
    const story = narrate(weave(judge(events).projection, agents))
    expect(story.filter((beat) => beat.bad)).toEqual([])
    expect(story.find((beat) => beat.text.startsWith('Researcher '))?.text).toMatch(/: it used one skill and read 3 files\.$/)
  })

  it('judges the folder the same whichever came first', () => {
    const after = marketBrief([...files('README.md', 'q3-sales.md'), ...read('folder', FOLDER, EISDIR)])
    expect(judge(after).receipt.lines.filter((line) => line.tone === 'bad')).toEqual([])
  })
})

describe('a source that really could not be read', () => {
  it('stays a red line when nothing in the folder was read', () => {
    const { receipt, verdict } = judge(marketBrief(read('folder', FOLDER, EISDIR)))
    expect(receipt.lines.map((line) => [line.tone, line.text])).toEqual([
      ['ok', 'Researcher finished · used 1 skill'],
      ['bad', 'Researcher couldn’t read q3-reports, and carried on without it'],
      ['ok', 'You gave your decision'],
      ['ok', 'Writer finished'],
    ])
    expect(receipt.lines[1].evidenceId).toBe('researcher:folder')
    expect(verdict).toMatchObject({ tone: 'look', label: '1 thing to check', detail: 'Researcher couldn’t read q3-reports, and carried on without it.' })
    const story = narrate(weave(judge(marketBrief(read('folder', FOLDER, EISDIR))).projection, agents))
    expect(story.filter((beat) => beat.bad).map((beat) => beat.text)).toEqual(['Researcher couldn’t read q3-reports — the run carried on.'])
  })

  it('stays a red line when every file in it failed too', () => {
    const denied = (name: string) => read(name, `${FOLDER}/${name}`, 'EACCES: permission denied')
    const { receipt } = judge(marketBrief([...read('folder', FOLDER, EISDIR), ...denied('README.md'), ...denied('q3-sales.md')]))
    expect(receipt.lines.filter((line) => line.tone === 'bad').map((line) => line.text)).toEqual([
      'Researcher couldn’t read q3-reports, and carried on without it',
      'Researcher couldn’t read README.md, and carried on without it',
      'Researcher couldn’t read q3-sales.md, and carried on without it',
    ])
  })

  // Reading the folder's README says nothing about q3-sales.md: that file is still missing.
  it('does not excuse a file because a file beside it was read', () => {
    const { receipt } = judge(marketBrief([...read('sales', `${FOLDER}/q3-sales.md`, 'EACCES: permission denied'), ...files('README.md')]))
    expect(receipt.lines.filter((line) => line.tone === 'bad').map((line) => line.text)).toEqual(['Researcher couldn’t read q3-sales.md, and carried on without it'])
    expect(receipt.lines[0].text).toBe('Researcher finished · used 1 skill, read 1 file')
  })

  it('does not take a folder whose name starts the same for the one that failed', () => {
    const { receipt } = judge(marketBrief([...read('folder', '/Users/Shared/harbor-pine/q3', EISDIR), ...files('README.md')]))
    expect(receipt.lines.filter((line) => line.tone === 'bad').map((line) => line.text)).toEqual(['Researcher couldn’t read q3, and carried on without it'])
  })
})

const item = (id: string, extra: Partial<Evidence>): Evidence =>
  ({ id, agentId: 'researcher', kind: 'file', relation: 'read file', name: id, status: 'succeeded', toolKind: 'read', rawInput: null, locations: [], ...extra }) as unknown as Evidence

describe('counting things, not calls', () => {
  it('names one skill once however it was reached, and never counts a supplied one as used', () => {
    const used = [
      item('a', { kind: 'skill', relation: 'used skill', name: 'Load skill: house-style', toolKind: 'other', rawInput: { skill: 'house-style' } }),
      item('b', { kind: 'skill', relation: 'used skill', name: 'Read .claude/skills/house-style/SKILL.md', locations: [{ path: SKILL }] }),
      item('c', { kind: 'skill', relation: 'opened by the agent', name: 'house-style' }),
      item('d', { kind: 'skill', relation: 'loaded into prompt', name: 'brand-voice', toolKind: 'prompt' }),
    ]
    expect(skillsUsed(used)).toEqual(['house-style'])
    expect(skillName(item('e', { kind: 'skill', relation: 'used skill', name: 'Skill(claude-design)' }))).toBe('claude-design')
    expect(skillName(item('f', { kind: 'skill', relation: 'used skill', name: 'Read .claude/skills/house-style/examples.md' }))).toBe('house-style')
    expect(describeEvidence('Writer', used[0])).toBe('Writer used the skill “house-style”.')
  })

  it('counts a skill the agent could not load once it loaded it another way', () => {
    const items = [
      item('a', { kind: 'skill', relation: 'used skill', name: 'Load skill: house-style', toolKind: 'other', status: 'failed' }),
      item('b', { kind: 'skill', relation: 'opened by the agent', name: 'house-style' }),
    ]
    expect(failuresOf(items)).toEqual([])
    expect(failuresOf(items.slice(0, 1)).map((miss) => miss.id)).toEqual(['a'])
  })

  it('reads a file read in pages as one, and leaves out what nobody read', () => {
    const items = [
      item('a', { locations: [{ path: `${FOLDER}/q3-sales.md`, line: 1 }] }),
      item('b', { locations: [{ path: `${FOLDER}/q3-sales.md`, line: 200 }] }),
      item('c', { status: 'failed', locations: [{ path: FOLDER }] }),
      item('d', { kind: 'source', relation: 'consulted source', name: 'Fetch https://ft.com/q3', toolKind: 'fetch', rawInput: { url: 'https://ft.com/q3' } }),
      item('e', { kind: 'source', relation: 'directed', name: 'Your answer', toolKind: null }),
      item('f', { kind: 'source', relation: 'wrote to notebook · decision', name: 'Note', toolKind: null }),
      item('g', { kind: 'source', relation: 'retrieved', name: 'Notebook entry', toolKind: null, rawInput: { id: 'n1' } }),
    ]
    expect(readCount(items)).toEqual({ files: 1, pages: 1, notes: 1 })
    expect(readPhrase(readCount(items))).toBe('1 file, 1 web page and 1 notebook entry')
    expect(readPhrase({ files: 3, pages: 0, notes: 0 })).toBe('3 files')
    expect(readPhrase({ files: 0, pages: 0, notes: 0 })).toBe('')
  })
})
