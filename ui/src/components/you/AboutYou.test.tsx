import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { announceAiStatus, forgetKeyStatus } from '../../lib/ai/useKeyStatus'
import { forgetYou } from '../../lib/you/client'
import { AboutYou } from './AboutYou'
import { ASK_ANOTHER_AI } from './AskAnotherAI'
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
    const about = screen.getByLabelText('What should your agents know about you?')
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

  // The first run's three questions, here too: each choice writes its sentence into the text agents
  // are told, and shows what that text says, so a sentence changed by hand moves its choice.
  it('asks what you do, the language and how long over the text, and saves the text they write', async () => {
    const saved = 'I like cats.\nI work in coffee farming.'
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ name: 'Mai', about: 'I like cats.\nAnswer in Vietnamese.', skipped: false }))
      .mockResolvedValueOnce(response({ name: 'Mai', about: saved, skipped: false }))
    vi.stubGlobal('fetch', fetch)
    render(<AboutYouPage />)
    const about = await screen.findByLabelText('What should your agents know about you?')
    const question = (label: string) => screen.getByRole('group', { name: label })
    const choice = (label: string, name: string) => within(question(label)).getByRole('button', { name })
    expect(choice('Answer in', 'Tiếng Việt')).toHaveAttribute('aria-pressed', 'true')
    expect(within(question('What do you do?')).getAllByRole('button').filter((button) => button.getAttribute('aria-pressed') === 'true')).toEqual([])
    // Nothing said about length: agents answer at the length they judge right.
    expect(choice('How long?', 'Just right')).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(choice('What do you do?', 'Teaching'))
    expect(about).toHaveValue('I like cats.\nAnswer in Vietnamese.\nI’m a teacher.')
    fireEvent.click(choice('Answer in', 'English'))
    expect(about).toHaveValue('I like cats.\nAnswer in English.\nI’m a teacher.')
    expect(choice('Answer in', 'English')).toHaveAttribute('aria-pressed', 'true')
    expect(choice('Answer in', 'Tiếng Việt')).toHaveAttribute('aria-pressed', 'false')

    fireEvent.change(about, { target: { value: 'I like cats.\nKeep answers short.' } })
    expect(choice('How long?', 'Short')).toHaveAttribute('aria-pressed', 'true')
    expect(choice('Answer in', 'English')).toHaveAttribute('aria-pressed', 'false')
    expect(choice('What do you do?', 'Teaching')).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(choice('What do you do?', 'Something else'))
    const words = screen.getByLabelText('In a few words')
    fireEvent.change(words, { target: { value: 'coffee ' } })
    expect(words).toHaveValue('coffee ')
    fireEvent.change(words, { target: { value: 'coffee farming' } })
    expect(about).toHaveValue('I like cats.\nKeep answers short.\nI work in coffee farming.')

    // Just right says nothing: it takes the length sentence out, and shows as picked.
    fireEvent.click(choice('How long?', 'Just right'))
    expect(about).toHaveValue(saved)
    expect(choice('How long?', 'Just right')).toHaveAttribute('aria-pressed', 'true')
    expect(choice('How long?', 'Short')).toHaveAttribute('aria-pressed', 'false')
    expect(choice('What do you do?', 'Something else')).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.')
    expect(sent(fetch, 1).body).toEqual({ name: 'Mai', about: saved, skipped: false })
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

  it('gives a message to copy into ChatGPT or Claude, which writes the note from what it remembers', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response({ skipped: false }))))
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<AboutYou />)
    expect(await screen.findByText('Already use ChatGPT or Claude? Have it write this for you')).toBeInTheDocument()
    const message = screen.getByLabelText('The message to copy')
    expect(message).toHaveTextContent(/write a short note about me that I can paste into the app’s “About you” box/)
    // The same limit as the box, and nothing that should stay private.
    expect(ASK_ANOTHER_AI).toContain('It must fit in 1,000 characters.')
    expect(ASK_ANOTHER_AI).toContain('Leave out my name and anything private: passwords')

    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(ASK_ANOTHER_AI)
  })

  it('selects the message when it can’t copy, and Home’s short card leaves it out', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(response({ skipped: false }))))
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel', clipboard: { writeText: () => Promise.reject(new Error('denied')) } })
    const { unmount } = render(<AboutYou />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy message' }))
    expect(await screen.findByText('Couldn’t copy here. The message is selected: press ⌘C.')).toBeInTheDocument()
    expect(window.getSelection()?.toString()).toBe(ASK_ANOTHER_AI)
    unmount()

    render(<AboutYou variant="card" />)
    expect(await screen.findByRole('heading', { name: 'Tell your agents about you' })).toBeInTheDocument()
    expect(screen.queryByText(/Already use ChatGPT or Claude/)).toBeNull()
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
