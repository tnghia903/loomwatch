import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { forgetReadings } from '../../lib/ai/reading'
import { forgetKeyStatus } from '../../lib/ai/useKeyStatus'
import { ModelReading } from './ModelReading'

let status = { enabled: false, readings: 0, spent: 0, today: 0, dailyLimit: 50 }
let connected = true
const puts: unknown[] = []

beforeEach(() => {
  forgetReadings(); forgetKeyStatus()
  status = { enabled: false, readings: 0, spent: 0, today: 0, dailyLimit: 50 }
  connected = true
  puts.length = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
    if (path === '/api/ai') return json({ openrouter: { connected } })
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      puts.push(body)
      status = { ...status, enabled: body.enabled }
    }
    return json(status)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ModelReading', () => {
  it('is off until turned on, and says it gives better suggestions for OpenRouter credit', async () => {
    render(<ModelReading />)
    expect(await screen.findByRole('region', { name: 'Model suggestions' })).toBeInTheDocument()
    const toggle = await screen.findByRole('switch', { name: 'Read each agent’s setup' })
    expect(toggle).not.toBeChecked()
    expect(toggle).toHaveAccessibleDescription('Better suggestions, for under a cent of OpenRouter credit per agent.')
    // What is sent is one click away, behind the heading's "?".
    expect(screen.queryByText(/never your files/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'About Model suggestions' }))
    expect(screen.getByRole('note')).toHaveTextContent(/never your files, your Brief or its other agents\. Each agent is read once, at most 50 a day\./)

    await waitFor(() => expect(toggle).toBeEnabled())
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(puts).toEqual([{ enabled: true }])
  })

  it('says what reading has cost so far', async () => {
    status = { enabled: true, readings: 12, spent: 0.0006, today: 3, dailyLimit: 50 }
    render(<ModelReading />)
    expect(await screen.findByText('12 agents read · under $0.01')).toBeInTheDocument()
  })

  it('waits for an OpenRouter key before it can be turned on', async () => {
    connected = false
    render(<ModelReading />)
    expect(await screen.findByText('Add your OpenRouter key above first.')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeDisabled()
  })
})
