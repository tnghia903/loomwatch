import { describe, expect, it } from 'vitest'

import { proposalChanges } from './proposal'

const spawn = '{ cmd: claude-agent-acp, args: [], env: {}, cwd: "." }'
const agent = (id: string, name: string, role: string, model = 'sonnet') => `  - id: ${id}\n    name: ${name}\n    role: ${role}\n    spawn: ${spawn}\n    model: ${model}\n`
const edge = (from: string, to: string) => `  - { from: ${from}, to: ${to}, layer: configured, kind: sequence, ts: "2026-10-02T00:00:00Z" }\n`
const team = (agents: string, edges: string, extra = '') => `schemaVersion: 1\nid: brief\nname: Brief\nentrypoint: collector\n${extra}agents:\n${agents}edges:\n${edges}`

const BEFORE = team(
  agent('collector', 'Collector', 'Collect the news.') + agent('writer', 'Writer', 'Write the brief.') + agent('old', 'Old step', 'Unused.'),
  edge('collector', 'writer') + edge('writer', 'old'),
)

describe('proposalChanges', () => {
  it('describes a new team as its steps in run order, review steps included', () => {
    const proposed = team(
      agent('collector', 'Collector', 'Collect.') + '  - id: review\n    kind: operator\n    name: You\n    role: Approve?\n' + agent('writer', 'Writer', 'Write.'),
      edge('collector', 'review') + edge('review', 'writer'),
    )
    const changes = proposalChanges(null, proposed)
    expect(changes.lines).toEqual(['3 steps: Collector → You (review) → Writer'])
    expect(changes.added).toEqual(['collector', 'review', 'writer'])
  })

  it('names who joins, whose job changes and who leaves', () => {
    const proposed = team(
      agent('collector', 'Collector', 'Collect the news.') + agent('editor', 'Editor', 'Tighten it.') + agent('writer', 'Writer', 'Write five bullets.', 'opus'),
      edge('collector', 'editor') + edge('editor', 'writer'),
    )
    const changes = proposalChanges(BEFORE, proposed)
    expect(changes.added).toEqual(['editor'])
    expect(changes.changed).toEqual(['writer'])
    expect(changes.removed).toEqual(['Old step'])
    expect(changes.lines).toEqual(['Adds Editor', 'Changes Writer’s job and model', 'Removes Old step'])
  })

  it('says when the team starts running on its own', () => {
    const proposed = team(
      agent('collector', 'Collector', 'Collect the news.') + agent('writer', 'Writer', 'Write the brief.') + agent('old', 'Old step', 'Unused.'),
      edge('collector', 'writer') + edge('writer', 'old'),
      'schedule:\n  cron: "0 8 * * 1-5"\n  prompt: Today\n',
    )
    expect(proposalChanges(BEFORE, proposed).lines).toEqual([expect.stringMatching(/^Runs on its own: weekdays at 8/)])
  })

  it('names the skills an agent is given or loses, whatever their case, and a new team’s skills', () => {
    const skill = (...names: string[]) => `    capabilities:\n${names.map((name) => `      - { kind: skill, name: ${name} }\n`).join('')}`
    const before = team(
      agent('collector', 'Collector', 'Collect the news.') + skill('report-design') + agent('writer', 'Writer', 'Write the brief.') + skill('house-style'),
      edge('collector', 'writer'),
    )
    const proposed = team(
      agent('collector', 'Collector', 'Collect the news.') + skill('Report-Design') + agent('writer', 'Writer', 'Write the brief.') + skill('explain-like-im-5', 'plain-words'),
      edge('collector', 'writer'),
    )
    const changes = proposalChanges(before, proposed)
    expect(changes.changed).toEqual(['writer'])
    expect(changes.lines).toEqual(['Gives Writer the skills explain-like-im-5 and plain-words', 'Disconnects the skill house-style from Writer'])
    expect(proposalChanges(null, proposed).lines).toEqual([
      '2 steps: Collector → Writer',
      'Gives Collector the skill Report-Design',
      'Gives Writer the skills explain-like-im-5 and plain-words',
    ])
  })

  it('still says something when the change is only in the file', () => {
    expect(proposalChanges(BEFORE, `${BEFORE}# a note\n`).lines).toEqual(['Small changes to the team file'])
  })

  it('orders a team with no connections by its first agent, and says who leads it', () => {
    const proposed = 'schemaVersion: 1\nid: solo\nname: Solo\nentrypoint: b\nagents:\n' + agent('a', 'A', 'x') + agent('b', 'B', 'y') + agent('c', 'C', 'z') + 'edges: []\n'
    const changes = proposalChanges(null, proposed)
    expect(changes.order).toEqual(['B', 'A', 'C'])
    expect(changes.lines).toEqual(['Led by B, with A and C'])
    const alone = 'schemaVersion: 1\nid: solo\nname: Solo\nentrypoint: a\nagents:\n' + agent('a', 'A', 'x') + 'edges: []\n'
    expect(proposalChanges(null, alone).lines).toEqual(['1 step: A'])
  })

  it('names an agent from My agents by its name there, and says which folders, files and tools each is given (ADR 0096)', () => {
    const given = (...items: string[]) => `    capabilities:\n${items.map((item) => `      - ${item}\n`).join('')}`
    const proposed = team(
      '  - id: collector\n    from: { agent: researcher }\n' + given("{ kind: knowledge, name: Client notes, path: '/Users/me/Client notes' }")
        + agent('writer', 'Writer', 'Write.') + given('{ kind: tool, name: Gmail }', '{ kind: tool, name: Linear }', '{ kind: knowledge, name: Q3.pdf, path: /Users/me/Q3.pdf }'),
      edge('collector', 'writer'),
    )
    const named = proposalChanges(null, proposed, { collector: 'Researcher', writer: 'Writer' })
    expect(named.lines).toEqual([
      '2 steps: Researcher → Writer',
      'Gives Researcher Client notes to read',
      'Gives Writer the tools Gmail and Linear',
      'Gives Writer Q3.pdf to read',
    ])
    expect(proposalChanges(null, proposed).order, 'without names, its id').toEqual(['collector', 'Writer'])

    const changed = proposedWithout(proposed)
    const changes = proposalChanges(proposed, changed, { collector: 'Researcher' })
    expect(changes.changed).toEqual(['collector', 'writer'])
    expect(changes.lines).toEqual(['Disconnects Client notes from Researcher', 'Disconnects the tool Linear from Writer'])
  })
})

/** `yaml` with the Client notes and Linear lines taken out. */
function proposedWithout(yaml: string): string {
  return yaml.split('\n').filter((line) => !line.includes('Client notes') && !line.includes('Linear')).join('\n').replace('  - id: collector\n    from: { agent: researcher }\n    capabilities:\n', '  - id: collector\n    from: { agent: researcher }\n')
}
