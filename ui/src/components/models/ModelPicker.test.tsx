import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { contextSize, price, shortName } from '../../lib/ai/client'
import { DEFAULT_MODEL } from '../../lib/ai/modelIds'
import { forgetReadings } from '../../lib/ai/reading'
import { forgetKeyStatus } from '../../lib/ai/useKeyStatus'
import { forgetModels } from '../../lib/ai/useModels'
import { CHECKER_ROLE } from '../../lib/library/checker'
import { onTheFastTier } from '../../lib/library/onTheFastTier'
import { ROLE_PRESETS } from '../../lib/library/roles'
import { ModelPicker } from './ModelPicker'

const opus = { id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', contextLength: 1_000_000, inputPrice: 4, outputPrice: 20, free: false, reasoning: true, note: 'Best for hard work' }
const sonnet = { id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', contextLength: 1_000_000, inputPrice: 2, outputPrice: 10, free: false, reasoning: true, note: 'Strong and quicker' }
const haiku = { id: 'anthropic/claude-haiku-5.5', name: 'Anthropic: Claude Haiku 5.5', contextLength: 1_000_000, inputPrice: 0.1, outputPrice: 0.5, free: false, reasoning: true, note: 'Fast and very cheap' }
const gemma = { id: 'google/gemma-4-31b-it:free', name: 'Google: Gemma 4 31B (free)', contextLength: 262_144, inputPrice: 0, outputPrice: 0, free: true, reasoning: false }
const catalog = { fetchedAt: '2026-10-17T00:00:00Z', defaultModel: opus.id, recommended: [opus, haiku], models: [haiku, gemma, opus, sonnet] }

const writer = { id: 'writer', name: 'Writer', role: 'Write the article from what you are handed.', model: DEFAULT_MODEL }
const researcher = { id: 'researcher', name: 'Researcher', role: 'Find sources on the topic and pass them on.' }
// The bundled daily digest's Gatherer, which the free reading calls a writer.
const gatherer = { id: 'gatherer', name: 'Gatherer', role: 'Find what happened in tech in the last 24 hours, from the trusted sources only. Do not judge the stories or write them: the Writer does.' }
const team = { agents: [gatherer, researcher, writer], responder: 'writer' }

let reading = { enabled: false, readings: 0, spent: 0, today: 0, dailyLimit: 50 }
let calls: { method: string; path: string; body?: { setup?: Record<string, unknown>; enabled?: boolean } }[] = []
const readings = () => calls.filter((call) => call.path === '/api/models/reading' && call.method === 'POST')

beforeEach(() => {
  forgetModels(); forgetKeyStatus(); forgetReadings()
  reading = { enabled: false, readings: 0, spent: 0, today: 0, dailyLimit: 50 }
  calls = []
  try { window.localStorage.clear() } catch { /* none */ }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
    if (path === '/api/models') return json(catalog)
    if (path === '/api/ai') return json({ openrouter: { connected: true } })
    if (path === '/api/models/reading' && method === 'PUT') { reading = { ...reading, enabled: Boolean(body?.enabled) }; return json(reading) }
    if (path === '/api/models/reading' && method === 'POST') {
      reading = { ...reading, readings: reading.readings + 1 }
      return json({ reading: { kind: 'gather', probabilities: { gather: 0.9, produce: 0.08, check: 0.02 }, confidence: 0.9 }, kept: false })
    }
    if (path === '/api/models/reading') return json(reading)
    return json({ error: 'not found' }, 404)
  }))
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
    expect(onChange).toHaveBeenCalledWith('google/gemma-4-31b-it:free', false)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('lists the model suggested for the agent first, with why, and not again below', onTheFastTier(async () => {
    render(<ModelPicker value={opus.id} onChange={() => {}} suggestFor={{ agent: researcher, team }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Claude Opus 5\.5/ }))
    const suggested = screen.getByRole('group', { name: 'Suggested for this agent' })
    expect(suggested).toHaveTextContent('Claude Sonnet 5.5')
    expect(suggested).toHaveTextContent('It gathers facts for Writer to write up.')
    expect(suggested).not.toHaveTextContent('Strong and quicker')
    const others = screen.getByRole('group', { name: 'Other good models' })
    expect(others).toHaveTextContent('Claude Opus 5.5')
    expect(others).not.toHaveTextContent('Sonnet')
  }))

  it('leaves the suggestion out when the model list doesn’t have it', async () => {
    // A check step's model, which this list doesn't have.
    render(<ModelPicker value={opus.id} onChange={() => {}} suggestFor={{ agent: { id: 'c', name: 'Checker', role: CHECKER_ROLE } }} />)
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
    expect(onChange).toHaveBeenCalledWith(opus.id, false)
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

  it('shows how sure an unclear agent’s suggestion is, and lets AI choose once turned on', async () => {
    render(<ModelPicker value={opus.id} onChange={() => {}} suggestFor={{ agent: gatherer, team }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Claude Opus 5\.5/ }))
    // "write them" makes it a writer, so it is offered the strongest model, as a quick guess.
    const suggested = screen.getByRole('group', { name: 'Suggested for this agent' })
    expect(suggested).toHaveTextContent('Claude Opus 5.5')
    // The suggestion is a card at the top, above the search, and still the list's first option.
    expect(suggested.compareDocumentPosition(screen.getByRole('combobox')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-owns', expect.stringContaining(suggested.id))
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Claude Opus 5.5')
    expect(await screen.findByRole('status')).toHaveTextContent('A quick guess from its configuration')
    const toggle = screen.getByRole('switch', { name: 'Let AI choose' })
    expect(toggle).not.toBeChecked()
    expect(toggle).toHaveAccessibleDescription(/^AI will read this agent’s configuration to choose the most suitable model\. It uses your OpenRouter credits, under \$0\.01\. A more accurate suggestion\./)
    // Its "?" says it all: what it gains, what it costs and what AI is sent.
    const about = screen.getByRole('button', { name: 'About Let AI choose' })
    expect(about).toHaveAccessibleDescription(/A more accurate suggestion\..*Uses your OpenRouter credits\. Under \$0\.01 a reading\..*Never your files or its teammates\. One toggle for every agent\./)
    // The meter: one bar of three for a quick guess, with a key to every level.
    const meter = screen.getByRole('img', { name: 'How sure the suggestion is: 1 of 3' })
    expect(meter).toHaveAccessibleDescription('How sure this suggestion is A quick guess from its configuration AI read it, but isn’t sure Chosen by AI from its configuration')
    expect(readings()).toHaveLength(0)

    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByRole('group', { name: 'Suggested for this agent' })).toHaveTextContent('Claude Sonnet 5.5'))
    expect(calls.filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([{ enabled: true }])
    expect(screen.getByRole('group', { name: 'Suggested for this agent' })).toHaveTextContent('Its configuration says it gathers for Writer rather than writing the answer.')
    expect(screen.getByRole('status')).toHaveTextContent('Chosen by AI from its configuration')
    expect(screen.getByRole('img', { name: 'How sure the suggestion is: 3 of 3' })).toBeInTheDocument()
    // Its own setup, by name, and never its teammates.
    expect(readings()).toHaveLength(1)
    expect(readings()[0].body?.setup).toMatchObject({ name: 'Gatherer', instructions: gatherer.role })
    expect(JSON.stringify(readings()[0].body)).not.toContain('Write the article')

    // Closed and opened again: answered from what was read, not asked again.
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: /Claude Opus 5\.5/ }))
    expect(screen.getByRole('group', { name: 'Suggested for this agent' })).toHaveTextContent('Claude Sonnet 5.5')
    expect(readings()).toHaveLength(1)
  })

  it('asks nothing before its picker opens, or for an agent a fact already places', async () => {
    reading = { ...reading, enabled: true }
    const lead = ROLE_PRESETS.find((preset) => preset.id === 'lead')!
    const { unmount } = render(<ModelPicker value={opus.id} onChange={() => {}} suggestFor={{ agent: gatherer, team }} />)
    await screen.findByRole('button', { name: /Claude Opus 5\.5/ })
    expect(readings()).toHaveLength(0)
    unmount()

    // A built-in job's own instructions under another name, and a step whose name says its job.
    for (const agent of [{ id: 's', name: 'Step 2', role: lead.role }, researcher]) {
      render(<ModelPicker value={opus.id} onChange={() => {}} suggestFor={{ agent, team }} />)
      fireEvent.click(await screen.findByRole('button', { name: /Claude Opus 5\.5/ }))
      await screen.findByRole('group', { name: 'Suggested for this agent' })
      expect(screen.queryByRole('switch')).toBeNull()
      expect(screen.queryByText('A quick guess from its configuration')).toBeNull()
      cleanup()
    }
    expect(readings()).toHaveLength(0)
  })

  it('turned off, goes back to the quick guess and reads nothing more', async () => {
    reading = { ...reading, enabled: true }
    render(<ModelPicker value={opus.id} onChange={() => {}} suggestFor={{ agent: gatherer, team }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Claude Opus 5\.5/ }))
    await waitFor(() => expect(screen.getByRole('group', { name: 'Suggested for this agent' })).toHaveTextContent('Claude Sonnet 5.5'))
    fireEvent.click(screen.getByRole('switch', { name: 'Let AI choose' }))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Let AI choose' })).not.toBeChecked())
    expect(calls.filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([{ enabled: false }])
    expect(screen.getByRole('group', { name: 'Suggested for this agent' })).toHaveTextContent('Claude Opus 5.5')
    expect(screen.getByRole('status')).toHaveTextContent('A quick guess from its configuration')
    expect(readings()).toHaveLength(1)
  })

  it('keeps the suggestion at the top while searching, and it can still be picked', async () => {
    const onChange = vi.fn()
    render(<ModelPicker value={haiku.id} onChange={onChange} suggestFor={{ agent: writer, team }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Claude Haiku 5\.5/ }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gemma' } })
    expect(screen.getByRole('listbox', { name: 'Models found' })).toHaveTextContent('Gemma 4 31B')
    const suggested = screen.getByRole('group', { name: 'Suggested for this agent' })
    // Not one of the search results, so not an option, but still a pick.
    expect(within(suggested).queryByRole('option')).toBeNull()
    fireEvent.click(within(suggested).getByRole('button', { name: /Claude Opus 5\.5/ }))
    // Picking the suggestion has the agent follow it.
    expect(onChange).toHaveBeenCalledWith(opus.id, true)
  })

  it('says Suggested on its button while the model follows its suggestion, and pins any other pick', async () => {
    const onChange = vi.fn()
    const following = { ...writer, followsSuggestion: true }
    render(<ModelPicker value={opus.id} onChange={onChange} suggestFor={{ agent: following, team }} follows />)
    const button = await screen.findByRole('button', { name: /Claude Opus 5\.5/ })
    expect(button).toHaveAccessibleName('Model Claude Opus 5.5 Suggested')
    fireEvent.click(button)
    expect(screen.getByText('Follows its configuration')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: /Claude Haiku 5\.5/ }))
    expect(onChange).toHaveBeenLastCalledWith(haiku.id, false)

    cleanup()
    render(<ModelPicker value={haiku.id} onChange={onChange} suggestFor={{ agent: writer, team }} follows={false} />)
    const pinned = await screen.findByRole('button', { name: /Claude Haiku 5\.5/ })
    expect(pinned).toHaveAccessibleName('Model Claude Haiku 5.5')
    fireEvent.click(pinned)
    const suggestion = screen.getAllByRole('option')[0]
    expect(suggestion).toHaveAccessibleDescription('Pick it, and this agent’s model follows its configuration from now on.')
    fireEvent.click(suggestion)
    expect(onChange).toHaveBeenLastCalledWith(opus.id, true)
  })

  it('says where its model moved from, with Undo, while the list is closed', async () => {
    const onUndo = vi.fn()
    render(<ModelPicker value={sonnet.id} onChange={() => {}} follows moved={{ from: opus.id, onUndo }} />)
    expect(await screen.findByRole('status')).toHaveTextContent('Its configuration changed, so it moved from Claude Opus 5.5. Undo')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(onUndo).toHaveBeenCalled()
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
