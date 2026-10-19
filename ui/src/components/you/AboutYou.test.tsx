import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { announceAiStatus, forgetKeyStatus } from '../../lib/ai/useKeyStatus'
import { forgetYou } from '../../lib/you/client'
import { AboutYou } from './AboutYou'
import AboutYouPage from './AboutYouPage'

// The privacy note names the AI the agents run on; known up front, so no test's fetch answers it.
beforeEach(() => { announceAiStatus({ openrouter: { connected: true } }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); forgetYou(); forgetKeyStatus() })
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const sent = (fetch: ReturnType<typeof vi.fn>, call: number) => {
  const [url, init] = fetch.mock.calls[call] as [string, RequestInit & { headers: Record<string, string> }]
  return { url, method: init.method, header: init.headers['X-LoomWatch-Request'], body: JSON.parse(String(init.body)) as unknown }
}

describe('About you', () => {
  it('asks for a name and a few lines, saves both from LoomWatch’s own page, and says who reads it', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ skipped: false }))
      .mockResolvedValueOnce(response({ name: 'Mai', about: 'I teach English.\nAnswer in Vietnamese.', skipped: false }))
    vi.stubGlobal('fetch', fetch)
    render(<AboutYouPage />)

    expect(screen.getByRole('heading', { name: 'About you' })).toBeInTheDocument()
    const name = await screen.findByLabelText('What should your agents call you?')
    const about = screen.getByLabelText('What should they know about you?')
    expect(name).toHaveAttribute('maxLength', '60')
    expect(about).toHaveAttribute('maxLength', '1000')
    // Nothing typed, nothing to save.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByText(/so it goes to OpenRouter with their work/)).toBeInTheDocument()

    fireEvent.change(name, { target: { value: '  Mai ' } })
    fireEvent.change(about, { target: { value: 'I teach English.\nAnswer in Vietnamese.' } })
    expect(screen.getByText('38 / 1,000')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved. Your agents read this from their next piece of work.')
    expect(sent(fetch, 1)).toEqual({
      url: '/api/you',
      method: 'PUT',
      header: '1',
      body: { name: 'Mai', about: 'I teach English.\nAnswer in Vietnamese.', skipped: false },
    })
    expect(name).toHaveValue('Mai')
    // Saved and unchanged: nothing to save again.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('says it goes to each AI the agents can run on now, and follows a change in Connections', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response({ skipped: false }))))
    forgetKeyStatus()
    announceAiStatus({ openrouter: { connected: false } })
    render(<AboutYou />)
    expect(await screen.findByText(/so it goes with their work to the AI they run on\. Leave out/)).toBeInTheDocument()

    // Signed in to ChatGPT but not using the plan: agents can't run there, so it isn't named.
    act(() => announceAiStatus({ chatgpt: { available: true, connected: true, planUse: false } }))
    expect(screen.getByText(/so it goes with their work to the AI they run on\./)).toBeInTheDocument()
    act(() => announceAiStatus({ chatgpt: { available: true, connected: true, planUse: true } }))
    expect(screen.getByText(/so it goes to ChatGPT with their work\./)).toBeInTheDocument()
    act(() => announceAiStatus({ anthropic: { connected: true } }))
    expect(screen.getByText(/so it goes with their work to ChatGPT or Claude, whichever an agent runs on\./)).toBeInTheDocument()
    act(() => announceAiStatus({ openrouter: { connected: true } }))
    expect(screen.getByText(/so it goes with their work to ChatGPT, Claude or OpenRouter, whichever an agent runs on\./)).toBeInTheDocument()
    expect(screen.queryByText(/OpenRouter with their work/)).toBeNull()
  })

  it('clears what agents know, and the card stays away after', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ name: 'Mai', about: 'Keep it short.', skipped: false }))
      .mockResolvedValueOnce(response({ skipped: true }))
    vi.stubGlobal('fetch', fetch)
    render(<AboutYou />)
    expect(await screen.findByDisplayValue('Mai')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Cleared.')
    expect(sent(fetch, 1).body).toEqual({ skipped: true })
    expect(screen.getByLabelText('What should your agents call you?')).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  })

  it('on Home, Not now puts the card away for good, and a refusal is said', async () => {
    const onDone = vi.fn()
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ skipped: false }))
      .mockResolvedValueOnce(response({ error: 'A name can be up to 60 characters.' }, 422))
      .mockResolvedValueOnce(response({ skipped: true }))
    vi.stubGlobal('fetch', fetch)
    render(<AboutYou variant="card" onDone={onDone} />)
    expect(await screen.findByRole('heading', { name: 'Tell your agents about you' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('What should your agents call you?'), { target: { value: 'Mai' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A name can be up to 60 characters.')
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith({ skipped: true }))
    expect(sent(fetch, 2).body).toEqual({ skipped: true })
  })
})
