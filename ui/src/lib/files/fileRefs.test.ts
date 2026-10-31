import { describe, expect, it } from 'vitest'

import { fileKindIn, fileLabel, fileNoun, filePathFrom, filePathFromLink, fileRefsIn, filesTouched, filesWritten, fileTitle, folderWords, formatBytes, withFolderPaths, workspaceAgent } from './fileRefs'

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

  it('finds a file the agent made with a command, from a link, under the folder it works in', () => {
    const folder = '/Users/me/LoomWatch/teams/.loomwatch/bench-coby/coby'
    // `cat > "LLM Prefill Guide.html"` leaves no path behind: nothing was touched by name.
    const reply = '### [Open the guide](./LLM%20Prefill%20Guide.html)\n\nAlso [the plan](drafts/plan.md).'
    expect(fileRefsIn(reply, [], folder)).toEqual([`${folder}/LLM Prefill Guide.html`, `${folder}/drafts/plan.md`])
    expect(withFolderPaths(reply, [], folder).split('\n')[0]).toBe(`### [Open the guide](${folder}/LLM%20Prefill%20Guide.html)`)
    // A file the run did touch says where it is, wherever the answering agent works.
    expect(fileRefsIn('[notes](./notes.md)', ['/a/helper/notes.md'], folder)).toEqual(['/a/helper/notes.md'])
    // On Windows, with Windows separators.
    expect(fileRefsIn('[plan](./drafts/plan.md)', [], 'C:\\Users\\ana\\work')).toEqual(['C:\\Users\\ana\\work\\drafts\\plan.md'])
  })

  it('takes only a link from the agent’s folder: never code, and nothing that leaves it or is not a file', () => {
    const folder = '/teams/.loomwatch/news/writer'
    // A name in code may be a file the agent ran or quoted, not one it made: it still needs a touched file.
    expect(fileRefsIn('**File:** `guide.html`, run `build.sh`', [], folder)).toEqual([])
    expect(withFolderPaths('**File:** `guide.html`', [], folder)).toBe('**File:** `guide.html`')
    expect(fileRefsIn([
      '[up](../secret.md)', '[encoded up](%2E%2E/secret.md)', '[hidden](./.cache/page.html)', '[site](www.example.com)',
      '[part](./guide.html#intro)', '[query](./guide.html?v=2)', '[web](https://x.com/a.html)', '[mail](mailto:a@b.co)',
      '[top](#summary)', '[no kind](./build)',
    ].join(' '), [], folder)).toEqual([])
    // A folder that is not a full path says nothing.
    expect(fileRefsIn('[guide](./guide.html)', [], 'writer')).toEqual([])
  })

  it('finds a file the run wrote where the reply names it in plain words, by name or by path', () => {
    const design = '/Users/me/sutd-final-project/design'
    const written = [`${design}/solution-design.md`, `${design}/architecture.html`, '/Users/me/My Files/LLM Prefill Guide.html']
    // The shape of a real Designer reply (run a75f05b4): no code, no links, only words.
    const reply = `Files are in ${design}:\n- solution-design.md\n- architecture.html`
    expect(fileRefsIn(reply, written, null, written)).toEqual([`${design}/solution-design.md`, `${design}/architecture.html`])
    expect(withFolderPaths(reply, written, null, written)).toBe(`Files are in ${design}:\n- \`${design}/solution-design.md\`\n- \`${design}/architecture.html\``)
    // From its folder, by its full path at the end of a sentence, in bold, in brackets, with spaces.
    expect(fileRefsIn('See design/architecture.html.', written, null, written)).toEqual([`${design}/architecture.html`])
    expect(fileRefsIn(`Saved to ${design}/solution-design.md, as asked.`, written, null, written)).toEqual([`${design}/solution-design.md`])
    expect(fileRefsIn('**architecture.html** (the diagram)', written, null, written)).toEqual([`${design}/architecture.html`])
    expect(fileRefsIn('The guide (LLM Prefill Guide.html) is done.', written, null, written)).toEqual(['/Users/me/My Files/LLM Prefill Guide.html'])
    expect(withFolderPaths('Open /Users/me/My Files/LLM Prefill Guide.html to read it.', written, null, written)).toBe('Open `/Users/me/My Files/LLM Prefill Guide.html` to read it.')
    // On Windows, either way round its separators go, in any case.
    const plan = 'C:\\Users\\ana\\work\\plan.md'
    expect(withFolderPaths('Wrote plan.md and c:/users/ana/work/plan.md.', [plan], null, [plan])).toBe(`Wrote \`${plan}\` and \`${plan}\`.`)
    // A path a code span cannot hold stays words.
    expect(withFolderPaths('See /a/x`y.md.', [], null, ['/a/x`y.md'])).toBe('See /a/x`y.md.')
  })

  it('finds a file an agent made in its own folder where the reply gives its full path in plain words', () => {
    const maker = '/Users/me/LoomWatch/teams/.loomwatch/slide-deck-prep-team/presentation-maker'
    const deck = `${maker}/EKIS_Presentation_2026-11-05.pptx`
    // The shape of a real Presentation maker reply (run 5d07bc73): `python make_deck.py` made the
    // deck, so the only file the run wrote by name is the script.
    const script = [`${maker}/build/make_deck.py`]
    const reply = `The deck is ready, unchanged since last round:\n**${deck}**\n\nIts notes cite the files in \`/Users/me/sutd-final-project/\`.`
    expect(fileRefsIn(reply, script, maker, script)).toEqual([deck])
    expect(withFolderPaths(reply, script, maker, script).split('\n')[1]).toBe(`**\`${deck}\`**`)
    // Whoever answers: the checker names the maker's deck, at the end of a sentence, or in brackets.
    expect(fileRefsIn(`Checked ${deck}.`, [], '/Users/me/LoomWatch/teams/.loomwatch/slide-deck-prep-team/checker')).toEqual([deck])
    expect(fileRefsIn(`The deck (${deck}) has 13 slides.`)).toEqual([deck])
    // In a folder of its own there, and on Windows.
    expect(fileRefsIn(`Saved ${maker}/out/notes.md, as asked.`)).toEqual([`${maker}/out/notes.md`])
    const plan = 'C:\\Users\\ana\\LoomWatch\\teams\\.loomwatch\\launch\\writer\\plan.docx'
    expect(fileRefsIn(`Done: ${plan}`)).toEqual([plan])
    // An agent in no team works in `.loomwatch/<agent>`.
    expect(fileRefsIn('See /Users/me/teams/.loomwatch/writer/notes.md.')).toEqual(['/Users/me/teams/.loomwatch/writer/notes.md'])
  })

  it('finds a full path with spaces when the reply sets it off in bold or quotes', () => {
    const deck = '/Users/John Smith/LoomWatch/teams/.loomwatch/review/maker/Q3 Report.pptx'
    expect(fileRefsIn(`The deck is ready: **${deck}**`)).toEqual([deck])
    expect(withFolderPaths(`Saved “${deck}” for you.`)).toBe(`Saved “\`${deck}\`” for you.`)
    const plan = 'C:\\Users\\John Smith\\LoomWatch\\teams\\.loomwatch\\launch\\writer\\Launch plan.docx'
    expect(fileRefsIn(`Done: "${plan}"`)).toEqual([plan])
    // In running words, where it ends would be a guess; and the marks around it must match.
    expect(fileRefsIn(`The deck is ready: ${deck} for Thursday`)).toEqual([])
    expect(fileRefsIn(`**${deck}" and more`)).toEqual([])
  })

  it('leaves a full path in plain words alone outside an agent’s own folder, or not something it made', () => {
    const maker = '/teams/.loomwatch/news/writer'
    // Read from the person's own folders, or no file at all.
    expect(fileRefsIn('Read /Users/me/brief/budget.md and /Users/me/sutd/report.docx first.', [], maker)).toEqual([])
    expect(fileRefsIn(`See ${maker}/build and ${maker}/draft.`, [], maker)).toEqual([])
    // LoomWatch's own files there: hidden folders, the copies of what it was given, its notes file.
    expect(fileRefsIn(`${maker}/.agents/skills/deck/SKILL.md ${maker}/knowledge/brief.md ${maker}/AGENTS.md`, [], maker)).toEqual([])
    // LoomWatch's folder itself holds no agent's work.
    expect(fileRefsIn('See /teams/.loomwatch/notes.md.', [], maker)).toEqual([])
    // A kind of file the reader doesn't name, a path that climbs out, inside a word or an address.
    expect(fileRefsIn(`Ran ${maker}/build/make_deck.py and ${maker}/../../secret.md.`, [], maker)).toEqual([])
    expect(fileRefsIn(`~${maker}/a.md x${maker}/b.md https://example.com${maker}/c.html`, [], maker)).toEqual([])
    // Code and fenced blocks stay as they are.
    const kept = `\`\`\`\n${maker}/deck.pptx\n\`\`\``
    expect(withFolderPaths(kept, [], maker)).toBe(kept)
  })

  it('leaves plain words alone unless they name just one file the run wrote', () => {
    const written = ['/a/design/architecture.html', '/a/one/README.md', '/a/two/README.md']
    const read = ['/a/brief/budget.md', ...written]
    // Read, not written; two written files of that name; a name inside another word or address.
    expect(fileRefsIn('From budget.md. See README.md.', read, null, written)).toEqual([])
    expect(fileRefsIn('old-architecture.html, my_architecture.html, architecture.html.bak, architecture.htmlx', read, null, written)).toEqual([])
    expect(fileRefsIn('https://example.com/architecture.html and www.example.com/architecture.html', read, null, written)).toEqual([])
    expect(fileRefsIn('/b/design/architecture.html, ../design/architecture.html, ~/architecture.html', read, null, written)).toEqual([])
    // A link's words, and fenced code, stay as written.
    const kept = '[architecture.html](https://example.com/page)\n\n```\narchitecture.html\n```'
    expect(withFolderPaths(kept, read, null, written)).toBe(kept)
    // Without the run's files, words are words.
    expect(fileRefsIn('See architecture.html.', read)).toEqual([])
    // Its full path picks one of two files of the same name.
    expect(fileRefsIn('See /a/two/README.md.', read, null, written)).toEqual(['/a/two/README.md'])
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

  it('collects the files a run wrote: not those it read, nor writes refused or failed', () => {
    expect(filesWritten([
      { toolKind: 'edit', status: 'succeeded', locations: [{ path: '/a/page.html' }] },
      { toolKind: 'read', status: 'succeeded', locations: [{ path: '/a/input.md' }] },
      { toolKind: 'edit', status: 'failed', locations: [{ path: '/a/broken.md' }] },
      { toolKind: 'edit', status: 'succeeded', declined: 'denied', locations: [{ path: '/a/denied.md' }] },
    ])).toEqual(['/a/page.html'])
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
    expect(fileLabel('/x/a.docm')).toBe('Word document')
    expect(fileLabel('/x/a.pptm')).toBe('Slides')
  })

  it('names the kind inside a sentence, keeping the names of apps and letters', () => {
    expect(fileKindIn(REPORT, 'a')).toBe('a Word document')
    expect(fileKindIn(REPORT, 'the')).toBe('the Word document')
    expect(fileKindIn('/x/a.pdf', 'a')).toBe('a PDF')
    expect(fileKindIn('/x/a.png', 'a')).toBe('an image')
    expect(fileKindIn('/x/deck.pptx', 'a')).toBe('slides')
    expect(fileKindIn('/x/deck.pptx', 'the')).toBe('the slides')
    expect(fileKindIn('/x/a.odt', 'a')).toBe('a document')
    expect(fileKindIn('/x/a.weird', 'a')).toBe('a WEIRD file')
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
