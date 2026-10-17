import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenRouterKey } from './OpenRouterKey'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('OpenRouterKey', () => {
  it('explains where a key comes from, checks it, and never keeps it on screen', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ openrouter: { connected: false } }))
      .mockResolvedValueOnce(response({ error: 'OpenRouter refused this key. Copy it again from openrouter.ai/keys, or make a new one.' }, 400))
      .mockResolvedValueOnce(response({ openrouter: { connected: true, label: 'sk-or-v1-abc...xyz', spent: 0.4, spentThisMonth: 0.17 } }))
    vi.stubGlobal('fetch', fetch)
    render(<OpenRouterKey />)

    expect(await screen.findByRole('link', { name: 'Open OpenRouter’s keys page' })).toHaveAttribute('href', 'https://openrouter.ai/keys')
    const input = screen.getByLabelText('OpenRouter key')
    fireEvent.change(input, { target: { value: 'sk-or-v1-wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('refused this key')
    expect(input).toHaveValue('')

    fireEvent.change(screen.getByLabelText('OpenRouter key'), { target: { value: 'sk-or-v1-good' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    expect(await screen.findByRole('status')).toHaveTextContent('OpenRouter accepted the key')
    expect(screen.getByText(/Key sk-or-v1-abc\.\.\.xyz · \$0\.17 this month · \$0\.40 spent with this key/)).toBeInTheDocument()
    // The one cap that holds every run, Ask and every schedule is the key's own, at OpenRouter (ADR 0068).
    expect(screen.getByRole('link', { name: 'Set a monthly limit on this key' })).toHaveAttribute('href', 'https://openrouter.ai/settings/keys')
    expect(screen.queryByDisplayValue('sk-or-v1-good')).toBeNull()

    const sent = fetch.mock.calls[2]
    expect(sent[0]).toBe('/api/ai/openrouter')
    expect(sent[1].method).toBe('PUT')
    expect(sent[1].headers['X-LoomWatch-Request']).toBe('1')
    expect(JSON.parse(sent[1].body)).toEqual({ key: 'sk-or-v1-good' })
  })

  it('says when only free models work, and removes the key', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ openrouter: { connected: true, label: 'sk-or-v1-abc...xyz', freeTier: true } }))
      .mockResolvedValueOnce(response({ openrouter: { connected: false } }))
    vi.stubGlobal('fetch', fetch)
    render(<OpenRouterKey />)
    expect(await screen.findByText(/only free models work/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }))
    expect(await screen.findByRole('status')).toHaveTextContent('The key is removed')
    expect(fetch.mock.calls[1][1].method).toBe('DELETE')
    expect(screen.getByLabelText('OpenRouter key')).toBeInTheDocument()
  })
})
