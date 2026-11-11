import { cleanup, render, screen } from '@testing-library/react'
import { createRef, useEffect, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetModels } from '../../lib/ai/useModels'
import { BLANK_DRAFT } from '../../lib/library/draft'
import { ByHand } from './ByHand'

// The bench's 3D figure, counted each time it is set up: setting it up again is drawing the scene
// from nothing.
const setUps = vi.hoisted(() => ({ count: 0 }))
vi.mock('./AgentFigure', () => ({
  default: function Figure() {
    useEffect(() => { setUps.count += 1 }, [])
    return <canvas data-testid="bench" />
  },
}))

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const catalog = { fetchedAt: '2026-11-06T00:00:00Z', defaultModel: 'anthropic/claude-opus-5.5', recommended: [], models: [] }

beforeEach(() => {
  setUps.count = 0
  forgetModels()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input) === '/api/skills' ? json({ folder: '/skills', skills: [] }) : json(catalog))))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Bench({ chat, cover }: { chat?: ReactNode; cover?: ReactNode }) {
  return <ByHand draft={{ ...BLANK_DRAFT, name: 'Coby', instructions: 'Answer questions.' }} set={() => {}} skills={[]} skillsLoading={false} roleField={createRef()} figure={{ kind: 'tall', color: 'clay' }} record={null} chat={chat} cover={cover} />
}

/** Whether `first` comes before `then` in the page, as it is read and tabbed through. */
const before = (first: Element, then: Element) => Boolean(first.compareDocumentPosition(then) & Node.DOCUMENT_POSITION_FOLLOWING)

describe('an agent’s page, laid out as a team’s chat', () => {
  it('has its settings, or its chat, on the left and the bench on the right, the same bench in both tabs', async () => {
    const { container, rerender } = render(<Bench />)
    const bench = await screen.findByTestId('bench')
    const stage = container.querySelector('.byhand-stage')!
    const blocks = container.querySelector('.byhand-blocks')!
    expect(before(blocks, stage)).toBe(true)
    // What its settings add up to heads the settings, so it never pushes the bench down in Build alone.
    expect(blocks.contains(container.querySelector('.byhand-say'))).toBe(true)

    rerender(<Bench chat={<p>The chat</p>} />)
    const chat = container.querySelector('.byhand-chat')!
    expect(chat).toHaveTextContent('The chat')
    expect(before(chat, stage)).toBe(true)
    expect(container.querySelector('.byhand-stage')).toBe(stage)

    // An answer, its Details or a file opens on the right, over the bench, as a team's Details does.
    rerender(<Bench chat={<p>The chat</p>} cover={<p>The answer</p>} />)
    expect(stage.contains(screen.getByText('The answer'))).toBe(true)
    expect(before(chat, screen.getByText('The answer'))).toBe(true)

    rerender(<Bench />)
    expect(screen.getByTestId('bench')).toBe(bench)
    expect(setUps.count).toBe(1)
  })
})
