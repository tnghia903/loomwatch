import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'

import { applyEdits, blockChange, blockShape, sourceSpans } from './markdownEdits'

/** `source` drawn as the reader draws it to be typed into. */
function drawn(source: string): HTMLElement {
  const page = document.createElement('div')
  page.innerHTML = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[sourceSpans(source)]} skipHtml>{source}</ReactMarkdown>)
  return page
}

/** Type into the block `selector` finds with `change`, then leave it: the file's text after. */
function typed(source: string, selector: string, change: (block: HTMLElement) => void): string {
  const block = drawn(source).querySelector<HTMLElement>(selector)
  if (!block) throw new Error(`no ${selector}`)
  const before = blockShape(block)
  change(block)
  const edits = blockChange(block, before, source)
  return edits ? applyEdits(source, edits) : source
}

/** Replace words in the run of words that holds them. */
const say = (words: string, instead: string) => (block: HTMLElement) => {
  const run = [...block.querySelectorAll('[data-lw-src]')].find((each) => each.textContent?.includes(words))
  if (!run) throw new Error(`no run with ${words}`)
  run.textContent = (run.textContent ?? '').replace(words, instead)
}

const REPORT = '# Market\n\nSales grew **fast** in May, said [the survey](https://example.com/s).\n\n- One shop\n- Two shops\n\n```\nconst may = 1\n```\n'

describe('changing a Markdown file where it is drawn (ADR 0107)', () => {
  it('puts a changed word back in its own place, every other character as it was', () => {
    expect(typed(REPORT, 'p', say('in May', 'in June'))).toBe(REPORT.replace('in May', 'in June'))
    expect(typed(REPORT, 'p', say('fast', 'quickly'))).toBe(REPORT.replace('**fast**', '**quickly**'))
    expect(typed(REPORT, 'p', say('the survey', 'our survey'))).toBe(REPORT.replace('[the survey]', '[our survey]'))
    expect(typed(REPORT, 'h1', say('Market', 'Markets'))).toBe(REPORT.replace('# Market', '# Markets'))
    expect(typed(REPORT, 'li:nth-child(2)', say('Two', 'Three'))).toBe(REPORT.replace('- Two shops', '- Three shops'))
  })

  it('keeps marks someone types as words', () => {
    expect(typed(REPORT, 'p', say('in May', 'in May *and* June_2'))).toBe(REPORT.replace('in May', 'in May \\*and\\* June\\_2'))
  })

  it('writes the no-break spaces a browser types as spaces, unless the words had their own', () => {
    // WebKit's, after the bold words are deleted; Chromium's, for a space typed at the end.
    expect(typed(REPORT, 'p', (block) => { block.querySelector('strong')?.remove(); const after = block.querySelectorAll('[data-lw-src]')[1]; after.textContent = after.textContent!.replace(/^ /, '\u00a0') }))
      .toBe(REPORT.replace('Sales grew **fast** in May,', 'Sales grew  in May,'))
    expect(typed(REPORT, 'li:first-child', say('One shop', 'One shop\u00a0'))).toBe(REPORT.replace('- One shop', '- One shop '))
    const spaced = 'Pay 10\u00a0kg now.\n'
    expect(typed(spaced, 'p', say('now', 'today'))).toBe('Pay 10\u00a0kg today.\n')
  })

  it('changes nothing when the words are as they were', () => {
    const block = drawn(REPORT).querySelector('p')
    if (!block) throw new Error('no paragraph')
    expect(blockChange(block, blockShape(block), REPORT)).toBeNull()
  })

  it('writes a block out again as Markdown when its shape changed, keeping its markers and its marks', () => {
    // The bold words deleted whole, as a browser removes an emptied element.
    const after = typed(REPORT, 'p', (block) => block.querySelector('strong')?.remove())
    expect(after).toBe(REPORT.replace('Sales grew **fast** in May, said [the survey](https://example.com/s).', 'Sales grew  in May, said [the survey](https://example.com/s).'))
    // Words typed between two runs, in a list item: its "- " stays.
    const listed = typed(REPORT, 'li:first-child', (block) => block.append(' near the station'))
    expect(listed).toBe(REPORT.replace('- One shop', '- One shop near the station'))
  })

  it('reaches a paragraph across two lines of the file, and a list item that is a paragraph', () => {
    const source = 'Sales grew\nin May.\n\n- First\n\n  Second line of it\n'
    expect(typed(source, 'p', say('in May', 'in June'))).toBe('Sales grew\nin June.\n\n- First\n\n  Second line of it\n')
    expect(typed(source, 'li p', say('First', 'Last'))).toBe(source.replace('- First', '- Last'))
  })

  it('leaves code as it is, and gives a list item holding a list no place to type', () => {
    const page = drawn(REPORT)
    expect(page.querySelector('pre [data-lw-src]')).toBeNull()
    expect(page.querySelector('pre')?.hasAttribute('data-lw-block')).toBe(false)
    const nested = drawn('- Shops\n  - One\n')
    expect(nested.querySelector('li')?.hasAttribute('data-lw-block')).toBe(false)
    expect(nested.querySelector('li li')?.getAttribute('data-lw-block')).toMatch(/^\d+-\d+$/)
  })
})
