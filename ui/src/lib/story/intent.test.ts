import { describe, expect, it } from 'vitest'

import { matchTeam, parseIntent } from './intent'

describe('parseIntent', () => {
  it.each([
    ['add a reviewer', { kind: 'add', job: 'reviewer' }, false],
    ['/add writer', { kind: 'add', job: 'writer' }, true],
    ['hire an editor', { kind: 'add', job: 'editor' }, false],
    ['I need a developer', { kind: 'add', job: 'coder' }, false],
    ['add designers', { kind: 'add', job: 'designer' }, false],
    ['let me approve', { kind: 'review-step' }, false],
    ['add a review step', { kind: 'review-step' }, false],
    ['zoom out', { kind: 'depth', depth: 'story' }, false],
    ['show me the details', { kind: 'depth', depth: 'trace' }, false],
    ['/depth team', { kind: 'depth', depth: 'team' }, true],
    ['Looks good!', { kind: 'approve' }, false],
    ['/approve', { kind: 'approve' }, true],
    ['open the daily news team', { kind: 'open', query: 'daily news' }, false],
    ['/run write a blog post about loom weaving', { kind: 'run', request: 'write a blog post about loom weaving' }, true],
    ['ask the team to summarise this week', { kind: 'run', request: 'summarise this week' }, false],
  ])('understands “%s”', (input, intent, exact) => {
    expect(parseIntent(input)).toEqual({ intent, exact })
  })

  it('does not guess at what it does not know', () => {
    expect(parseIntent('add a unicorn')).toBeNull()
    expect(parseIntent('make it better')).toBeNull()
    expect(parseIntent('   ')).toBeNull()
  })
})

describe('matchTeam', () => {
  const teams = [{ name: 'Daily AI, tech & business news', path: 'daily-news.yaml' }, { name: 'Research and review', path: 'research-team.yaml' }]
  it('finds a team by the words in its name or file', () => {
    expect(matchTeam('daily news', teams)?.path).toBe('daily-news.yaml')
    expect(matchTeam('research', teams)?.path).toBe('research-team.yaml')
    expect(matchTeam('payroll', teams)).toBeNull()
  })
})
