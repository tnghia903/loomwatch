import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Spool } from './Spool'
import type { SpendStop } from '../../lib/runs/client'

afterEach(cleanup)
const name = (id: string) => ({ r: 'Researcher', w: 'Writer' })[id] ?? id
const hue = (id: string) => (id === 'r' ? 3 : 5)

describe('the spool (ADR 0068)', () => {
  it('unwinds as the run spends, each agent’s thread in its colour, beside the figure', () => {
    const { container } = render(<Spool spend={{ limitUsd: 1, spentUsd: 0.75, agents: { r: { spentUsd: 0.5 }, w: { spentUsd: 0.25 } } }} name={name} hue={hue} />)
    expect(screen.getByRole('img', { name: 'Spent $0.75 of $1.00: Researcher $0.50, Writer $0.25' })).toBeInTheDocument()
    expect(screen.getByText('$0.75 of $1.00')).toBeInTheDocument()
    const threads = [...container.querySelectorAll<HTMLElement>('.tc-spool-track i')]
    expect(threads.map((thread) => [thread.className, thread.style.width])).toEqual([['hue-3', '50%'], ['hue-5', '25%']])
    // What is left on the bobbin: a quarter of the limit.
    expect(container.querySelector<SVGRectElement>('.tc-spool-wound')?.style.transform).toBe('scaleY(0.25)')
    expect(container.querySelector('.tc-spool')).not.toHaveClass('full')
  })

  it('turns gold, empty, once the run has used its limit', () => {
    const { container } = render(<Spool spend={{ limitUsd: 1, spentUsd: 1.03, agents: { r: { spentUsd: 1.03 } } }} name={name} hue={hue} />)
    expect(container.querySelector('.tc-spool')).toHaveClass('full')
    expect(container.querySelector<SVGRectElement>('.tc-spool-wound')?.style.transform).toBe('scaleY(0)')
  })

  it('stays off a run’s line until the run nears its limit, so money is not a meter on every message', () => {
    for (const spentUsd of [0.12, 0.74]) {
      const { container } = render(<Spool spend={{ limitUsd: 1, spentUsd, agents: { r: { spentUsd } } }} name={name} hue={hue} />)
      expect(container).toBeEmptyDOMElement()
      cleanup()
    }
    render(<Spool spend={{ limitUsd: 1, spentUsd: 0.75, agents: { r: { spentUsd: 0.75 } } }} name={name} hue={hue} />)
    expect(screen.getByText('$0.75 of $1.00')).toBeInTheDocument()
    cleanup()
    // A run with no limit has nothing to near: its line never shows money.
    const { container } = render(<Spool spend={{ spentUsd: 5, agents: { r: { spentUsd: 5 } } }} name={name} hue={hue} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows once the run met a limit: waiting at one, money added, or stopped there', () => {
    const low = { limitUsd: 1, spentUsd: 0.12, agents: { r: { spentUsd: 0.12 } } }
    const guard: SpendStop = { id: 's', agent: 'r', name: 'Researcher', limitUsd: 0.1, spentUsd: 0.12, addUsd: 0.1, since: '' }
    const met = [
      { spend: low, stops: [guard] },
      { spend: { ...low, limitUsd: 1.5, added: [{ atUsd: 1, addUsd: 0.5 }] } },
      { spend: { ...low, stopped: 'finished' as const } },
      { spend: { ...low, agents: { r: { spentUsd: 0.12, limitUsd: 0.1, stopped: true } } } },
    ]
    for (const { spend, stops } of met) {
      const { container } = render(<Spool spend={spend} stops={stops} name={name} hue={hue} />)
      expect(container.querySelector('.tc-spool')).not.toBeNull()
      cleanup()
    }
    // With no team limit, an agent waiting at its own guard still shows the figure, with no bobbin.
    const { container } = render(<Spool spend={{ spentUsd: 0.2, agents: { r: { spentUsd: 0.2 } } }} stops={[guard]} name={name} hue={hue} />)
    expect(screen.getByText('$0.20')).toBeInTheDocument()
    expect(container.querySelector('.tc-spool-bobbin')).toBeNull()
  })

  it('shows nothing with no record of spend', () => {
    const { container } = render(<Spool spend={undefined} name={name} hue={hue} />)
    expect(container).toBeEmptyDOMElement()
  })
})
