import { describe, expect, it } from 'vitest'

import { briefFileNameFor } from './client'

describe('briefFileNameFor', () => {
  it('files a note in the team’s own Brief folder, named from its first line', () => {
    expect(briefFileNameFor('# House constraints\nWe ship on ACP v1 only.', [], 'research-team.brief')).toBe('research-team.brief/house-constraints.md')
  })

  // Two teams kept in one folder used to write both of their "Style guide" notes to
  // brief/style-guide.md, so the second silently replaced the first team's Brief.
  it('keeps two teams’ notes with the same first line apart', () => {
    const a = briefFileNameFor('Style guide', [], 'trip-planner.brief')
    const b = briefFileNameFor('Style guide', [], 'blog-writer.brief')
    expect(a).not.toBe(b)
  })

  it('cuts a long first line at a word, not halfway through one', () => {
    const file = briefFileNameFor('Budget is under $2000. We prefer trains over flights.', [], 'trip.brief')
    expect(file).toBe('trip.brief/budget-is-under-2000-we-prefer-trains-over.md')
  })

  it('never reuses a path the team already names', () => {
    expect(briefFileNameFor('Tone', ['brief/tone.md'])).toBe('brief/tone-2.md')
  })
})
