import { describe, expect, it } from 'vitest'

import { fileLabel, fileNoun, filePathFrom, fileRefsIn, fileTitle, folderWords, formatBytes, workspaceAgent } from './fileRefs'

const REPORT = '/Users/tnghia/Developer/loomwatch/teams/.loomwatch/sutd-final-project/writer/enterprise-knowledge-systems-design-report.docx'

describe('filePathFrom', () => {
  it('recognises an absolute path to a file, a Windows path, and a file:// URL', () => {
    expect(filePathFrom(REPORT)).toBe(REPORT)
    expect(filePathFrom(` ${REPORT} `)).toBe(REPORT)
    expect(filePathFrom('C:\\Users\\me\\out\\report.pdf')).toBe('C:\\Users\\me\\out\\report.pdf')
    expect(filePathFrom('file:///Users/me/My%20Report.pdf')).toBe('/Users/me/My Report.pdf')
  })

  it('leaves alone what is not a file: routes, folders, relative paths, dotfiles, prose, URLs', () => {
    for (const text of ['/api/runs', '/Users/me/out/', 'out/report.pdf', '/Users/me/.env', 'npm run build', 'https://example.com/a.pdf', '', null, undefined, '/a/b.pdf\n/c/d.pdf']) {
      expect(filePathFrom(text)).toBeNull()
    }
  })
})

describe('fileRefsIn', () => {
  it('finds each file a reply names once, in order, from code spans, links and file URLs', () => {
    const reply = [
      `**File:** \`${REPORT}\``,
      'Slides: [deck](/Users/me/out/deck.pptx) and again `/Users/me/out/deck.pptx`.',
      'Raw: file:///Users/me/out/data.csv',
      'Not files: `/api/runs`, `npm test`, [site](https://example.com)',
    ].join('\n\n')
    expect(fileRefsIn(reply)).toEqual([REPORT, '/Users/me/out/deck.pptx', '/Users/me/out/data.csv'])
  })
})

describe('describing a file in words', () => {
  it('names the kind a person would use', () => {
    expect(fileLabel(REPORT)).toBe('Word document')
    expect(fileLabel('/x/a.PDF')).toBe('PDF')
    expect(fileLabel('/x/a.weird')).toBe('WEIRD file')
  })

  it('says where a managed workspace file sits as team › agent', () => {
    expect(folderWords('.loomwatch/sutd-final-project/writer', REPORT)).toBe('sutd-final-project › writer')
    expect(folderWords('reports/2026', '/teams/reports/2026/a.pdf')).toBe('reports › 2026')
  })

  it('reads a file name as a title, keeping capitals a person chose', () => {
    expect(fileTitle(REPORT)).toBe('Enterprise knowledge systems design report')
    expect(fileTitle('/x/Q3_Board-Pack.pptx')).toBe('Q3 Board Pack')
    expect(fileNoun(REPORT)).toBe('document')
    expect(fileNoun('/x/a.xlsx')).toBe('spreadsheet')
    expect(fileNoun('/x/a.bin')).toBe('file')
  })

  it('credits a file in a managed workspace to its agent, and nothing else', () => {
    expect(workspaceAgent('.loomwatch/sutd-final-project/writer')).toEqual({ team: 'sutd-final-project', agent: 'writer' })
    expect(workspaceAgent('.loomwatch/sutd-final-project/writer/drafts')).toEqual({ team: 'sutd-final-project', agent: 'writer' })
    expect(workspaceAgent('reports/2026')).toBeNull()
    expect(workspaceAgent(null)).toBeNull()
  })

  it('formats sizes the way a file browser does', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(48 * 1024 * 1024)).toBe('48 MB')
  })
})
