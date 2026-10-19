import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetKeyStatus } from '../../lib/ai/useKeyStatus'
import { forgetModels } from '../../lib/ai/useModels'
import { EffortSlider } from './EffortSlider'

const status = {
  openrouter: { connected: true },
  anthropic: { connected: true, models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextLength: 1_000_000, maxOutput: 128_000, adaptiveThinking: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }] },
  chatgpt: {
    available: true, connected: true, planUse: true,
    models: [
      { slug: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', contextLength: 500_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { slug: 'gpt-6-luna', name: 'GPT-6-Luna', contextLength: 272_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ],
  },
}
const listing = (id: string, name: string, outputPrice: number) => ({ id, name, contextLength: 1, inputPrice: 0, outputPrice, free: false, reasoning: true })
const catalog = {
  fetchedAt: '', defaultModel: 'anthropic/claude-opus-5.5', recommended: [], models: [listing('anthropic/claude-opus-5.5', 'Anthropic: Claude Opus 5.5', 20)],
  anthropic: [listing('anthropic:claude-opus-5-5', 'Claude Opus 5.5', 20)],
  chatgpt: [listing('chatgpt:gpt-6.1-sol', 'GPT-6.1-Sol', 0), listing('chatgpt:gpt-6-luna', 'GPT-6-Luna', 0)],
}

beforeEach(() => {
  forgetModels()
  forgetKeyStatus()
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(path === '/api/ai' ? status : catalog), { headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const scale = () => [...document.querySelectorAll('.thinking-scale > span')].map((stop) => stop.textContent)
// Each meter: its label, how many pips, and how many are lit.
const meters = () => [...document.querySelectorAll('.thinking-meter')].map((meter) => [meter.firstChild?.textContent, meter.querySelectorAll('i').length, meter.querySelectorAll('i.on').length])

describe('the effort slider follows the model', () => {
  it('has every effort the ChatGPT plan lists for the model, up to Ultra', async () => {
    const onChange = vi.fn()
    render(<EffortSlider model="chatgpt:gpt-6.1-sol" value="medium" onChange={onChange} />)
    await waitFor(() => expect(scale()).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max', 'Ultra']))
    const slider = screen.getByRole('slider', { name: 'Thinking effort' })
    expect(slider).toHaveAttribute('max', '6')
    fireEvent.change(slider, { target: { value: '6' } })
    expect(onChange).toHaveBeenCalledWith('ultra')
    expect(screen.getByText('Thinking uses your ChatGPT plan’s allowance, not money: more effort uses more of it.')).toBeInTheDocument()
  })

  it('stops at Max on a model without Ultra, and says where Ultra runs', async () => {
    render(<EffortSlider model="chatgpt:gpt-6-luna" value="ultra" onChange={() => {}} />)
    await waitFor(() => expect(scale()).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max']))
    const slider = screen.getByRole('slider', { name: 'Thinking effort' })
    expect(slider).toHaveValue('5')
    expect(slider).toHaveAttribute('aria-valuetext', 'Max')
    expect(slider).toHaveAccessibleDescription('This model doesn’t offer Ultra, so it thinks at Max.')
  })

  it('has Extra high and Max for a Claude model, priced from the Claude credit', async () => {
    const onChange = vi.fn()
    render(<EffortSlider model="anthropic:claude-opus-5-5" value="xhigh" onChange={onChange} />)
    await waitFor(() => expect(scale()).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max']))
    const slider = screen.getByRole('slider', { name: 'Thinking effort' })
    expect(slider).toHaveAttribute('aria-valuetext', 'Extra high')
    expect(slider).toHaveAccessibleDescription(/extra long think: slower than high, and it costs more/)
    expect(screen.getByText('Thinking is paid for like writing: $20 per million tokens on Claude Opus 5.5, from your Claude API credit.')).toBeInTheDocument()
    fireEvent.change(slider, { target: { value: '3' } })
    expect(onChange).toHaveBeenCalledWith('high')
  })

  it('doesn’t call High the slowest when the model thinks longer', async () => {
    render(<EffortSlider model="anthropic:claude-opus-5-5" value="high" onChange={() => {}} />)
    await waitFor(() => expect(scale()).toHaveLength(6))
    expect(screen.getByRole('slider', { name: 'Thinking effort' })).toHaveAccessibleDescription(/A long think: slower, and it costs more/)
  })

  it('measures speed and plan use against the model’s own stops, in plan words', async () => {
    render(<EffortSlider model="chatgpt:gpt-6.1-sol" value="xhigh" onChange={() => {}} />)
    await waitFor(() => expect(scale()).toHaveLength(7))
    expect(meters()).toEqual([['Speed', 6, 3], ['Plan use', 6, 4]])
    expect(screen.getByRole('slider', { name: 'Thinking effort' })).toHaveAccessibleDescription(/slower than high, and it uses more of your plan/)
    cleanup()
    render(<EffortSlider model="chatgpt:gpt-6-luna" value="medium" onChange={() => {}} />)
    await waitFor(() => expect(scale()).toHaveLength(6))
    expect(screen.getByRole('slider', { name: 'Thinking effort' })).toHaveAccessibleDescription(/middle speed and share of your plan/)
    cleanup()
    render(<EffortSlider model="chatgpt:gpt-6.1-sol" value="ultra" onChange={() => {}} />)
    await waitFor(() => expect(scale()).toHaveLength(7))
    expect(screen.getByRole('slider', { name: 'Thinking effort' })).toHaveAccessibleDescription('The longest think this model has: the slowest, and it uses the most of your plan. It often overthinks, so keep it for the very hardest work.')
  })

  it('names Ultra as Max on OpenRouter, which has no Ultra', async () => {
    render(<EffortSlider model="anthropic/claude-opus-5.5" value="ultra" onChange={() => {}} />)
    await waitFor(() => expect(screen.getByText(/\$20 per million tokens/)).toBeInTheDocument())
    expect(screen.getByRole('slider', { name: 'Thinking effort' })).toHaveAttribute('aria-valuetext', 'Max')
  })

  it('keeps low, medium and high for an OpenRouter model', async () => {
    render(<EffortSlider model="anthropic/claude-opus-5.5" value="max" onChange={() => {}} />)
    await waitFor(() => expect(screen.getByText(/\$20 per million tokens/)).toBeInTheDocument())
    expect(scale()).toEqual(['Default', 'Low', 'Medium', 'High'])
    expect(screen.getByRole('slider', { name: 'Thinking effort' })).toHaveAccessibleDescription('Max is beyond what most work needs, and it costs the most.')
  })
})
