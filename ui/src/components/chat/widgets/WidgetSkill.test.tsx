import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { KeptWidget, WidgetState } from '../../../lib/widgets/types'
import { AnswerWidgets } from './AnswerWidgets'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const suggested: KeptWidget = {
  n: 1,
  spec: {
    kind: 'skill',
    title: 'Weekly client update',
    description: 'Writes the weekly update for a client. Use it when asked for a client update.',
    instructions: '1. Read this week’s notes.\n2. Write three short bullets.\n3. Sign it Mai.',
  },
}

type Sent = { method: string; url: string; body?: Record<string, unknown>; header?: string }

function daemon(answer: (sent: Sent) => Response | undefined) {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const request: Sent = { method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined, header: headers['X-LoomWatch-Request'] }
    sent.push(request)
    return answer(request) ?? json({ error: 'no route' }, 404)
  }))
  return sent
}

/** What the chat keeps for the widget: `onChange`, answering as the daemon does. */
function keeper() {
  const kept: WidgetState[] = []
  const onChange = vi.fn(async (n: number, state: WidgetState) => {
    kept.push(state)
    return { ...suggested, n, state, changedAt: new Date().toISOString() }
  })
  return { kept, onChange }
}

const written = (name: string) => ({ skill: { name, description: 'd', origin: { kind: 'written', suggestedBy: 'Mai' }, license: { restricted: false }, needs: [], runtimes: [], hasScripts: false, sizeBytes: 1, sha256: '', addedAt: '' }, base: 'b' })

describe('a skill an agent suggests', () => {
  it('says what it would teach, and saves it as the person, with who suggested it', async () => {
    const sent = daemon((request) => (request.method === 'PUT' && request.url === '/api/skills/words' ? json(written('weekly-client-update')) : undefined))
    const { kept, onChange } = keeper()
    render(<AnswerWidgets widgets={[suggested]} onChange={onChange} by="Mai" />)
    const card = screen.getByRole('region', { name: 'Suggested skill: Weekly client update' })
    expect(within(card).getByText('Writes the weekly update for a client. Use it when asked for a client update.')).toBeTruthy()
    // What it says, one tap away.
    expect(within(card).getByText('What it says')).toBeTruthy()
    expect(sent).toHaveLength(0)

    fireEvent.click(within(card).getByRole('button', { name: 'Save skill' }))
    expect(await within(card).findByText('Saved. Every agent can use it now.')).toBeTruthy()
    expect(sent[0]).toMatchObject({ method: 'PUT', url: '/api/skills/words', header: '1' })
    expect(sent[0].body).toEqual({
      name: 'weekly-client-update',
      description: suggested.spec.kind === 'skill' ? suggested.spec.description : '',
      instructions: suggested.spec.kind === 'skill' ? suggested.spec.instructions : '',
      suggestedBy: 'Mai',
    })
    expect(kept).toEqual([{ saved: 'weekly-client-update' }])
    expect(within(card).queryByRole('button', { name: 'Save skill' })).toBeNull()
  })

  it('is left with Not now, and can be looked at again', async () => {
    const sent = daemon(() => undefined)
    const { kept, onChange } = keeper()
    const { rerender } = render(<AnswerWidgets widgets={[suggested]} onChange={onChange} by="Mai" />)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(kept).toEqual([{ dismissed: true }]))
    expect(sent).toHaveLength(0)
    // As the chat's page brings it back, kept as left.
    rerender(<AnswerWidgets widgets={[{ ...suggested, state: { dismissed: true }, changedAt: '2999-01-01T00:00:00Z' }]} onChange={onChange} by="Mai" />)
    expect(await screen.findByText(/You didn’t save “Weekly client update”/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show it' }))
    expect(screen.getByRole('button', { name: 'Save skill' })).toBeTruthy()
  })

  it('opens on the Skills page’s sheet to change first, and a name you have already says so', async () => {
    let tries = 0
    const sent = daemon((request) => {
      if (request.method !== 'PUT') return undefined
      tries += 1
      return tries === 1
        ? json({ error: 'You already have a skill named “weekly-client-update”. Give this one another name.' }, 409)
        : json(written('weekly-update-for-acme'))
    })
    const { kept, onChange } = keeper()
    render(<AnswerWidgets widgets={[suggested]} onChange={onChange} by="Mai" />)
    fireEvent.click(screen.getByRole('button', { name: 'Save skill' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already have a skill')
    expect(kept).toEqual([])

    // Opened and closed without a change: nothing of the person's to lose, so it doesn't ask.
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByText('Suggested by Mai')).toBeTruthy()
    expect(within(sheet).getByLabelText('Name')).toHaveValue('Weekly client update')
    expect(within(sheet).getByLabelText('What to do')).toHaveValue(suggested.spec.kind === 'skill' ? suggested.spec.instructions : '')
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Weekly update for Acme' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save skill' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(sent[1].body).toMatchObject({ name: 'weekly-update-for-acme', suggestedBy: 'Mai' })
    expect(sent[1].body).not.toHaveProperty('base')
    expect(kept).toEqual([{ saved: 'weekly-update-for-acme' }])
    expect(await screen.findByText('Saved. Every agent can use it now.')).toBeTruthy()
  })
})
