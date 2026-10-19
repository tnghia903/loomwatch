import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetKeyStatus } from '../../lib/ai/useKeyStatus'
import { chatAgentId } from '../../lib/library/draft'
import { resetFirstRunForTests } from '../../lib/firstrun/store'
import { forgetYou } from '../../lib/you/client'
import { FirstRun } from './FirstRun'

// The run each answer follows, set by the test as the daemon would report it.
const runs = vi.hoisted(() => ({ records: new Map<string, Record<string, unknown>>(), listeners: new Set<() => void>() }))
vi.mock('../../lib/runs/useRunSession', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useRunSession: (runId: string | null) => {
      const record = useSyncExternalStore(
        (changed) => { runs.listeners.add(changed); return () => { runs.listeners.delete(changed) } },
        () => (runId ? runs.records.get(runId) ?? null : null),
      )
      return { record, projection: { agents: [] }, terminal: Boolean(record && ['succeeded', 'failed', 'cancelled'].includes(String(record.status))) }
    },
  }
})
function settle(runId: string, patch: Record<string, unknown>) {
  act(() => {
    runs.records.set(runId, { ...runs.records.get(runId), ...patch })
    for (const changed of runs.listeners) changed()
  })
}

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
let fetchMock: ReturnType<typeof vi.fn>
let assign: ReturnType<typeof vi.fn>
let connected: boolean
let ai: unknown
let you: Record<string, unknown>
let started: number

beforeEach(() => {
  resetFirstRunForTests(); forgetKeyStatus(); forgetYou()
  runs.records.clear()
  connected = true
  ai = null
  you = { skipped: false }
  started = 0
  assign = vi.fn()
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } })
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/ai') return json(ai ?? { openrouter: { connected } })
    if (url === '/api/ai/openrouter' && method === 'PUT') { connected = true; return json({ openrouter: { connected: true, label: 'sk-or-v1-tes...est' } }) }
    if (url === '/api/you') return json(method === 'PUT' ? JSON.parse(String(init?.body)) : you)
    if (url === '/api/bench') return json({ folder: '.jobs/.bench' })
    if (url.startsWith('/api/team?')) return json({ error: 'not found' }, 404)
    if (url === '/api/team') return json({ ...JSON.parse(String(init?.body)), revision: 'r1' })
    if (url === '/api/chat/messages') {
      started += 1
      const runId = `run-${started}`
      runs.records.set(runId, { runId, status: 'running' })
      return json({ route: 'agent', message: { id: `m-${started}` }, run: { runId, status: 'queued' } }, 202)
    }
    if (url === '/api/jobs/helper') return json({ id: 'helper', file: 'helper.yaml', name: 'Helper', instructions: 'x', version: 1 })
    return json({ error: `unexpected ${method} ${url}` }, 500)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const sent = (path: string, method = 'POST') => fetchMock.mock.calls
  .filter(([url, init]) => url === path && ((init as RequestInit | undefined)?.method ?? 'GET') === method)
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)

async function ask(request: string) {
  fireEvent.change(screen.getByLabelText('What shall we make?'), { target: { value: request } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

describe('The first run', () => {
  it('asks which AI should answer on the first Send only when none is connected, then goes on with that Send', async () => {
    connected = false
    const { container } = render(<FirstRun onLookAround={vi.fn()} onDone={vi.fn()} />)
    expect(screen.getByText('What shall we make first?')).toBeInTheDocument()
    // The first agent greets them in the crew figure it keeps in My agents.
    expect(container.querySelector('img.fr-figure')).toHaveAttribute('src', '/agent/figures/spool-butter.webp')
    fireEvent.click(screen.getByRole('button', { name: 'Plan a 30-minute lesson about animals' }))
    expect(screen.getByLabelText('What shall we make?')).toHaveValue('Plan a 30-minute lesson about animals')
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/ai')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const sheet = await screen.findByRole('dialog', { name: 'Which AI should answer?' })
    expect(within(sheet).getByRole('button', { name: /OpenRouter key/ })).toHaveTextContent('Pay as you go: add credit at OpenRouter.')
    // A Claude plan's credit is offered with the same weight (ADR 0073); the ChatGPT plan too, where this copy offers it.
    expect(within(sheet).getByRole('button', { name: /Claude Max or Team/ })).toHaveTextContent('Spends your plan’s monthly API credit.')
    // The ruling: nothing on the way in calls OpenRouter free.
    expect(sheet.textContent).not.toMatch(/\bfree\b/i)
    expect(sent('/api/chat/messages')).toHaveLength(0)

    // The key form inside the sheet connects it, as a newcomer would.
    fireEvent.click(within(sheet).getByRole('button', { name: /OpenRouter key/ }))
    fireEvent.change(await within(sheet).findByLabelText('OpenRouter key'), { target: { value: 'sk-or-v1-test' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save key' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(sent('/api/chat/messages')).toHaveLength(1))
    const [message] = sent('/api/chat/messages')
    expect(message).toMatchObject({ teamPath: '.jobs/.bench/helper.yaml', text: 'Plan a 30-minute lesson about animals', to: { kind: 'agent', agent: chatAgentId('helper') }, expectedRevision: 'r1' })
    expect(String(sent('/api/team', 'PUT')[0].yaml)).toContain('name: Helper')
    expect(screen.getByText('Connected.')).toBeInTheDocument()
    expect(screen.getByText(/I’m answering through OpenRouter\./)).toBeInTheDocument()
  })

  it('answers on a plan already connected, on that plan’s model, without asking (ADR 0073)', async () => {
    ai = { openrouter: { connected: false }, anthropic: { connected: true } }
    render(<FirstRun onLookAround={vi.fn()} onDone={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/Your first agent · Claude credit/)).toBeInTheDocument())
    await ask('Explain how compound interest works')
    await waitFor(() => expect(sent('/api/chat/messages')).toHaveLength(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(String(sent('/api/team', 'PUT')[0].yaml)).toContain('anthropic:claude-opus-5-5')
  })

  it('shows the first answer, takes what the person tells about themselves, and answers the same request again for them', async () => {
    const { container } = render(<FirstRun onLookAround={vi.fn()} onDone={vi.fn()} />)
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/ai')).toBe(true))
    await ask('Plan a 30-minute lesson about animals')
    await waitFor(() => expect(sent('/api/chat/messages')).toHaveLength(1))
    expect(await screen.findByText('Writing your answer…')).toBeInTheDocument()
    settle('run-1', { status: 'succeeded', reply: 'A plain lesson plan.' })
    expect(await screen.findByText(/A plain lesson plan/)).toBeInTheDocument()
    const seen = [container.textContent ?? '']

    fireEvent.click(await screen.findByRole('button', { name: 'Tell my agents about me' }))
    const tape = screen.getByRole('region', { name: 'About you' })
    seen.push(container.textContent ?? '')
    const again = within(tape).getByRole('button', { name: 'Answer that again' })
    expect(again).toBeDisabled()
    fireEvent.change(within(tape).getByLabelText('What should I call you?'), { target: { value: 'Mai' } })
    fireEvent.click(within(tape).getByRole('button', { name: 'Teaching' }))
    fireEvent.click(within(tape).getByRole('button', { name: 'Tiếng Việt' }))
    fireEvent.click(within(tape).getByRole('button', { name: 'Short' }))
    expect(within(tape).getByRole('button', { name: 'Short' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(again)

    await waitFor(() => expect(sent('/api/you', 'PUT')).toEqual([{ name: 'Mai', about: 'I’m a teacher.\nAnswer in Vietnamese.\nKeep answers short.', skipped: false }]))
    await waitFor(() => expect(sent('/api/chat/messages')).toHaveLength(2))
    expect(sent('/api/chat/messages')[1].text).toBe('Answer this again for me, using what I just told you about myself: Plan a 30-minute lesson about animals')
    expect(screen.getByText('Same request, made for you')).toBeInTheDocument()
    settle('run-2', { status: 'succeeded', reply: 'Bài học 30 phút.' })
    expect(await screen.findByText(/Bài học 30 phút/)).toBeInTheDocument()
    expect(screen.getByText('made for Mai').parentElement).toHaveTextContent('Teaching · Tiếng Việt · Short')
    expect(screen.getByText('Done, Mai. That one was made for you.')).toBeInTheDocument()
    seen.push(container.textContent ?? '')
    // The ruling: plain words. No sewing word a newcomer would have to decode, anywhere on the way.
    for (const text of seen) expect(text).not.toMatch(/\b(sew|thread|stitch|fitting|fitted|measurement|tailor|weav|woven)/i)

    fireEvent.click(screen.getByRole('button', { name: 'Keep this agent' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/agents/helper?view=chat'))
    const keep = fetchMock.mock.calls.find(([url]) => url === '/api/jobs/helper') as [string, RequestInit] | undefined
    expect(keep).toBeDefined()
    expect(keep![1].headers).toMatchObject({ 'If-None-Match': '*' })
    // Kept in the figure that greeted them, so My agents shows the same crew member.
    expect(JSON.parse(String(keep![1].body))).toMatchObject({ name: 'Helper', figure: { kind: 'spool', color: 'butter' } })
    expect(localStorage.getItem('loomwatch:first-run')).toBe('done')
  })

  it('says why an answer stopped and tries it again; Not now skips telling about me, and Home ends it', async () => {
    const onDone = vi.fn()
    render(<FirstRun onLookAround={vi.fn()} onDone={onDone} />)
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/ai')).toBe(true))
    await ask('Explain how compound interest works')
    await waitFor(() => expect(sent('/api/chat/messages')).toHaveLength(1))
    settle('run-1', { status: 'failed', error: 'Your OpenRouter account is out of credits. Add credits at openrouter.ai, then try again.' })
    const stopped = await screen.findByRole('alert')
    expect(stopped).toHaveTextContent('out of credits')
    fireEvent.click(within(stopped).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(sent('/api/chat/messages')).toHaveLength(2))
    expect(sent('/api/chat/messages')[1].text).toBe('Explain how compound interest works')
    settle('run-2', { status: 'succeeded', reply: 'Interest on interest.' })

    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('region', { name: 'About you' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Go to Home' }))
    expect(onDone).toHaveBeenCalled()
    expect(localStorage.getItem('loomwatch:first-run')).toBe('done')
    expect(sent('/api/you', 'PUT')).toHaveLength(0)
  })

  it('doesn’t offer it to someone who told their agents about themselves already', async () => {
    you = { name: 'Mai', about: 'Answer in Vietnamese.', skipped: false }
    render(<FirstRun onLookAround={vi.fn()} onDone={vi.fn()} />)
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/you')).toBe(true))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/ai')).toBe(true))
    await ask('Reply to a customer whose order is late')
    await waitFor(() => expect(sent('/api/chat/messages')).toHaveLength(1))
    settle('run-1', { status: 'succeeded', reply: 'Xin lỗi quý khách.' })
    expect(await screen.findByRole('button', { name: 'Keep this agent' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Tell my agents about me' })).toBeNull()
  })

  it('lets someone look around instead', () => {
    const onLookAround = vi.fn()
    render(<FirstRun onLookAround={onLookAround} onDone={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Just look around' }))
    expect(onLookAround).toHaveBeenCalled()
  })
})
