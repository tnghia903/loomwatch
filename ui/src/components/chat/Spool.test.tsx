import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Spool } from './Spool'

afterEach(cleanup)
const name = (id: string) => ({ r: 'Researcher', w: 'Writer' })[id] ?? id
const hue = (id: string) => (id === 'r' ? 3 : 5)

describe('the spool (ADR 0068)', () => {
  it('unwinds as the run spends, each agent’s thread in its colour, beside the figure', () => {
    const { container } = render(<Spool spend={{ limitUsd: 1, spentUsd: 0.12, agents: { r: { spentUsd: 0.08 }, w: { spentUsd: 0.04 } } }} name={name} hue={hue} />)
    expect(screen.getByRole('img', { name: 'Spent $0.12 of $1.00: Researcher $0.08, Writer $0.04' })).toBeInTheDocument()
    expect(screen.getByText('$0.12 of $1.00')).toBeInTheDocument()
    const threads = [...container.querySelectorAll<HTMLElement>('.tc-spool-track i')]
    expect(threads.map((thread) => [thread.className, thread.style.width])).toEqual([['hue-3', '8%'], ['hue-5', '4%']])
    // What is left on the bobbin: 88% of the limit.
    expect(container.querySelector<SVGRectElement>('.tc-spool-wound')?.style.transform).toBe('scaleY(0.88)')
    expect(container.querySelector('.tc-spool')).not.toHaveClass('full')
  })

  it('turns gold, empty, once the run has used its limit', () => {
    const { container } = render(<Spool spend={{ limitUsd: 1, spentUsd: 1.03, agents: { r: { spentUsd: 1.03 } } }} name={name} hue={hue} />)
    expect(container.querySelector('.tc-spool')).toHaveClass('full')
    expect(container.querySelector<SVGRectElement>('.tc-spool-wound')?.style.transform).toBe('scaleY(0)')
  })

  it('has no bobbin with no limit, and nothing at all with no record of spend', () => {
    const { container, rerender } = render(<Spool spend={{ spentUsd: 0.2, agents: { r: { spentUsd: 0.2 } } }} name={name} hue={hue} />)
    expect(screen.getByText('$0.20')).toBeInTheDocument()
    expect(container.querySelector('.tc-spool-bobbin')).toBeNull()
    rerender(<Spool spend={undefined} name={name} hue={hue} />)
    expect(container).toBeEmptyDOMElement()
  })
})
