import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { withMathMarks } from '../../lib/chat/mathMarks'
import MarkdownRenderer from './MarkdownRenderer'

afterEach(cleanup)

describe('math in an answer', () => {
  // A ChatGPT plan's first answer showed "[ A=P\left(1+\frac{r}{n}\right)^{nt} ]" as typed.
  it('typesets \\[…\\] as a block and \\(…\\) in the line', () => {
    const { container } = render(<MarkdownRenderer>{'The formula:\n\n\\[ A=P\\left(1+\\frac{r}{n}\\right)^{nt} \\]\n\nwhere \\(r\\) is the rate.'}</MarkdownRenderer>)
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1)
    expect(container.querySelectorAll('.katex')).toHaveLength(2)
    expect(container.querySelector('.katex-html')).not.toHaveTextContent('\\frac')
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
