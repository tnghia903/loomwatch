import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetModels } from '../../lib/ai/useModels'
import { BLANK_DRAFT, type AgentDraft } from '../../lib/library/draft'
import { ByHand } from './ByHand'

// The bench's 3D figure is beside the point here.
vi.mock('./AgentFigure', () => ({ default: () => null }))

const model = (id: string, name: string, reasoning = true) => ({ id, name, contextLength: 200_000, inputPrice: 2, outputPrice: 10, free: false, reasoning })
const opus = model('anthropic/claude-opus-5.5', 'Anthropic: Claude Opus 5.5')
const plain = model('acme/plain-1', 'Acme: Plain 1', false)
const catalog = { fetchedAt: '2026-10-17T00:00:00Z', defaultModel: opus.id, recommended: [opus], models: [opus, plain] }

beforeEach(() => {
  forgetModels()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(catalog), { headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderByHand(draft: Partial<AgentDraft>) {
  const set = vi.fn()
  render(<ByHand draft={{ ...BLANK_DRAFT, ...draft }} set={set} skills={[]} skillsLoading={false} roleField={createRef()} figure={{ kind: 'yarn', color: 'sage' }} record={null} />)
  return set
}

describe('By hand: its model and how hard it thinks', () => {
  it('names the model it thinks with, and changes it from OpenRouter’s list', async () => {
    const set = renderByHand({})
    fireEvent.click(await screen.findByRole('button', { name: /Claude Opus 5\.5/ }))
    fireEvent.click(screen.getByRole('option', { name: /Claude Opus 5\.5/ }))
    expect(set).toHaveBeenCalledWith('model', opus.id)
  })

  it('runs at the model’s own default until an effort is chosen, and goes up to high', () => {
    const set = renderByHand({ effort: '' })
    const slider = screen.getByRole('slider', { name: 'Thinking effort' })
    expect(slider).toHaveAttribute('aria-valuetext', 'Model default')
    fireEvent.change(slider, { target: { value: '3' } })
    expect(set).toHaveBeenCalledWith('effort', 'high')
  })

  it('takes the effort out at the default', () => {
    const set = renderByHand({ effort: 'medium' })
    fireEvent.change(screen.getByRole('slider', { name: 'Thinking effort' }), { target: { value: '0' } })
    expect(set).toHaveBeenCalledWith('effort', '')
  })

  it('offers no effort on a model that doesn’t reason separately', async () => {
    renderByHand({ model: plain.id })
    expect(await screen.findByText('This model doesn’t reason separately, so it has no effort setting.')).toBeInTheDocument()
    expect(screen.queryByRole('slider', { name: 'Thinking effort' })).not.toBeInTheDocument()
  })
})
