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
    const toggle = await screen.findByRole('switch', { name: 'Read each agent’s whole setup for better suggestions' })
    expect(toggle).not.toBeChecked()
    expect(toggle).toHaveAccessibleDescription(/Suggestions get more accurate, and this uses your OpenRouter credit\./)
    expect(screen.getByText(/Never your files, your team’s Brief or its other agents\. At most 50 agents a day\./)).toBeInTheDocument()

    await waitFor(() => expect(toggle).toBeEnabled())
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(puts).toEqual([{ enabled: true }])
  })

  it('says what reading has cost so far', async () => {
    status = { enabled: true, readings: 12, spent: 0.0006, today: 3, dailyLimit: 50 }
    render(<ModelReading />)
    expect(await screen.findByText('12 agents read so far, for less than $0.01.')).toBeInTheDocument()
  })

  it('waits for an OpenRouter key before it can be turned on', async () => {
    connected = false
    render(<ModelReading />)
    expect(await screen.findByText('Add your OpenRouter key above to turn this on.')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeDisabled()
  })
})
