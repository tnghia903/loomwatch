import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { renderToString } from 'katex'
import { afterEach, describe, expect, it } from 'vitest'

import { withMathMarks } from '../../lib/chat/mathMarks'
import MarkdownRenderer from './MarkdownRenderer'

afterEach(cleanup)

// What kind of atom a box is (ordinary, binary, relation, …), which KaTeX's stylesheet leaves alone.
const ATOM_KINDS = ['mord', 'mop', 'mbin', 'mrel', 'mopen', 'mclose', 'mpunct', 'minner', 'mtight', 'text']
const SAMPLE = '\\left(1+\\frac{r}{n}\\right)^{nt} + \\sqrt{x} + \\rlap{a} + {\\large b} + \\hat{x} + \\sum_{i=1}^n x_i'

describe('math in an answer', () => {
  // A ChatGPT plan's first answer showed "[ A=P\left(1+\frac{r}{n}\right)^{nt} ]" as typed.
  it('typesets \\[…\\] as a block and \\(…\\) in the line', () => {
    const { container } = render(<MarkdownRenderer>{'The formula:\n\n\\[ A=P\\left(1+\\frac{r}{n}\\right)^{nt} \\]\n\nwhere \\(r\\) is the rate.'}</MarkdownRenderer>)
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1)
    expect(container.querySelectorAll('.katex')).toHaveLength(2)
    expect(container.querySelector('.katex-html')).not.toHaveTextContent('\\frac')
  })

  // katex 0.18 renamed boxes (base → katex-base); its stylesheet beside 0.16's drawing left them unstyled.
  it('lays out every box it draws with the stylesheet the app loads', () => {
    const css = readFileSync(resolve(process.cwd(), 'node_modules/katex/dist/katex.min.css'), 'utf8')
    expect(css).toContain('.katex')
    const { container } = render(<MarkdownRenderer>{`\\[ ${SAMPLE} \\]`}</MarkdownRenderer>)
    const names = new Set([...container.querySelectorAll('.katex-html, .katex-html *')].flatMap((box) => [...box.classList]))
    expect(names.size).toBeGreaterThan(20)
    expect([...names].filter((name) => !ATOM_KINDS.includes(name) && !new RegExp(`\\.${name}(?![\\w-])`).test(css))).toEqual([])
  })

  // A fraction's parts lost their height and place, and its line its width.
  it('keeps the size and place KaTeX gives each box', () => {
    const { container } = render(<MarkdownRenderer>{`\\[ ${SAMPLE} \\]`}</MarkdownRenderer>)
    const drawn = document.createElement('div')
    drawn.innerHTML = renderToString(SAMPLE, { displayMode: true, throwOnError: false, strict: 'ignore' })
    const styles = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.katex-html [style]')].map((box) => `${box.className} {${box.style.cssText}}`)
    expect(styles(drawn).length).toBeGreaterThan(20)
    expect(styles(container)).toEqual(styles(drawn))
  })

  it('typesets $$…$$ and leaves a price alone', () => {
    const { container } = render(<MarkdownRenderer>{'Put $1,000 in at 5% and get $50.\n\n$$\nA = P(1+r)^t\n$$'}</MarkdownRenderer>)
    expect(container.querySelectorAll('.katex')).toHaveLength(1)
    expect(container).toHaveTextContent('Put $1,000 in at 5% and get $50.')
  })

  it('leaves code and an escaped bracket with no math in it as they are', () => {
    expect(withMathMarks('`\\(x+1\\)` and \\[Sourced\\]')).toBe('`\\(x+1\\)` and \\[Sourced\\]')
    expect(withMathMarks('```\n\\[ a=b \\]\n```')).toBe('```\n\\[ a=b \\]\n```')
  })

  it('shows a table with its rows', () => {
    const { container } = render(<MarkdownRenderer>{'| Year | Balance |\n| ---: | ---: |\n| 1 | $1,050.00 |\n| 2 | $1,102.50 |'}</MarkdownRenderer>)
    expect(container.querySelectorAll('table tbody tr')).toHaveLength(2)
    expect(container.querySelector('td')).toHaveStyle({ textAlign: 'right' })
  })
})
