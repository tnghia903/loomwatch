import { describe, expect, it } from 'vitest'

import { afterClosing, closedKey, fileTab, madeTabs, paneTabId, shownPaneTab } from './paneTabs'

const file = (path: string, runId = 'run-2') => ({ path, runId, from: 'writer' })
const made = (path: string, lead = true) => ({ file: file(path), label: path.split('/').pop() ?? path, kind: 'markdown', lead })
const answer = (title: string) => ({ by: 'writer', name: 'Writer', title })
const NONE = new Set<string>()

describe('madeTabs', () => {
  // The owner: "there is no way to tell what is the artifact, what is the long message". The answer
  // is named by who gave it, as the chat names a message, never by a title that reads as a file's.
  it('lists the long answer first, by who gave it, then the files, each said in full on hover', () => {
    const tabs = madeTabs({ runId: 'run-2', files: [made('/a/report.html'), made('/a/data.csv')], answer: answer('Market brief'), kept: null, closed: NONE })
    expect(tabs.map((tab) => [tab.tab, tab.label, tab.hint, tab.by])).toEqual([
      ['answer', 'Writer', 'Market brief', 'writer'],
      ['file:/a/report.html', 'report.html', '/a/report.html', undefined],
      ['file:/a/data.csv', 'data.csv', '/a/data.csv', undefined],
    ])
    const team = madeTabs({ runId: 'run-2', files: [], answer: { by: null, name: 'The team', title: 'Brief' }, kept: null, closed: NONE })
    expect(team.map((tab) => [tab.label, 'by' in tab])).toEqual([['The team', false]])
  })

  it('leaves out what you closed on that work only', () => {
    const closed = new Set([closedKey('run-2', fileTab('/a/report.html')), closedKey('run-2', 'answer')])
    const files = [made('/a/report.html'), made('/a/data.csv')]
    expect(madeTabs({ runId: 'run-2', files, answer: answer('Brief'), kept: null, closed }).map((tab) => tab.tab)).toEqual(['file:/a/data.csv'])
    expect(madeTabs({ runId: 'run-3', files, answer: answer('Brief'), kept: null, closed }).map((tab) => tab.tab)).toEqual(['answer', 'file:/a/report.html', 'file:/a/data.csv'])
  })

  it('keeps a file from other work last, once, and marks it kept', () => {
    const kept = { file: file('/b/notes.md', 'run-1'), label: 'notes.md' }
    const tabs = madeTabs({ runId: 'run-2', files: [made('/a/report.html')], answer: null, kept, closed: NONE })
    expect(tabs.map((tab) => [tab.tab, Boolean(tab.kept)])).toEqual([['file:/a/report.html', false], ['file:/b/notes.md', true]])
    const same = madeTabs({ runId: 'run-2', files: [made('/b/notes.md')], answer: null, kept, closed: NONE })
    expect(same.map((tab) => [tab.tab, Boolean(tab.kept)])).toEqual([['file:/b/notes.md', false]])
  })
})

describe('shownPaneTab', () => {
  const tabs = madeTabs({ runId: 'run-2', files: [made('/a/make_chart.py', false), made('/a/report.html')], answer: answer('Brief'), kept: { file: file('/b/notes.md', 'run-1'), label: 'notes.md' }, closed: NONE })

  it('shows the tab you chose while it is there', () => {
    expect(shownPaneTab('answer', tabs, true, true)).toBe('answer')
    expect(shownPaneTab('details', tabs, true, true)).toBe('details')
    expect(shownPaneTab(fileTab('/gone.md'), tabs, false, true)).toBe('details')
  })

  it('following work done well, opens what it came to: a file it made before the answer about it; never code, a file it only named, or one kept from other work', () => {
    expect(tabs[0].tab).toBe('answer')
    expect(shownPaneTab(null, tabs, true, true)).toBe('file:/a/report.html')
    expect(shownPaneTab(null, tabs.filter((tab) => tab.tab !== 'file:/a/report.html'), true, true)).toBe('answer')
    expect(shownPaneTab(null, [tabs[1], tabs[3]], true, true)).toBe('details')
    expect(shownPaneTab(null, tabs, true, false)).toBe('details')
    expect(shownPaneTab(null, tabs, false, true)).toBe('details')
  })
})

describe('afterClosing', () => {
  const tabs = madeTabs({ runId: 'run-2', files: [made('/a/one.md'), made('/a/two.md')], answer: answer('Brief'), kept: null, closed: NONE })

  it('moves to the tab after the one closed, else the one before, else Details', () => {
    expect(afterClosing(tabs, 'file:/a/one.md')).toBe('file:/a/two.md')
    expect(afterClosing(tabs, 'answer')).toBe('file:/a/one.md')
    expect(afterClosing(tabs, 'file:/a/two.md')).toBe('file:/a/one.md')
    expect(afterClosing(tabs.slice(0, 1), 'answer')).toBe('details')
    expect(afterClosing(tabs, 'file:/gone.md')).toBe('details')
  })
})

describe('paneTabId', () => {
  it('names a tab by its place, as a path can hold spaces', () => {
    const tabs = madeTabs({ runId: 'run-2', files: [made('/a/Transformers in Recommenders.html')], answer: null, kept: null, closed: NONE })
    expect(paneTabId(tabs, fileTab('/a/Transformers in Recommenders.html'))).toBe('tc-pane-made-0')
    expect(paneTabId(tabs, 'details')).toBe('tc-pane-details')
  })
})
