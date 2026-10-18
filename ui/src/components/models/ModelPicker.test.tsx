import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { contextSize, price, shortName } from '../../lib/ai/client'
import { forgetModels } from '../../lib/ai/useModels'
import { ModelPicker } from './ModelPicker'

const opus = { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', contextLength: 1_000_000, inputPrice: 4, outputPrice: 20, free: false, reasoning: true, note: 'Best for hard work' }
const sonnet = { id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', contextLength: 1_000_000, inputPrice: 2, outputPrice: 10, free: false, reasoning: true, note: 'Strong and quicker' }
const haiku = { id: 'anthropic/claude-haiku-5.5', name: 'Anthropic: Claude Haiku 5.5', contextLength: 1_000_000, inputPrice: 0.1, outputPrice: 0.5, free: false, reasoning: true, note: 'Fast and very cheap' }
const gemma = { id: 'google/gemma-4-31b-it:free', name: 'Google: Gemma 4 31B (free)', contextLength: 262_144, inputPrice: 0, outputPrice: 0, free: true, reasoning: false }
const catalog = { fetchedAt: '2026-10-17T00:00:00Z', defaultModel: opus.id, recommended: [opus, haiku], models: [haiku, gemma, opus, sonnet] }

beforeEach(() => {
  forgetModels()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog), { headers: { 'Content-Type': 'application/json' } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ModelPicker', () => {
  it('shows the chosen model with its price, recommends a few, and searches the rest', async () => {
    const onChange = vi.fn()
    render(<ModelPicker value={opus.id} onChange={onChange} />)
    const current = await screen.findByRole('button', { name: /Claude Opus 5\.5/ })
    expect(current).toHaveTextContent('$4 / $20 per million tokens')
    fireEvent.click(current)
    const recommended = screen.getByRole('listbox', { name: 'Recommended models' })
    expect(recommended).toHaveTextContent('Best for hard work')
    expect(recommended).not.toHaveTextContent('Gemma')

    fireEvent.change(screen.getByLabelText('Search all 4 models'), { target: { value: 'free' } })
    fireEvent.click(screen.getByRole('option', { name: /Gemma 4 31B/ }))
    expect(onChange).toHaveBeenCalledWith('google/gemma-4-31b-it:free')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('lists the model suggested for the agent first, with why, and not again below', async () => {
    render(<ModelPicker value={opus.id} onChange={() => {}} suggestion={{ model: sonnet.id, why: 'It gathers facts for Writer to write up.' }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Claude Opus 5\.5/ }))
    const suggested = screen.getByRole('group', { name: 'Suggested for this agent' })
    expect(suggested).toHaveTextContent('Claude Sonnet 5.5')
    expect(suggested).toHaveTextContent('It gathers facts for Writer to write up.')
    expect(suggested).not.toHaveTextContent('Strong and quicker')
    const others = screen.getByRole('group', { name: 'Other good models' })
    expect(others).toHaveTextContent('Claude Opus 5.5')
    expect(others).not.toHaveTextContent('Sonnet')
  })

  it('leaves the suggestion out when the model list doesn’t have it', async () => {
    render(<ModelPicker value={opus.id} onChange={() => {}} suggestion={{ model: 'someone/gone-model', why: 'Gone.' }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Claude Opus 5\.5/ }))
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('starts on the chosen model, moves with the arrow keys, and picks with Enter, like the palette', async () => {
    const onChange = vi.fn()
    render(<ModelPicker value={haiku.id} onChange={onChange} />)
    const toggle = await screen.findByRole('button', { name: /Claude Haiku 5\.5/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const search = screen.getByRole('combobox', { name: 'Search all 4 models' })
    const [first, second] = screen.getAllByRole('option')
    expect(second).toHaveAttribute('aria-selected', 'true')
    expect(second).toHaveClass('active')
    expect(search).toHaveAttribute('aria-activedescendant', second.id)

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(first).toHaveClass('active')
    expect(second).not.toHaveClass('active')
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(opus.id)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes on Escape without choosing', async () => {
    const onChange = vi.fn()
    render(<ModelPicker value={opus.id} onChange={onChange} />)
    fireEvent.click(await screen.findByRole('button', { name: /Claude Opus 5\.5/ }))
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('marks every model with its maker’s logo and names the maker, with the chosen one ticked', async () => {
    render(<ModelPicker value={opus.id} onChange={() => {}} />)
    const current = await screen.findByRole('button', { name: /Claude Opus 5\.5/ })
    expect(current.querySelector('.maker-mark svg')).not.toBeNull()
    fireEvent.click(current)
    fireEvent.change(screen.getByLabelText('Search all 4 models'), { target: { value: 'gemma' } })
    const gemmaRow = screen.getByRole('option', { name: /Gemma 4 31B/ })
    expect(gemmaRow.querySelector('.maker-mark svg')).not.toBeNull()
    expect(gemmaRow).toHaveTextContent('Google · 262K context')
    expect(gemmaRow.querySelector('.model-row-tick')).toBeNull()
    fireEvent.change(screen.getByLabelText('Search all 4 models'), { target: { value: 'opus' } })
    expect(screen.getByRole('option', { name: /Claude Opus 5\.5/ }).querySelector('.model-row-tick')).not.toBeNull()
  })

  // A flex column squeezes its items to their min-height when it scrolls: the search results once
  // shrank to 34px, so a row's second line spilled out under the next and its highlight covered half.
  it('keeps every row its own height in a list that scrolls', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
    expect(css.match(/\n\.pop-row \{[^}]*\}/)?.[0]).toMatch(/flex-shrink:\s*0/)
  })

  it('says when a team names a model OpenRouter doesn’t list', async () => {
    render(<ModelPicker value="someone/gone-model" onChange={() => {}} />)
    expect(await screen.findByText('Not in OpenRouter’s list')).toBeInTheDocument()
  })
})

describe('model words', () => {
  it('reads prices, names and sizes the way a newcomer compares them', () => {
    expect(price(0)).toBe('Free')
    expect(price(0.1)).toBe('$0.10')
    expect(price(4)).toBe('$4')
    expect(price(2.5)).toBe('$2.50')
    expect(shortName(opus)).toBe('Claude Opus 5.5')
    expect(contextSize(1_000_000)).toBe('1M')
    expect(contextSize(262_144)).toBe('262K')
  })
})
