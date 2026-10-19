import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AI_CHANNEL } from '../../lib/ai/client'
import { forgetKeyStatus } from '../../lib/ai/useKeyStatus'
import { forgetModels } from '../../lib/ai/useModels'
import { Sources } from './Sources'

let fetchMock: ReturnType<typeof vi.fn>

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

const CONSENT = 'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client'

function daemon(state: { chatgpt: Record<string, unknown>; anthropic?: Record<string, unknown> }) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/ai') {
      return respond({ openrouter: { connected: false }, anthropic: state.anthropic ?? { connected: false }, chatgpt: { available: true, planUse: false, connected: false, ...state.chatgpt } })
    }
    if (url === '/api/ai/chatgpt/sign-in') return respond({ url: CONSENT })
    if (url === '/api/ai/chatgpt' && init?.method === 'DELETE') return respond({ chatgpt: { available: true, connected: false, planUse: false }, revoked: true })
    if (url === '/api/ai/anthropic' && init?.method === 'PUT') {
      const { key } = JSON.parse(String(init.body)) as { key: string }
      return key === 'sk-ant-api03-good'
        ? respond({ anthropic: { connected: true, label: 'sk-ant-api03-…good', models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextLength: 1_000_000, maxOutput: 128_000, adaptiveThinking: true }] } })
        : respond({ error: 'Anthropic refused this key.' }, 400)
    }
    if (url === '/api/models') return respond({ fetchedAt: '', defaultModel: '', recommended: [], models: [] })
    return respond({})
  }
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  forgetKeyStatus()
  forgetModels()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('How agents’ models are paid', () => {
  it('shows the three ways side by side, with what each costs', async () => {
    fetchMock.mockImplementation(daemon({ chatgpt: {} }))
    render(<Sources />)
    const plan = await screen.findByRole('region', { name: 'Your ChatGPT plan' })
    expect(within(plan).getByText(/No extra charge/)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Your Claude API credit' })).toHaveTextContent('Each call has a price.')
    expect(screen.getByRole('region', { name: 'OpenRouter (pay per use)' })).toBeInTheDocument()
  })

  it('opens ChatGPT’s own page in one click and carries on when the sign-in comes back', async () => {
    let signedIn = false
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === '/api/ai' && signedIn
      ? respond({ openrouter: { connected: false }, anthropic: { connected: false }, chatgpt: { available: true, connected: true, planUse: true, email: 'a@example.com', models: [{ slug: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', contextLength: 500_000 }] } })
      : daemon({ chatgpt: {} })(url, init))
    render(<Sources />)
    const button = await screen.findByRole('link', { name: 'Continue with ChatGPT' })
    await waitFor(() => expect(button).toHaveAttribute('href', CONSENT))
    expect(button).toHaveAttribute('target', '_blank')
    fireEvent.click(button)
    expect(await screen.findByText(/Finish signing in on ChatGPT’s page/)).toBeInTheDocument()
    signedIn = true
    new BroadcastChannel(AI_CHANNEL).postMessage({ source: 'chatgpt', outcome: 'connected' })
    expect(await screen.findByText('Using ChatGPT plan')).toBeInTheDocument()
    expect(screen.getByText('Signed in as a@example.com')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Manage usage' })).toHaveAttribute('href', 'https://chatgpt.com/settings/usage')
  })

  it('says plainly when plan use is off, and offers to turn it on', async () => {
    fetchMock.mockImplementation(daemon({ chatgpt: { connected: true, planUse: false, email: 'a@example.com' } }))
    render(<Sources />)
    expect(await screen.findByText('Signed in, plan use off')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Turn on plan use' })).toBeInTheDocument()
  })

  it('signs out of ChatGPT, saying whether OpenAI confirmed it', async () => {
    fetchMock.mockImplementation(daemon({ chatgpt: { connected: true, planUse: true } }))
    render(<Sources />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByText(/Signed out\. Agents on ChatGPT models/)).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/ai/chatgpt' && (init as RequestInit)?.method === 'DELETE')).toBe(true)
  })

  it('keeps a Claude key only after Anthropic accepts it', async () => {
    fetchMock.mockImplementation(daemon({ chatgpt: {} }))
    render(<Sources />)
    const field = await screen.findByLabelText('Claude API key')
    fireEvent.change(field, { target: { value: 'sk-ant-api03-wrong' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save key' })[0])
    expect(await screen.findByText('Anthropic refused this key.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Claude API key'), { target: { value: 'sk-ant-api03-good' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save key' })[0])
    expect(await screen.findByText(/Anthropic accepted the key/)).toBeInTheDocument()
    expect(screen.getByText(/sk-ant-api03-…good · 1 Claude models/)).toBeInTheDocument()
  })
})
