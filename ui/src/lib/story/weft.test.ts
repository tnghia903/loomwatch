import { describe, expect, it } from 'vitest'

import type { Evidence, ProjectedAgent, RunProjection } from '../watch/events'
import { buildReceipt, receiptMarkdown } from './receipt'
import { clock, describeEvidence, momentAt, narrate, shortName, weave } from './weft'

const T0 = Date.parse('2026-09-29T08:00:00Z')
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

function agent(id: string, from: number, to: number, extra: Partial<ProjectedAgent> = {}): ProjectedAgent {
  return { id, status: 'succeeded', firstTs: iso(from), lastTs: iso(to), openCalls: 0, exitCode: null, stopReason: null, requiredSkills: [], ...extra } as unknown as ProjectedAgent
}

function evidence(id: string, agentId: string, seconds: number, extra: Partial<Evidence> = {}): Evidence {
  return { id, agentId, seq: Number(id.replace(/\D/g, '')) || 1, offsetMs: seconds * 1000, kind: 'source', relation: 'consulted source', name: 'https://reuters.com/tech/story', status: 'succeeded', target: null, ...extra } as unknown as Evidence
}

function projection(extra: Partial<RunProjection> = {}): RunProjection {
  return {
    agents: [agent('collector', 0, 110), agent('editor', 112, 165)],
    evidence: [evidence('e1', 'collector', 4), evidence('e2', 'editor', 140, { kind: 'file', relation: 'read file', name: '/Users/x/skills/newsletter/SKILL.md', status: 'failed' })],
    delegations: [],
    attention: [],
    prompt: 'Monday edition',
    promptAgentId: 'collector',
    phase: 'succeeded',
    errorCode: null,
    startedAt: iso(0),
    updatedAt: iso(165),
    lastSeq: 2,
    totals: { thoughts: 0, toolCalls: 2, messages: 2, agents: 2 },
    coverage: { agents: { level: 'complete', reason: 'observed', observed: 2 }, reasoning: { level: 'complete', reason: 'none_recorded', observed: 0 }, skills: { level: 'complete', reason: 'observed', observed: 0 }, tools: { level: 'complete', reason: 'observed', observed: 2 }, commands: { level: 'complete', reason: 'none_recorded', observed: 0 }, sources: { level: 'complete', reason: 'observed', observed: 1 } },
    ...extra,
  }
}

const order = [{ id: 'collector', name: 'News Collector', operator: false }, { id: 'editor', name: 'News Editor', operator: false }]

describe('weave', () => {
  it('draws a lane per helper from its first to last event', () => {
    const weft = weave(projection(), order)
    expect(weft.duration).toBe(165_000)
    expect(weft.lanes.map((lane) => [lane.id, lane.start, lane.end])).toEqual([['collector', 0, 110_000], ['editor', 112_000, 165_000]])
    expect(weft.live).toBe(false)
  })

  it('ties a knot where the next stage starts when no delegation was recorded', () => {
    expect(weave(projection(), order).knots).toEqual([{ at: 112_000, from: 'collector', to: 'editor', relation: 'handed off to' }])
  })

  it('ends a relay stage at its handoff even when its harness stayed alive', () => {
    const weft = weave(projection({ agents: [agent('collector', 0, 160), agent('editor', 112, 165)] }), order)
    expect(weft.lanes[0].end).toBe(112_000)
  })

  it('keeps a relay stage’s thread while the record shows it still working', () => {
    const asked = projection({ agents: [agent('collector', 0, 160), agent('editor', 112, 165)], evidence: [evidence('e1', 'collector', 4), evidence('e8', 'editor', 130, { kind: 'delegation', relation: 'asked', name: 'ask', target: 'collector' })] })
    expect(weave(asked, order).lanes[0].end).toBe(130_000)
  })

  it('names a skill by its folder', () => {
    const skill = projection({ evidence: [evidence('e7', 'editor', 150, { kind: 'skill', relation: 'used skill', name: 'Read /tmp/skills/newsletter-style/SKILL.md' })] })
    expect(weave(skill, order).stitches[0].sentence).toBe('News Editor used the skill “newsletter-style”.')
  })

  it('stitches each call with a sentence for people and a code for experts', () => {
    const [first, second] = weave(projection(), order).stitches
    expect(first.sentence).toBe('News Collector opened reuters.com.')
    expect(second).toMatchObject({ bad: true, code: 'file · read file · #2' })
    expect(second.sentence).toBe('News Editor couldn’t read SKILL.md.')
  })

  it('reads the moment under the playhead', () => {
    const weft = weave(projection(), order)
    expect(momentAt(weft, 2_000).sentence).toBe('News Collector is getting started.')
    expect(momentAt(weft, 120_000).sentence).toBe('News Collector handed the work to News Editor.')
    expect(momentAt(weft, 150_000)).toMatchObject({ evidenceId: 'e2', bad: true })
  })

  it('runs a live thread up to now', () => {
    const live = projection({ phase: 'running', agents: [agent('collector', 0, 30, { status: 'running' } as Partial<ProjectedAgent>)], evidence: [] })
    const weft = weave(live, order, T0 + 50_000)
    expect(weft.live).toBe(true)
    expect(weft.duration).toBe(50_000)
    expect(weft.lanes[0]).toMatchObject({ live: true, end: 50_000 })
    expect(weft.lanes[1].start).toBeNull()
  })
})

describe('describeEvidence', () => {
  it('says the operator answered, not that they "opened Your answer"', () => {
    expect(describeEvidence('You', { kind: 'source', relation: 'directed', name: 'Your answer', status: 'succeeded', target: null })).toBe('You answered.')
    expect(describeEvidence('Researcher', { kind: 'source', relation: 'consulted source', name: 'https://www.ft.com/x', status: 'succeeded', target: null })).toBe('Researcher opened ft.com.')
  })
})

describe('shortName and clock', () => {
  it('keeps the file name from a long command, the host from a URL, and drops a title verb', () => {
    expect(shortName("cat '/Users/me/teams/daily-news/notes.md'")).toBe('notes.md')
    expect(shortName('Fetch https://www.usnews.com/news/world/articles/2026-09-19/story')).toBe('usnews.com')
    expect(shortName('Read README.md')).toBe('README.md')
    expect(shortName('Search "AI chip export rules"')).toBe('AI chip export rules')
    expect(clock(112_400)).toBe('1:52')
  })
})

describe('buildReceipt', () => {
  const evidenceByAgent = new Map(Object.entries({ collector: [evidence('e1', 'collector', 4)], editor: [evidence('e2', 'editor', 140, { kind: 'file', relation: 'read file', name: '/x/SKILL.md', status: 'failed' })] }))
  const base = {
    attempt: 16, prompt: 'Monday edition', phase: 'succeeded' as const, elapsed: '2m 45s',
    agents: [{ id: 'collector', name: 'News Collector', operator: false }, { id: 'review', name: 'You', operator: true, runtime: { status: 'succeeded' as const } }, { id: 'editor', name: 'News Editor', operator: false }],
    evidenceByAgent, harnessLabels: new Map([['collector', 'Claude Code'], ['editor', 'Claude Code']]), answered: true,
  }

  it('lists who did what, then failures and what happened instead', () => {
    const receipt = buildReceipt({ ...base, projection: projection() })
    expect(receipt.heading).toBe('Run 16 · Finished')
    expect(receipt.team).toBe('2 helpers + your review')
    expect(receipt.ranOn).toBe('Claude Code')
    expect(receipt.lines.map((line) => [line.tone, line.text])).toEqual([
      ['ok', 'News Collector finished · read 1 web page'],
      ['ok', 'You gave your decision'],
      ['ok', 'News Editor finished'],
      ['bad', 'News Editor couldn’t read SKILL.md, and carried on without it'],
    ])
    expect(receipt.lines[3].evidenceId).toBe('e2')
  })

  // ADR 0037: a refused request says what the agent could not do, once per switch, and offers
  // the switch that would allow it next time.
  it('says what an agent was not allowed to do, and offers the switch that covers it', () => {
    const refused = (id: string, kind: string | null, name: string) => evidence(id, 'collector', 10, { kind: 'permission', relation: 'asked permission for', name, status: 'rejected', rawInput: kind ? { toolCall: { kind, title: name } } : {} })
    const byAgent = new Map(Object.entries({
      collector: [evidence('e1', 'collector', 4), refused('p1', 'fetch', 'Web search'), refused('p2', 'fetch', 'Fetch https://x.test'), refused('p3', 'fetch', 'Web search'), refused('p4', 'execute', 'Bash: ls'), refused('p5', null, 'Mystery tool')],
      editor: [],
    }))
    const lines = (allow?: { web?: boolean; edits?: boolean; commands?: boolean }) => buildReceipt({ ...base, agents: [{ id: 'collector', name: 'News Collector', operator: false, allow }], evidenceByAgent: byAgent, projection: projection() })
    const receipt = lines()
    expect(receipt.lines.map((line) => [line.text, line.allow ?? null, line.allowed ?? null])).toEqual([
      ['News Collector finished · read 1 web page', null, null],
      ['News Collector wasn’t allowed to search the web (asked 3 times), and carried on without it', 'web', false],
      ['News Collector wasn’t allowed to run commands, and carried on without it', 'commands', false],
      ['News Collector asked permission for “Mystery tool”, and it was refused, and carried on without it', null, null],
    ])
    expect(receipt.lines[1].evidenceId).toBe('p1')
    expect(receipt.checks.map((line) => line.text)).toContain('What an agent isn’t allowed to do waits for your answer during a run. Requests you denied, or that nobody answered in time, were declined. Change what each agent may do in its panel in Build.')

    // Switched on since: the same refusal now says so instead of offering the switch again.
    expect(lines({ web: true }).lines[1]).toMatchObject({ allow: 'web', allowed: true })
  })

  it('does not offer edits for a change outside the folder when edits are already on', () => {
    const outside = evidence('p1', 'collector', 10, { kind: 'permission', relation: 'asked permission for', name: 'Write /etc/hosts', status: 'rejected', rawInput: { toolCall: { kind: 'edit' } } })
    const receipt = buildReceipt({ ...base, agents: [{ id: 'collector', name: 'News Collector', operator: false, allow: { edits: true } }], evidenceByAgent: new Map([['collector', [outside]]]), projection: projection() })
    const line = receipt.lines.find((item) => item.evidenceId === 'p1')
    expect(line).toMatchObject({ text: 'News Collector wasn’t allowed to edit files outside its own folder, and carried on without it' })
    expect(line?.allow).toBeUndefined()
  })

  it('flags what is worth a second look, and never counts a supplied skill as used', () => {
    const editor = agent('editor', 112, 165, { openCalls: 1, requiredSkills: [{ name: 'newsletter-style', state: 'supplied' }] } as unknown as Partial<ProjectedAgent>)
    const receipt = buildReceipt({ ...base, answered: false, projection: projection({ agents: [agent('collector', 0, 110), editor], coverage: { ...projection().coverage, tools: { level: 'partial', reason: 'unpaired_calls', observed: 2 } } }) })
    expect(receipt.checks.map((line) => line.text)).toEqual([
      'News Editor was given the skill “newsletter-style” but the record never shows it opened',
      '1 call from News Editor never reported back',
      'The run ended without an answer',
      'Not everything was recorded: tools',
    ])
  })

  // Stopping a run while it waited for you used to print "Collector is still working" and
  // "Waiting for your decision" on the receipt of a run that was over.
  it('never says anyone is still working or waiting on a run you stopped', () => {
    const parked = projection({ phase: 'cancelled', agents: [agent('collector', 0, 110, { status: 'running' } as Partial<ProjectedAgent>)] })
    const receipt = buildReceipt({
      ...base, phase: 'cancelled', answered: false, projection: parked,
      agents: [
        // The card knows the collector handed over before it was parked; the projection does not.
        { id: 'collector', name: 'News Collector', operator: false, runtime: { status: 'succeeded' as const } },
        { id: 'review', name: 'You', operator: true, runtime: { status: 'waiting' as const } },
        { id: 'editor', name: 'News Editor', operator: false },
      ],
    })
    expect(receipt.heading).toBe('Run 16 · Stopped by you')
    expect(receipt.lines.map((line) => line.text)).toEqual([
      'News Collector finished · read 1 web page',
      'You stopped the run before giving your decision',
      'News Editor didn’t run',
    ])
    const stillWorking = buildReceipt({ ...base, phase: 'cancelled', projection: parked, agents: [{ id: 'collector', name: 'News Collector', operator: false }] })
    expect(stillWorking.lines[0].text).toBe('News Collector was stopped before it finished')
  })

  it('prints as Markdown', () => {
    const markdown = receiptMarkdown(buildReceipt({ ...base, projection: projection() }))
    expect(markdown).toContain('### Run 16 · Finished')
    expect(markdown).toContain('- ✗ News Editor couldn’t read SKILL.md, and carried on without it')
  })
})

describe('narrate', () => {
  it('tells the run as a short story, counted from what was recorded', () => {
    const beats = narrate(weave(projection(), order))
    expect(beats.map((beat) => beat.text)).toEqual([
      'News Collector worked for 2 minutes, and opened one web page.',
      'News Collector handed the work to News Editor.',
      'News Editor worked for 53 seconds.',
      'News Editor couldn’t read SKILL.md — the run carried on.',
      'The run ended after 3 minutes.',
    ])
    expect(beats[3]).toMatchObject({ bad: true, at: 140_000 })
  })

  // The story and the receipt tell one record, so they count and fail the same things
  // (lib/story/reads.ts). Only the stitch keeps the call itself, failed or not.
  const FOLDER = '/Users/Shared/harbor-pine/q3-reports'
  const SKILL = '/Users/me/LoomWatch/work/researcher/.claude/skills/house-style/SKILL.md'
  const researcher = [{ id: 'researcher', name: 'Researcher', operator: false }]
  const record = (calls: Evidence[]) => projection({ agents: [agent('researcher', 0, 40)], evidence: calls })
  const story = (calls: Evidence[]) => narrate(weave(record(calls), researcher))
  const readOf = (id: string, seconds: number, path: string, status = 'succeeded') =>
    evidence(id, 'researcher', seconds, { kind: 'file', relation: 'read file', name: `Read ${path}`, status, toolKind: 'read', rawInput: { file_path: path }, locations: [{ path, line: 1 }] } as Partial<Evidence>)
  // One skill: supplied in the prompt, read as its SKILL.md, and recorded by LoomWatch as opened.
  const skill = [
    evidence('s1', 'researcher', 1, { kind: 'skill', relation: 'loaded into prompt', name: 'house-style', toolKind: 'prompt', locations: [{ path: SKILL }] }),
    evidence('s2', 'researcher', 2, { kind: 'skill', relation: 'used skill', name: 'Read .claude/skills/house-style/SKILL.md', toolKind: 'read', rawInput: { file_path: SKILL }, locations: [{ path: SKILL, line: 1 }] }),
    evidence('s3', 'researcher', 3, { kind: 'skill', relation: 'opened by the agent', name: 'house-style', toolKind: 'read', locations: [{ path: SKILL }] }),
  ]

  it('does not tell a folder read as a file as a failure once the files in it were read', () => {
    const calls = [...skill, readOf('e4', 5, FOLDER, 'failed'), ...['README.md', 'q3-sales.md', 'q3-churn.md', 'q3-sales.md'].map((name, index) => readOf(`e${5 + index}`, 6 + index, `${FOLDER}/${name}`))]
    expect(story(calls).map((beat) => [beat.text, beat.bad])).toEqual([
      ['Researcher worked for 40 seconds: it used one skill and read 3 files.', false],
      ['The run ended after 40 seconds.', false],
    ])
    expect(weave(record(calls), researcher).stitches.find((stitch) => stitch.evidenceId === 'e4')).toMatchObject({ bad: true, sentence: 'Researcher couldn’t read q3-reports.' })
  })

  it('still tells a folder as a failure when nothing in it was read', () => {
    expect(story([...skill, readOf('e4', 5, FOLDER, 'failed')]).filter((beat) => beat.bad)).toEqual([{ at: 5_000, text: 'Researcher couldn’t read q3-reports — the run carried on.', bad: true }])
  })

  it('counts the failures nothing made up for, and refused requests', () => {
    const refused = evidence('e8', 'researcher', 9, { kind: 'permission', relation: 'asked permission for', name: 'Web search', status: 'rejected' })
    const calls = [readOf('e4', 5, FOLDER, 'failed'), readOf('e5', 6, `${FOLDER}/README.md`), readOf('e6', 8, `${FOLDER}/q3-sales.md`, 'failed'), refused]
    expect(story(calls).filter((beat) => beat.bad)).toEqual([{ at: 8_000, text: '2 of Researcher’s calls failed — first it couldn’t read q3-sales.md.', bad: true }])
  })

  it('says the name once when the first failure is told as the agent’s own', () => {
    const search = (id: string, seconds: number) => evidence(id, 'researcher', seconds, { kind: 'search', relation: 'searched', name: 'Web search: q3 churn', status: 'failed' })
    expect(story([search('e1', 4), search('e2', 6)]).filter((beat) => beat.bad).map((beat) => beat.text)).toEqual(['2 of Researcher’s calls failed — first its search for “q3 churn” failed.'])
  })

  it('counts each thing once, and nothing nobody read', () => {
    const page = { name: 'Fetch https://ft.com/q3', rawInput: { url: 'https://ft.com/q3' } }
    const brief = { kind: 'file', relation: 'edited file', name: 'Edit brief.md', locations: [{ path: '/w/brief.md' }] } as Partial<Evidence>
    const notion = { kind: 'tool', relation: 'invoked tool', name: 'mcp__notion__search' } as Partial<Evidence>
    const calls = [
      evidence('e1', 'researcher', 1, page), evidence('e2', 'researcher', 2, page),
      evidence('e3', 'researcher', 3, { relation: 'retrieved', name: 'Q2 decision', rawInput: { id: 'n1' } }),
      evidence('e4', 'researcher', 4, { relation: 'wrote to notebook · decision', name: 'Q3 decision' }),
      evidence('e5', 'researcher', 5, brief), evidence('e6', 'researcher', 6, brief),
      evidence('e7', 'researcher', 7, { kind: 'command', relation: 'ran command', name: 'npm test' }),
      evidence('e8', 'researcher', 8, notion), evidence('e9', 'researcher', 9, notion),
    ]
    expect(story(calls)[0].text).toBe('Researcher worked for 40 seconds: it opened one web page, retrieved one notebook entry, changed one file, ran one command and used one tool.')
  })

  it('says what a working helper has done so far', () => {
    const live = projection({ phase: 'running', agents: [agent('researcher', 0, 30, { status: 'running' } as Partial<ProjectedAgent>)], evidence: [evidence('e1', 'researcher', 4, { kind: 'search', relation: 'searched', name: 'Web search: q3 churn' })] })
    expect(narrate(weave(live, researcher, T0 + 50_000))[0].text).toBe('Researcher is working — so far it ran one search.')
  })
})

describe('knots from recorded delegations', () => {
  it('says what the call was, not just that work moved', () => {
    const asked = projection({ evidence: [evidence('e9', 'editor', 120, { kind: 'delegation', relation: 'asked', name: 'ask', target: 'collector' })] })
    const weft = weave(asked, order, Date.now(), false)
    expect(weft.knots).toEqual([{ at: 120_000, from: 'editor', to: 'collector', relation: 'asked' }])
    expect(weave(asked, order).knots.map((knot) => knot.relation)).toEqual(['handed off to', 'asked'])
    expect(momentAt(weft, 121_000).sentence).toBe('News Editor asked News Collector a question.')
    expect(narrate(weft).map((beat) => beat.text)).toContain('News Editor asked News Collector a question.')
  })
})

describe('the run view’s own status', () => {
  it('wins over the raw projection, so a parked stage does not read as still working', () => {
    const parked = projection({ phase: 'running', agents: [agent('collector', 0, 30, { status: 'running' } as Partial<ProjectedAgent>)] })
    const raw = weave(parked, order, T0 + 50_000)
    expect(raw.lanes[0]).toMatchObject({ live: true, status: 'running' })
    const shown = weave(parked, [{ ...order[0], status: 'succeeded' }, order[1]], T0 + 50_000)
    expect(shown.lanes[0]).toMatchObject({ live: false, status: 'succeeded' })
  })
})
