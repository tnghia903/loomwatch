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

  it('orders a team with no connections by its first agent', () => {
    const proposed = 'schemaVersion: 1\nid: solo\nname: Solo\nentrypoint: b\nagents:\n' + agent('a', 'A', 'x') + agent('b', 'B', 'y') + 'edges: []\n'
    expect(proposalChanges(null, proposed).order).toEqual(['B', 'A'])
  })
})
