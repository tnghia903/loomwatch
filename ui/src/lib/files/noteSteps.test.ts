import { describe, expect, it } from 'vitest'

import { noteSteps, wordsOf, type SlidePart } from './noteSteps'

const p = (words: string) => `<p style="text-align:left;">${words}</p>`
const blank = '<p style="text-align:left;"></p>'
const said = (note: string, parts: SlidePart[] = []) => noteSteps(note, parts).map((step) => ({ words: wordsOf(step.html), parts: step.parts }))

// A slide of a diagram in two lanes, as an agent's deck has it.
const lanes: SlidePart[] = [
  { key: '0', text: 'Architecture: batch flow and query flow' },
  { key: '1', text: 'Batch (offline)' },
  { key: '2', text: 'Query (online)' },
  { key: '3', text: 'Snapshot export (code built)' },
  { key: '4', text: 'Parse and quality review' },
  { key: '5', text: 'Team sign-in' },
  { key: '6', text: 'Hybrid retrieval and rerank' },
  { key: '7', text: 'Evidence store: ADLS originals, PostgreSQL with pgvector, BM25 index' },
  { key: '8', text: 'All company data and model calls stay inside the project’s Azure resource group.' },
]

describe('speaker notes walked a step at a time', () => {
  it('takes the paragraphs between empty lines as a step each, as a speaker spaces them', () => {
    const steps = said([p('Walk the diagram left to right.'), blank, p('Batch first.'), p('- one'), p('- two'), blank, blank, p('Then the query.')].join(''))
    expect(steps.map((step) => step.words)).toEqual(['Walk the diagram left to right.', 'Batch first. - one - two', 'Then the query.'])
  })

  it('takes each paragraph as a step in notes with no empty line, a line ending in a colon kept with the next', () => {
    const steps = said([p('Limitations (state plainly):'), p('- No results yet.'), p('- Stubs only.')].join(''))
    expect(steps.map((step) => step.words)).toEqual(['Limitations (state plainly): - No results yet.', '- Stubs only.'])
    expect(said('')).toEqual([])
    expect(said(blank + blank)).toEqual([])
    // Words outside any paragraph are a step too.
    expect(said('Just words')).toEqual([{ words: 'Just words', parts: [] }])
  })

  it('ties a step to the parts whose own words it says, and nothing to a step that says no part clearly', () => {
    const steps = said([
      p('Walk the diagram left to right, top lane then bottom lane.'),
      blank,
      p('Batch (offline): the approved scope is exported as a dated snapshot. Documents are parsed; quality checks run first.'),
      blank,
      p('Query (online): team sign-in, then hybrid retrieval with a bounded rerank.'),
    ].join(''), lanes)
    expect(steps.map((step) => step.parts)).toEqual([[], ['1', '3', '4'], ['2', '5', '6']])
  })

  it('needs more than one shared word, unless it is the only part with that word and the part is short', () => {
    // "Azure" alone is a long part's one word in common; "pgvector" alone is one word of a part of eight.
    expect(said(p('We stay on Azure, and pgvector does the work.'), lanes)[0]!.parts).toEqual([])
    const short: SlidePart[] = [{ key: '0', text: 'Revenue' }, { key: '1', text: 'Costs and margins by region' }]
    expect(said(p('Revenue grew in the spring.'), short)[0]!.parts).toEqual(['0'])
    // One word two parts have doesn't say which of them.
    const shared: SlidePart[] = [{ key: '0', text: 'Revenue' }, { key: '1', text: 'Revenue by region' }, { key: '2', text: 'Costs' }]
    expect(said(p('Revenue rose.'), shared)[0]!.parts).toEqual([])
  })

  it('makes a step for each line of a list that walks a table row by row, each tied to its row', () => {
    const table: SlidePart[] = ['Data boundary: company data stays in Azure', 'Frozen snapshot: one approved read-only export', 'Cost control: a monthly budget with an alert']
      .map((text, at) => ({ key: `2r${at + 1}`, text, table: { key: '2', along: 'row' as const } }))
    const steps = said([p('Each row is a requirement.'), blank, p('1. Data boundary: data only in Azure.'), p('2. Frozen snapshot: one read-only export.'), p('3. Cost: the monthly budget and its alert.')].join(''), table)
    expect(steps).toEqual([
      { words: 'Each row is a requirement.', parts: [] },
      { words: '1. Data boundary: data only in Azure.', parts: ['2r1'] },
      { words: '2. Frozen snapshot: one read-only export.', parts: ['2r2'] },
      { words: '3. Cost: the monthly budget and its alert.', parts: ['2r3'] },
    ])
    // A list whose lines are all about one part stays one step.
    const one = said([p('Limits:'), p('- No measured results.'), p('- Pipeline stubs only.'), blank, p('Then close.')].join(''), [{ key: '0', text: 'No measured results. Pipeline stubs only.' }, { key: '1', text: 'Next steps' }])
    expect(one).toEqual([{ words: 'Limits: - No measured results. - Pipeline stubs only.', parts: ['0'] }, { words: 'Then close.', parts: [] }])
  })

  it('ties a step that says both rows and columns of a table to the ones it says most of', () => {
    const grid: SlidePart[] = [
      { key: '3r1', text: 'Complexity Medium High', table: { key: '3', along: 'row' } },
      { key: '3r2', text: 'Strength Controlled tests, traceable failures Adaptive evidence', table: { key: '3', along: 'row' } },
      { key: '3c1', text: 'Lean shared pipeline (chosen) Medium Controlled tests, traceable failures', table: { key: '3', along: 'column' } },
      { key: '3c2', text: 'Full hierarchy and agents High Adaptive evidence', table: { key: '3', along: 'column' } },
    ]
    expect(said(p('A. Lean shared pipeline (chosen): medium complexity. Pros: controlled tests, traceable failures.'), grid)[0]!.parts).toEqual(['3c1'])
  })

  it('ties a step about most of the slide to none of it', () => {
    const three: SlidePart[] = [{ key: '0', text: 'Batch lane' }, { key: '1', text: 'Query lane' }, { key: '2', text: 'Store lane' }, { key: '3', text: 'Footer note' }]
    expect(said(p('Each lane: the batch lane, the query lane and the store lane.'), three)[0]!.parts).toEqual([])
  })

  it('reads no file path or link as words about the slide', () => {
    const parts: SlidePart[] = [{ key: '0', text: 'Design overview' }, { key: '1', text: 'Snapshot export' }]
    expect(said(p('Sources: /Users/someone/project/design/overview.md and https://example.com/design/overview'), parts)[0]!.parts).toEqual([])
  })
})
