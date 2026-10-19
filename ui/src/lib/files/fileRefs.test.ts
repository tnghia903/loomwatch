import { describe, expect, it } from 'vitest'

import { fileLabel, fileNoun, filePathFrom, filePathFromLink, fileRefsIn, filesTouched, fileTitle, folderWords, formatBytes, withFolderPaths, workspaceAgent } from './fileRefs'

const REPORT = '/Users/me/loomwatch/teams/.loomwatch/launch-plan/writer/market-research-report.docx'

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

  it('finds the files a reply lists by name under the folder it names', () => {
    // The shape of a real Editor reply (run 6ca4befe): the folder once, then bare names.
    const outputs = '/Users/me/LoomWatch/teams/.loomwatch/loomwatch-marketing-plan/editor/outputs'
    const reply = [
      'The validator couldn’t run (missing `defusedxml`), so the DOCX hasn’t been checked.',
      `Files are in \`${outputs}\`:\n- \`LoomWatch-marketing-plan.docx\`\n- \`LoomWatch-marketing-plan.pdf\``,
    ].join('\n\n')
    expect(fileRefsIn(reply)).toEqual([`${outputs}/LoomWatch-marketing-plan.docx`, `${outputs}/LoomWatch-marketing-plan.pdf`])
  })

  it('resolves a name against the folder named in its own passage, before or after it', () => {
    expect(fileRefsIn('Saved `plan.pdf` and [the deck](deck.pptx) to `/Users/me/out/`.')).toEqual(['/Users/me/out/plan.pdf', '/Users/me/out/deck.pptx'])
    expect(fileRefsIn('In `/a/one`: `x.pdf`. In `/a/two`: `y.pdf` and `drafts/z.md`.')).toEqual(['/a/one/x.pdf', '/a/two/y.pdf', '/a/two/drafts/z.md'])
    // A loose list (blank lines between items) still belongs to the sentence that introduces it.
    expect(fileRefsIn('Written to `/a/out`:\n\n- `x.pdf`\n\n- `y.csv`')).toEqual(['/a/out/x.pdf', '/a/out/y.csv'])
    expect(fileRefsIn('Written to `C:\\Users\\me\\out`: `x.pdf`')).toEqual(['C:\\Users\\me\\out\\x.pdf'])
  })

  it('leaves names alone with no folder in their passage, or that are not files', () => {
    expect(fileRefsIn('I read `/Users/me/project`.\n\nThen I wrote `report.pdf`.')).toEqual([])
    expect(fileRefsIn('## Files\n\nNothing yet.\n\n## In `/a/out`\n\nSee `x.pdf`.')).toEqual([])
    expect(fileRefsIn('In `/a/out` run `python build.py`, see `example.com`, `v0.1.0`, `window.claude`, `.env`, `../x.pdf`, `~/x.pdf`.')).toEqual([])
    expect(fileRefsIn('In `/a/out`:\n\n```\nplan.pdf\n`inside.pdf`\n```')).toEqual([])
    expect(fileRefsIn('The route `/api/runs` is a folder, not a file.')).toEqual([])
  })

  it('resolves a name given from the agent’s own folder to the one file the run read or wrote', () => {
    const folder = '/Users/me/LoomWatch/teams/.loomwatch/bench-coby/coby'
    const guide = `${folder}/LLM Prefill Guide.html`
    const touched = [guide, `${folder}/research/notes.md`, '/a/one/README.md', '/a/two/README.md']
    // The shape of a real reply (run aace60a2): a relative link with %20s, then the bare name.
    const reply = '### [Open the guide](./LLM%20Prefill%20Guide.html)\n\nSee `research/notes.md` and `./notes.md`.\n\n**File:** `LLM Prefill Guide.html`'
    expect(fileRefsIn(reply, touched)).toEqual([`${folder}/research/notes.md`, guide])
    expect(withFolderPaths(reply, touched).split('\n')[0]).toBe(`### [Open the guide](${folder}/LLM%20Prefill%20Guide.html)`)
    // Two files end in the name, the agent never touched it, or it is not a file: left as written.
    expect(fileRefsIn('`README.md`, `report.pdf`, `tokenizer.decode()`, `../notes.md`, [site](https://x.com/notes.md)', touched)).toEqual([])
    // A folder named in the passage still comes first.
    expect(fileRefsIn('In `/b/out`: `notes.md`.', touched)).toEqual(['/b/out/notes.md'])
  })

  it('reads a link’s %20s as the spaces in a file’s name', () => {
    expect(filePathFromLink('/Users/me/My%20Report.pdf')).toBe('/Users/me/My Report.pdf')
    expect(filePathFromLink('file:///Users/me/My%20Report.pdf')).toBe('/Users/me/My Report.pdf')
    expect(filePathFromLink('/Users/me/100%.pdf')).toBe('/Users/me/100%.pdf')
    expect(filePathFromLink('./guide.html')).toBeNull()
  })

  it('collects the files a run read or wrote, once each', () => {
    expect(filesTouched([
      { locations: [{ path: '/a/guide.html' }, { path: '/a/research' }] },
      { locations: [{ path: '/a/guide.html' }, { path: 'relative.md' }] },
      {},
    ])).toEqual(['/a/guide.html'])
  })

  it('writes resolved names out as paths only where it resolved them', () => {
    const reply = 'Files are in `/a/out`:\n- `x.pdf`\n\n```\n`y.pdf`\n```\n\nAlso `z.pdf`.'
    expect(withFolderPaths(reply)).toBe('Files are in `/a/out`:\n- `/a/out/x.pdf`\n\n```\n`y.pdf`\n```\n\nAlso `z.pdf`.')
  })
})

describe('describing a file in words', () => {
  it('names the kind a person would use', () => {
    expect(fileLabel(REPORT)).toBe('Word document')
    expect(fileLabel('/x/a.PDF')).toBe('PDF')
    expect(fileLabel('/x/a.weird')).toBe('WEIRD file')
  })

  it('says where a managed workspace file sits as team › agent', () => {
    expect(folderWords('.loomwatch/launch-plan/writer', REPORT)).toBe('launch-plan › writer')
    expect(folderWords('reports/2026', '/teams/reports/2026/a.pdf')).toBe('reports › 2026')
  })

  it('reads a file name as a title, keeping capitals a person chose', () => {
    expect(fileTitle(REPORT)).toBe('Market research report')
    expect(fileTitle('/x/Q3_Board-Pack.pptx')).toBe('Q3 Board Pack')
    expect(fileNoun(REPORT)).toBe('document')
    expect(fileNoun('/x/a.xlsx')).toBe('spreadsheet')
    expect(fileNoun('/x/a.bin')).toBe('file')
  })

  it('credits a file in a managed workspace to its agent, and nothing else', () => {
    expect(workspaceAgent('.loomwatch/launch-plan/writer')).toEqual({ team: 'launch-plan', agent: 'writer' })
    expect(workspaceAgent('.loomwatch/launch-plan/writer/drafts')).toEqual({ team: 'launch-plan', agent: 'writer' })
    expect(workspaceAgent('reports/2026')).toBeNull()
    expect(workspaceAgent(null)).toBeNull()
  })

  it('formats sizes the way a file browser does', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(48 * 1024 * 1024)).toBe('48 MB')
  })
})
