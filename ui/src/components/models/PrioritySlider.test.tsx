import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CHECK_MODEL, DEFAULT_MODEL, FAST_MODEL, currentPriority, modelForJobId, modelForTier, modelNameFromId } from '../../lib/ai/modelIds'
import { forgetKeyStatus } from '../../lib/ai/useKeyStatus'
import { forgetModels } from '../../lib/ai/useModels'
import { suggestModel } from '../../lib/team-file/modelSuggestion'
import { agentsGet } from '../../lib/ai/agentsGet'
import { PrioritySlider } from './PrioritySlider'

let kept: string | undefined
let refuse = false
let puts: unknown[] = []

beforeEach(() => {
  forgetKeyStatus(); forgetModels()
  kept = undefined; refuse = false; puts = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
    if (path === '/api/ai') return json({ openrouter: { connected: true }, ...(kept ? { priority: kept } : {}) })
    if (path === '/api/ai/priority' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { priority: string }
      puts.push(body)
      if (refuse) return json({ error: 'The setting couldn’t be kept: disk full' }, 500)
      kept = body.priority
      return json({ priority: kept })
    }
    return json({ error: 'not found' }, 404)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); forgetKeyStatus() })

const researcher = { id: 'researcher', name: 'Researcher', role: 'Find sources on the topic and pass them on.' }
const writer = { id: 'writer', name: 'Writer', role: 'Write the article from what you are handed.', model: DEFAULT_MODEL }

describe('PrioritySlider', () => {
  it('starts on Highest quality when the daemon says nothing, and says what agents get there', async () => {
    render(<PrioritySlider />)
    const slider = screen.getByRole('slider', { name: 'Your agents’ models' })
    await waitFor(() => expect(slider).toHaveAttribute('aria-valuetext', 'Highest quality'))
    expect(slider).toHaveAccessibleDescription(`Most new agents on ${modelNameFromId(DEFAULT_MODEL)}. Checker on ${modelNameFromId(CHECK_MODEL)}.`)
  })

  it('keeps a stop with the daemon, and every model suggestion follows it from then on', async () => {
    render(<PrioritySlider />)
    const slider = screen.getByRole('slider', { name: 'Your agents’ models' })
    await waitFor(() => expect(slider).toHaveAttribute('aria-valuetext', 'Highest quality'))
    const team = { agents: [researcher, writer], responder: 'writer' }
    expect(suggestModel({ agent: researcher, team }).model).toBe(DEFAULT_MODEL)

    fireEvent.change(slider, { target: { value: '1' } })
    await waitFor(() => expect(currentPriority()).toBe('balance'))
    expect(puts).toEqual([{ priority: 'balance' }])
    expect(slider).toHaveAttribute('aria-valuetext', 'Balanced')
    expect(slider).toHaveAccessibleDescription(`Most new agents on ${modelNameFromId(DEFAULT_MODEL)}. Researcher, Editor, Reviewer and Document maker on ${modelNameFromId(FAST_MODEL)}. Checker and Analyst on GPT-6.1 Sol. Spreadsheet maker on GPT-6.1 Terra.`)
    // The same table, at the same stop: the suggestion is what the line says.
    expect(suggestModel({ agent: researcher, team }).model).toBe(FAST_MODEL)

    fireEvent.change(slider, { target: { value: '0' } })
    await waitFor(() => expect(currentPriority()).toBe('saving'))
    expect(suggestModel({ agent: writer, team }).model).toBe(modelForJobId('writer', 'strong', undefined, undefined, 'saving'))
    expect(suggestModel({ agent: researcher, team }).model).toBe(modelForTier('fast', undefined, undefined, 'saving'))
  })

  it('chooses a stop by its name, and says nothing when the name is the stop already chosen', async () => {
    render(<PrioritySlider />)
    const slider = screen.getByRole('slider', { name: 'Your agents’ models' })
    await waitFor(() => expect(slider).toHaveAttribute('aria-valuetext', 'Highest quality'))
    fireEvent.click(screen.getByText('Highest quality'))
    fireEvent.click(screen.getByText('Saving'))
    await waitFor(() => expect(currentPriority()).toBe('saving'))
    expect(puts).toEqual([{ priority: 'saving' }])
    expect(slider).toHaveAttribute('aria-valuetext', 'Saving')
  })

  it('goes back to the stop kept, and says why, when the daemon can’t keep the new one', async () => {
    kept = 'balance'
    render(<PrioritySlider />)
    const slider = screen.getByRole('slider', { name: 'Your agents’ models' })
    await waitFor(() => expect(slider).toHaveAttribute('aria-valuetext', 'Balanced'))
    refuse = true
    fireEvent.change(slider, { target: { value: '2' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('LoomWatch couldn’t save Highest quality, so it’s still on Balanced. Try again, or restart LoomWatch.')
    expect(slider).toHaveAttribute('aria-valuetext', 'Balanced')
    expect(currentPriority()).toBe('balance')
  })

  it('names the models on the ways of paying connected, and says it in short for the Ask panel', () => {
    // With only the Claude credit, it pays for every job: a job's own pick it can't run gives way to the job's tier.
    const { all, short } = agentsGet('balance', (model) => model, ['anthropic'])
    expect(all).toBe('Most new agents on anthropic:claude-opus-5-5. Researcher, Editor, Reviewer and Document maker on anthropic:claude-sonnet-5-5.')
    expect(short).toBe('Most new agents on anthropic:claude-opus-5-5, others for some jobs.')
    expect(agentsGet('quality', modelNameFromId).short).toBe(`Most new agents on ${modelNameFromId(DEFAULT_MODEL)}; checks on ${modelNameFromId(CHECK_MODEL)}.`)
    expect(agentsGet('saving', modelNameFromId).short).toBe('Most new agents on Claude Haiku 5.5, others for some jobs.')
  })
})
